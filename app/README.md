# Brand Studio — app de escritorio

Interfaz visual para el sistema de marca. Se instala como cualquier
programa: `.dmg` en Mac, `.exe` en Windows.

## Lo importante: no reemplaza nada

La app **lee y escribe los mismos archivos** que ya usa el sistema de
agentes. No hay base de datos propia ni formato paralelo.

| Lo que edita la app | Archivo que toca |
|---|---|
| Colores, tipografías, logo | `profiles/<slug>/brand.yaml` |
| Texto de un post | `profiles/<slug>/content/drafts/*.md` |
| "Ya lo publiqué" | mueve el `.md` a `content/published/` |

Si desinstalas la app, el repo sigue funcionando igual que hoy. Los
agentes no se enteran de que existió.

## Estado

**Compila y arranca.** La ventana abre.

| Pieza | Estado |
|---|---|
| Configuración de la ventana y el empaquetado | lista |
| Backend en Rust (leer/escribir perfiles y piezas) | compila |
| Protección de rutas | verificada, 5/5 |
| Interfaz | la maqueta, copiada a `src/index.html` |
| Capa de datos con doble modo | lista |
| Arranque de la app | verificado |
| Botones conectados al backend | **pendiente** |

## Cómo abrirlo

```bash
cd app && npm install    # solo la primera vez
npm run dev
```

Los scripts ya añaden `~/.cargo/bin` al PATH, así que no hace falta
`source` de nada.

Para generar el instalable:

```bash
npm run build            # deja el .dmg en src-tauri/target/release/bundle/
```

El resultado queda en `src-tauri/target/release/bundle/`.

En Mac, para que no salga el aviso de "no se puede abrir", hay que firmar
la app: cuenta de desarrollador de Apple, unos 99 USD al año.

## Cómo está organizado

```
app/
  src/
    index.html   ← la interfaz (copia de la maqueta)
    data.js      ← capa de datos: archivos o demo
  src-tauri/
    src/main.rs  ← backend: lee y escribe el repo
    tauri.conf.json
```

La lógica de verdad —contraste, grilla de afiches, corte de LinkedIn— vive
en `../core/` y no depende de Tauri. Corre igual en el navegador.

## La misma interfaz en dos sitios

`data.js` detecta dónde está corriendo:

- **En la app**: archivos reales.
- **En el navegador**: datos de ejemplo en memoria.

Así se puede seguir iterando el diseño abriendo el HTML directamente, sin
compilar nada. Y cuando corre instalada, los mismos botones escriben en el
disco.

## Dónde vive el contenido

En desarrollo apunta al repo actual. En producción, la carpeta que elija
el usuario.

Se puede forzar con una variable de entorno:

```bash
BRAND_STUDIO_ROOT=/ruta/al/repo npm run dev
```

## Qué falta

- Conectar los botones de la maqueta a `data.js` (hoy usa datos internos)
- Elegir carpeta de trabajo la primera vez que se abre
- Exportar afiches a PNG y PDF — el motor ya está verificado,
  ver `../docs/spike-satori.md`
- Icono e identidad de la app
- Firma para Mac y Windows
