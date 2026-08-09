# Contexto del handoff — separación perfiles / motor de reels

> **Estado: el plan de `PLAN-skills-agnosticas.md` está ejecutado.** Los 7
> pasos están hechos y el criterio de aceptación se verificó renderizando un
> segundo perfil, en otra ciudad y otro idioma, sin tocar `system/` ni
> `.claude/`. Lo que queda es revisión y decisiones de publicación.

---

## Por qué existe este worktree

El repo `personal-brand` va a **publicarse** para que otras personas lo usen
con sus propias marcas. Para eso el negocio de una marca concreta no puede
estar mezclado con el motor técnico.

La regla fundacional (ver `CLAUDE.md`):

> **system/** → motor genérico, sin literales de marca
> **profiles/** → identidad de cada marca

---

## Qué se hizo

### Los dos problemas del handoff original, resueltos

**1. `generar-carrusel-semana` filtraba el modelo de negocio.** Ya no: el
orquestador genérico vive en `.claude/skills/` sin nombrar ninguna marca, y la
skill con criterio de negocio se movió a `profiles/<slug>/skills/`. Esto ya
estaba hecho en commits previos a esta sesión.

**2. El prototipo del reel tenía la marca incrustada.** Resuelto en esta
sesión: `prototipo-reel/` se portó a `system/ig-reel/`, parametrizado por
`brand.json` y por el recipe del perfil.

### Las cuatro capas, completas

```
system/ig-carousel/  motor de carruseles      (ya existía)
system/ig-reel/      motor de reels           ← NUEVO
system/recipes/      contratos de flujo       weekly-roundup, brand-message, reel-week
profiles/<slug>/     tokens + config          brand.json + recipes/*.yaml
.claude/skills/      orquestadores genéricos
```

### El motor de reels

`system/ig-reel/` produce el mismo MP4 vertical que el prototipo (1080x1920,
portada + N ítems con transición de mapa + cierre) pero sin un solo literal de
marca. Detalle técnico y trampas ya resueltas: `system/ig-reel/README.md`.

Diferencias respecto del prototipo, todas exigidas por la agnosticidad:

| Antes | Ahora |
|---|---|
| Colores y copy en el CSS | `brand.json` (`copy.reel`, `gradients.cover`) |
| bbox de una ciudad en el script | `map.bbox` del recipe del perfil |
| 10 puntos de referencia a mano | auto-descubiertos de OSM por tipo, tope de 12 por dispersión |
| Coordenadas hardcodeadas | del input, o geocodificadas con Nominatim |
| 8 escenas escritas por un script Python | generadas para N ítems (3 a 6) |

`npm run check` cubre el motor: 41 tests, incluida la verificación de que el
mar cae sobre el agua y no sobre el pueblo.

### Caché de red (revisado por Álvaro)

El motor dibuja el mapa desde datos de OSM, y la API pública de Overpass se cae
seguido — durante esta sesión falló unas seis veces. Antes eso significaba
esperas de minutos o corridas perdidas.

Ahora toda llamada a Overpass y Nominatim pasa por `<repo>/.cache/`:

```
1a corrida:  ~40s + lo que tarde Overpass
2a corrida:  42s medidos, cero requests
```

Las decisiones de diseño (por qué se cachea la respuesta cruda y no el SVG, por
qué el caché no vive en `profiles/<slug>/`, el TTL, el fallback anunciado)
están en `system/ig-reel/README.md`. La que más importa recordar: **el criterio
de aceptación debe seguir cumpliéndose con caché frío.** Si alguna vez pasa
verde solo con caché caliente, el criterio se volvió mentira.

---

## Criterio de aceptación: verificado

**Test de transportabilidad.** `profiles/example/` — otra marca, otra ciudad
(una bahía, no una costa recta), otro idioma, otra paleta, fuentes del sistema
— renderiza con:

```bash
npx tsx system/ig-reel/render-reel-week.ts --profile example --date <fecha>
```

**sin ninguna edición bajo `system/` ni `.claude/`.**

**Su recíproca:** un perfil no puede cambiar lo que el motor hace. `map.bbox`
se valida como rectángulo y tamaño; `map.reference_types`, `source.kind` y
`render.script` son enums cerrados; las claves desconocidas son error de carga,
no se ignoran; y no hay forma de declarar ejecución de shell ni de escribir
Overpass QL.

El segundo perfil pagó por sí solo: **encontró un defecto real** que el perfil
original no podía exponer. El relleno del mar asumía una costa recta y pintaba
agua sobre el centro de la ciudad en una bahía. Está corregido y fijado con un
test contra una costa real cacheada (`system/ig-reel/fixtures/`).

---

## Estado del repo

`python3 scripts/validate_commit_guardian.py --scan` da **0 hallazgos en el
árbol**. Lo único que reporta son ~15 commits en el historial local que
contienen la marca. No hay nada en un remoto: es higiene previa, y la salida
limpia es publicar por squash sobre una base limpia.

**No se hicieron commits en esta sesión**, siguiendo la instrucción original.
Todo está en el working tree.

---

## Lo sensible: `prototipo-reel/`

Sigue **intacto**, y así debe quedar hasta que alguien decida borrarlo. Fue un
port no destructivo: el motor nuevo se construyó al lado y se validó contra
`prototipo-reel/output/reel-referencia.mp4` (misma duración, mismas
dimensiones, mismo número de frames; los frames coinciden salvo diferencias de
compresión y dos puntos donde el diseño mejoró a propósito).

No hay commits ni respaldo remoto de esa carpeta.

---

## Commits de esta sesión (en la rama, `main` intacto)

| Commit | Qué |
|---|---|
| `6b3d909` | El motor `system/ig-reel/` + el perfil de ejemplo + el caché |
| `6395d11` | La skill `generar-reel-semana` |

**El commit gate encontró una fuga en cada uno, y las dos estaban en la
prosa** — que es exactamente lo que advierte `CLAUDE.md`:

- `docs/PLAN-skills-agnosticas.md` nombraba la marca, su host de API y su
  ciudad 15 veces. Sacado del commit y agregado al `.gitignore`.
- La descripción de la skill usaba una palabra del vocabulario de una marca
  concreta como frase de disparo. Reemplazada por una neutra.

Ninguna de las dos estaba en TypeScript. Vale la pena recordarlo la próxima vez
que se revise un diff.

## Worktrees lanzados

- **`arreglar-mar-mapa`** — rehace el relleno del mar, que hoy se rasteriza en
  celdas y se ve escalonado al zoom 2.4× del reel. Su brief lleva los cuatro
  intentos que ya fallaron y por qué, para que no los repita.
- **`probar-skill-reel`** — valida la skill nueva en caché frío, en un checkout
  que nunca generó un video.

## Decisiones abiertas para Rodrigo

1. **Qué hacer con `prototipo-reel/`.** Ya cumplió su función y el motor nuevo
   lo reemplaza. Borrarlo es razonable, pero es tu llamada.
2. **Cómo publicar el historial.** El scan recomienda squash sobre base limpia;
   nadie lo ha ejecutado. **Es lo único que separa el repo de poder
   publicarse.**
3. **Nombres largos en el mapa.** El segundo detalle cosmético: en una ciudad
   con nombres oficiales largos las etiquetas se encabalgan. No se mandó a
   ningún worktree. La vía sin listar lugares por ciudad es acortar nombres con
   reglas genéricas en el motor.
4. **El caption del reel.** El recipe define la etapa (9) pero esta sesión no
   generó captions: se enfocó en el motor.
5. **ACU-77 (voz) y ACU-78 (música)** siguen pendientes, sin tocar.

---

## Referencias en Linear

- **ACU-76** — Epic "Motor de Reels en video"
  - **ACU-74** — Video (spike, resuelto; su resultado es lo que se portó)
  - **ACU-77** — Voz / narración (pendiente)
  - **ACU-78** — Música libre de copyright (pendiente)
