# Spike: exportar afiches a imagen con Satori

**Fecha:** 2026-08-04
**Pregunta:** ¿puede Satori renderizar los templates de afiche a PNG?
**Respuesta:** sí, con un ajuste. El riesgo queda descartado.

---

## Lo que se probó

Satori (HTML/CSS → SVG) + resvg (SVG → PNG). Es la cadena que usaría la app
para exportar afiches y carruseles.

## Hallazgo 1: Satori NO soporta CSS Grid

Rechazo explícito:

```
Invalid value for CSS property "display".
Allowed values: "flex" | "block" | "contents" | "none" | "-webkit-box".
Received: "grid".
```

Los templates se habían especificado en grilla 12×12 asumiendo que
`grid-area` mapeaba 1:1 con CSS Grid, sin traducción. **Esa asunción era
falsa** para el export.

## Hallazgo 2: el fallback funciona perfecto

La grilla 12×12 se traduce a posicionamiento absoluto en porcentajes:

```js
const cell = (col, row, colSpan, rowSpan) => ({
  position: 'absolute',
  left:   `${((col - 1) / 12) * 100}%`,
  top:    `${((row - 1) / 12) * 100}%`,
  width:  `${(colSpan / 12) * 100}%`,
  height: `${(rowSpan / 12) * 100}%`,
})
```

**Resultado: 20/20 celdas exactas al píxel** en los 5 formatos
(1:1, 4:5, 9:16, 16:9, A4). Solo 1px de diferencia por redondeo en A4.

La grilla normalizada sigue siendo la decisión correcta — lo que cambia
es cómo se traduce al renderizar.

## Hallazgo 3: el texto sale como vectores

Satori convierte el texto a `<path>`, no a `<text>`. Consecuencias:

- El texto no es seleccionable en el SVG (irrelevante: el destino es PNG).
- No depende de que la fuente esté instalada en la máquina que abre el archivo.
- **Para verificar posiciones en tests hay que medir las máscaras
  `<mask><rect>`, no buscar elementos `<text>`.**

## Hallazgo 4: los colores salen exactos

`#00E5A0` entra y sale idéntico. Confirma que declarar `accent_soft`
explícito en `brand.yaml` —en vez de calcularlo con opacidad— es lo correcto.

## Hallazgo 5: fuentes

Satori exige al menos una fuente embebida como buffer; no lee las del
sistema por nombre. Se probó con `Arial.ttf` leído del disco.

**Implicación para fuentes propias de marca:** el camino ya está abierto.
Un `.ttf` en la carpeta del perfil se pasa como buffer igual que cualquier
otra. No hay obstáculo técnico.

---

## Qué queda pendiente de verificar

- **Paridad entre el preview en pantalla y el PNG exportado.** El preview
  usa CSS del navegador y el export usa Satori: son dos motores distintos.
  Van a diferir en el salto de línea, que es justo donde se nota. Hace falta
  un test que compare ambos renders.
- Ajuste automático de texto largo (que no se desborde de su celda).
- PDF multipágina para carruseles (`pdf-lib` sobre los PNG).

## Cómo reproducir

```
scratchpad/satori-spike/
  spike.mjs    ← prueba grid vs absoluto
  verify.mjs   ← verifica las 20 celdas en 5 formatos
```
