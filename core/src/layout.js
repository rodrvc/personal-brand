/**
 * Layout de afiches: traduce la grilla 12×12 de los templates a cajas
 * concretas.
 *
 * Por qué no se usa CSS Grid: Satori —el motor que exporta a imagen— lo
 * rechaza. Ver `docs/spike-satori.md`. El posicionamiento absoluto en
 * porcentajes da resultados exactos al píxel en los 5 formatos.
 */

export const GRID = 12

/** Formatos soportados, en píxeles */
export const FORMATOS = {
  '1:1': { w: 1080, h: 1080, nombre: 'Cuadrado' },
  '4:5': { w: 1080, h: 1350, nombre: 'Vertical (carrusel)' },
  '9:16': { w: 1080, h: 1920, nombre: 'Historia' },
  '16:9': { w: 1920, h: 1080, nombre: 'Horizontal' },
  A4: { w: 1240, h: 1754, nombre: 'A4 impresión' },
}

/** Las 9 posiciones de anclaje */
export const ANCLAJES = [
  'top-left', 'top-center', 'top-right',
  'mid-left', 'mid-center', 'mid-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

/**
 * Celda de la grilla -> caja en porcentajes.
 * Para el preview en el navegador (CSS) y para Satori: ambos entienden %.
 *
 * @param {number} col     columna inicial, 1..12
 * @param {number} row     fila inicial, 1..12
 * @param {number} colSpan cuántas columnas ocupa
 * @param {number} rowSpan cuántas filas ocupa
 */
export function cellToPercent(col, row, colSpan, rowSpan) {
  return {
    position: 'absolute',
    left: `${((col - 1) / GRID) * 100}%`,
    top: `${((row - 1) / GRID) * 100}%`,
    width: `${(colSpan / GRID) * 100}%`,
    height: `${(rowSpan / GRID) * 100}%`,
  }
}

/** Celda -> caja en píxeles, para un formato concreto. */
export function cellToPixels(col, row, colSpan, rowSpan, formato) {
  const f = typeof formato === 'string' ? FORMATOS[formato] : formato
  if (!f) throw new Error(`Formato desconocido: ${formato}`)
  return {
    x: Math.round(((col - 1) / GRID) * f.w),
    y: Math.round(((row - 1) / GRID) * f.h),
    w: Math.round((colSpan / GRID) * f.w),
    h: Math.round((rowSpan / GRID) * f.h),
  }
}

/**
 * Posición del logo dentro de la caja segura.
 *
 * Se ancla contra el margen interior, no contra el borde de la pieza:
 * un logo pegado al canto se ve como un error de maquetación.
 *
 * @param {string} anchor   una de ANCLAJES
 * @param {object} opts
 * @param {number} opts.heightPct  alto del logo, % de la dimensión menor
 * @param {number} opts.aspect     ancho/alto del logo (1 = cuadrado)
 * @param {number} opts.paddingPct margen de seguridad, % del lado menor
 */
export function logoBox(anchor, formato, { heightPct = 6, aspect = 3, paddingPct = 8 } = {}) {
  const f = typeof formato === 'string' ? FORMATOS[formato] : formato
  if (!f) throw new Error(`Formato desconocido: ${formato}`)
  if (!ANCLAJES.includes(anchor)) throw new Error(`Anclaje desconocido: ${anchor}`)

  const menor = Math.min(f.w, f.h)
  const pad = (paddingPct / 100) * menor
  const h = (heightPct / 100) * menor
  const w = h * aspect

  const [vert, horiz] = anchor.split('-')

  let x
  if (horiz === 'left') x = pad
  else if (horiz === 'right') x = f.w - pad - w
  else x = (f.w - w) / 2

  let y
  if (vert === 'top') y = pad
  else if (vert === 'bottom') y = f.h - pad - h
  else y = (f.h - h) / 2

  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * Caja segura: el área utilizable descontando el margen.
 * Nada importante debería salirse de aquí.
 */
export function safeArea(formato, paddingPct = 8) {
  const f = typeof formato === 'string' ? FORMATOS[formato] : formato
  if (!f) throw new Error(`Formato desconocido: ${formato}`)
  // Se redondea el margen primero y se derivan las medidas de él, para que
  // x + w == ancho - x siempre. Redondear cada valor por separado deja
  // desfases de 1px que se ven al centrar.
  const pad = Math.round((paddingPct / 100) * Math.min(f.w, f.h))
  return {
    x: pad,
    y: pad,
    w: f.w - pad * 2,
    h: f.h - pad * 2,
  }
}
