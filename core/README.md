# core — la lógica del sistema

Funciones puras, sin navegador ni base de datos. Corren igual en Node, en
una web o dentro de una app de escritorio.

Es la parte que **no cambia** aunque cambie la interfaz. Por eso está
separada: si mañana esto es una app instalable en vez de un HTML, este
código se queda tal cual.

```bash
node core/test/run.mjs     # 54 tests, sin instalar nada
```

## Qué hay

### `color.js` — contraste y logos

```js
import { contrast, pickLogoVariant, checkFixedLogo } from './core/src/color.js'

contrast('#FFFFFF', '#000000')   // 21
pickLogoVariant('#00E5A0')       // { variant: 'dark', ratio: 12.4, safe: true }
```

`pickLogoVariant` **mide** el contraste de las dos variantes en vez de usar
un umbral de luminancia. Importa: sobre verde neón gana la tinta oscura,
sobre rojo del mismo brillo puede ganar la clara. Un umbral fijo falla ahí.

Las variantes se llaman por la tinta del logo, no por el fondo:
`dark` = tinta oscura = va sobre fondos claros.

Dato del análisis: teniendo negro y blanco disponibles, **ningún fondo baja
de 4.61 de contraste** (el peor es `#757575`). El aviso de ilegibilidad solo
importa con logos de un color fijo — para eso está `checkFixedLogo`.

### `layout.js` — grilla de afiches

```js
import { cellToPixels, logoBox } from './core/src/layout.js'

cellToPixels(2, 3, 10, 3, '4:5')   // { x: 90, y: 225, w: 900, h: 338 }
logoBox('bottom-right', '4:5')     // { x: 799, y: 1178, w: 194, h: 65 }
```

Los templates se declaran en una grilla de 12×12 y esto la traduce a
píxeles o porcentajes.

**No se usa CSS Grid**: Satori, el motor que exporta a imagen, lo rechaza.
Verificado — ver `docs/spike-satori.md`. La traducción a posiciones
absolutas da resultados exactos al píxel, comprobados contra el render real
de Satori en los 5 formatos.

Formatos: `1:1`, `4:5`, `9:16`, `16:9`, `A4`.

### `linkedin.js` — límites y corte del post

```js
import { analyzePost } from './core/src/linkedin.js'

analyzePost(texto)
// { length, withinLimit, inSweetSpot, cutDesktop, cutMobile,
//   truncates, earlyBlankLine, avisos }
```

LinkedIn **no corta por caracteres, corta a las 3 líneas visuales**. Los
"210 caracteres" que circulan son consecuencia del ancho, no una regla.

Efecto práctico que la herramienta debe mostrar: una línea en blanco
temprana se come una de las 3 líneas visibles, así que un gancho corto se
trunca igual. `earlyBlankLine` lo detecta.

Sin DOM, el conteo de líneas es una estimación. En el navegador se le puede
pasar un medidor real:

```js
cutIndex(texto, ancho, (t) => medirConDOM(t))
```

## Nota de diseño

Nada de aquí sabe de dónde vienen los datos ni dónde se muestran. Esa es la
propiedad que hace que la interfaz sea intercambiable.
