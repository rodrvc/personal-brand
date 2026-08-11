# system/ig-reel — motor de reels

Renderiza un **reel vertical 1080x1920** (MP4) a partir de los ítems fechados
de un perfil: portada, N ítems cada uno precedido por un vuelo de cámara sobre
un mapa real hacia su ubicación, y cierre.

Genérico, como `system/ig-carousel/`: **nada aquí nombra una marca, una ciudad
ni una taxonomía**. Todo eso llega desde `profiles/<slug>/`.

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
                                           [--voice <script.txt>] [--music]
```

Contrato de flujo: `system/recipes/reel-week.md`.
Contrato de datos de marca: `system/config/brand.schema.md`.

---

## Qué necesita de un perfil

| Archivo | Qué aporta |
|---|---|
| `brand.json` | Colores, tipografías, categorías y `copy.reel` + `gradients.cover` |
| `recipes/reel-week.yaml` | Fuente, curaduría, `map.bbox`, y opcionalmente `voice:` y `music:` |
| `reels/week-input.json` | Los ítems ya curados, con fecha, coordenada e imagen |
| `assets/fonts/*.woff2` | Opcional: la fuente de logo, embebida para que preview y render coincidan |

El mismo `brand.json` que consume el carrusel. No hay un segundo archivo de
marca.

---

## Arquitectura: Node orquesta, Remotion renderiza

El video lo emite un subproyecto Remotion (`remotion/`) cuyo mapa son **tiles
raster reales movidos por una cámara MapLibre**, no un SVG dibujado. La
frontera entre ambos lados es el contrato `ReelProps`
(`remotion/src/props.ts`): todo llega **resuelto** — colores como CSS, copy ya
interpolado, imágenes en rutas servibles. La composición no conoce
`brand.json`, recipes ni perfiles; `render-reel-week.ts` es el único que los
lee y los aplana a ese shape. Todo el vocabulario de marca queda del lado Node.

| Archivo | Rol |
|---|---|
| `types.ts` | Contrato de datos del input y `VerifiedReelItem` |
| `geo.ts` | Validación de bbox y encuadre wide de la cámara (`wideFraming`) |
| `osm.ts` | Nominatim: geocodifica texto libre a coordenada, acotado al bbox |
| `osm-cache.ts` | Caché en disco de esas llamadas |
| `verify-items.ts` | El guard previo al render |
| `recipe.ts` | Carga y valida `recipes/reel-week.yaml` |
| `voice.ts` | ElevenLabs: narración TTS y cama musical, ambas opt-in |
| `render-reel-week.ts` | Entrypoint: geocodifica, verifica, arma props, renderiza y muxea |
| `reel.test.ts` | Tests de guards, timeline y recipe |
| `remotion/src/timeline.ts` | Tiempos de escena y matemática de cámara — funciones puras, testeadas |
| `remotion/src/maplibre.ts` | MapLibre bajo el reloj de Remotion, estilo de tiles y atribución |
| `remotion/src/Reel.tsx` | La composición: portada, escenas de mapa+ítem, cierre |

---

## Decisiones que no son obvias

### Los tiles son CARTO Voyager — y no pueden ser otros

Es una restricción **legal**, no una preferencia técnica, y por eso vive en el
motor y ningún perfil la puede tocar:

- Los tiles de openstreetmap.org prohíben el *pre-emptive fetching*.
  Pre-renderizar un video es exactamente eso.
- Las imágenes de Google Maps/Earth están prohibidas en contenido promocional,
  y un reel de marca lo es.
- Mapbox exige licencia comercial aparte.

Los basemaps de CARTO (Voyager raster, sin API key) son usables **con
atribución**: de ahí el rótulo **"© OpenStreetMap contributors © CARTO"** que
la composición imprime sobre cada escena de mapa. Es obligatorio y ningún
campo de perfil lo apaga.

### El mapa es un renderer vivo que Remotion trata como foto por frame

MapLibre anima solo si se lo deja; acá **no debe poseer ninguna animación**.
La cámara se calcula desde `useCurrentFrame()` y se aplica con `jumpTo()`
(nunca `flyTo()`), y cada frame bloquea en `delayRender()` hasta que los tiles
de esa cámara cargaron. Parte del mismo contrato es cómo se invoca el render:

```
npx remotion render src/index.ts Reel out.mp4 --props=... --concurrency=1 --gl=swangle
```

`--gl=swangle` (SwiftShader/ANGLE) es la vía segura para WebGL headless, y
`--concurrency=1` porque Chromium headless no aloja varios contextos WebGL de
forma confiable — y las instancias paralelas se pelean el caché de tiles sin
ganar reloj.

### El encuadre wide sale de los ítems, no del bbox

El bbox es territorio del **filtro**: en una ciudad costera su punto medio es
mar abierto. `wideFraming()` encuadra sobre los ítems verificados. Y como la
cámara puede centrar cualquier coordenada del bbox, "dónde cae el pin en el
lienzo" dejó de ser problema del motor: las zonas y la cobertura del lienzo
del renderer SVG anterior ya no existen (`map.zones` y `map.reference_types`
se aceptan en el recipe por compatibilidad, con warning, y se ignoran).

### El staging es efímero a propósito

`staticFile()` de Remotion solo sirve desde el `public/` del propio proyecto,
así que las imágenes y la fuente del perfil se copian a
`remotion/public/staging/` mientras dura el render. La carpeta está ignorada
por git y **se borra al terminar**: nada con forma de marca puede quedar bajo
`system/` un segundo más de lo que el render lo necesita.

### Geocodificación: acotada, secuencial y sin inventos

Un ítem sin `lat`/`lng` se geocodifica con Nominatim, acotado al bbox y con
`User-Agent` identificable. Secuencial y un request por ítem, como exige su
política de uso. Lo que no geocodifica **se descarta con su razón** — nunca se
cae al centro del bbox, porque un pin en el lugar equivocado se ve igual de
correcto que uno bien puesto.

Toda llamada pasa por un caché en disco (`osm-cache.ts` → `<repo>/.cache/`):
re-correr la misma semana cuesta cero requests al servicio gratuito. Se cachea
la **respuesta cruda, con la request literal como clave** — cambia el input y
el caché falla solo. TTL de 180 días (una dirección se mueve poco), entrada
vencida se usa con aviso si la red falla, siempre imprime de dónde salió el
dato, `--no-cache` fuerza datos frescos. Vive en `<repo>/.cache/` y nunca en
`profiles/<slug>/`: un perfil es una declaración transportable; un caché es un
derivado con vencimiento.

### El bbox se topa en 0.5° por lado

Más ancho y el zoom wide→calle deja de leerse como llegar a alguna parte, y la
geocodificación acotada a esa caja deja de acotar nada. Falla en load con la
explicación, no a mitad de render.

### La pista de audio no es opcional

Remotion emite el MP4 sin audio, y **varios reproductores de macOS se quedan
congelados en el primer frame con videos mudos**: el video *parece* roto
aunque esté bien. El script muxea siempre una pista con FFmpeg — silenciosa si
no se pidió nada, la narración con `--voice`, la cama con `--music`, o ambas.
El video se copia sin re-encodear, y al final se verifica con ffprobe que la
pista de audio dure lo que el video: un filter graph puede emitir un stream de
audio casi vacío en vez de fallar.

Dos trampas operativas alrededor de `renders/`:

- El muxeo toma **el último `.mp4` de `renders/` por orden de nombre**
  (`.sort().pop()` en `render-reel-week.ts`). Antes de una corrida limpia,
  limpia los renders viejos de esa carpeta, y no dejes archivos de audio ni
  nada ajeno dentro de `renders/`: el audio del render vive en una carpeta
  hermana (`audio-<fecha>/`) justamente para que nada que escanee la salida
  lo confunda con el video.
- La música generada **trae su propio fade de salida** (se pide ~15% más
  larga que el video y el muxeo recorta la cola por eso mismo). No le
  apliques un segundo fade encima: queda un final que muere dos veces.

### Narración y música son opt-in, y su identidad es del perfil

`--voice <script.txt>` narra un guion que se le entrega — el motor sabe
*hablar*, nunca qué decir. Exige un bloque `voice:` en el recipe del perfil
(`voice_id` mínimo): en qué voz habla una marca es decisión de perfil. La API
key sale de `ELEVENLABS_API_KEY` en el entorno, jamás de un archivo del
perfil. `--music` compone la cama desde `music.prompt` del recipe; con
narración encima la cama suena entera durante `intro_seconds` y luego se
atenúa a `gain_db`, y la voz se normaliza (loudnorm) antes de mezclar. Un
guion más largo que el video falla con mensaje, no se corta a mitad de frase.

---

## Requisitos

- **Node 22+** (el subproyecto instala sus dependencias solo en la primera corrida)
- **FFmpeg** (con ffprobe) — para muxear y verificar el audio
- Red durante el render: los tiles se bajan al renderizar; Nominatim solo si
  hay ítems sin coordenada y el caché está frío
- `ELEVENLABS_API_KEY` en el entorno, solo si se usa `--voice` o `--music`.
  La key vive en un `.env` **fuera del repo** (jamás en el perfil ni en ningún
  archivo del árbol) y se carga en el mismo comando del render:
  `set -a; . <ruta-a-tu-env>; set +a; npx tsx …`. La ruta concreta del `.env`
  de cada operador se anota localmente (p. ej. en una nota dentro de su
  carpeta de perfil, que está gitignorada), nunca en el repo.

Preview interactivo: `cd system/ig-reel/remotion && npm run studio`. Abre con
props ficticios y neutros ("Puerto Ejemplo", coordenadas cerca de 0,0) sin
necesitar ningún perfil real en disco; un render real siempre pasa props
completos vía `--props`.
