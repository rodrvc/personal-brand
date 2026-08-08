/**
 * Tests del núcleo. Sin dependencias: `node core/test/run.mjs`
 */
import { contrast, pickLogoVariant, checkFixedLogo, hexToRgb, passesAA, readableInk } from '../src/color.js'
import { cellToPixels, cellToPercent, logoBox, safeArea, FORMATOS, ANCLAJES } from '../src/layout.js'
import { analyzePost, cutIndex, earlyBlankLine, estimateLines } from '../src/linkedin.js'

let pasan = 0
let fallan = 0
const fallos = []

function ok(nombre, cond, detalle = '') {
  if (cond) {
    pasan++
  } else {
    fallan++
    fallos.push(`${nombre}${detalle ? ' — ' + detalle : ''}`)
  }
}

function casi(nombre, actual, esperado, tol = 1) {
  ok(nombre, Math.abs(actual - esperado) <= tol, `esperado ${esperado}, obtenido ${actual}`)
}

// ─── color ──────────────────────────────────────────────────────────
ok('hex válido', JSON.stringify(hexToRgb('#00E5A0')) === '[0,229,160]')
ok('hex sin almohadilla', JSON.stringify(hexToRgb('00E5A0')) === '[0,229,160]')
ok('hex inválido devuelve null', hexToRgb('#GGG') === null)
ok('hex de 3 dígitos no se acepta', hexToRgb('#FFF') === null)

casi('contraste blanco/negro = 21', contrast('#FFFFFF', '#000000'), 21, 0.1)
casi('contraste consigo mismo = 1', contrast('#123456', '#123456'), 1, 0.01)
ok('contraste es simétrico', contrast('#FFF000', '#001122') === contrast('#001122', '#FFF000'))
ok('color inválido da 0', contrast('nope', '#000000') === 0)

ok('AA: negro sobre blanco pasa', passesAA('#000000', '#FFFFFF'))
ok('AA: gris claro sobre blanco falla', !passesAA('#BBBBBB', '#FFFFFF'))

// El caso que motivó medir en vez de usar umbral:
const verde = pickLogoVariant('#00E5A0')
ok('logo sobre verde neón usa tinta oscura', verde.variant === 'dark', `dio ${verde.variant}`)
const rojo = pickLogoVariant('#C4361B')
ok('logo sobre rojo oscuro usa tinta clara', rojo.variant === 'light', `dio ${rojo.variant}`)
ok('logo sobre fondo oscuro usa tinta clara', pickLogoVariant('#0D1117').variant === 'light')
ok('logo sobre fondo claro usa tinta oscura', pickLogoVariant('#FFF8F0').variant === 'dark')
// Con negro y blanco disponibles, el peor fondo posible sigue siendo
// legible: el mínimo absoluto es 4.61 sobre #757575.
ok('con ambas variantes, cualquier fondo es seguro',
   pickLogoVariant('#757575').safe === true)
ok('el peor caso ronda 4.6',
   Math.abs(pickLogoVariant('#757575').ratio - 4.61) < 0.05)

// El aviso real: logo de color fijo sobre un fondo que no contrasta
const fijoMal = checkFixedLogo('#00E5A0', '#FFF8F0')
ok('logo fijo ilegible se marca', fijoMal.safe === false, `ratio ${fijoMal.ratio.toFixed(2)}`)
ok('logo fijo ilegible sugiere remedio', typeof fijoMal.remedio === 'string')
const fijoBien = checkFixedLogo('#0D1117', '#FFF8F0')
ok('logo fijo legible pasa sin aviso', fijoBien.safe === true && fijoBien.remedio === null)

ok('readableInk elige blanco sobre oscuro', readableInk('#0D1117').ink === '#FFFFFF')
ok('readableInk elige negro sobre claro', readableInk('#FFF8F0').ink === '#000000')

// ─── layout ─────────────────────────────────────────────────────────
// Los mismos valores que verificó el spike de Satori
const c1 = cellToPixels(2, 3, 10, 3, '4:5')
ok('celda 4:5 exacta', c1.x === 90 && c1.y === 225 && c1.w === 900 && c1.h === 338,
   JSON.stringify(c1))

const c2 = cellToPixels(1, 11, 12, 2, '16:9')
ok('banda inferior 16:9 exacta', c2.x === 0 && c2.y === 900 && c2.w === 1920 && c2.h === 180,
   JSON.stringify(c2))

const p = cellToPercent(2, 3, 10, 3)
ok('porcentajes correctos',
   p.left === `${(1 / 12) * 100}%` && p.width === `${(10 / 12) * 100}%`)

// La celda completa debe cubrir la pieza entera en todos los formatos
for (const f of Object.keys(FORMATOS)) {
  const full = cellToPixels(1, 1, 12, 12, f)
  ok(`celda completa cubre ${f}`,
     full.x === 0 && full.y === 0 && full.w === FORMATOS[f].w && full.h === FORMATOS[f].h)
}

// Logo: los 9 anclajes deben caer dentro de la pieza
for (const a of ANCLAJES) {
  const b = logoBox(a, '4:5')
  const dentro = b.x >= 0 && b.y >= 0 &&
                 b.x + b.w <= FORMATOS['4:5'].w && b.y + b.h <= FORMATOS['4:5'].h
  ok(`logo ${a} dentro de la pieza`, dentro, JSON.stringify(b))
}

const tl = logoBox('top-left', '1:1', { paddingPct: 8 })
casi('logo top-left respeta el margen', tl.x, Math.round(0.08 * 1080))
const br = logoBox('bottom-right', '1:1', { paddingPct: 8, heightPct: 6, aspect: 3 })
casi('logo bottom-right pegado al margen derecho',
     br.x + br.w, Math.round(1080 - 0.08 * 1080))

const mc = logoBox('mid-center', '1:1')
casi('logo centrado en horizontal', mc.x + mc.w / 2, 540, 2)

const sa = safeArea('4:5', 8)
ok('caja segura simétrica', sa.x === sa.y && sa.w === 1080 - sa.x * 2)

ok('formato desconocido lanza error', (() => {
  try { cellToPixels(1, 1, 2, 2, 'nope'); return false } catch { return true }
})())
ok('anclaje desconocido lanza error', (() => {
  try { logoBox('centro', '1:1'); return false } catch { return true }
})())

// ─── linkedin ───────────────────────────────────────────────────────
const corto = 'Un gancho breve.'
ok('texto corto no se trunca', cutIndex(corto, 508) === -1)

const largo = 'a'.repeat(2000)
const iL = cutIndex(largo, 508)
ok('texto largo sí se trunca', iL > 0 && iL < 2000, `índice ${iL}`)

// El hallazgo clave: la línea en blanco temprana gasta espacio visible
const sinBlanco = 'Línea uno que ocupa espacio. Línea dos que sigue. Línea tres aquí.'
const conBlanco = 'Línea uno.\n\nLínea dos que sigue. Línea tres aquí y más texto para desbordar el límite visible del post.'
const iSin = cutIndex(sinBlanco.repeat(6), 508)
const iCon = cutIndex(conBlanco.repeat(6), 508)
ok('línea en blanco reduce el texto visible', iCon < iSin, `con=${iCon} sin=${iSin}`)

const eb = earlyBlankLine('Gancho.\n\nDesarrollo.')
ok('detecta línea en blanco temprana', eb.found && eb.atLine === 2)
ok('no marca cuando la blanca va tarde',
   !earlyBlankLine('a\nb\nc\n\nd').found)

ok('estimateLines cuenta saltos duros', estimateLines('a\nb\nc', 500) === 3)

const a1 = analyzePost('x'.repeat(3200))
ok('detecta exceso de caracteres', !a1.withinLimit && a1.avisos.some(v => v.nivel === 'error'))

const a2 = analyzePost('x'.repeat(1500))
ok('reconoce el rango óptimo', a2.inSweetSpot)

const a3 = analyzePost('Corto.')
ok('avisa cuando es muy corto', a3.avisos.some(v => v.nivel === 'nota'))

const a4 = analyzePost('Gancho.\n\n' + 'texto '.repeat(300))
ok('reporta la línea en blanco temprana',
   a4.earlyBlankLine.found && a4.avisos.some(v => v.mensaje.includes('línea en blanco')))

// ─── resultado ──────────────────────────────────────────────────────
console.log(`\n  ${pasan} pasan, ${fallan} fallan\n`)
if (fallos.length) {
  console.log('  Fallos:')
  fallos.forEach(f => console.log('   - ' + f))
  console.log()
  process.exit(1)
}
