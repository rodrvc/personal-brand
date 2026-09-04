export const LIMITE_CARACTERES: number

export const RANGO_OPTIMO: { min: number; max: number }

export const ANCHOS: { desktop: number; mobile: number }

export const LINEAS_VISIBLES: number

/** Estima cuántas líneas ocupa un texto. */
export function estimateLines(
  text: string,
  widthPx: number,
  opts?: { charWidth?: number }
): number

/** Índice del carácter donde cae el corte, o -1 si no se trunca. */
export function cutIndex(
  text: string,
  widthPx: number,
  measureLines?: (t: string) => number
): number

export type EarlyBlankLineResult = { found: boolean; atLine: number | null }

/** Detecta una línea en blanco dentro de las primeras 3 líneas. */
export function earlyBlankLine(text: string): EarlyBlankLineResult

export type Aviso = { nivel: 'error' | 'aviso' | 'nota'; mensaje: string }

export type AnalyzePostResult = {
  length: number
  withinLimit: boolean
  inSweetSpot: boolean
  cutDesktop: number
  cutMobile: number
  truncates: boolean
  earlyBlankLine: EarlyBlankLineResult
  avisos: Aviso[]
}

/** Revisión completa de un post: longitud, corte y avisos. */
export function analyzePost(text: string): AnalyzePostResult
