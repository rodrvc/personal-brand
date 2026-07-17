# carousel-week-generator

## Rol
Generar el carrusel semanal de Instagram de eventos para el perfil Adondepo:
curar eventos reales, renderizar las slides con `system/ig-carousel/`, y
escribir el caption.

## Lee primero
- `.claude/skills/carousel-designer/references/anti-slop.md` y `style-library.md`
- `system/ig-carousel/types.ts` (contrato de datos `Slide`)
- `system/ig-carousel/templates/list-format.ts` (template vigente)
- `system/ig-carousel/render-week.ts` (script de render)

## Flujo

1. **Determinar la semana**: por defecto, la semana calendario actual
   (lunes a domingo). Si el usuario pide "la próxima semana" o un rango
   explícito, usa ese rango en su lugar — no asumas que siempre es "hoy".

2. **Traer eventos reales**: `GET https://api.adondepo.cl/api/events?limit=200`
   (API pública, nunca Prisma/DB directo — este proyecto no se acopla al
   backend). Filtra por `eventDate` dentro del rango de la semana, `isActive:
   true`, sin `hiddenAt`.

3. **Curar (criterio humano, no solo el primero que aparezca)**:
   - Descarta eventos que no son "panoramas" reales: casting, talleres
     internos, operativos sociales, cine-foro informativo, contenido
     administrativo.
   - Descarta duplicados (mismo evento publicado por más de una cuenta con
     caption casi idéntico).
   - Prioriza eventos con `permanentImageUrl` (imagen ya alojada de forma
     estable) sobre `imageUrl` (URL de Instagram, puede expirar).
   - Prioriza variedad de categorías y buen engagement (`likes`) sobre
     simplemente los primeros N por fecha.
   - 5 eventos es un buen default para un carrusel de 3 slides (grupos de 2)
     — ajusta si el usuario pide más/menos.

4. **Armar `week-input.json`**: para cada evento, extrae de `caption` (texto
   libre) un `title` corto y legible, `subtitle` (fecha/hora tal como
   aparece, ej. "Sáb 11 Jul, 23:00"), `meta` (lugar), y `category` (mapea
   `categories[0]` del API a uno de: Música, Deporte, Cultura, Familiar,
   Fiesta, Destacados — o el string tal cual si no calza, el template tiene
   un color de fallback). Guarda en `system/ig-carousel/week-input.json`.

5. **Renderizar**: `npx tsx system/ig-carousel/render-week.ts --profile
   adondepo --city Antofagasta` (ambos flags son opcionales, default a esos
   mismos valores). El script calcula solo el output folder — no lo
   hardcodees. Verifica los PNG resultantes leyéndolos (no solo confirmando
   que el archivo existe) — chequea que ninguna card se corte y que las
   fotos carguen.

6. **Escribir el caption**: tono cálido, breve, con emojis moderados
   (siguiendo el estilo de posts reales de @adondepo). Estructura: hook de
   una línea, lista de eventos con día+hora+nombre, cierre con llamada a
   guardar/compartir, mención a adondepo.cl, 3-5 hashtags. Guarda
   `caption.txt` en la MISMA carpeta que imprimió el script en su línea
   final ("Output folder: ..."). El rango de fechas en el caption debe
   coincidir exactamente con el que aparece en las imágenes (mismo cálculo
   de semana).

## Output
`<outputs.base_dir del perfil>/<año>/<mes-DD>/` (ej. para Adondepo hoy:
`~/Pictures/adondepo/carruseles/2026/jul-06/`, donde `jul-06` es el lunes en
que empieza esa semana) — carpeta nueva por cada semana generada, nunca
sobrescribe la anterior. Contiene: `slide-N.png` (una por grupo de hasta 2
eventos), `caption.txt`, `manifest.json`.

`outputs.base_dir` vive en `profiles/<perfil>/config.local.yaml` (config
privada por máquina, no versionada — sigue el patrón
`config.yaml`/`config.local.yaml.example` ya usado en este repo). Puede ser
una ruta relativa (dentro del repo) o absoluta/`~`-prefijada (fuera del
repo, para no versionar binarios generados). Si el perfil no tiene
`config.local.yaml`, cae a `config.yaml`, y si tampoco está ahí, usa
`outputs/` relativo al perfil por defecto.

## Reglas
- Nunca inventes datos de eventos — si un dato (hora, lugar) no está claro en
  el caption original, usa el texto disponible tal cual en vez de adivinar.
- El header de las slides muestra el rango de la semana calculado, nunca un
  valor hardcodeado a mano — evita el error de publicar una fecha
  desincronizada de los eventos reales.
- No agregues precio (`price`) al contrato de datos — decisión de producto
  ya tomada, la mayoría de eventos scrapeados no lo tienen estructurado.
- Publicación siempre manual: este flujo deja los archivos listos en
  `output/week/`, nunca publica en Instagram directamente.
