# Esquema de configuración de perfil

Cada perfil se describe con dos archivos:

| Archivo | Qué define | Quién lo edita |
|---|---|---|
| `config.yaml` | Estrategia: pilares, tono, canales | A mano. Cambia poco. |
| `brand.yaml` | Apariencia: colores, tipografía, forma | La interfaz visual. Cambia seguido. |

Están separados a propósito: mezclarlos haría que una herramienta reescriba
un archivo que tú mantienes con comentarios.

`brand.yaml` es **opcional**. Si falta, se usan los valores por defecto.

---

# 1. `config.yaml` — estrategia

## Estructura sugerida

```yaml
profile:
  slug: example
  name: Nombre Apellido
  title: Rol principal
  primary_language: es

channels:
  active:
    - linkedin
    - youtube
  primary: linkedin

content:
  pillars:
    - pilar-1
    - pilar-2
  default_cta_style: question
  default_hashtags:
    - AI
    - Tech
  valid_states:
    - Idea
    - Borrador
    - Listo
    - Publicado
    - Archivado

tone:
  style:
    - directo
    - opinionado
  avoid:
    - frases-vacias
    - humo

notion:
  enabled: false
  database_id: ""
  parent_page_id: ""
```

## Campos

### `profile`
- `slug`: identificador de carpeta
- `name`: nombre visible del autor o marca
- `title`: posicionamiento principal
- `primary_language`: idioma por defecto

### `channels`
- `active`: canales habilitados
- `primary`: canal principal

### `content`
- `pillars`: pilares editoriales
- `default_cta_style`: estilo por defecto del cierre (`question`, `opinion`, `soft-cta`)
- `default_hashtags`: hashtags reutilizables
- `valid_states`: estados permitidos para el pipeline

### `tone`
- `style`: rasgos deseados de la voz
- `avoid`: patrones a evitar

### `notion`
- `enabled`: activa o desactiva integración
- `database_id`: base de datos destino
- `parent_page_id`: página contenedora opcional

---

# 2. `brand.yaml` — apariencia

Define cómo se ve la marca. Alimenta el preview de posts y el render de afiches.

Ver ejemplo comentado en `profiles/example/brand.yaml`.

## Campos

### `colors`
Solo hex de 6 dígitos — nada de `rgba()` ni nombres CSS: el render a imagen
necesita valores literales.

- `canvas`: fondo de la pieza
- `ink`: tinta principal sobre ese fondo
- `accent`: color de marca
- `accent_soft`: versión suave, para fondos de bloque
- `accent_ink`: tinta que va encima del acento cuando el acento es fondo
- `muted`: texto secundario
- `line`: divisorias y bordes

`accent_soft` se declara explícito en vez de calcularse con opacidad: al
exportar a PNG el color debe ser exacto.

### `canvas_scheme`
`light` o `dark`. Determina qué variante de logo se usa y cómo se calcula
el contraste.

### `type`
- `display` / `body`: `sans`, `serif` o `mono`
- `display_weight` / `body_weight`: peso numérico
- `display_tracking`: espaciado entre letras del titular, en em
- `display_uppercase`: titulares en mayúscula

Solo familias del sistema. Sin webfonts remotas: si no cargan, el export
sale roto y sin avisar.

### `shape`
- `radius`: radio de esquinas en px
- `padding`: margen interior, en % del lado menor

### `logo`
- `dark` / `light`: rutas relativas a la carpeta del perfil
- `height`: alto como % de la dimensión menor de la pieza
- `anchor`: una de las 9 posiciones (`top-left` … `bottom-right`)

Las variantes se nombran por el color de la **tinta** del logo, no por el
fondo: `dark` es tinta oscura y va sobre fondos claros. Es la fuente de
error más común.

Si no hay logo, se usan las iniciales del perfil como monograma.

---

# 3. Regla práctica

- `profile.md` = contexto humano y narrativo
- `config.yaml` = valores operativos y parametrizables
- `brand.yaml` = identidad visual

Evitar duplicar datos entre ellos salvo que haga falta por claridad.

## Regla motor / negocio

`system/` es el motor genérico y **no debe contener literales de marca**:
ni colores hex, ni nombres propios, ni hashtags concretos. Los toma de
`profiles/`.

Test de aceptación: un segundo perfil debe renderizar sin tocar `system/`.

Verificación mecánica:

```bash
grep -rE '#[0-9A-Fa-f]{6}' system/    # no debe devolver nada
```
