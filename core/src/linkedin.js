/**
 * LinkedIn: límites del post y dónde cae el corte de "…ver más".
 *
 * Lo importante: LinkedIn NO corta por número de caracteres, corta a las
 * 3 líneas visuales. Los "210 caracteres" que circulan son consecuencia
 * del ancho del contenedor, no una regla.
 *
 * Efecto práctico: una línea en blanco temprana se come una de las 3
 * líneas. Por eso un gancho corto a veces se trunca igual. La herramienta
 * tiene que hacer visible ese error.
 */

export const LIMITE_CARACTERES = 3000
export const RANGO_OPTIMO = { min: 1300, max: 1900 }

/** Anchos del cuerpo del post, ya descontado el padding */
export const ANCHOS = {
  desktop: 540 - 32,
  mobile: 375 - 32,
}

export const LINEAS_VISIBLES = 3

/**
 * Estima cuántas líneas ocupa un texto.
 *
 * Sin DOM: aproxima el ancho de cada carácter. Menos exacto que medir en
 * el navegador, pero sirve para validar en Node y en la app.
 *
 * Cuando hay DOM disponible, usar `cutIndexWithMeasure` con un medidor real.
 */
export function estimateLines(text, widthPx, { charWidth = 7.6 } = {}) {
  const porLinea = Math.max(1, Math.floor(widthPx / charWidth))
  let lineas = 0
  // Los saltos de línea son duros: cada párrafo empieza en línea nueva
  for (const parrafo of String(text).split('\n')) {
    lineas += parrafo.length === 0 ? 1 : Math.ceil(parrafo.length / porLinea)
  }
  return lineas
}

/**
 * Índice del carácter donde cae el corte, o -1 si no se trunca.
 *
 * @param {string} text
 * @param {number} widthPx
 * @param {(t:string)=>number} measureLines  función que devuelve cuántas
 *   líneas ocupa un texto. En el navegador se le pasa un medidor real del
 *   DOM; si se omite, se usa la estimación.
 */
export function cutIndex(text, widthPx, measureLines) {
  const medir = measureLines || ((t) => estimateLines(t, widthPx))
  if (medir(text) <= LINEAS_VISIBLES) return -1

  // Búsqueda binaria: el texto más largo que aún cabe en 3 líneas
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (medir(text.slice(0, mid)) <= LINEAS_VISIBLES) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Detecta el error más común: una línea en blanco dentro de las primeras
 * 3 líneas, que desperdicia espacio visible del gancho.
 */
export function earlyBlankLine(text) {
  const lineas = String(text).split('\n')
  for (let i = 0; i < Math.min(lineas.length, LINEAS_VISIBLES); i++) {
    if (lineas[i].trim() === '') {
      return { found: true, atLine: i + 1 }
    }
  }
  return { found: false, atLine: null }
}

/**
 * Revisión completa de un post: longitud, corte y avisos.
 */
export function analyzePost(text) {
  const len = String(text).length
  const cutDesktop = cutIndex(text, ANCHOS.desktop)
  const cutMobile = cutIndex(text, ANCHOS.mobile)
  const blank = earlyBlankLine(text)

  const avisos = []
  if (len > LIMITE_CARACTERES) {
    avisos.push({
      nivel: 'error',
      mensaje: `Supera el límite de LinkedIn por ${len - LIMITE_CARACTERES} caracteres.`,
    })
  } else if (len > LIMITE_CARACTERES * 0.9) {
    avisos.push({ nivel: 'aviso', mensaje: 'Cerca del límite de 3.000 caracteres.' })
  }
  if (len < RANGO_OPTIMO.min) {
    avisos.push({
      nivel: 'nota',
      mensaje: `Corto: el rango que suele rendir mejor es ${RANGO_OPTIMO.min}-${RANGO_OPTIMO.max}.`,
    })
  }
  if (blank.found) {
    avisos.push({
      nivel: 'aviso',
      mensaje: `Hay una línea en blanco en la línea ${blank.atLine}: gasta espacio del gancho antes del "ver más".`,
    })
  }

  return {
    length: len,
    withinLimit: len <= LIMITE_CARACTERES,
    inSweetSpot: len >= RANGO_OPTIMO.min && len <= RANGO_OPTIMO.max,
    cutDesktop,
    cutMobile,
    truncates: cutDesktop >= 0,
    earlyBlankLine: blank,
    avisos,
  }
}
