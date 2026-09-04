# Editor de carruseles — estado del módulo

Actualizado: 2026-09-04

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
