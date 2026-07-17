---
name: generar-carrusel-semana
description: >-
  Generate the weekly Instagram carousel of events for the Adondepo profile:
  fetch real events from adondepo.cl's public API, curate them, render the
  slides with system/ig-carousel/, and write the caption. Use whenever the
  user asks to "generar el carrusel de esta semana / la próxima semana",
  "crea el post de Instagram de Adondepo", "arma el carrusel semanal", or
  similar — including when they report the previous attempt said files or
  the template were missing (this skill exists specifically so that never
  happens again: every path below is absolute and verified to exist).
---

# Generar carrusel semanal (Adondepo)

Todo lo que este flujo necesita YA EXISTE en este repo. Si en algún punto
parece que falta un archivo, verifica la ruta exacta antes de asumir que
hay que crearlo — las rutas de abajo son las reales, no aproximadas.

## Piezas que ya existen (verificar, no recrear)

| Pieza | Ruta |
|---|---|
| Motor de render (Playwright + TS) | `system/ig-carousel/render-week.ts` |
| Template vigente ("magazine card" hand-drawn) | `system/ig-carousel/templates/list-format.ts` |
| Contrato de datos (`Slide`, `CarouselInput`) | `system/ig-carousel/types.ts` |
| Tokens de marca (colores, fuentes) | `system/ig-carousel/brand.ts` |
| Skill de criterio de diseño (anti-slop, estilos) | `.claude/skills/carousel-designer/` |
| Config del perfil Adondepo | `profiles/adondepo/config.yaml` + `config.local.yaml` |
| Input de la última corrida (se sobreescribe cada vez) | `system/ig-carousel/week-input.json` |

Si `profiles/adondepo/config.local.yaml` no existe, cópialo desde
`profiles/adondepo/config.local.yaml.example` antes de correr el render —
ahí vive `outputs.base_dir` (dónde se guardan las imágenes generadas).

## Flujo

1. **Determinar la semana**: por defecto, la semana calendario actual
   (lunes a domingo). Si el usuario pide "la próxima semana" o un rango
   explícito, usa ese rango — no asumas que siempre es "hoy". El propio
   script (`render-week.ts`) calcula el rango lunes-domingo de la semana
   que contiene la fecha de referencia; para "la próxima semana" pásale
   una fecha de referencia dentro de esa semana en vez de "hoy".

2. **Traer eventos reales**: `GET https://api.adondepo.cl/api/events?limit=200`
   (API pública HTTP — este proyecto nunca se acopla a Prisma/DB directo
   del backend de Adondepo). Filtra por `eventDate` dentro del rango de la
   semana, `isActive: true`, sin `hiddenAt`.

3. **Curar (criterio humano, no solo el primero que aparezca)**:
   - Descarta eventos que no son "panoramas" reales: casting, talleres
     internos, operativos sociales, cine-foro informativo, contenido
     administrativo.
   - Descarta duplicados (mismo evento publicado por más de una cuenta con
     caption casi idéntico).
   - Prioriza eventos con `permanentImageUrl` (imagen ya alojada de forma
     estable) sobre `imageUrl` (URL de Instagram, puede expirar/dar 404).
   - Prioriza variedad de categorías y buen engagement (`likes`) sobre
     simplemente los primeros N por fecha.
   - 5 eventos es un buen default (rinde 3 slides de hasta 2 eventos cada
     una con el template actual) — ajusta si el usuario pide más/menos.

4. **Armar el input**: para cada evento, extrae de `caption` (texto libre
   del post) un `title` corto y legible, `subtitle` (fecha/hora tal como
   aparece, ej. "Sáb 11 Jul, 23:00"), `meta` (lugar), y `category` (mapea
   `categories[0]` del API a uno de: Música, Deporte, Cultura, Familiar,
   Fiesta, Destacados — o el string tal cual si no calza, `brand.ts` tiene
   un color de fallback gris). Escribe el resultado en
   `system/ig-carousel/week-input.json`, sobreescribiendo el anterior —
   esa forma exacta: `{ "slides": [{ "image", "title", "subtitle", "meta",
   "category" }, ...] }`.

5. **Renderizar**: desde la raíz del repo,
   `npx tsx system/ig-carousel/render-week.ts --profile adondepo --city
   Antofagasta` (ambos flags son opcionales, ya son el default). El script
   imprime la carpeta de salida real en su última línea ("Output folder:
   ...") — nunca la des-adivines, léela de ahí. Verifica los PNG
   resultantes leyéndolos con la herramienta de lectura de imágenes (no
   solo confirmando que el archivo existe) — chequea que ninguna card se
   corte y que las fotos carguen.

6. **Escribir el caption**: tono cálido, breve, con emojis moderados
   (estilo posts reales de @adondepo). Estructura: hook de una línea, lista
   de eventos con día+hora+nombre, cierre con llamada a guardar/compartir,
   mención a adondepo.cl, 3-5 hashtags. Guarda `caption.txt` en la MISMA
   carpeta que imprimió el script en el paso 5. El rango de fechas del
   caption debe coincidir exactamente con el que aparece en las imágenes
   (mismo cálculo de semana, no lo redactes a mano por separado).

## Output final

`<outputs.base_dir del perfil>/<año>/<mes-DD>/` — por ejemplo,
`~/Pictures/adondepo/carruseles/2026/jul-13/` si `base_dir` en
`config.local.yaml` apunta ahí (`jul-13` = el lunes en que empieza esa
semana). Carpeta nueva por cada semana generada, nunca sobrescribe la
anterior. Contiene: `slide-N.png` (una por grupo de hasta 2 eventos),
`caption.txt`, `manifest.json`.

## Si algo del diseño visual no convence

No improvises variantes a ciegas — invoca `carousel-designer`
(`.claude/skills/carousel-designer/SKILL.md`) para evaluar el template
actual contra su checklist de anti-slop y librería de estilos antes de
tocar `list-format.ts`.

## Reglas

- Nunca inventes datos de eventos — si un dato (hora, lugar) no está claro
  en el caption original, usa el texto disponible tal cual en vez de
  adivinar.
- El header de las slides muestra el rango de semana calculado por el
  script, nunca un valor hardcodeado a mano — evita publicar una fecha
  desincronizada de los eventos reales.
- No agregues precio (`price`) al contrato de datos — decisión de producto
  ya tomada; la mayoría de eventos scrapeados no lo tienen estructurado.
- Publicación siempre manual: este flujo deja los archivos listos en la
  carpeta de output, nunca publica en Instagram directamente.
