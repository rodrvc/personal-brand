# Editor de carruseles — estado del módulo

Actualizado: 2026-09-08

## Design direction from the owner (2026-09-08)

Decisions from the owner's review, to guide the next PR. Recorded as
decisions with rationale, not as a task list.

**Scope of this PR: stay on the carousel editor screen.** A per-brand
library screen (assets/templates managed at brand level, never mixed
between brands) is the eventual target but is explicitly out of scope here.
The goal is a workflow a human can actually use end to end, not a polished
one — polish comes after.

**Single-screen editor layout** (from the owner's sketch): top shows the
current work path and the carousel title. Left: the canvas with the
carousel slide(s), and below it the layer list — the selected layer is
where edits apply. Bottom-left: an AI advisor panel ("IA Consejos") that
assists continuously, rather than a one-shot initial prompt. Right: a side
panel with three tabs — Tools, Assets, Templates.

**Drag and drop is the central interaction.** An item from the Assets or
Templates panel can be dragged either (a) onto the canvas, to be used
directly in the piece, or (b) onto the AI panel, to be used as a visual
reference for generation. Same item, two destinations depending on where
it's dropped. Neither exists today: assets are currently only selectable
from a dropdown inside a slide, and there's no way to give the AI a visual
reference.

**Tools tab = the manual design controls that already exist and were
judged good:** colors, fonts, and the other manual design affordances. No
new concept needed there.

**New carousel always starts empty.** There is no initial prompt that
composes a whole carousel on entry — the user enters an empty canvas and
builds with AI assistance. This settles the owner's complaint that "as soon
as I enter the UI it's already trying to create content": the fix is this
design change, not a bug fix. Investigation confirmed no code path
generates on load; the only generation trigger is the explicit Crear
button, which this design removes.

**Template = grounding, not a starting point. This is the core idea.** A
template is the set of constraints the AI is obliged to work within,
always — both when generating a whole carousel and when changing a single
piece. The AI fills the gaps; it never moves the walls. This differs from
today's model in two ways:

- Today `pinned` protects a piece, but that's a per-document decision the
  user makes *after* seeing a result. A template is decided once at brand
  level, *before*, and inherited by every carousel using it.
- Today brand guidance is injected into prompts as text — a suggestion the
  model may ignore. A template must be enforced by the system: if the model
  returns something that violates it, the system does not apply it.

A brand may have several templates.

**What a template fixes, for now:** position (e.g. a logo that must not
move), content (a slide that always says a given thing), and
layout/disposition (e.g. cover always has title above, image below). Only
these three for now.

**Conflict handling:** when the AI attempts something the template
forbids, the system must *tell* the user — not silently discard, not offer
an override. The owner noted this may be split into a separate issue;
recorded here as the decided behavior, flagged as possibly deferred.

### Investigation findings (verified, do not re-investigate)

- Assets do persist and are read correctly. The symlinked profile roots
  (`profiles/<slug>` → outside the repo) do not defeat the confinement
  guard, which realpaths the root before checking it. Endpoints return
  correct data. The actual gap is that there is no assets view outside an
  open carousel document — assets today live only in the Bucket tab of the
  properties panel.
- No per-brand template override directories exist on disk for any
  profile, and only one system layout exists. There is no list-templates
  endpoint. So "I can't see the templates" is nothing-to-show, not a read
  failure.
- No code path generates content on app load; the only trigger is the
  explicit create button.

### Follow-up decisions from the owner (same review, continued)

**Template selection is explicit, never implicit.** A template is not a
default property of a carousel; the user picks it from the UI and applies
it. A brand may have several templates, and "no template" is itself a valid
choice — in that case the piece is grounded only by the brand palette (and
fonts), with no structural constraints. Consequence for the data model: the
template is a selectable, swappable reference on the document, not baked in
at creation time.

**Two consumption fronts — this reframes the whole module.** The editor UI
is not the product; it is the assisted mode of a composition engine that
must be usable without a UI:

- **Front 1 — agent/messaging.** An external agent (reachable over a
  messaging channel, for example) receives the information the owner wants
  presented, composes the carousel using the brand's templates, assets and
  creative frame, and returns the finished carousel to the channel where it
  was requested. No UI involved.
- **Front 2 — assisted UI.** Used when the owner wants tighter control
  (notably early in a brand's life), to interact with elements until the
  carousel is right, while teaching/refining the guide.

Consequence: the core must be invocable headlessly; the UI hangs on top of
it, not the other way around.

**Why this product exists (competitive rationale, worth preserving).**
Existing tools each fail on one axis: one design tool gives insufficient
freedom; a general chat model has no anchoring — asking for a modification
returns a wholly different result; a design-tool-plus-chat integration is
the closest but cannot be used outside that tool's own environment. The
missing capability across all of them is **local editing**: changing one
piece without disturbing the rest. That is the real product, and it is also
the reason the template — as enforced grounding — exists at all.

**Proposed three-layer model (discussed, to validate):**

- **template** — non-negotiable constraints.
- **plan** — the cheap, text-level structure of the carousel; what the AI
  produces, and what can be discussed or corrected in conversation
  (especially over messaging, before spending money on rendering).
- **render** — deterministic, non-creative; takes plan + template and
  draws.

If the plan is a first-class artifact rather than an internal step, the
same object serves both fronts: discussed in words over messaging, seen and
manipulated in the UI. Local editing then falls out naturally — changing
one piece means changing one part of the plan and redrawing only that.

**Text/image relationship.** Text should stay untied from the image (it
already is: text objects carry their own geometry over a background image),
but must respect the image in positioning, disposition and contrast.
Deciding text color/placement against the underlying image region is
measurable and does not require AI.

**Correction of an earlier assumption.** The owner had speculated that a
well-known design tool achieves good text results by talking to an MCP that
adjusts letters. That is not how it works. The realistic mechanism is that
the image is generated leaving free space, and the text is measured against
its box and adjusted until it fits — plain auto-fit, measurable in the
browser, no AI needed.

**Verified finding — nothing to salvage from the deprecated desktop app
regarding fonts.** Investigation of `app/` found: three hardcoded generic
system font stacks, no custom font file loading at all, a fixed per-role
type-scale table, and a hand-rolled greedy canvas `measureText` word-wrap
(which prevents words overflowing horizontally but does not make a block
fit vertically — this is most likely what was remembered as "it made them
fit"). The current stack is strictly ahead: real `@font-face` loading of
fonts from the profile's asset index, waiting on `document.fonts.ready`
before rasterizing, and native browser line-breaking. True gap on both
sides: real shrink-to-fit/auto-sizing does not exist anywhere; font size is
manual (numeric input, or proportional scaling on corner-drag). If wanted,
it is net-new work, self-contained, best done by measuring `scrollHeight`
against box height inside the render pass.

### Agreed PR breakdown

Close the current PR with a coherent, usable slice: empty canvas on entry
(remove the compose-on-create prompt), the right-hand panel with its three
tabs listing what exists, a list-templates endpoint (none exists today),
and the i18n move (UI strings to a locale JSON file, technical prose to
English).

Deferred to later PRs, in order:

1. drag-and-drop (asset to canvas, and asset to the AI panel as a visual
   reference) plus text auto-fit.
2. template enforced as a real constraint (touches the engine).
3. the conversational AI panel.
4. as a separate track, the headless composition API and the plan-as-
   artifact work that enable the agent/messaging front.

A hand-written SEED template is being added inside a profile folder purely
so the Templates panel has something to show for testing. Templates are
meant to be AI-generated from existing brand material and references —
explicitly out of scope for the current PR.

> **Esto es UN MÓDULO**, no el proyecto entero. El proyecto es una
> plataforma de contenido: publicaciones, videos, guiones y seguimiento de
> redes. Lee [`../docs/ARQUITECTURA.md`](../docs/ARQUITECTURA.md) para las
> fronteras entre módulos antes de tocar algo fuera de `editor/`.

## Qué es esto

Un editor web local para armar carruseles de Instagram con la identidad
visual de cada marca: se describe la pieza en un prompt, la IA arma un plan
por lámina y por hueco (fondo, textos, figuras), y cada pieza se puede fijar,
regenerar o reemplazar por una del bucket de la marca sin tocar el resto.
Reemplaza en esa función a `app/` (el editor de escritorio), que queda
deprecado — ver más abajo.

La meta de fondo no es "generar más rápido con IA": es que cada pieza
aprobada (fondo, personaje, logo, foto, tipografía) entra a una biblioteca
reusable de la marca, de modo que con el uso la IA pasa de generar a
componer piezas ya aprobadas y cada carrusel cuesta menos que el anterior.

## Qué puede tocar este módulo

Solo escribe dentro de dos raíces, ambas resueltas por perfil:

- `profiles/<slug>/` (documento del carrusel, índice y sidecars de assets,
  fuentes, templates override)
- el `outputs.base_dir` resuelto de ese perfil (puede vivir fuera del repo)

**No puede tocar** `system/`, `core/`, `.claude/agents/`, ni ningún otro
módulo. La confinación no es una convención de código: la impone
`ProfileStore` (`editor/server/src/profile-store.ts`), el único módulo del
servidor que toca disco para datos de perfil. Rechaza cualquier ruta con
`..`, absoluta, o cuyo `realpath` (siguiendo symlinks) caiga fuera de las dos
raíces permitidas — así se detecta tanto un `../` explícito como un symlink
dentro de `assets/` apuntando a `system/`. Cubierto por tests
(`editor/server/src/profile-store.test.ts`), igual que `resolver_dentro()` en
`app/src-tauri/src/main.rs` lo estaba para la app de escritorio.

## Cómo arrancar

```bash
pnpm install
pnpm dev:editor
```

`pnpm dev:editor` corre `editor/dev.mjs`, que levanta `editor/server` (puerto
4310 por defecto) y `editor/web` (Vite) juntos, con la salida de cada uno
prefijada en la misma terminal.

Variables de entorno, en un `.env` en la raíz del repo (no en `editor/`):

- `OPENAI_API_KEY` — opcional. Sin ella el servidor arranca igual pero los
  endpoints de generación por IA devuelven 503 (ver "Trampas conocidas").
  Ya está listada en el `.env.example` de la raíz.
- `EDITOR_BIND` — por defecto `127.0.0.1`. Cambiarla a algo no-loopback sin
  `EDITOR_AUTH` hace que el servidor se niegue a arrancar (ver D13/D12 en
  `openspec/changes/editor-carruseles/design.md`): no existe auth todavía, así
  que exponer la API sin ella no está soportado.
- `EDITOR_PORT` — por defecto `4310`.
- `EDITOR_AUTH` — reservada, no implementada. Requerida junto a `EDITOR_BIND`
  si algún día se expone en una interfaz no-loopback.

Antes de generar con IA hace falta bajar las fuentes de la marca al perfil
(los templates usan `@font-face` local, nunca Google Fonts en vivo):

```bash
tsx system/assets/fetch-fonts.ts --profile <slug>
```

## Reglas que no se negocian

**1. Una sola función de render para preview y export.**
`renderFreeLayoutSlide` (`system/ig-carousel/templates/free-layout.ts`) es la
única que convierte una lámina resuelta en HTML. El servidor la corre para
mostrarla en el iframe del editor y Playwright la corre para exportar a PNG.
No hay una segunda implementación en React "pareciéndose" al CSS del
template — divergirían el primer día y el export dejaría de ser lo que se ve.

**2. Colores solo por clave de `brand.json`, nunca hex.**
El documento del carrusel guarda `colorKey` (clave de `brand.colors`) o
`colorRole` (clave de `brand.roles`, en el template), nunca un literal
`#rgb`/`#rrggbb`/`#rrggbbaa`. El validador (`carousel-document.ts`) rechaza
cualquier string hex en cualquier campo del documento, no solo en los de
color.

**3. La IA no dibuja texto.**
Genera fondos y figuras; el texto lo escribe el template encima, siempre
editable. Motivo: los modelos de imagen escriben mal — letras deformes,
palabras inventadas.

**4. Regeneración por pieza, y nada pisa lo fijado.**
Cada pieza (fondo, cada texto, cada figura) tiene `pinned`. El botón general
es "Regenerar lo no fijado", no "Rehacer": nunca sobreescribe una pieza con
`pinned: true`. No existe un "rehacer todo el carrusel" global — eso es
justo lo que el dueño rechazó en un intento anterior de la maqueta.

**5. Nada se borra ni se sobrescribe.**
Toda imagen generada se escribe en `assets/generated/<hash>.<ext>` con su
sidecar; fijarla o exportarla la mueve a `approved`, pero el archivo nunca se
reemplaza. Cada export crea un `v<N>` nuevo bajo `outputs.base_dir` con
`mkdir` atómico — si `N` ya existe, reintenta con `N+1` en vez de pisar.

**6. Biblioteca primero.**
Para cada hueco visual de una lámina, el planner busca primero en la
biblioteca de la marca (tipo + tags + brand) y solo genera si no hay
candidato o el usuario pide explícitamente generar. Cada objeto guarda su
`source` (`ai | library | manual`) y la interfaz lo muestra por pieza, no
solo como agregado.

## Decisiones tomadas, con su porqué

| Decisión | Por qué |
|---|---|
| **Web, no Tauri** | El dueño revirtió la decisión de `app/`: portabilidad entre sistemas operativos. La razón original de escritorio — "los logos del cliente se quedan en su máquina" — se preserva con local-first: el servidor corre en `127.0.0.1`, no hay login ni sync remoto por ahora. |
| **Local-first, sin deploy ni auth todavía** | Es el punto de partida más simple que no cierra la puerta a un deploy futuro. Todo el I/O de perfil pasa por `ProfileStore`, que es exactamente el punto donde un adaptador de disco remoto reemplazaría al de disco local sin tocar el resto del módulo. |
| **El logo es un asset, no un token de `brand.json`** | Antes vivía como campo `logo{}` en el brand. Ahora es un asset más (`kind: "logo"`, tags `ink:dark`/`ink:light`) que la zona de footer del template pide "automático": el template elige la variante por contraste medido contra el color de fondo real de la lámina (`pickLogoVariant` en `core/color.js`). Esto disuelve la costura que `brand.schema.md` ya señalaba, en vez de resolverla con otro campo. |
| **Herencia template → carrusel → lámina, no copia** | Un objeto con `slot` y sin `geometry` propia hereda la del template; cambiar un margen del template mueve todas las láminas que no lo overridearon. Copiar la geometría a cada lámina rompería esa propagación y duplicaría datos que deberían vivir en un solo lugar. |
| **Paginación como parámetro del template, no del documento** | `zones.footer.pagination` (`all` \| `steps` \| `none`) es una decisión de diseño de la marca/template, no algo que cada carrusel deba repetir. `template.params` permite que un carrusel puntual la ajuste sin tocar el archivo de template del perfil ni afectar a otros carruseles que usan el mismo id. |
| **Una función de render concreta, no un overload genérico** | `renderCarouselDocument` (`system/ig-carousel/render-batch.ts`) es una función standalone, no un tercer overload de `renderSlides`. Las láminas de `CarouselDocument` no son `VerifiedSlide`: mezclar ambos pipelines difuminaría la garantía de que solo `verifyOrThrow` acuña un `VerifiedSlide` (ver `system/ig-carousel/types.ts`). |
| **Sidecar de clasificación por asset, `source: ai \| library \| manual`** | Cada pieza generada escribe un sidecar (prompt, modelo, costo, fecha, carrusel de origen) en estado `candidate`; fijarla o exportarla la sube a `approved`. El índice (`assets/index.json`) es una caché reconstruible desde archivos + sidecars, nunca la fuente de verdad — así un agente que copie un archivo a mano dentro de `assets/` no rompe nada, el servidor reconstruye el índice al arrancar y al detectar cambios de `mtime`. |

Detalle completo de estas decisiones (D1–D16) y las alternativas
descartadas: `openspec/changes/editor-carruseles/design.md`.

## Cómo está armado

```
editor/
  server/        Express 5 + TS, puerto 4310 por defecto
    src/index.ts         entry point, bind y checks de arranque
    src/profile-store.ts confinación de escritura (única puerta a profiles/)
    src/routes/          profiles, assets, render, compose, export
    src/ai/              PieceGenerator (interfaz) + implementación OpenAI
  web/           React 19 + Vite + TS
    src/editor/          Stage, overlay de selección, paneles (Selección/Bucket/Lámina)
    src/routes/          listado de carruseles, picker de perfil, ruta del editor
    src/styles/tokens.css paleta propia del producto (no confundir con --brand-*)
  dev.mjs        corre server + web juntos, para pnpm dev:editor

system/ig-carousel/
  carousel-document.ts        tipos + validador zod del documento
  carousel-document-resolve.ts resolución de herencia template→lámina
  layout-template.ts          carga y merge de templates (default + override + params)
  layouts/<id>.json           templates default, genéricos, sin literales de marca
  templates/free-layout.ts    la única función de render (preview y export)

system/assets/    biblioteca de piezas de marca (compartida con el motor de reel)
  index.ts        escaneo, hash sha256, dedup, reconstrucción completa
  usage.ts        conteo de uso derivado leyendo carousels/*/carousel.json
  logo.ts         selección de logo por contraste
  fetch-fonts.ts  baja fuentes de Google Fonts al perfil como woff2
```

`core/` es ahora un paquete del workspace pnpm (`@personal-brand/core`) que
`editor/server` importa directo — ya no hay copia sincronizada tipo
`sync-core.mjs` para este módulo (eso sigue existiendo solo dentro de `app/`).

## Qué funciona hoy

- Prompt → plan de IA por lámina y por hueco, biblioteca primero
- Documento de carrusel persistido con CRUD + versiones
- Render WYSIWYG: iframe con el HTML real del servidor, overlay de selección
  con handles, edición de texto con textarea flotante
- Paneles Selección / Bucket / Lámina: propiedades, paleta cerrada de la
  marca, capas con badge de origen (IA/biblioteca), pin/regenerar por pieza
- Regeneración selectiva ("Regenerar lo no fijado") respetando `pinned`
- Biblioteca de assets: índice, subida, reclasificación, ocultar, contraste
  medido, contador de uso
- Vista exacta por lámina (PNG real renderizado con el mismo Chromium del
  export) y medición de contraste contra el fondo real
- Export versionado: `v<N>` con `manifest.json` reproducible (sha del
  motor, template resuelto, snapshot de `brand.json`, hashes de assets y
  fuentes), cola serial, no sobreescribe
- Undo/redo del lado del cliente con persistencia debounced
- Listado mínimo de carruseles para entrar y salir (sin galería completa)
- Tema claro/oscuro del chrome del editor, con tokens propios del producto

## Qué falta

- **Deploy**: no hay auth implementada (`EDITOR_AUTH` está reservada pero no
  hace nada); no está decidido si en deploy los perfiles siguen en disco
  local con sync por comando o si un storage remoto pasa a ser la copia
  única — es una pregunta abierta del design, no deuda oculta
  (`openspec/changes/editor-carruseles/design.md`, "Open Questions")
- Galería completa de carruseles (hoy solo el listado mínimo para entrar/salir)
- Edición de la marca (colores, tipografías) desde el editor — hoy el editor
  solo consume `brand.json`, nunca lo escribe
- Formatos distintos a 1080×1350 (4:5); publicación social; métricas
- Tests de interfaz: ninguno, por decisión — ver "Trampas conocidas"

## Trampas conocidas

- **Express 5 usa `*splat`, no `*`, para rutas comodín.** El endpoint de
  archivos estáticos de assets es `/api/profiles/:slug/assets/files/*splat`;
  escribir `*` a secas rompe en Express 5.
- **Safari corta líneas de texto distinto que Chromium.** El preview del
  editor corre en el navegador del usuario, pero el export siempre sale de
  Chromium vía Playwright. Por eso existe la vista exacta (PNG real
  renderizado server-side): es la forma de confirmar cómo se va a ver antes
  de exportar, sin depender de que el navegador de preview coincida con el
  de export.
- **El índice de assets (`assets/index.json`) es una caché reconstruible,
  no la fuente de verdad.** La identidad real es el hash del archivo; el
  servidor reconstruye el índice completo al arrancar y al detectar cambios
  de `mtime`. Un agente copiando un archivo a mano dentro de `assets/` no
  rompe nada, pero tampoco aparece en el índice hasta la próxima
  reconstrucción.
- **Sin `OPENAI_API_KEY` en el `.env` de la raíz, los endpoints de IA
  devuelven 503**, no error 500 ni silencio: el servidor arranca igual y
  loggea "AI: not configured" al iniciar. Componer desde la biblioteca sigue
  funcionando sin la clave.
- **No hay tests de interfaz**, por decisión explícita del alcance del
  cambio (ver `openspec/changes/editor-carruseles/tasks.md`, sección 6): el
  peso de la verificación está en el servidor (`ProfileStore`, versionado de
  export, validador del documento) y en el motor de render
  (`system/ig-carousel/*.test.ts`).

## Documentos de respaldo

- `openspec/changes/editor-carruseles/proposal.md` — por qué y qué cambia
- `openspec/changes/editor-carruseles/design.md` — decisiones D1–D16,
  riesgos, plan de migración, preguntas abiertas
- `docs/carousel-document.md` — referencia del formato del documento y del
  template para agentes y skills
- `system/config/assets.schema.md` — esquema del índice y sidecars de assets
