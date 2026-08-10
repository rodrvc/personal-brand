#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PROFILES_DIR = ROOT / 'profiles'

# Rutas que deben permanecer libres de literales de marca: el motor y los
# orquestadores son genéricos por contrato (ver CLAUDE.md).
# Las capas que deben ser genéricas: ninguna puede llevar literales de una
# marca real. `app/` y `core/` entran porque `docs/ARQUITECTURA.md` promete
# verificar las cuatro, y hasta ahora el validador cubría dos: la promesa
# escrita y lo que el código comprobaba habían dejado de coincidir, que es la
# forma exacta en que una garantía se convierte en una costumbre.
GENERIC_PREFIXES = ('system/', '.claude/', 'app/', 'core/')

# Solo los perfiles de ejemplo (marcas ficticias de onboarding) son
# publicables. Un perfil real vive fuera del árbol del repo.
PUBLIC_PROFILE_PREFIX = 'profiles/example'

# Términos manuales, que se SUMAN a los derivados de los perfiles en disco.
# Sigue existiendo porque hay literales que no salen de ningún perfil: el
# nombre de un repo privado, un producto interno, un alias antiguo.
BRAND_DENYLIST = ROOT / 'scripts' / 'brand-denylist.txt'
# Gemelo local e ignorado por git: aquí van los términos que no pueden viajar
# al repo público. Ver manual_terms().
BRAND_DENYLIST_LOCAL = ROOT / 'scripts' / 'brand-denylist.local.txt'

# --- derivación automática desde los perfiles en disco -----------------------
#
# El fichero manual protegía contra la marca #1 y NO EXISTÍA para la marca #2
# hasta que alguien recordara darla de alta. Un paso manual que nada obliga no
# es una garantía; es un procedimiento recordado — el mismo modo de fallo que
# dejó pasar la fuga original (la regla en prosa ya estaba escrita).
#
# Así que los términos se leen de los perfiles REALES que hay en disco. Un
# perfil real es una carpeta bajo profiles/ que no es `example*`: los `example*`
# son marcas ficticias, publicables y trackeadas, y si aportaran términos el
# gate se bloquearía a sí mismo con su propio contenido de onboarding.

# Longitud mínima de un término derivado.
#
# 4 caracteres. Es el umbral más bajo que no genera falsos positivos masivos:
# con 3 entran siglas y fragmentos ("AI", "cl", "Rol") que aparecen en prosa
# genérica constantemente, y un `re.search` sin frontera de palabra los
# encontraría dentro de otras palabras. Con 4 el término más corto plausible de
# una marca real ("Nike", "Uber") sigue entrando. Un slug de 2-3 letras existe,
# pero es exactamente el caso en que hay que declararlo a mano en
# brand-denylist.txt con el contexto que lo hace único, no derivarlo a ciegas.
MIN_TERM_LENGTH = 4

# Palabras demasiado comunes para bloquear por sí solas.
#
# Mitigación de falsos positivos: si un perfil declara la ciudad "Santiago" o
# un wordmark que es una palabra corriente ("Norte", "Plaza", "Studio"), el
# término derivado bloquearía commits legítimos del motor — y peor, empujaría a
# desactivar el gate. Estas se descartan de la derivación; si de verdad hay que
# vigilarlas para una marca concreta, se declaran a mano en brand-denylist.txt,
# que es donde un humano puede asumir el coste con contexto.
GENERIC_WORDS = {
    # ciudades/regiones frecuentes en documentación y ejemplos
    'santiago', 'chile', 'madrid', 'barcelona', 'lima', 'bogota', 'bogotá',
    'mexico', 'méxico', 'buenos aires', 'london', 'berlin', 'paris',
    'new york', 'ciudad', 'city', 'region', 'región',
    # palabras que un wordmark puede ser y el motor usa como vocabulario
    'brand', 'marca', 'studio', 'design', 'content', 'media', 'group',
    'digital', 'agency', 'personal', 'norte', 'sur', 'este', 'oeste',
    'plaza', 'centro', 'local', 'example', 'demo', 'test', 'default',
    'profile', 'perfil', 'system', 'carousel', 'carrusel', 'week',
    'semana', 'events', 'eventos', 'panoramas',
}

# TLDs que se recortan al derivar el nombre base de un dominio.
KNOWN_TLDS = (
    '.com', '.cl', '.net', '.org', '.io', '.dev', '.app', '.co', '.ai',
    '.es', '.mx', '.ar', '.pe', '.me', '.xyz', '.cl.com',
)

HANDLE = re.compile(r'@([A-Za-z0-9._]{3,30})\b')


def _is_public_profile(name: str) -> bool:
    return name == 'example' or name.startswith('example-')


def real_profile_dirs() -> list[Path]:
    """Perfiles reales en disco. Vacío en un clon recién hecho — no crashea."""
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(
        path for path in PROFILES_DIR.iterdir()
        if path.is_dir() and not _is_public_profile(path.name)
    )


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _yaml_scalar(text: str, key: str) -> list[str]:
    """Extrae `key: valor` de un YAML sin dependencias externas.

    A propósito no se usa PyYAML: el gate corre en un pre-commit hook y no
    puede depender de que el entorno tenga instalado un paquete. Si falta, la
    derivación se degradaría a silencio — que es el fallo que esto elimina.
    """
    pattern = re.compile(rf'^\s*{re.escape(key)}\s*:\s*(.+?)\s*$', re.MULTILINE)
    out = []
    for raw in pattern.findall(text):
        value = raw.split('#')[0].strip().strip('\'"')
        if value:
            out.append(value)
    return out


def _yaml_list(text: str, key: str) -> list[str]:
    """Extrae los ítems `- x` del bloque de lista que sigue a `key:`."""
    out = []
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.match(rf'^\s*{re.escape(key)}\s*:\s*$', line):
            continue
        indent = len(line) - len(line.lstrip())
        for candidate in lines[index + 1:]:
            if not candidate.strip():
                continue
            candidate_indent = len(candidate) - len(candidate.lstrip())
            item = candidate.strip()
            if candidate_indent <= indent or not item.startswith('- '):
                break
            value = item[2:].split('#')[0].strip().strip('\'"')
            if value:
                out.append(value)
    return out


def _domain_terms(domain: str) -> list[str]:
    """`ejemplo.cl` → el dominio completo y su nombre base.

    El nombre base importa porque en prosa la marca aparece sin el TLD; el
    dominio completo importa porque una URL de API lo lleva entero.
    """
    domain = domain.strip().strip('/').lower()
    domain = re.sub(r'^[a-z]+://', '', domain).split('/')[0]
    if not domain or '.' not in domain:
        return [domain] if domain else []
    terms = [domain]
    # Nombre base: la etiqueta anterior al TLD, no el subdominio. Para un TLD
    # de dos niveles (`.cl.com`, `.co.uk`) hay que retroceder una etiqueta más,
    # o el "nombre" sería el propio sufijo público.
    labels = domain.split('.')
    stripped = domain
    for tld in sorted(KNOWN_TLDS, key=len, reverse=True):
        if stripped.endswith(tld):
            stripped = stripped[: -len(tld)]
            break
    base = stripped.split('.')[-1] if stripped else (labels[-2] if len(labels) > 1 else labels[0])
    if base:
        terms.append(base)
    return terms


def derive_terms() -> dict[str, set[str]]:
    """{término: {procedencia, …}} derivado de los perfiles reales en disco.

    Devuelve {} si no hay ningún perfil real (clon recién hecho): la derivación
    aporta cero términos y el fichero manual sigue gobernando.
    """
    derived: dict[str, set[str]] = {}

    def add(value, origin: str) -> None:
        if not isinstance(value, str):
            return
        term = value.strip()
        if len(term) < MIN_TERM_LENGTH or term.lower() in GENERIC_WORDS:
            return
        derived.setdefault(term, set()).add(origin)

    for profile in real_profile_dirs():
        slug = profile.name
        where = f'profiles/{slug}/'
        add(slug, f'{where} (slug)')

        brand = _load_json(profile / 'brand.json')
        if isinstance(brand, dict):
            copy = brand.get('copy')
            if isinstance(copy, dict):
                add(copy.get('wordmark'), f'{where}brand.json copy.wordmark')
                site = copy.get('site')
                if isinstance(site, str):
                    for term in _domain_terms(site):
                        add(term, f'{where}brand.json copy.site')
            hosts = brand.get('sourceImageHosts')
            if isinstance(hosts, list):
                for host in hosts:
                    if isinstance(host, str):
                        for term in _domain_terms(host):
                            add(term, f'{where}brand.json sourceImageHosts')

        config = profile / 'config.yaml'
        if config.is_file():
            try:
                text = config.read_text(encoding='utf-8')
            except OSError:
                text = ''
            for tag in _yaml_list(text, 'default_hashtags'):
                add(tag.lstrip('#'), f'{where}config.yaml default_hashtags')
            for value in _yaml_scalar(text, 'name'):
                add(value, f'{where}config.yaml profile.name')

        for recipe in sorted(profile.glob('recipes/*.yaml')):
            try:
                text = recipe.read_text(encoding='utf-8')
            except OSError:
                continue
            rel = f'{where}recipes/{recipe.name}'
            for value in _yaml_scalar(text, 'city'):
                add(value, f'{rel} defaults.city')
            for value in _yaml_scalar(text, 'url'):
                for term in _domain_terms(value):
                    add(term, f'{rel} source.url')

        for carousel in sorted(profile.glob('carousels/*.json')):
            data = _load_json(carousel)
            if isinstance(data, dict):
                add(data.get('city'), f'{where}carousels/{carousel.name} city')

        # @handle: puede estar en cualquier texto del perfil (skills, spec,
        # config). Se busca en los ficheros de texto, no en un campo fijo,
        # porque el esquema no tiene un lugar declarado para él.
        for path in sorted(profile.rglob('*')):
            if not path.is_file() or path.suffix not in {'.md', '.yaml', '.yml', '.json'}:
                continue
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            for handle in HANDLE.findall(text):
                if '.' in handle or handle.lower() in GENERIC_WORDS:
                    continue  # emails, versiones de fuentes, @400;600
                add(handle, f'{where}… (@handle)')

    return derived


def manual_terms() -> dict[str, set[str]]:
    """Términos declarados a mano, de los dos archivos manuales.

    Son dos y no uno por una razón que solo aparece al publicar: para prohibir
    una palabra hay que escribirla, así que el denylist *es* la lista literal
    de todo lo que se quiso ocultar. Publicarlo entrega exactamente eso — el
    nombre de un repo privado ahí dentro llegó a decir "no debe aparecer en el
    repo público" mientras estaba en el repo público.

    Así que el trackeado (`brand-denylist.txt`) lleva solo lo publicable, y lo
    sensible va al local (`brand-denylist.local.txt`), que está en .gitignore.
    Las dos listas se suman, y una ausente no es error: un clon nuevo funciona
    con la derivación desde `profiles/<slug>/` y con la lista pública.
    """
    out: dict[str, set[str]] = {}
    for path in (BRAND_DENYLIST, BRAND_DENYLIST_LOCAL):
        if not path.exists():
            continue
        label = path.relative_to(ROOT)
        for line in path.read_text(encoding='utf-8').splitlines():
            term = line.strip()
            if term and not term.startswith('#'):
                out.setdefault(term, set()).add(f'{label} (manual)')
    return out


def denylist_with_origins() -> dict[str, set[str]]:
    """Manuales + derivados. Un término puede tener varias procedencias.

    Se colapsa por minúsculas porque la búsqueda es case-insensitive: mantener
    "Marca" y "marca" como entradas separadas duplicaría cada hallazgo y
    haría ilegible el informe de procedencias sin vigilar nada más.
    """
    combined: dict[str, set[str]] = {}
    index: dict[str, str] = {}
    for source in (manual_terms(), derive_terms()):
        for term, origins in source.items():
            key = term.lower()
            canonical = index.setdefault(key, term)
            combined.setdefault(canonical, set()).update(origins)
    return combined

# `as VerifiedSlide` afirma la marca de verificación sin pasar por el guard.
# TypeScript permite el cast en un solo paso porque VerifiedSlide es subtipo de
# Slide, así que el compilador NO puede impedirlo — y no hace falta mala fe: es
# lo que uno escribe cuando el compilador dice "Slide[] no es asignable a
# VerifiedSlide[]". Solo verify-slides.ts tiene por qué acuñarla.
VERIFIED_CAST = re.compile(r'\bas\s+(?:unknown\s+as\s+)?VerifiedSlide\b')
VERIFIED_CAST_HOME = 'system/ig-carousel/verify-slides.ts'
# El archivo de pruebas de tipos afirma el cast a propósito, para que el límite
# quede asertado y no solo descrito. Un check que castigue documentar el problema
# empuja a borrar la documentación, que es lo contrario de lo que se busca.
VERIFIED_CAST_DOCS = 'system/ig-carousel/render-batch.types.test.ts'

# Una negación en .gitignore es como se colaron los perfiles reales al repo:
# gana silenciosamente sobre cualquier regla escrita en prosa.
#
# `/?` porque `!/profiles/<marca>/` es gitignore válido con el mismo efecto, y
# `(?![^/]*)` ancla la excepción al segmento completo: `!profiles/exampleEVIL/`
# no es el perfil de ejemplo y no debe pasar por empezar igual.
GITIGNORE_NEGATION = re.compile(r'^\s*!\s*/?profiles/(?!example(?:-personal)?/)')


def git(*args: str) -> str:
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def denylist() -> list[str]:
    return sorted(denylist_with_origins(), key=str.lower)


def staged_blob(path: str) -> str | None:
    """Contenido tal como quedaría commiteado, no el del working tree."""
    try:
        return subprocess.check_output(
            ['git', 'show', f':{path}'], cwd=ROOT, text=True, errors='replace',
            stderr=subprocess.DEVNULL,  # un borrado es caso normal, no un error
        )
    except subprocess.CalledProcessError:
        return None  # borrado del índice


def check_brand_leaks(staged_files: list[str]) -> list[str]:
    """Literales de marca en la capa genérica.

    Determinista a propósito: el gate ya existía cuando ocurrieron las fugas
    de este repo y no las detuvo, porque todo el juicio sobre qué era seguro
    estaba delegado a la revisión de un agente. Esto no depende de criterio.
    """
    origins = denylist_with_origins()
    if not origins:
        return []
    pattern = re.compile(
        '|'.join(re.escape(t) for t in sorted(origins, key=len, reverse=True)),
        re.IGNORECASE,
    )
    leaks = []
    for path in staged_files:
        if not path.startswith(GENERIC_PREFIXES):
            continue
        blob = staged_blob(path)
        if blob is None:
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            hit = pattern.search(line)
            if hit:
                # Se nombra el término Y su procedencia: si no, un bloqueo por
                # un término derivado es indistinguible de un bug del gate y
                # nadie sabe qué archivo del perfil lo originó.
                leaks.append(
                    f'{path}:{number}: {line.strip()[:80]}\n'
                    f'      ↳ término "{hit.group(0)}" — '
                    f'{describe_origin(hit.group(0), origins)}'
                )
    return leaks


def describe_origin(matched: str, origins: dict[str, set[str]]) -> str:
    """De dónde salió el término que hizo match (case-insensitive)."""
    for term, where in origins.items():
        if term.lower() == matched.lower():
            return '; '.join(sorted(where))
    return 'procedencia desconocida'


def check_private_profiles(staged_files: list[str], *, tracked: bool = False) -> list[str]:
    """Archivos de un perfil real que entrarían al repo.

    Un borrado NO es violación: sacar un perfil real del árbol es exactamente
    la operación que este check quiere favorecer. Sin esta distinción el gate
    se bloquea a sí mismo justo cuando alguien hace lo correcto.
    """
    candidates = [
        path for path in staged_files
        if path.startswith('profiles/')
        and not path.startswith(PUBLIC_PROFILE_PREFIX)
    ]
    if tracked:
        # Modo --scan: la lista viene de `git ls-files -co`, así que incluye
        # archivos nuevos que no están en el índice. Se comprueba en disco.
        return [path for path in candidates if (ROOT / path).exists()]
    return [path for path in candidates if staged_blob(path) is not None]


def check_verified_casts(staged_files: list[str]) -> list[str]:
    """Casts que fabrican la marca de verificación fuera de su único dueño.

    El guard de pre-render es una garantía del compilador, y este es el hueco
    que el compilador no puede cerrar solo. Un check textual sí puede.
    """
    findings = []
    for path in staged_files:
        if path in (VERIFIED_CAST_HOME, VERIFIED_CAST_DOCS) or not path.endswith('.ts'):
            continue
        blob = staged_blob(path)
        if blob is None:
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            # Solo código: una línea de comentario que *menciona* el cast está
            # explicando por qué existe el check, no fabricando la marca.
            if line.lstrip().startswith(('*', '//', '/*')):
                continue
            if VERIFIED_CAST.search(line):
                findings.append(f'{path}:{number}: {line.strip()[:80]}')
    return findings


def check_gitignore_negations(staged_files: list[str]) -> list[str]:
    """Ataca la causa raíz en su forma general.

    Sin esto, un `!profiles/<marca>/` vuelve a hacer trackeable un perfil
    real y los otros dos checks quedan sin efecto para los archivos que ese
    perfil añada después.
    """
    if '.gitignore' not in staged_files:
        return []
    blob = staged_blob('.gitignore') or ''
    return [
        f'.gitignore:{number}: {line.strip()}'
        for number, line in enumerate(blob.splitlines(), 1)
        if GITIGNORE_NEGATION.match(line)
    ]


# Asked of git rather than hardcoded as `ROOT/.git`, because in a linked
# worktree `.git` is a *file* pointing at the real gitdir
# (…/.git/worktrees/<name>), not a directory — so the hardcoded path could
# never exist there and the gate rejected every commit made from a worktree,
# no matter how it had been reviewed. post-commit already resolves it this
# way; this keeps the two halves of the gate agreeing on one location.
#
# `--absolute-git-dir`, not `--git-dir`: the latter answers a bare relative
# ".git" in an ordinary clone, which `Path` would then resolve against the
# process's cwd instead of the repository — letting a stray `.git/` in some
# subdirectory supply the approval. Anchoring it absolutely keeps the lookup
# tied to this repository wherever the script is invoked from.
APPROVAL = Path(git('rev-parse', '--absolute-git-dir')) / 'commit-guardian-approval.json'


def fail(message: str) -> int:
    print(f'commit-gate: {message}', file=sys.stderr)
    return 1


def scan_tree() -> int:
    """`--scan`: audita el árbol actual Y el historial local.

    El gate solo ve lo que se está commiteando. Esto responde las otras dos
    preguntas, que son distintas y hay que reportar por separado:

      1. ¿el árbol de HOY está limpio?  → lo que se publicaría al hacer push
      2. ¿el HISTORIAL local está limpio? → un árbol limpio con commits sucios
         detrás sigue publicando la marca si se pushea el historial completo

    Auditar solo (1) es peor que no auditar: imprime "publicable" mientras
    los commits siguen ahí.
    """
    origins = denylist_with_origins()
    terms = sorted(origins, key=str.lower)
    if not terms:
        print(
            'commit-gate: no hay términos que buscar — scripts/brand-denylist.txt '
            'está vacío o ausente y no hay ningún perfil real en profiles/',
            file=sys.stderr,
        )
        return 1
    pattern = re.compile(
        '|'.join(re.escape(t) for t in sorted(terms, key=len, reverse=True)),
        re.IGNORECASE,
    )

    # --- (0) de dónde sale cada término ---
    # Se imprime ANTES de los hallazgos: sin esto, un bloqueo por un término
    # derivado es opaco y el humano no puede decidir si es una fuga real o un
    # falso positivo que hay que mitigar.
    print('TÉRMINOS VIGILADOS (y de dónde salen)')
    for term in terms:
        print(f'  {term}')
        for origin in sorted(origins[term]):
            print(f'      ← {origin}')
    profiles = real_profile_dirs()
    print(
        f'  {len(terms)} término(s): derivados de {len(profiles)} perfil(es) real(es) '
        f'en disco + los manuales de scripts/brand-denylist.txt'
    )
    if not profiles:
        print('  (ningún perfil real en profiles/ — solo gobiernan los términos manuales)')
    print()

    # --- (1) árbol actual ---
    # `-co --exclude-standard`: trackeados MÁS los nuevos sin trackear que no
    # están ignorados. Con solo `ls-files` el scan no veía el trabajo en curso
    # y reportaba "ok" con una fuga viva en disco — el mismo falso verde que
    # este script existe para eliminar, un nivel más arriba. Los ignorados
    # quedan fuera a propósito: ahí viven los perfiles reales.
    tracked = sorted(filter(None, git('ls-files', '-co', '--exclude-standard').splitlines()))
    leaks = []
    for path in tracked:
        if not path.startswith(GENERIC_PREFIXES):
            continue
        try:
            blob = (ROOT / path).read_text(encoding='utf-8', errors='replace')
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(blob.splitlines(), 1):
            hit = pattern.search(line)
            if hit:
                leaks.append(
                    f'{path}:{number}: {line.strip()[:100]}\n'
                    f'          ↳ término "{hit.group(0)}" — '
                    f'{describe_origin(hit.group(0), origins)}'
                )

    tree_findings = [
        ('brand literals in the generic layers (%s)' % ', '.join(GENERIC_PREFIXES), leaks),
        ('real profile files tracked', check_private_profiles(tracked, tracked=True)),
        ('.gitignore negations', [
            f'.gitignore:{number}: {line.strip()}'
            for number, line in enumerate(
                (ROOT / '.gitignore').read_text(encoding='utf-8').splitlines(), 1)
            if GITIGNORE_NEGATION.match(line)
        ] if (ROOT / '.gitignore').exists() else []),
    ]

    print('ÁRBOL ACTUAL (lo que se publicaría al hacer push)')
    for title, items in tree_findings:
        print(f'  {"FAIL" if items else "ok  "}  {title} ({len(items)})')
        for item in items:
            print(f'          {item}')
    tree_total = sum(len(items) for _, items in tree_findings)

    # --- (2) historial local ---
    # `git log -S<term>` recorre todos los refs y encuentra los commits que
    # introdujeron o quitaron el término. Un árbol limpio no dice nada sobre
    # esto: los commits siguen ahí y un push los publica.
    print()
    print('HISTORIAL LOCAL (commits que contienen la marca)')
    history: dict[str, list[str]] = {}
    for term in terms:
        try:
            found = git('log', '--all', '--oneline', '-i', f'-S{term}').splitlines()
        except subprocess.CalledProcessError:
            found = []
        for line in filter(None, found):
            history.setdefault(line, []).append(term)

    pushed = set()
    for line in history:
        sha = line.split()[0]
        try:
            if git('branch', '-r', '--contains', sha).strip():
                pushed.add(sha)
        except subprocess.CalledProcessError:
            pass

    if history:
        print(f'  FAIL  {len(history)} commit(s) contienen términos de la denylist')
        for line, hits in sorted(history.items()):
            sha = line.split()[0]
            mark = ' [YA EN UN REMOTO]' if sha in pushed else ''
            print(f'          {line[:80]}  ({", ".join(sorted(set(hits)))}){mark}')
        print()
        if pushed:
            print(f'  {len(pushed)} de esos commits YA están en un remoto — eso sí es una fuga')
            print('  consumada; borrarlos del árbol no los saca de ahí.')
        else:
            print('  Ninguno está en un remoto todavía: NO hay fuga publicada. Es higiene')
            print('  previa. Publicar por squash sobre una base limpia evita arrastrarlos.')
    else:
        print('  ok    ningún commit local contiene términos de la denylist')

    # --- alcance ---
    print()
    print('ALCANCE DE ESTA AUDITORÍA — lo que NO cubre:')
    print(f'  · Solo busca los {len(terms)} término(s) listados arriba. Los derivados')
    print('    aparecen solos al poner un perfil en profiles/<slug>/ — dar de alta')
    print('    una marca ya NO requiere editar el denylist a mano. Lo que la')
    print('    derivación no ve sí hay que declararlo ahí: alias antiguos, nombres')
    print('    de repos privados, o un slug de menos de')
    print(f'    {MIN_TERM_LENGTH} caracteres (se descarta por generar falsos positivos).')
    print('  · Términos genéricos (ciudades muy comunes, wordmarks que son palabras')
    print('    corrientes) se descartan a propósito para no bloquear el motor; si')
    print('    una marca los necesita, van a mano en el denylist.')
    print('  · No detecta negocio sin nombrar la marca (criterio editorial, copy,')
    print('    una paleta) — eso requiere lectura humana.')
    print('  · No audita archivos binarios ni no-trackeados.')

    total = tree_total + len(history)
    print()
    if total == 0:
        print('árbol e historial limpios para los términos conocidos')
    else:
        print(f'{tree_total} en el árbol + {len(history)} commit(s) en historial — revisar antes de publicar')
    return 1 if total else 0


def main() -> int:
    if '--scan' in sys.argv[1:]:
        return scan_tree()

    if not APPROVAL.exists():
        return fail(f'missing {APPROVAL}; run commit-guardian review first')

    try:
        approval = json.loads(APPROVAL.read_text())
    except Exception as exc:
        return fail(f'invalid approval file: {exc}')

    required = ['version', 'reviewer', 'safe_to_commit', 'staged_tree', 'allowed_files', 'forbidden_files']
    missing = [key for key in required if key not in approval]
    if missing:
        return fail(f'approval file missing keys: {", ".join(missing)}')

    if approval['reviewer'] != 'commit-guardian':
        return fail('approval reviewer must be commit-guardian')

    if approval['version'] != 1:
        return fail('unsupported approval version')

    if approval['safe_to_commit'] is not True:
        return fail('commit-guardian did not approve this commit')

    current_tree = git('write-tree')
    if current_tree != approval['staged_tree']:
        return fail('staged files changed after approval; re-run commit-guardian review')

    staged_files = sorted(filter(None, git('diff', '--cached', '--name-only').splitlines()))
    allowed_files = sorted(approval['allowed_files'])
    forbidden_files = approval['forbidden_files']

    if forbidden_files:
        return fail(f'approval still contains forbidden files: {", ".join(forbidden_files)}')

    if staged_files != allowed_files:
        return fail('staged files do not exactly match approved allowed_files set')

    # An approval is single-use. After a commit lands, the index still equals
    # the tree that was just committed, so `staged_tree` keeps matching and
    # `git diff --cached` goes empty — an empty commit or an amend would then
    # satisfy every check above on a review nobody re-issued. post-commit
    # deletes the approval, but that hook can be skipped or fail, so refuse
    # here too rather than depending on it.
    if not staged_files:
        return fail('nothing staged; this approval was already used — re-run commit-guardian review')

    # Los tres checks de abajo son deterministas y NO los puede aprobar
    # commit-guardian: son precisamente el tipo de fuga que una revisión por
    # criterio dejó pasar diez veces en este repo.
    negations = check_gitignore_negations(staged_files)
    if negations:
        return fail(
            'a .gitignore negation would make a real profile trackable; only '
            'profiles/example* is public (see CLAUDE.md):\n  '
            + '\n  '.join(negations)
        )

    private = check_private_profiles(staged_files)
    if private:
        return fail(
            'real profile files staged; a real profile lives outside the repo '
            'tree, only profiles/example* is public:\n  ' + '\n  '.join(private)
        )

    casts = check_verified_casts(staged_files)
    if casts:
        return fail(
            'a cast fabricates the VerifiedSlide mark outside verify-slides.ts — call '
            'verifyOrThrow() instead; the mark exists so unverified slides cannot be '
            'rendered:\n  ' + '\n  '.join(casts)
        )

    leaks = check_brand_leaks(staged_files)
    if leaks:
        return fail(
            'brand literals in the generic layers — parameterize them as '
            '<marca>/<ciudad>/<slug> (see CLAUDE.md):\n  ' + '\n  '.join(leaks)
        )

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
