# system/ig-reel — motor de reels

Renderiza un **reel vertical 1080x1920** (MP4) a partir de los ítems fechados
de un perfil: portada, N ítems cada uno precedido por una transición de mapa
que hace zoom sobre su ubicación, y cierre.

Genérico, como `system/ig-carousel/`: **nada aquí nombra una marca, una ciudad
ni una taxonomía**. Todo eso llega desde `profiles/<slug>/`.

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
```

Contrato de flujo: `system/recipes/reel-week.md`.
Contrato de datos de marca: `system/config/brand.schema.md`.

---

## Qué necesita de un perfil

| Archivo | Qué aporta |
|---|---|
| `brand.json` | Colores, tipografías, categorías y `copy.reel` + `gradients.cover` |
| `recipes/reel-week.yaml` | Fuente, curaduría, y el bloque `map` (bbox + tipos de referencia) |
| `reels/week-input.json` | Los ítems ya curados, con fecha, coordenada e imagen |
| `assets/fonts/*.woff2` | Opcional: la fuente de logo, embebida para que preview y render coincidan |

El mismo `brand.json` que consume el carrusel. No hay un segundo archivo de
marca.

---

## Archivos

| Archivo | Rol |
|---|---|
| `types.ts` | Contrato de datos, tiempos de escena y `VerifiedReelItem` |
| `geo.ts` | Proyección Mercator, validación de bbox, ubicación del mapa por ítem |
| `osm.ts` | Overpass y Nominatim: costa, calles, referencias y geocodificación |
| `map-svg.ts` | Dibuja el SVG del mapa con los colores del perfil |
| `verify-items.ts` | El guard previo al render |
| `composition.ts` | Genera el HTML+GSAP para HyperFrames |
| `recipe.ts` | Carga y valida `recipes/reel-week.yaml` |
| `render-reel-week.ts` | Entrypoint: orquesta todo y agrega la pista de audio |
| `reel.test.ts` | Tests de los guards (`npm run check`) |

---

## Decisiones que no son obvias

Cosas que costaron encontrar y conviene no re-descubrir a la mala.

### El mapa se dibuja desde DATOS de OSM, nunca desde tiles

Es una restricción **legal**, no una preferencia técnica, y por eso vive en el
motor y ningún perfil la puede apagar:

- Los tiles de OSM prohíben el *bulk download*. Pre-renderizar un video es
  exactamente eso.
- Las imágenes de Google Maps/Earth están prohibidas en contenido promocional,
  y un reel de marca lo es.
- Mapbox Satellite exige licencia comercial aparte.

Los **datos** OSM son ODbL: uso comercial permitido **con atribución**. De ahí
el "© OpenStreetMap" que el composition rotula en cada escena de mapa. Esa
atribución es obligatoria.

### Una coordenada en el borde del bbox no se puede centrar

Centrar un punto del borde deja medio lienzo fuera del mapa. Es geometría: no
hay `MAP_SCALE` que lo arregle, porque el faltante crece con la escala que lo
arreglaría. Por eso `isPlaceable()` lo trata como problema **del ítem** (se
descarta con su razón, como cualquier otro no renderizable) y `placeItem()`
mantiene el assert como última línea de defensa.

El prototipo nunca lo pisó porque sus cuatro eventos estaban en el interior.

### El mapa debe cubrir el lienzo

A escala 0.55 el mapa no alcanzaba a cubrir 1080x1920 al centrarse cerca del
borde, y asomaba el fondo como una franja clara. Está en 1.15, verificado por
ítem. **No bajarlo sin correr los tests.**

### El pin viaja dentro del contenedor que escala

Si se ancla al centro del lienzo, el zoom lo desalinea respecto a la calle. Va
en el mismo `transform-origin` que el mapa, con contra-escala `1/ZOOM` para no
deformarse.

### El mar se pinta por celdas, no como polígono cerrado

Es la decisión que más costó, y las dos alternativas fallidas están en el
código porque explican por qué:

1. **Cerrar la costa contra el borde izquierdo.** Asume que el mar está al
   oeste. Cierto para una costa, falso para la bahía siguiente.
2. **Desplazar la costa por su normal hacia el mar** formando una banda. La
   dirección es correcta (OSM dibuja la costa con tierra a la izquierda y mar
   a la derecha), pero la banda se auto-interseca donde la costa curva, y
   ninguna `fill-rule` recupera el interior. Pintó mar sobre el centro de una
   ciudad.

Un polígono obliga a responder *"¿dónde cierra la costa?"*, que no tiene
respuesta estable cuando la costa entra y sale del cuadro varias veces. El
muestreo pregunta por celda *"¿esto es agua?"*, que la normal del **segmento
más cercano** contesta bien en todas partes.

**El "más cercano" es lo esencial:** la convención de OSM solo vale
localmente. Medido contra una way real, un punto de mar abierto y uno en los
cerros caían del mismo lado, porque la costa curva entre medio. Cualquier
método que elija el segmento antes de conocer el punto se equivoca en una
bahía.

Está fijado por `reel.test.ts` contra `fixtures/bay-coastline.json` — la costa
real de una bahía, cacheada, para que el test no dependa de la red.

### El agua toma el rol `wordmark`, no `accent`

`accent` es el color del pin. Un mar pintado con él convierte el cuadro en una
masa plana con el marcador perdido adentro: el pin tiene que ser lo único del
mapa con ese color.

### Las referencias se topan en 12, y se eligen por dispersión

OSM devuelve decenas de features para una ciudad y dibujarlas todas sepulta el
mapa bajo texto encimado — el pin deja de encontrarse, que es lo único que el
mapa tiene que lograr. El prototipo lo evitaba con diez lugares elegidos a
mano, que es justo el contenido por-ciudad que este motor no puede cargar; el
tope reemplaza esa curaduría. La selección es por distancia mínima entre
elegidos, no por el orden que devolvió Overpass: doce etiquetas apiladas en un
barrio no orientan a nadie.

### Mapas y ítems van en tracks distintos

HyperFrames rechaza clips solapados en el mismo track, y el cross-fade
necesita el solape. Mapas en track 1, ítems en track 2.

### La pista de audio silenciosa no es opcional

HyperFrames emite el MP4 sin audio, y **varios reproductores de macOS se
quedan congelados en el primer frame con videos mudos**: el video *parece* roto
aunque esté bien. El script agrega la pista con FFmpeg. No suena nada — queda
libre para ponerle música en la plataforma.

### Overpass se cae seguido, y por eso hay caché

Devuelve HTML de error (o un 504) en vez de JSON cuando está saturado, así que
parsear la respuesta **es** el chequeo de salud. El motor prueba dos endpoints
en serie, nunca en paralelo — dos requests para una respuesta es la carga que
vuelve inusable un servicio gratuito— y da una segunda pasada con espera,
porque la saturación suele durar segundos.

Pero la respuesta de fondo es no volver a preguntar: **toda llamada a Overpass
y a Nominatim pasa por un caché en disco** (`osm-cache.ts` → `<repo>/.cache/`).
El mapa no cambia entre corridas: el bbox lo declara el perfil y es estable.

```
1a corrida:  ~40s + lo que tarde Overpass (o falla si está caído)
2a corrida:  ~40s, cero requests
```

Detalles que importan:

- **Se cachea la respuesta cruda, no el SVG.** El SVG es donde se cruzan la red
  y los tokens de marca; cachear ahí ataría la clave al `brand.json` y a
  constantes del motor, y una clave que depende de código es una clave que
  nadie mantiene bien. La clave es la query literal, que ya deriva de todos los
  inputs: si cambian los tags de un `reference_type`, la query cambia y el
  caché falla solo.
- **Vive en `<repo>/.cache/`, nunca en `profiles/<slug>/`.** Un perfil es una
  declaración transportable; un caché es un derivado con vencimiento. Copiar la
  carpeta de una marca a otra máquina debe llevarse la marca, no un snapshot de
  OSM de hace ocho meses.
- **TTL de 30 días** (180 para geocodificación: una dirección se mueve menos
  que una calle). Un mapa congelado para siempre es un bug lento.
- **Si la red falla y hay una entrada vencida, se usa y se avisa.** Caché caído
  no es render caído.
- **Siempre imprime de dónde salió el dato y qué edad tiene.** Un caché
  silencioso es una trampa; uno que se anuncia es una herramienta — sin esa
  línea la corrida deja de ser auditable desde su propia salida.
- `--no-cache` fuerza datos frescos.

Está ignorado por git, que es también lo que lo mantiene fuera de
`validate_commit_guardian.py --scan`: el scan recorre trackeados y no-ignorados,
así que quitar esa línea del `.gitignore` haría que el auditor leyera nombres de
calles cacheados como una fuga de marca.

**El criterio de aceptación debe seguir cumpliéndose con el caché frío.** Si
alguna vez pasa verde solo con caché caliente, el criterio se volvió mentira.

Este patrón ya existía sin que nadie lo notara: `fixtures/bay-coastline.json`
es exactamente esto — una respuesta de OSM guardada en disco para no depender
de la red — hecho para los tests. El caché es ese fixture, ascendido a parte
del motor.

---

## Requisitos

- **Node 22+**
- **FFmpeg** — para la pista de audio silenciosa
- Red, para Overpass y Nominatim (la primera vez que se genera un mapa)

HyperFrames se baja solo vía `npx`.
