/**
 * Color: contraste y elección de variante de logo.
 *
 * Sin dependencias del navegador: corre igual en Node, en el navegador
 * y dentro de la app de escritorio.
 */

/** "#RRGGBB" -> [r,g,b] | null si el formato no es válido */
export function hexToRgb(hex) {
  const m = /^#?([\da-f]{6})$/i.exec(String(hex).trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Luminancia relativa según WCAG 2.x */
export function luminance(rgb) {
  const c = rgb.map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/**
 * Ratio de contraste entre dos colores. Va de 1 (idénticos) a 21
 * (blanco contra negro).
 *
 * Referencia: WCAG AA pide 4.5 para texto normal y 3 para texto grande.
 */
export function contrast(a, b) {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  if (!ra || !rb) return 0
  const la = luminance(ra)
  const lb = luminance(rb)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** ¿Cumple WCAG AA sobre ese fondo? */
export function passesAA(fg, bg, largeText = false) {
  return contrast(fg, bg) >= (largeText ? 3 : 4.5)
}

/**
 * Elige la variante de logo para un fondo dado.
 *
 * Mide el contraste real de ambas variantes en vez de usar un umbral de
 * luminancia. Importa: sobre un verde neón claro gana el logo oscuro, y
 * sobre un rojo de saturación parecida puede ganar el claro. Un umbral
 * fijo se equivoca en esos casos.
 *
 * Ojo con los nombres: la variante se llama por la tinta del logo, no por
 * el fondo donde va. `dark` = tinta oscura = para fondos claros. Es la
 * fuente de error más común.
 *
 * @returns {{variant:'dark'|'light', ratio:number, safe:boolean}}
 */
export function pickLogoVariant(bgHex, { darkInk = '#000000', lightInk = '#FFFFFF' } = {}) {
  const cDark = contrast(darkInk, bgHex)
  const cLight = contrast(lightInk, bgHex)
  const variant = cDark >= cLight ? 'dark' : 'light'
  const ratio = Math.max(cDark, cLight)
  // 3:1 es el mínimo para elementos gráficos no textuales (WCAG 1.4.11).
  //
  // Con negro y blanco como tintas esto nunca falla: el peor fondo posible
  // (#757575) todavía da 4.61. La bandera importa cuando la marca trae
  // tintas propias —un logo bicolor, o uno de un solo color— que pueden
  // quedarse cortas sobre según qué fondo.
  return { variant, ratio, safe: ratio >= 3 }
}

/**
 * Contraste de un logo de color fijo, sin variantes.
 *
 * Es el caso donde de verdad hay que avisar: la marca tiene un logo en un
 * solo color y el fondo del afiche puede dejarlo ilegible.
 */
export function checkFixedLogo(logoHex, bgHex) {
  const ratio = contrast(logoHex, bgHex)
  return {
    ratio,
    safe: ratio >= 3,
    // Qué hacer si no alcanza, en orden de menor intrusión
    remedio: ratio >= 3 ? null
      : ratio >= 2 ? 'agrandar el logo'
      : 'poner el logo sobre una plancha de color o cambiar el fondo',
  }
}

/**
 * Tinta legible sobre un fondo: elige entre la tinta de marca y un
 * fallback, quedándose con la que más contraste dé.
 */
export function readableInk(bgHex, candidates = ['#000000', '#FFFFFF']) {
  let best = candidates[0]
  let bestRatio = 0
  for (const c of candidates) {
    const r = contrast(c, bgHex)
    if (r > bestRatio) {
      bestRatio = r
      best = c
    }
  }
  return { ink: best, ratio: bestRatio }
}
