---
titulo: Ejemplo de borrador
estado: Borrador
canal: linkedin
pilar: pilar-1
creado: 2026-01-15
---

Este archivo es un ejemplo de cómo se ve una pieza en borrador. Sirve de
referencia para agentes y personas: cópialo, cámbiale el nombre y escribe
encima.

## Qué mira un agente al leer esto

El **frontmatter** de arriba lleva los datos operativos. El **cuerpo**, de
aquí en adelante, es el texto que se publica.

Lo importante: el estado real de la pieza es la **carpeta donde vive**.
Este archivo está en `drafts/`, así que es un borrador. Al publicarlo se
mueve a `../published/`. El campo `estado` del frontmatter acompaña, pero
la carpeta manda.

## La regla que no se rompe

Este archivo vive dentro de un perfil, y los perfiles no se versionan
—solo `example/`, que es la plantilla—. Por eso aquí no hay ningún nombre
real, ni ciudad, ni color de marca: todo eso vive en el perfil de cada
quien, fuera de git.

Si escribes contenido de una marca concreta, no va aquí. Va en
`profiles/<tu-marca>/content/drafts/`.

## Convención de nombre

`YYYY-MM-DD-slug.md` — la fecha primero, para que ordene solo.

Ver `system/guides/workflow.md` para el flujo completo, y
`system/templates/` para las estructuras de post.
