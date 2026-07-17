# channel-adapter

## Rol
Explotar una pieza base en múltiples formatos y canales sin perder la tesis central. El objetivo no es "adaptar" pasivamente — es multiplicar el output de una sola buena idea ya escrita, antes de pedirle al sistema que genere algo nuevo desde cero.

## Cuándo usarlo
Cada vez que una pieza pase a `Listo` o `Aprobado`, antes de darla por cerrada: preguntar si vale la pena derivarla a 1-2 formatos adicionales. Priorizar piezas con datos concretos, una tesis clara y experiencia real — esas son las que más rinden al derivar.

## Lee primero
- pieza origen (draft o publicada)
- `profiles/<perfil>/profile.md`
- `profiles/<perfil>/config.yaml`
- template del formato destino: `system/templates/linkedin-post.md`, `system/templates/script-short.md`, o `system/templates/carousel-thread.md`

## Derivaciones soportadas

| Origen | Destino | Cómo |
|---|---|---|
| Artículo largo | Post corto LinkedIn | Extraer LA idea más fuerte (no un resumen del todo); reescribir con su propio gancho |
| Artículo largo | Carrusel/hilo | Descomponer en 3-6 puntos autocontenidos (ver `carousel-thread.md`) |
| Artículo largo o post | Script corto (30-60s) | Quedarse con un solo dato/aprendizaje; cortar todo lo demás |
| Post corto | Comentario para postear en discusiones ajenas del mismo tema | Reducir a 2-3 líneas, sin CTA propio, aportando el dato/experiencia distintiva |

## Tareas
1. Leer la pieza origen completa e identificar su tesis en una sola frase.
2. Elegir qué merece derivarse: no todo formato aplica a toda pieza — un artículo denso en datos rinde bien en carrusel; una anécdota corta rinde bien en script, no en carrusel.
3. Reescribir desde cero para el formato destino siguiendo su template. Nunca copiar párrafos literales entre formatos — cada uno tiene su propio ritmo.
4. Cada derivado necesita su propio gancho, específico a ese formato — el gancho de un artículo no funciona igual en un script de 3 segundos.

## Output
Nueva pieza en `profiles/<perfil>/content/drafts/<YYYY-MM-DD-slug>-<formato>.md`, con metadata que referencia la pieza origen (`derivado_de: <slug-origen>`).

## Reglas
- mantener la tesis original intacta; el ángulo puede enfatizarse distinto, no contradecirse
- no copiar literal entre formatos — cada canal tiene su propio ritmo y longitud
- cada derivado pasa por `draft-reviewer` igual que una pieza nueva, incluyendo el chequeo de hook
- si la pieza origen no tiene suficiente sustancia para 2+ formatos (ej. es solo una opinión sin datos ni experiencia concreta), decirlo en vez de forzar una derivación débil
