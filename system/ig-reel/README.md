# system/ig-reel — motor de reels

Renderiza un **reel vertical 1080x1920** (MP4) a partir de los ítems fechados
de un perfil: portada, N ítems cada uno precedido por un vuelo de cámara sobre
un mapa real hacia su ubicación, y cierre.

Genérico, como `system/ig-carousel/`: **nada aquí nombra una marca, una ciudad
ni una taxonomía**. Todo eso llega desde `profiles/<slug>/`.

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
                                           [--storyboard [ruta]] [--audio-only]
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
| `reels/<fecha>/storyboard.yaml` | Opcional: la narración por tarjeta (ver "Storyboard: audio primero") |
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
| `storyboard.ts` | Carga y valida el storyboard, sintetiza por tarjeta con caché, deriva la timeline |
| `render-reel-week.ts` | Entrypoint: geocodifica, verifica, arma props, renderiza y muxea |
| `reel.test.ts` | Tests de guards, timeline y recipe |
| `remotion/src/timeline.ts` | Escenas (fijas o derivadas del audio) y matemática de cámara — funciones puras, testeadas |
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
  limpia los renders viejos de esa carpeta. El audio del render vive en una
  carpeta hermana (`audio/`) dentro de la salida para evitar que herramientas
  que escanean la carpeta confundan archivos de audio con el video.
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

### Storyboard: audio primero

**El problema que resuelve.** Con `--voice` el guion es un solo texto → un
solo MP3 → se pone encima de un video cuyas escenas duran lo que dicen las
constantes de `timeline.ts`. Nada une la frase N con la escena N, así que la
voz se desfasa siempre: el narrador habla del tercer plan mientras la cámara
todavía vuela al segundo.

**La solución.** Un storyboard por tarjetas: cada escena es una tarjeta, y la
tarjeta lleva su narración. El motor sintetiza **un MP3 por tarjeta**, lo
mide con ffprobe y deriva la duración de cada escena de su propio audio:
"audio primero, video después". La estructura se respeta por construcción —
una escena no puede terminar antes de que acabe su frase porque la escena
dura lo que dura la frase.

**Dónde vive.** `profiles/<slug>/reels/<YYYY-MM-DD>/storyboard.yaml`; la
fecha es el lunes del período, la misma que sale de `--date`. Es dato del
perfil (gitignorado con él); el ejemplo ficticio está en
`profiles/example/reels/<fecha>/storyboard.yaml`. Si el archivo existe para
ese período, el render lo usa solo; `--storyboard <ruta>` apunta a otro.
`--voice` y storyboard son excluyentes: uno fija los tiempos de las escenas y
el otro pone un guion encima de los tiempos fijos; pasar los dos es error.

**Contrato:**

```yaml
storyboard: reel
version: 1
transitions: crossfade  # opcional: 'crossfade' (default) o 'cut' para cortes secos
voice:            # opcional: override parcial del bloque voice: del recipe
  speed: 1.05
cards:
  - id: cover     # slug único
    visual: cover # enum cerrado: cover | item | closing
    narration: "lo que dice el narrador en esta tarjeta"
  - id: item-1
    visual: item
    item: 0       # índice en reels/week-input.json; obligatorio y único por item
    narration: "..."
    min_seconds: 5.0   # opcional: piso de la escena (nunca bajo el mínimo del motor)
  - id: closing
    visual: closing
    narration: ""      # vacío = tarjeta muda (0s de voz, la escena dura su mínimo)
```

Falla **al cargar**, nombrando la tarjeta: `storyboard`/`version` exactos,
ids únicos, `visual` en el enum, exactamente una `cover` al inicio y una
`closing` al final, entre 2 y 6 `item`, cada `item` con un índice válido y
distinto, claves desconocidas, `narration` ausente (vacía sí se permite).
**El orden de las escenas lo fija el storyboard**, no `week-input.json`: el
reel muestra los ítems en el orden de las tarjetas `item`.

**Presupuesto de palabras** (constantes del motor, no del perfil): cover
4–15, item 8–30, closing 4–15. Fuera de rango falla con el conteo real
(`card item-2: 41 words, max 30 for visual=item`). Es lo que mantiene una
escena derivada dentro del largo que el formato sostiene.

Validar sin red, sin key y sin ffmpeg — imprime siempre la tabla
id / visual / palabras:

```
npx tsx system/ig-reel/storyboard.ts --check profiles/<slug>/reels/<fecha>/storyboard.yaml \
                                     --items profiles/<slug>/reels/week-input.json
```

**Síntesis por tarjeta y caché por contenido.** Cada tarjeta se sintetiza a
`profiles/<slug>/reels/<fecha>/audio/<card-id>.mp3` con la voz efectiva
(recipe + override). Al lado queda un sidecar `<card-id>.json` con el sha256
de (texto normalizado + voice config efectiva + model_id) y la duración
medida. Si el hash coincide y el MP3 existe, **no se llama a la API**: editar
una tarjeta re-sintetiza solo esa; cambiar la voz re-sintetiza todas.

**La timeline derivada.** Por tipo de tarjeta, con `RESPIRO = 0.4s`
(`BREATH_SECONDS`, el silencio tras la frase para que el corte no caiga en la
última sílaba):

| Tarjeta | Duración |
|---|---|
| cover | `max(2.2, voz + respiro)` |
| item | `max(1.8 + 3.2, voz + respiro, min_seconds)` — el vuelo de mapa sigue fijo en 1.8s (cámara 1.2s); el tiempo extra va al hold de la tarjeta de ítem, nunca al vuelo; la narración arranca con el vuelo |
| closing | `max(2.0, voz + respiro)` |

Solape/cross-fade igual que antes. Con `--music`, `intro_seconds` desplaza
la narración de la portada **dentro de la portada** (la portada crece para
contenerla), así cada tarjeta posterior sigue arrancando exacto con su
escena. La timeline se escribe en `profiles/<slug>/reels/<fecha>/timeline.json`
(por tarjeta: id, visual, item, palabras, segundos de voz, inicio, duración;
y el total) y se imprime legible en consola.

**`--audio-only`** se detiene ahí: sintetiza, imprime la tabla, abre la
carpeta de audio con `open` y no renderiza. Es el paso para *escuchar* las
tarjetas antes de pagar el render. Sin el flag, el render recibe las escenas
ya resueltas (`ReelProps.scenes`), y la pista de narración se arma
concatenando los MP3 con `adelay` al inicio de cada tarjeta; luego el mux es
el mismo de siempre (loudnorm, cama, verificación con ffprobe). El guard
"narración más larga que el video" no aplica con storyboard: el video se
ajusta a la voz. Sigue vigente para `--voice`.

**Sin storyboard no cambia nada.** `ReelProps.scenes` es opcional; si no
viene, la composición calcula las escenas con los tiempos fijos y el output
es idéntico al anterior, frame a frame.

### Transiciones: crossfade o cut

Por defecto, las escenas se solapan 0.35s para que el fade-in/out tenga espacio;
la portada se extiende beyond su duración y el cierre arranca antes. Con 
`transitions: cut` (en el storyboard) o `--cut` (flag CLI), cada escena aparece
a opacidad completa en su inicio exacto y desaparece en su fin exacto — sin solape
ni fade. Los rangos de frames de la timeline no cambian; solo se anulan los fades.

Útil cuando la edición de transiciones ocurre **fuera del motor** — cada clip
por tarjeta es independiente, y el editor agrega las propias transiciones en su
app de edición de video.

---

## Clips por tarjeta y ensamblaje

Un render monolítico renderiza todo de una sola vez. **Los clips** permiten
rehacer una sola escena sin re-renderizar el resto. Internamente, un clip
**no es una composición separada**: es un rango de frames de la misma composición
`Reel`, renderizado con los mismos props. Los píxeles son idénticos al render
monolítico, y los crossfades entre escenas (un solape de `TIMING.overlap`
segundos) se preservan de forma libre — el frame en el límite de la escena ya
mezcla ambas, así que el corte cae limpio en él.

**Dónde quedan los clips.** En `<salida>/clips/`, uno por tarjeta del
storyboard. El nombre es `<índice>-<card-id>.mp4` (`0-cover.mp4`,
`1-item-1.mp4`, …); el índice va en orden de escena y se rellena con ceros a
la izquierda según cuántas tarjetas haya, para que ordenen bien en disco.
Requieren un storyboard: el ritmo fijo no tiene ids de tarjeta.

**Por qué el clip es mudo de verdad (`--muted`).** Sin el flag, Remotion
escribe cada clip con su propia pista de audio silenciosa cuyo padding no
coincide con el conteo de frames del video (medido: un video de 77 frames /
2.5667s dentro de un contenedor cuyo `format=duration` reporta 2.624s, porque
esa cifra es la del stream más largo — la pista de audio con relleno). Al
concatenar clips que cada uno arrastra un padding de audio distinto, el
resultado queda con frame rate variable: los frames correctos, mal
repartidos en el tiempo (758 frames que debían durar 25.2667s terminaban
estirados a 25.5s). `--muted` deja el clip con un solo stream, sin nada que
desalinear.

**Los tres modos de render:**

- `--clips`: renderiza todas las tarjetas como clips y las ensambla en una sola
  (silenciosa). El ensamblaje concatena con `ffmpeg -c copy` (stream copy, sin
  re-encodear) y verifica con ffprobe que el video resultante mida
  `totalFrames/FPS` (±1 frame). Si el stream copy falla o el resultado no
  calza en duración — la señal de un glitch en una frontera entre clips — cae
  a un segundo intento con concat **re-encodeado** (`libx264 -crf 18`), a
  costa de una generación de calidad solo en los cortes. En la práctica, con
  clips mudos (`--muted`) el stream copy funciona directo: cada frame de
  Remotion es keyframe, así que no hay frontera que desalinear.
- `--card <id> [--card <id2> ...]`: renderiza solo esas tarjetas, sin ensamblar.
  Útil para rehacer una escena que no gustó — cada clip es mudo.
- `--assemble`: une los clips ya renderizados en `clips/`, muxea el audio
  (narración+música) sobre el resultado y verifica. Falla si falta un clip o si
  su duración no calza con la timeline.

**El audio es post-producción.** Los clips salen mudos (`--muted` en Remotion),
un solo stream de video. La pista de narración (tarjeta a tarjeta, con delays) y
la cama se aplican **después**, en el muxeo — igual que el render monolítico.
Eso mantiene el video del mismo tamaño aunque se cambie el audio.

**Ejemplo de flujo:** rehacer la escena del tercer ítem (tarjeta `item-2`)
cuando el resultado no gustó:

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> --date <fecha> --card item-2
# → renderiza solo ese clip

# Verifica el clip en `outputs/…/clips/2-item-2.mp4`

# Luego, ensambla todos los clips (incluido el nuevo) con audio:
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> --date <fecha> --assemble
# → muxea la pista de voz y música sobre la concatenación
```

---

## Qué queda en la carpeta de salida

Al terminar el render, todos los artefactos quedan organizados en
`profiles/<slug>/outputs/reels/<fecha>/` — la carpeta para llevar y editar a
mano en otra herramienta:

```
reel-<fecha>.mp4        archivo final con audio (MP4, 1080x1920)
storyboard.yaml         snapshot del storyboard que se renderizó (si existe)
timeline.json           snapshot de la timeline usada (si existe)
reel-props.json         props resueltos para la composición (Remotion)
clips/
  0-cover.mp4           clip mudo por tarjeta (stream copy, sin audio)
  1-item-1.mp4
  ... (uno por tarjeta del storyboard)
  concat-list.txt       lista ffmpeg para el ensamblaje (generado)
audio/
  cards/                copia de cada MP3 sintetizado (tarjeta por tarjeta)
    cover.mp3
    item-1.mp3
    ... (sin los sidecars .json del caché)
  narration-<fecha>.wav|.mp3  pista de narración armada (si existe)
  music-<fecha>.mp3     cama musical (si se pidió --music)
renders/                intermedios mudos de Remotion (interno, no llevar)
  reel-<fecha>.mp4      render monolítico sin audio
```

Los audios por tarjeta con su caché (`.mp3` + `.json`) siguen viviendo en
`profiles/<slug>/reels/<fecha>/audio/` — eso es la fuente y el caché que
alimenta el motor; la carpeta `audio/cards/` de la salida es una copia
derivada.

---

## Requisitos

- **Node 22+** (el subproyecto instala sus dependencias solo en la primera corrida)
- **FFmpeg** (con ffprobe) — para muxear y verificar el audio
- Red durante el render: los tiles se bajan al renderizar; Nominatim solo si
  hay ítems sin coordenada y el caché está frío
- `ELEVENLABS_API_KEY` en el entorno, solo si se usa `--voice` o `--music`.
  La key vive en `<repo>/.env` (gitignorado; hay `.env.example` en la raíz que
  Orca copia a cada worktree vía `.worktreeinclude`). El motor la carga
  automáticamente. Si la key ya está en el entorno (p. ej. exportada en el
  shell), el entorno gana sobre el archivo.

Preview interactivo: `cd system/ig-reel/remotion && npm run studio`. Abre con
props ficticios y neutros ("Puerto Ejemplo", coordenadas cerca de 0,0) sin
necesitar ningún perfil real en disco; un render real siempre pasa props
completos vía `--props`.
