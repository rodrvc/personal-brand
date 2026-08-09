# Esquema de configuración de perfil

Cada perfil puede tener un archivo `profiles/<perfil>/config.yaml`.

## Estructura sugerida

```yaml
profile:
  slug: example
  name: Nombre Apellido
  title: Rol principal
  primary_language: es

channels:
  active:
    - linkedin
    - youtube
  primary: linkedin

content:
  pillars:
    - pilar-1
    - pilar-2
  default_cta_style: question
  default_hashtags:
    - AI
    - Tech
  valid_states:
    - Idea
    - Borrador
    - Listo
    - Publicado
    - Archivado

tone:
  style:
    - directo
    - opinionado
  avoid:
    - frases-vacias
    - humo

notion:
  enabled: false
  database_id: ""
  parent_page_id: ""

outputs:
  base_dir: ~/Pictures/<marca>/carruseles
  brand_message: presentacion-marca
```

## Campos

### `profile`
- `slug`: identificador de carpeta
- `name`: nombre visible del autor o marca
- `title`: posicionamiento principal
- `primary_language`: idioma por defecto

### `channels`
- `active`: canales habilitados
- `primary`: canal principal

### `content`
- `pillars`: pilares editoriales
- `default_cta_style`: estilo por defecto del cierre (`question`, `opinion`, `soft-cta`)
- `default_hashtags`: hashtags reutilizables
- `valid_states`: estados permitidos para el pipeline

### `tone`
- `style`: rasgos deseados de la voz
- `avoid`: patrones a evitar

### `notion`
- `enabled`: activa o desactiva integración
- `database_id`: base de datos destino
- `parent_page_id`: página contenedora opcional

### `outputs`
- `base_dir`: raíz donde se escriben los renders (relativa al perfil, o
  absoluta / con `~` para dejarlos fuera del repo). Suele ir en
  `config.local.yaml` por ser específica de la máquina.
- `brand_message`: subcarpeta para el carrusel de `render-brand.ts`. Si no se
  declara, cae a la clave misma (`brand_message`).

---

# Datos de marca: `brand-spec.md` + `brand.json`

Los perfiles que generan piezas visuales (carruseles) necesitan además sus
**tokens de marca**. Viven en dos archivos con propósitos distintos:

| Archivo | Para quién | Contenido |
|---|---|---|
| `profiles/<perfil>/brand-spec.md` | humanos | paleta con **la fuente de cada color** (dónde se verificó), tipografías, usos permitidos/prohibidos del logo, keywords de tono, notas de completitud |
| `profiles/<perfil>/brand.json` | el motor de render | los mismos valores, sin prosa, en la forma que consume `system/ig-carousel/` |

El `.md` es la fuente de verdad: es el único que puede explicar *por qué* un
color es el que es. El `.json` es su forma compilada. Al cambiar algo, se
edita primero el `.md` y luego se refleja en el `.json`.

## Estructura de `brand.json`

```json
{
  "locale": "es-CL",
  "colors":  { "<nombre>": "#rrggbb" },
  "roles":   { "accent": "<nombre>", "wordmark": "...", "surface": "...",
               "onSurface": "...", "onSurfaceMuted": "...",
               "flourish": "...", "highlight": "..." },
  "fonts":   { "logo": "...", "body": "...", "handwritten": "..." },
  "googleFontsHref": "https://fonts.googleapis.com/css2?...",
  "radius":  { "card": "12px" },

  "gradients": { "<nombre>": "linear-gradient(...)" },
  "categories": {
    "fallback": { "solid": "#rrggbb" },
    "byName": { "<Categoría>": { "solid": "#rrggbb", "gradient": "..." } }
  },
  "copy":  { "wordmark": "...", "site": "...",
             "listFormat": { ... }, "brandMessage": { ... } },
  "dates": { "monthAbbr": ["ene", "..."], "weekRangeSameMonth": "...",
             "weekRangeCrossMonth": "..." }
}
```

## Núcleo obligatorio vs bloques por template

Solo el **núcleo** es obligatorio para todo perfil, porque lo lee cualquier
template: `colors`, `roles`, `fonts`, `radius`, `copy.wordmark` y `copy.site`.

Todo lo demás es **opt-in y se valida por template**. Cada script declara qué
necesita al cargar la marca:

| Feature | Quién la pide | Qué exige |
|---|---|---|
| `categories` | templates que colorean por categoría | `categories.fallback` + `byName` |
| `dates` | scripts con rango semanal (`render-week`) | `monthAbbr` (12) + los dos patrones |
| `listFormat` | template `list-format` | `copy.listFormat.*` |
| `brandMessage` | template `brand-message` | `copy.brandMessage.footerCta` |
| `reel` | motor `system/ig-reel/` | `copy.reel.*` + `gradients.cover` |

Pero esa lista **no se escribe a mano en cada script**. Cada template declara
lo que lee, junto al código que lo lee:

```ts
// templates/list-format.ts
renderListFormat.features = ["categories", "listFormat"] as const;
```

y los scripts la derivan con `featuresOf()`:

```ts
// render-brand.ts: solo tipografía, no toca categorías ni fechas
const brand = loadBrand(profileDir, featuresOf([renderBrandMessage]));

// render-week.ts: lo del template + "dates", que lo usa el script mismo
const brand = loadBrand(profileDir, featuresOf([renderListFormat], "dates"));
```

Esto importa: si la lista se tipeara en cada call site, un script que usa
`list-format` pero olvida declarar `"listFormat"` igual funcionaría contra un
perfil rico en datos y recién fallaría, en render, contra uno más pobre.
Derivándola del template el olvido deja de ser posible.

Consecuencias deliberadas:

- Un perfil de **marca personal** que solo usa `brand-message` no declara
  taxonomía de categorías, ni los 12 meses, ni copy de listado — y carga.
  Ver `profiles/example-personal/`, que existe justamente como esa prueba.

  Lo que ese perfil **sí** necesita es su `recipes/brand-message.yaml`, aunque
  quede casi vacío: es donde declara de dónde pueden venir sus imágenes, y el
  motor lo exige en cuanto una slide trae `image`. Contrato en
  `system/recipes/brand-message.md`.
- Agregar un **sexto template** no rompe ningún perfil existente: su bloque
  `copy.<template>` es opcional y nadie valida un bloque que no se pidió.
- El **motor de reels** (`system/ig-reel/`) es la prueba de que eso escala más
  allá de un template: se sumó entero — otro formato, otro medio de salida —
  sin tocar un solo `brand.json` existente. Un perfil que solo publica
  carruseles nunca declara `copy.reel` y sigue cargando igual.

  Lo que **sí** pide, vía la feature `reel`:

  ```jsonc
  "copy": {
    "reel": {
      "coverTitle":    "...",   // portada, en la tipografía de logo
      "coverSubtitle": "en {city}",
      "coverCount":    "{count} ... de la semana",
      "closingCta":    "..."    // antecede a copy.site en el cierre
    }
  },
  "gradients": { "cover": "linear-gradient(180deg, ...)" }
  ```

  `coverTitle` y `coverSubtitle` son dos campos y no una sola frase con la
  ciudad adentro porque llevan tipografías distintas: el título va en la cara
  de logo y el subtítulo en la de cuerpo. `{city}` sale del input del reel
  —geografía del contenido—, nunca de un token de marca; `{count}` lo pone el
  motor con los ítems que sobrevivieron la verificación.

  `gradients.cover` es **obligatorio** para esta feature en vez de caer a un
  color plano: portada y cierre son las dos tarjetas a sangre de la pieza, y
  un perfil que no lo declarara obtendría en silencio un video más apagado que
  el que el motor sabe hacer. Nombrar la clave que falta es barato; descubrir
  la tarjeta plana después de publicar, no.

Claves del diseño:

- **`roles`** mapea roles semánticos a nombres de la propia paleta. Los
  templates piden `accent`, nunca "terracotta" — así una marca con otros
  nombres de color funciona sin tocar el motor.
- **`categories.byName`** es data, no tipos: cada perfil usa la taxonomía que
  quiera, en el idioma que quiera. Lo no listado cae a `fallback`.
- **`googleFontsHref` es opcional.** Si se omite no se emite ningún `<link>`
  de fuentes: un perfil con fuentes del sistema no hace pedidos externos.
- **`copy`** contiene los textos fijos de las plantillas. `{city}` y
  `{region}` se interpolan.
- **La geografía NO va aquí.** Tanto `city` como `region` viajan en el input
  del carrusel (`carousels/*.json`, al tope), porque describen *el contenido*:
  una marca puede cubrir varias ciudades y regiones sin duplicar sus tokens.
- **Las carpetas de salida NO van aquí.** Dónde se escriben los archivos es
  una decisión de output, no de marca: viven en el bloque `outputs:` de
  `config.yaml` (junto a `base_dir`), p. ej. `brand_message: presentacion-marca`.
- **La procedencia de los datos NO va aquí.** `sourceImageHosts` vivió un
  tiempo en este archivo y era el lugar equivocado: es una aserción sobre *de
  dónde salió el dato*, del mismo linaje que `source.url` y
  `field_map.image` del recipe — no un token de presentación como un color o
  una tipografía. Ahora se declara en `<perfil>/recipes/<recipe>.yaml` bajo
  `source.image_hosts` y viaja al motor en el input del carrusel (ver más
  abajo). Un perfil que cambia de fuente cambia su recipe, no su paleta.

  `loadBrand()` **falla** si encuentra `sourceImageHosts` (o el singular) en un
  `brand.json`, en vez de ignorarlo: una clave huérfana ahí leería como un
  chequeo activo que en realidad nadie consume.

`loadBrand()` (en `system/ig-carousel/brand-schema.ts`) valida el archivo al
cargarlo y falla nombrando la clave que falta, en vez de dejar `undefined`
dentro del CSS de un PNG ya publicado. Pero solo valida lo que el template
invocado realmente consume — no el esquema entero.

---

# Contrato de datos del carrusel: `carousels/*.json`

Lo que describe **el contenido** (no la marca) viaja acá:

```json
{
  "city": "<Ciudad>",
  "region": "<País o región>",
  "sourceImageHosts": ["<host>"],
  "slides": [
    {
      "image": "https://...",
      "title": "Cerati Sinfónico",
      "subtitle": "Vie 7 Ago, 20:00",
      "time": "20:00",
      "meta": "Teatro Municipal",
      "category": "Música",
      "date": "2026-08-07"
    }
  ]
}
```

- `city` / `region`: geografía de este lote de contenido. Se interpolan en el
  copy (`{city}`, `{region}`).
- `sourceImageHosts` (**opcional**): hosts de los que pueden venir las `image`
  de este lote. Con la clave presente, el motor descarta cualquier slide cuya
  imagen apunte a otro host — el caso real fue una URL *compuesta* a mano en vez
  de copiada, que renderiza una tarjeta apuntando a un archivo inexistente.

  Va acá y no en `brand.json` porque describe **la procedencia del contenido**,
  igual que `city`. Y va en el archivo y no en un flag porque **el mismo paso
  que escribe las `image` escribe los hosts que deben cumplir**: la aserción no
  puede quedar desfasada del dato que restringe, y una clave ausente se ve al
  leer el archivo mientras un flag olvidado no deja rastro.

  Se valida al cargar y de forma estricta, porque guarda un *chequeo* y no un
  valor renderizado: el singular `sourceImageHost`, un string en vez de un
  array, o un array vacío son **errores**, no claves ignoradas. Cualquiera de
  los tres dejaría el chequeo desarmado mientras el archivo lee como cubierto.
  Omitir la clave del todo sí es válido: es "mis imágenes pueden estar en
  cualquier parte".

  Los hosts son **literales y no hay comodines**, ni acá ni en el
  `source.image_hosts` del recipe que esta clave copia. `"*"` es error de carga:
  como la comparación es contra el host exacto, no calzaba con nada y
  **descartaba todas las imágenes** en vez de permitirlas — fallaba cerrado por
  accidente, culpando al dato. Y soportarlo de verdad sería un interruptor de
  apagado, dentro del dato vigilado, para el chequeo que vigila ese dato: un
  perfil podría desactivarlo dejando el archivo con cara de tenerlo encendido.
  "Cualquier parte" se dice **borrando la clave**, que es la única forma en que
  no queda una allowlist que se pueda leer como activa.

  **El recipe manda.** Si el recipe del perfil declara `source.image_hosts`,
  esta clave sólo puede repetirlo o quedarse corta: agregar un host que el
  recipe no declaró es error, porque el mismo paso que escribe las `image`
  escribiría la lista que esas URLs deben cumplir. Ver
  `system/recipes/weekly-roundup.md` y `system/recipes/brand-message.md`.
- `date` (**opcional en el contrato, obligatorio en la práctica para un script
  con período**): la fecha del ítem en `YYYY-MM-DD`. No se renderiza nunca — lo
  visible es `meta`/`subtitle` — pero es lo que permite comprobar que el ítem
  pertenece al período que anuncia el encabezado.

  El contrato la deja opcional porque hay contenido que no es fechado, pero
  `render-week.ts` **se niega a renderizar** si *ningún* slide del lote la trae:
  cada slide sin fecha aprueba la comprobación por separado, así que 0 de N
  fechados daba el mismo resultado que un lote verificado. Ese era exactamente
  el estado en que se publicó un carrusel con eventos de una semana bajo el
  título de otra.
- `time` (**opcional**): la hora como dato estructurado. Si no está, no se
  renderiza el chip de hora. El motor **no** infiere la hora leyendo
  `subtitle`: antes hacía regex sobre texto libre y, si fallaba, metía un
  fragmento arbitrario dentro de un chip con ícono de reloj — sin error y sin
  warning. Si un contenido tiene hora, lo dice quien publica.
- `image` (**opcional**): sin imagen la tarjeta colapsa a la columna de texto;
  no reserva un cuadro vacío.

---

## Regla práctica

- `profile.md` = contexto humano y narrativo
- `config.yaml` = valores operativos y parametrizables
- `brand-spec.md` = decisiones de marca y su procedencia
- `brand.json` = esas mismas decisiones, compiladas para el motor

Evitar duplicar datos salvo que haga falta por claridad. La duplicación entre
`brand-spec.md` y `brand.json` es deliberada y direccional: el `.md` lleva el
porqué (que el JSON no puede expresar), el `.json` lleva la forma que el
motor sabe leer.
