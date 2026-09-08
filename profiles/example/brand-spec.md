# Brand spec — Example

Fictional placeholder profile. Same rule as `brand.json`: deliberately
unlike any real profile, so that pointing the editor's "Marca" tab at
`example` proves the engine reads these sections generically and never
assumes a specific brand.

## Paleta

| Nombre | Hex | Rol | Procedencia |
|---|---|---|---|
| ink | #14213d | wordmark | elegido para el logotipo |
| signal | #fca311 | accent | color de acento del template original |
| slate | #3d405b | onSurface | texto principal sobre `paper` |
| mist | #8d99ae | onSurfaceMuted | texto secundario |
| paper | #ffffff | surface | fondo por defecto |
| sky | #4361ee | flourish, highlight | acento secundario, usado en gradientes |

## Tipografía

- **Logo / titulares**: Georgia, serif
- **Cuerpo**: system sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI"`)
- Sin webfonts remotas para este perfil ficticio.

## Dirección de imagen

Fondos ilustrados, geométricos, con formas planas y poco detalle
fotográfico — nunca fotografía realista de personas. Preferir composiciones
con mucho espacio negativo para dejar lugar al texto. Evitar texturas
ruidosas o degradados agresivos: el acento (`signal`) debe aparecer como un
detalle, no como el color dominante del fondo.

## Vibe keywords

- editorial
- geométrico
- limpio
- confiable
- cálido pero profesional

## Posicionamiento

Marca ficticia de ejemplo para un perfil que enseña un oficio técnico con
un tono directo y sin humo. Se posiciona como una fuente confiable de
información práctica, no como una marca aspiracional.

## Logo

El isotipo nunca se recolorea ni se distorsiona. Nunca dibujar el logo ni
ningún texto dentro de una imagen generada por IA — el logo y los textos
siempre los coloca el motor de render encima, nunca el modelo de imagen.

## Completeness notes

Este `brand-spec.md` es deliberadamente completo (a diferencia del resto
de `profiles/example/`, que se mantiene mínimo) para poder probar
`loadBrandStyle()` y la pestaña "Marca" del editor sin depender de un
perfil real.
