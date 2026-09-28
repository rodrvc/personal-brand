---
name: usar-perfil
description: >-
  Resolve which brand profile a request is about and load its business rules
  before doing any content work in this repo. Use FIRST — before generating,
  rendering, curating or writing anything for a brand — whenever a request
  names a brand or profile ("hazme el carrusel de X", "un reel de X", "el post
  de X"), or asks for branded content without naming one. Also use when a
  profile, a brand, a skill or a recipe "does not exist" or cannot be found:
  profiles are gitignored and carry their own skills, so a missing profile is
  usually a discovery problem, not a missing file.
---

# Usar un perfil

Esta skill existe porque **las reglas de negocio de una marca no están en este
repo**. Están dentro de la carpeta de la marca, y esa carpeta está ignorada por
git. Si no las buscas, no las ves — y terminas inventando criterio que ya
estaba decidido.

## La arquitectura en una frase

El repo es el **motor**. La carpeta del perfil es el **negocio**, y trae sus
propias skills adentro.

```
system/              motor: render, schema, contratos      ← genérico
system/recipes/      flujos por tipo de contenido          ← genérico
.claude/skills/      orquestadores                         ← genérico
profiles/<slug>/     LA MARCA: tokens, config, recipes,
                     y sus propias skills de negocio       ← ignorado por git
```

**Regla:** si algo sirve igual para otra marca, va en el motor. Si es propio de
una marca, va en su perfil. Al mover una cosa, esa es la única pregunta.

## Paso 1 — Resolver de qué perfil se trata

En este orden; el primero que aplique gana:

1. **Explícito** — el usuario nombró la marca, o pasó `--profile`
2. **`cwd`** dentro de `profiles/<slug>/`
3. **`default_profile`** en `.claude/repo.yaml` si existe (archivo local, no
   trackeado)
4. **Si hay exactamente un perfil real** en `profiles/` (ignorando los
   `example*`), ese
5. **Si no → PREGUNTAR**, listando los slugs que encontraste

```bash
ls profiles/            # los example* son plantillas ficticias, no marcas
```

**Regla dura:** anuncia el perfil resuelto y por qué, en una línea, **antes de
escribir, descargar o renderizar nada**:

> Uso el perfil `<slug>` (único perfil real en `profiles/`).

**Sin inferencia semántica.** "Habló de eventos, entonces debe ser tal marca"
no es resolución válida. Preguntar de más es gratis; renderizar con la marca
equivocada, en silencio, y que se publique, no lo es.

## Paso 1.5 — Sincronizar con el bucket, si aplica

Cuando el editor corre contra un bucket (`STORAGE_BACKEND=s3`, sea en el
`.env` de la raíz del repo o exportado en el shell — el shell gana si está en
ambos lados), el perfil vive ahí y no en el filesystem local: hay que traerlo antes de leer
cualquier archivo suyo. Ejecuta esto siempre, **antes** de leer `profile.md`,
`brand.json`, las skills del perfil o cualquier otra cosa bajo
`profiles/<slug>/` — encadenado en el mismo comando de shell que lo usa, las
variables no sobreviven entre llamadas de shell separadas:

```bash
npx tsx editor/server/scripts/profile-sync.ts pull --profile <slug> \
  && eval "$(npx tsx editor/server/scripts/profile-sync.ts env)"
```

Con backend `fs` (el default, sin configurar nada) esto es **no-op**: el CLI
lo detecta solo, imprime que no hay nada que sincronizar y sale en 0 — se
invoca siempre, sin preguntar antes qué backend está activo.

Con backend `s3`, `pull` trae al mirror local los archivos "eager" del
perfil, y el `eval` apunta `BRAND_PROFILES_DIR`/`BRAND_OUTPUTS_ROOT` a ese
mirror — desde ahí, cada ruta `profiles/<slug>/...` de esta skill (y de
`system/`) se resuelve contra el mirror, sin que ningún path cambie. Un
archivo grande ya renderizado (algo bajo `outputs/`/`reels/`) puede no bajar
en el `pull`: si hace falta uno puntual, usa

```bash
npx tsx editor/server/scripts/profile-sync.ts fetch --profile <slug> --path <ruta-relativa>
```

**Repite el `eval` en cada llamada de shell nueva** que necesite
`BRAND_PROFILES_DIR`/`BRAND_OUTPUTS_ROOT`: encadénalo con `&&` en el mismo
comando en vez de asumir que ya quedó exportado desde una llamada anterior.

Al terminar de escribir (drafts, el input del carrusel/reel, o renders), la
skill que orquesta el flujo hace el `push` correspondiente — ver
`generar-carrusel-semana` / `generar-reel-semana`. Esta skill solo resuelve y
trae; no sube nada por sí sola.

## Paso 2 — Cargar las reglas de esa marca

Lee lo que exista, en este orden. **Las skills del perfil son lo más
importante y lo que más se olvida:**

| Qué | Dónde | Qué te da |
|---|---|---|
| **Skills de negocio** | `profiles/<slug>/skills/*/SKILL.md` | el criterio propio de la marca: qué contenido sirve, tono, reglas de producto ya decididas |
| Recipes | `profiles/<slug>/recipes/*.yaml` | parametrización declarativa: fuente de datos, filtros, conteos |
| Tokens | `profiles/<slug>/brand.json` | colores, fuentes, categorías, copy |
| Spec de marca | `profiles/<slug>/brand-spec.md` | las decisiones de marca y de dónde salieron |
| Config | `profiles/<slug>/config.yaml` (+ `config.local.yaml`) | operativa: hashtags, rutas de salida |

```bash
ls profiles/<slug>/skills/     # ¿la marca trae skills propias?
```

Si el perfil tiene una skill para lo que te pidieron, **esa manda sobre
cualquier criterio genérico**. Si el perfil no la tiene, no improvises su
criterio de negocio ni lo copies de otra marca: dilo y ofrece definirlo.

## Paso 3 — Ejecutar

La skill del perfil apunta al recipe genérico correspondiente en
`system/recipes/`, que define las etapas y su orden. El perfil llena huecos; no
inventa etapas ni reordena el pipeline.

## Si un perfil "no existe"

Casi siempre es un problema de descubrimiento, no un archivo faltante:

1. `ls profiles/` — está en disco pero **git lo ignora**, así que no aparece en
   `git status` ni en un `git ls-files`. Eso es intencional.
2. `ls profiles/<slug>/skills/` — la skill de negocio puede estar acá y no en
   `.claude/skills/`.
3. Si de verdad no está: la carpeta del perfil es la unidad transportable
   completa. Se copia desde donde el usuario la tenga; no se reconstruye a
   mano.

## Los datos de una marca nunca vuelven al motor

`system/` y `.claude/` no pueden contener el nombre de una marca, su dominio,
su @handle, sus hashtags, su ciudad ni su taxonomía. Ver `CLAUDE.md` →
"Motor vs negocio". El commit gate lo verifica de forma determinista:

```bash
python3 scripts/validate_commit_guardian.py --scan
```

Y al dar de alta una marca nueva, agrega sus literales a
`scripts/brand-denylist.txt` — es lo que evita que se filtren después.
