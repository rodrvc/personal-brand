# Personal Brand System

## Propósito

Este repo guarda un **sistema reusable de contenido/marca** separado de los **perfiles específicos** que lo usan.

La idea es distinguir entre:
- **system/** → templates, guías y reglas compartidas
- **profiles/** → identidad, backlog y contenido de cada perfil

---

## Estructura del proyecto

| Ruta | Propósito |
|---|---|
| `system/templates/` | Templates reutilizables para posts y scripts |
| `system/guides/` | Guías operativas del sistema |
| `system/config/` | Esquemas y convenciones de configuración |
| `profiles/<perfil>/profile.md` | Identidad, posicionamiento y tono del perfil |
| `profiles/<perfil>/config.yaml` | Configuración operativa del perfil |
| `profiles/<perfil>/config.local.yaml` | Overrides locales y privados opcionales |
| `profiles/<perfil>/ideas/` | Backlog de ideas del perfil |
| `profiles/<perfil>/content/drafts/` | Borradores en progreso |
| `profiles/<perfil>/content/published/` | Archivo de contenido publicado |
| `notion-sync/` | Notas de integración con Notion |
| `docs/` | Documentación adicional |

---

## Cómo trabajar con un perfil

Cuando se trabaje contenido para un autor concreto:
1. leer su `profile.md`
2. revisar su `config.yaml`
3. si existe, revisar también `config.local.yaml`
4. usar los templates de `system/templates/`
5. guardar ideas y drafts dentro de su carpeta de perfil

---

## Workflow

Ver guía principal en:
- `system/guides/workflow.md`

Resumen:
- idea → backlog del perfil
- draft → `profiles/<perfil>/content/drafts/`
- revisión del owner
- publicación manual
- archivo en `published/`

---

## Regla de separación

No meter en este archivo:
- datos personales del autor
- narrativa personal específica
- stack individual
- diferenciadores de una sola persona
- IDs privados, tokens o enlaces internos

Eso debe vivir en el perfil correspondiente o en archivos locales fuera del repo.
