export const GRID: number

export type FormatoId = '1:1' | '4:5' | '9:16' | '16:9' | 'A4'

export type Formato = { w: number; h: number; nombre: string }

export const FORMATOS: Record<FormatoId, Formato>

export type Anclaje =
  | 'top-left' | 'top-center' | 'top-right'
  | 'mid-left' | 'mid-center' | 'mid-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right'

export const ANCLAJES: Anclaje[]

export type PercentBox = {
  position: 'absolute'
  left: string
  top: string
  width: string
  height: string
}

export type PixelBox = { x: number; y: number; w: number; h: number }

/** Celda de la grilla -> caja en porcentajes. */
export function cellToPercent(
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number
): PercentBox

/** Celda -> caja en píxeles, para un formato concreto. */
export function cellToPixels(
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
  formato: FormatoId | Formato
): PixelBox

/** Posición del logo dentro de la caja segura. */
export function logoBox(
  anchor: Anclaje,
  formato: FormatoId | Formato,
  opts?: { heightPct?: number; aspect?: number; paddingPct?: number }
): PixelBox

/** Caja segura: el área utilizable descontando el margen. */
export function safeArea(formato: FormatoId | Formato, paddingPct?: number): PixelBox
