# Editor de afiches — estado del módulo

Actualizado: 2026-08-08

> **Esto es UN MÓDULO**, no el proyecto entero. El proyecto es una
> plataforma de contenido: publicaciones, videos, guiones y seguimiento de
> redes. Lee [`../docs/ARQUITECTURA.md`](../docs/ARQUITECTURA.md) para las
> fronteras entre módulos antes de tocar algo fuera de `app/`.

## Qué es esto

Una app de escritorio para crear afiches con la identidad visual de cada
marca. Se le describe la pieza en una caja de texto y la IA la genera:
escribe los textos, crea la imagen de fondo y ajusta los colores para que
todo se lea.

**Va a venderse** a diseñadoras que gestionan su marca o la de sus clientes.

## Qué puede tocar este módulo

Solo escribe tres cosas, todas dentro de `profiles/`:

- `profiles/<marca>/brand.yaml`
- `profiles/<marca>/content/**/*.md`
- mover un `.md` de `drafts/` a `published/`

**No toca** `system/`, ni `.claude/agents/`, ni ningún otro módulo.
Verificado 2026-08-08. Se puede publicar incompleto sin romper nada.

## Cómo abrirla

```bash
cd app && npm run dev
```

Necesita Rust instalado. La clave de OpenAI se lee de
`~/.brand-studio/openai.key` (fuera del repo, nunca en git).

## Reglas que no se negocian

**1. El proyecto de hoy no puede dejar de funcionar.**
El sistema de markdown + los 7 agentes de `.claude/agents/` siguen operando
igual. La app es un añadido para usuarios no técnicos, no un reemplazo.
La app lee y escribe **los mismos archivos**: nada de base de datos paralela.
Si se desinstala, el repo sigue igual.

**2. `system/` es el motor y no lleva literales de marca.**
Ni colores, ni nombres propios. Los toma de `profiles/`.
Test: `grep -rE '#[0-9A-Fa-f]{6}' system/` debe salir vacío.

**3. Dos capas de color que nunca se mezclan.**
`--ui-*` es el chrome de la app (cálido, crema, terracota `#B4552F`).
`--brand-*` vive solo dentro del lienzo del afiche.

**4. La IA no dibuja texto.**
Genera la imagen de fondo; el texto y el logo los pone el template encima.
Motivo: los modelos de imagen escriben mal — letras deformes, palabras
inventadas. Separado, la imagen sale bonita y el texto nítido y editable.

## Decisiones tomadas, con su porqué

| Decisión | Por qué |
|---|---|
| **Escritorio (Tauri), no web** | Los logos y tipografías de los clientes de la usuaria se quedan en su máquina: el riesgo legal no se traslada. Web obliga a servidor, logins y backups. Y el diferenciador es justo "esto es tuyo y vive en tu equipo". |
| **El pipeline de estados NO es el producto** | El dueño lo dijo dos veces. El propósito es el estilo de cada marca y la edición de piezas. El estado es un campo discreto, nunca el eje de la navegación. |
| **Publicación manual** | Se descubrió que `w_member_social` de LinkedIn es self-serve, así que automatizar es viable más adelante. Se hace al final y como adaptador intercambiable. |
| **Una sola caja de texto** | Separar "texto" e "imagen" era problema del sistema, no del usuario. Además así hay coherencia: la IA devuelve una `escena` junto al texto, y esa escena alimenta al generador de imagen. |
| **Nada de CSS Grid en el lienzo** | Satori (el motor de export) lo rechaza. Se usa posicionamiento absoluto. Ver `../docs/spike-satori.md`. |
| **`brand.yaml` aparte de `config.yaml`** | Ciclos de vida distintos: la estrategia se toca cada meses, los colores diez veces en una tarde y los escribe la app. |

## Cómo está armado

```
core/            lógica pura, sin navegador ni Tauri — 54 tests
  color.js       contraste, variante de logo por contraste medido
  layout.js      grilla 12×12 → píxeles, 9 anclajes de logo
  linkedin.js    límites del post y corte de "…ver más"

app/
  src/index.html el editor completo (~1.385 líneas)
  src/core/      copia de core/ — la genera sync-core.mjs, no editar
  src-tauri/
    src/main.rs  lee y escribe el repo, con protección de rutas
    src/ia.rs    puente a OpenAI

profiles/<slug>/
  config.yaml    estrategia (a mano)
  brand.yaml     apariencia (la escribe la app)
  content/       drafts/ y published/
```

`core/` vive en la raíz porque no es solo de la app. `sync-core.mjs` lo
copia dentro de `app/src/` al arrancar, porque Tauri solo empaqueta lo que
hay bajo `frontendDist`.

```bash
node core/test/run.mjs     # 54 tests, sin instalar nada
```

## Qué funciona hoy

- Editor de afiche: 5 templates, 5 formatos (1:1, 4:5, 9:16, 16:9, A4)
- Fondo de color o imagen, con oscurecimiento
- Bloques de texto e imágenes: añadir y quitar
- Logo con 9 anclajes, variante clara/oscura elegida por contraste medido
- Panel de marca: colores y tipografía
- **Generar con IA**: un campo, genera textos + imagen de fondo coherentes
- Referencias: soltar una imagen extrae su paleta; pegar CSS extrae los hex
- Deshacer con pila de 10 pasos
- Descarga a PNG a resolución real (verificado 1080×1350 en disco)

## Costos medidos con llamadas reales

| | Costo | Tiempo |
|---|---|---|
| Solo texto | 0,004¢ | ~2 s |
| Texto + imagen de fondo | 0,39¢ | ~17 s |

Modelos: `gpt-4o-mini` para texto, `gpt-image-1-mini` calidad baja para
imagen. El contador de la sesión se muestra en el panel.

## Qué falta

- **El panel de marca no guarda en `brand.yaml`.** Cambias colores y se ven,
  pero al cerrar se pierden. Falta conectar `guardar_brand`, que ya existe
  en el backend.
- Elegir carpeta de trabajo la primera vez que se abre.
- Icono propio (hoy hay uno generado) y firma para Mac (~99 USD/año, sin
  ella el primer arranque muestra un aviso).
- `app/src/data.js` es código muerto: nada lo importa. El editor llama a
  `window.__TAURI_INTERNALS__.invoke` directo.

## Trampas conocidas

- **El modelo mutila palabras** para no pasarse del límite de caracteres
  ("Arendar" por "Arrendar"). El prompt lo prohíbe explícitamente; si se
  vuelve a ver, reforzar ahí.
- **Oscurecer el fondo no siempre mejora el contraste.** Con tinta oscura lo
  empeora. El ajuste mide el contraste real en todo el rango en vez de
  asumir que más oscuro es mejor.
- **Al extraer paleta de una imagen, muestrear a 600px.** A 100-200px el
  resultado sale mal, y muchas librerías usan esa resolución por velocidad.
- La primera compilación de Rust tarda varios minutos; las siguientes son
  de segundos.

## Documentos de respaldo

En `docs/`: `spike-satori.md` (por qué no CSS Grid).
El resto —design system, arquitectura, modelo de datos, análisis de
mercado, revisión de arquitectura— quedó en el scratchpad de la sesión y
**no está versionado**. Si hace falta, hay que rehacerlo.

## Lo que se decidió NO construir

Panel de chat con IA, gestión de perfiles en la app, lista de contenido,
preview de LinkedIn dentro del editor, kanban de estados, carrusel
multi-slide, sección de voz/tono, sync con Notion.

Se probó una maqueta con todo eso (10 pantallas, 6.000 líneas) y el
veredicto del dueño fue: *"quisiste abarcar mucho muy rápido"*. Se
reemplazó por una sola pantalla bien hecha. **Mantener ese criterio.**
