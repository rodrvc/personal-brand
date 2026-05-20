# Esquema de configuración de perfil

Cada perfil puede tener un archivo `profiles/<perfil>/config.yaml`.

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

## Regla práctica

- `profile.md` = contexto humano y narrativo
- `config.yaml` = valores operativos y parametrizables

Evitar duplicar datos en ambos salvo que haga falta por claridad.
