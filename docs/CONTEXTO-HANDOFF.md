# Handoff — motor de reels agnóstico

> **Lee esto entero antes de tocar nada.** El trabajo del issue original está
> terminado y publicado en un PR. Lo que queda son tres frentes abiertos, y
> uno de ellos (el conflicto del PR) te va a morder si lo resuelves a la
> ligera.

---

## En una línea

El repo `personal-brand` se publica para que otras personas lo usen con sus
marcas. Esta tanda portó el prototipo de reels a un motor genérico
(`system/ig-reel/`) y limpió lo que impedía publicar. **`main` ya es público.**

---

## Estado: qué está hecho

Los 7 pasos del plan original están cerrados. Seis commits en la rama
`rodrvc/separacion-perfiles-motor-reels`:

| Commit | Qué |
|---|---|
| `6b3d909` | Motor `system/ig-reel/` + perfil de ejemplo + caché de red |
| `6395d11` | Skill `generar-reel-semana` (el orquestador genérico) |
| `99c57e7` | `public-repo-rules.md`: un perfil es input no confiable |
| `2d5ee43` | El denylist ya no publica lo que oculta |
| `676540e` | Saca del tracking un borrador de contenido personal |
| `b1e77d9` | El commit gate audita `app/` y `core/`, no solo dos capas |
| `7dbf24c` | La frontera entre `brand.yaml` y `brand.json` |

**Verificado, no asumido:**

- `npm run check` → 41/41 + 33/33
- `validate_commit_guardian.py --scan` → 0 hallazgos en el árbol
- **Transportabilidad**: `profiles/example` (otra ciudad, otro idioma, otra
  paleta) renderiza un reel **sin editar `system/` ni `.claude/`**
- **La skill se explica sola**: un agente sin contexto, en un checkout limpio
  con caché vacío, la leyó y produjo un MP4 válido sin tocar el motor

---

## Los tres frentes abiertos

### 1. El PR #4 tiene conflictos — NO lo resuelvas "con mi versión"

https://github.com/rodrvc/personal-brand/pull/4 · rama `rodrvc/publicable`

`main` avanzó con el **PR #3** (una app de escritorio Tauri para editar
afiches, 8641 líneas) mientras esto se hacía. El squash se hizo sobre una base
que quedó vieja.

Un revisor analizó el choque. Lo esencial:

| Archivo | Veredicto |
|---|---|
| `CLAUDE.md` | **Auto-mergea.** Las reglas de ambos se refuerzan, no chocan |
| `.gitignore` | Complementario: unión simple |
| `system/config/brand.schema.md` | Edición deliberada, no un conflicto a elegir |

**El error caro sería `checkout --ours`.** Descartaría el bloque de
arquitectura del PR #3 sin ninguna necesidad. Lista de lo que no debe perderse:

1. El encabezado de `CLAUDE.md` con las 3 reglas y los punteros a
   `docs/ARQUITECTURA.md` y `app/ESTADO.md`
2. `.gitignore`: `app/src/core/`, `app/src-tauri/target/`, `app/src-tauri/gen/`
   — sin esto un `cargo build` ensucia el repo
3. En `brand.schema.md`: la sección `brand.yaml` completa, sobre todo el bloque
   `logo` y `canvas_scheme`, que no tienen equivalente del lado motor
4. `profiles/example/brand.yaml`, `content/drafts/`, `content/published/`
5. Todo `app/`, `core/`, `docs/ARQUITECTURA.md`, `docs/spike-satori.md`

### 2. El mapa se ve escalonado

Worktree **`arreglar-mar-mapa`** (rama `rodrvc/arreglar-mar-mapa`), trabajando.

El relleno del mar se rasteriza en celdas y al zoom 2.4× del reel se ven
escalones. Su brief lleva los cuatro intentos que ya fallaron.

**Advertencia sobre ese worktree:** en su última revisión tenía 43 tests en
verde **con el bug presente** — sus puntos de prueba no caían sobre las
franjas defectuosas. Si retomas eso, primero haz fallar el test.

### 3. Nombres largos en el mapa

En una ciudad con nombres oficiales largos las etiquetas se encabalgan. Sin
asignar. La vía sin listar lugares por ciudad es acortar con reglas genéricas
en el motor.

---

## Lo que hay que saber para no repetir errores

### Las fugas de este repo están en la prosa, no en el código

Cuatro fugas se atraparon en esta tanda. **Ninguna estaba en TypeScript:**

- `docs/PLAN-skills-agnosticas.md` nombraba marca, host de API y ciudad 15 veces
- La descripción de una skill usaba vocabulario de una marca como frase de disparo
- **`scripts/brand-denylist.txt` era la fuga que previene**: para prohibir una
  palabra hay que escribirla. Contenía la marca, la ciudad y el nombre de un
  repo privado — este último justo bajo el comentario "no debe aparecer en el
  repo público". Ahora lo sensible vive en `brand-denylist.local.txt`,
  gitignored, y el validador suma ambos.
- Un borrador de LinkedIn con audiencia, objetivo, CTA y posicionamiento

Los chequeos deterministas vigilan **términos de marca**. No ven contenido
personal ni categorías nuevas de dato sensible. **Audita a mano antes de
publicar.**

### El commit gate

Ningún commit pasa sin aprobación previa. Ver `docs/commit-gate.md`. La
aprobación es de un solo uso.

### Overpass se cae seguido

El motor pide datos a OpenStreetMap y ese servicio falla a menudo (504, HTML
en vez de JSON). **Hay caché en disco** (`.cache/`): la segunda corrida de la
misma semana no hace ni un request. No entres en bucles de reintentos: el
motor ya reintenta con espera y usa una entrada vencida si la red muere,
anunciándolo.

### Errores de método que costaron caro en esta sesión

Están documentados para que no se repitan:

- **Iterar a ciegas mirando frames renderizados.** El relleno del mar se
  rehizo cuatro veces así. Lo que lo destrabó fue cachear los datos y escribir
  una sonda punto-a-punto: el diagnóstico salió en dos minutos.
- **Un test verde que no prueba lo que crees.** Un test de etiquetas
  superpuestas pasaba mientras el video mostraba dos textos encimados — el
  solape real estaba en otra capa que el test no veía.

---

## Decisiones que son de Rodrigo, no tuyas

1. **Mergear el PR #4.** Está abierto a propósito.
2. **`prototipo-reel/`.** Ya cumplió y el motor lo reemplaza. **No tiene
   respaldo remoto**; borrarlo es su llamada.
3. **Unificar `brand.yaml` y `brand.json`.** Ver la sección de frontera en
   `system/config/brand.schema.md`. El disparador está escrito como condición:
   el día que la UI de la app llame a `guardar_brand`. **Hoy no lo hace**, y
   por eso no se unifica todavía.
4. **El caption del reel** (etapa 9 del recipe, nunca ejercitada).
5. **ACU-77 (voz) y ACU-78 (música)**, sin tocar.

---

## Mapa del código

| Ruta | Qué es |
|---|---|
| `system/ig-reel/` | Motor de reels. Su `README.md` tiene las trampas ya resueltas |
| `system/ig-carousel/` | Motor de carruseles (preexistente) |
| `system/recipes/*.md` | Contratos de flujo: etapas, enums cerrados |
| `.claude/skills/` | Orquestadores genéricos, sin marca |
| `profiles/<slug>/` | Una marca. **Los reales están gitignored**: en disco, no en `git status` |
| `scripts/validate_commit_guardian.py` | El gate determinista |

**Regla fundacional** (`CLAUDE.md`): `system/` y `.claude/` no pueden llevar
literales de marca — tampoco en comentarios ni en descripciones de skills.

---

## Referencias en Linear

- **ACU-76** — Epic "Motor de Reels en video"
  - **ACU-74** — Video (spike resuelto; es lo que se portó)
  - **ACU-77** — Voz / narración (pendiente)
  - **ACU-78** — Música libre de copyright (pendiente)
