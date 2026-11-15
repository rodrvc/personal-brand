# Guía del dueño

Para quien maneja las marcas, no para quien programa. Un comando por tarea.
Los ejemplos usan la marca ficticia `example-posters`; cambia el nombre por el de tu marca.

## 1. Qué es esto

- El repo es un **motor genérico**: no sabe nada de ninguna marca.
- Cada marca vive en el **almacenamiento** con sus datos, habilidades (criterio) y herramientas.
- Para sumar una marca nueva **nunca se edita el motor**: se guarda la marca y listo.
- Las marcas reales jamás entran al repo.
- Detalle técnico: [`ARQUITECTURA.md`](ARQUITECTURA.md).

## 2. Antes de empezar

Una sola vez, en cada equipo: sigue [`SETUP.md`](SETUP.md) (`pnpm install` y `pnpm setup`).
Variables de entorno (solo los nombres; los valores van en tu `.env`, nunca en un mensaje):

- `DATABASE_URL` (siempre) y `DATABASE_MIGRATOR_URL` (solo para migrar).
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (imágenes y archivos).
- `BRAND_OWNER_OPT_IN` (solo tú, para marcas reales; ver sección 6).

Todos los comandos se escriben así (abajo se abrevia como `brand`):

```bash
pnpm -s --filter @personal-brand/storage brand <verbo> ...
```

## 3. Tareas

| Quiero... | Comando | Qué hace |
|---|---|---|
| Ver mis marcas | `brand list` | Lista las marcas (`--archived` incluye las archivadas). |
| Ver una marca | `brand show example-posters` | Resumen de la marca guardada. |
| Pasar una marca de carpeta al almacenamiento | `brand import --from profiles/example-posters --dry-run` y luego sin `--dry-run`; al final `brand cutover example-posters --confirm example-posters` | Copia la carpeta al almacenamiento y verifica. Nunca borra la carpeta. Una marca real exige tu aprobación (sección 6). |
| Preparar la carpeta de trabajo | `brand workspace example-posters --out ~/trabajo/posters [--date 2026-12-15]` | Copia de solo lectura de la marca, con el tema de esa fecha, lista para las herramientas. |
| Cambiar colores, fuentes o configuración | `brand doc get example-posters tokens > brand.json`, edítalo, y `brand doc put example-posters tokens --file brand.json --if-version <n>` (igual con `config` y `config.json`) | `tokens` son los colores y fuentes; `config` la operativa (hashtags, salidas, `timezone`). Los dos van en JSON. La versión `<n>` la muestra `brand doc get ... --json`. Escribirlos exige tu aprobación. |
| Ver herramientas | `brand tool list example-posters` | Lista sus herramientas. |
| Leer / guardar una herramienta | `brand tool get example-posters render-sample.mjs` / `brand tool put example-posters render-sample.mjs --file render-sample.mjs --description "..."` | El nombre es el del archivo, con su extensión. Escribirlas exige tu aprobación. |
| Ver / guardar criterio (habilidades) | `brand guidance list example-posters` / `brand guidance put example-posters posters --file posters.md --description "..."` | El criterio de la marca. Si el texto parece un secreto, no se guarda. El nombre `tema-...` está reservado. |
| Ver / agregar imágenes | `brand asset list example-posters` / `brand asset add example-posters logo.png` / `brand asset get example-posters <id> --out ~/trabajo/logo.png` | Lista, sube o baja una imagen. |
| Imágenes de un lote | `brand asset list example-posters --tag batch:<lote>` | Muestra lo que un render por lote dejó guardado (`--status hidden` para las ocultas). |
| Tema de temporada | `brand theme put example-posters winter-sale --from 2026-12-01 --to 2026-12-31 --tokens cambios.json --guidance criterio.md` | Cambia colores o fuentes entre esas fechas. Exige tu aprobación. |
| Ver temas / el activo | `brand theme list example-posters` / `brand theme active example-posters --date 2026-12-15` | Sin `--date` usa hoy. |
| Bajar las fuentes | `brand fonts fetch example-posters` | Descarga las fuentes que piden los tokens y los temas. |
| Sacar un carrusel exportado | `brand export pull example-posters <carrusel> --out ~/trabajo/salida` | Copia sus archivos a una carpeta tuya (fuera del repo). |

Reglas por tarea:

- **Herramientas**: importan librerías por nombre (`import { chromium } from "playwright"`), nunca con una ruta de tu equipo. La carpeta de salida es un argumento, siempre **fuera** de la carpeta de la marca y del repo. Nunca corras `npm` ni `pnpm` dentro de la carpeta de trabajo: su `node_modules` es el del motor. Si una herramienta trae una ruta fija, verás un aviso (no bloquea).
- **Temas**: dos temas no pueden compartir un día. No se borran: para retirar uno, muévelo a un día ya pasado con `--from`/`--to`. Para cambiarlo usa `--if-version <n>`. Un `--tokens` vacío deja el tema sin cambios de colores ni fuentes; un `--guidance` vacío borra su criterio.
- **Fecha de "hoy"**: sale de la clave opcional `timezone` de la marca; sin ella, de tu equipo.

## 4. Cómo pedirle algo a Claude

Pide en lenguaje normal: "hazme los afiches de hoy", "arma el carrusel de esta semana". Claude debe:

1. Usar primero la habilidad `usar-perfil`: averigua de qué marca hablas y lee su criterio guardado.
2. Seguir las habilidades guardadas de la marca (no inventar criterio).
3. Escribir la salida fuera del repo y darte el enlace.

Si no nombras la marca, Claude te la pregunta. Si dice que una marca o su criterio "no existe", suele ser un problema de búsqueda: pídele que revise con `brand list` y `brand show`.

## 5. Reglas que no cambian

- **Nunca se borra nada**: si quieres rehacer algo, se crea una versión al lado (`-v2`).
- **Las marcas reales nunca entran al repo** (viven en el almacenamiento o en `profiles/`, ignorado por git).
- **Los secretos no van en el texto de la marca** (criterio, temas, herramientas): van en variables de entorno.
- El motor no se edita por una marca. Si parece necesario, el dato está en el lugar equivocado.

## 6. Si algo falla

| Mensaje | Qué hacer |
|---|---|
| "...no es de ejemplo: requiere la aprobación explícita del dueño" | Es a propósito. Solo tú: `BRAND_OWNER_OPT_IN=<marca>` y `--owner-opt-in <marca>` (la misma marca, una a la vez). Claude solo los usa con tu OK explícito para esa marca. |
| "Conflicto de versión (versión actual: N)" | Alguien cambió eso antes. Léelo de nuevo (`get`) y reintenta con `--if-version N`. |
| "Las fechas se cruzan con el tema X" | Cambia las fechas de uno de los dos; no se guardó nada. |
| "...parece contener un secreto... no se guardó" (código de salida 6) | Quita la clave del texto y léela de una variable de entorno. |
| Aviso de zona horaria inválida | Corrige `timezone` en la config de la marca con `brand doc put ... config` (nombre IANA, p. ej. `Pacific/Auckland`) o pasa `--date`. |
| "Ese archivo ya está registrado como asset ..." | Ya estaba subido; usa ese id. |
| Fuera de esto | Corre el comando con `--json` y muéstraselo a Claude; no borres nada. |
