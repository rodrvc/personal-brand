export type RGB = [number, number, number]

export type LogoVariantResult = {
  variant: 'dark' | 'light'
  ratio: number
  safe: boolean
}

export type FixedLogoResult = {
  ratio: number
  safe: boolean
  remedio: string | null
}

export type ReadableInkResult = {
  ink: string
  ratio: number
}

/** "#RRGGBB" -> [r,g,b] | null si el formato no es válido */
export function hexToRgb(hex: string): RGB | null

/** Luminancia relativa según WCAG 2.x */
export function luminance(rgb: RGB): number

/** Ratio de contraste entre dos colores. Va de 1 (idénticos) a 21 (blanco contra negro). */
export function contrast(a: string, b: string): number

/** ¿Cumple WCAG AA sobre ese fondo? */
export function passesAA(fg: string, bg: string, largeText?: boolean): boolean

/** Elige la variante de logo para un fondo dado. */
export function pickLogoVariant(
  bgHex: string,
  opts?: { darkInk?: string; lightInk?: string }
): LogoVariantResult

/** Contraste de un logo de color fijo, sin variantes. */
export function checkFixedLogo(logoHex: string, bgHex: string): FixedLogoResult

/** Tinta legible sobre un fondo: elige entre la tinta de marca y un fallback. */
export function readableInk(bgHex: string, candidates?: string[]): ReadableInkResult

/** [r,g,b] (0-255) -> [h,s,l] con h en grados (0-360) y s/l en 0-1. */
export function rgbToHsl(rgb: RGB): [number, number, number]

/** Describe una paleta de colores hex en palabras en inglés (p. ej. "a warm palette of amber and cream"), para un prompt de imagen. `undefined` si la lista está vacía o no trae hex válidos. */
export function describePaletteInWords(hexes: string[]): string | undefined
