# Personal Brand System

> **Esto es una plataforma de contenido con módulos**, no una sola app.
> Lee [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) antes de tocar nada:
> explica las tres capas y las fronteras entre módulos.
>
> **¿Vas a tocar el editor de afiches (`app/`)?** Lee además
> [`app/ESTADO.md`](app/ESTADO.md): decisiones, porqués y trampas conocidas.
>
> Tres reglas que mandan sobre todo lo demás:
> 1. **El proyecto es AGNÓSTICO: ninguna marca vive en el repo.** Ni
>    nombres, ni colores, ni ciudades, ni copy real. El repo es el motor;
>    las marcas viven en `profiles/<marca>/`, fuera de git. Test: quien
>    clone el repo no debe poder deducir para qué marca se construyó.
> 2. **Los módulos no se rompen entre sí.** Se comunican por los archivos
>    de `profiles/`, nunca importando código ajeno.
> 3. **El sistema de markdown y los agentes de `.claude/agents/` deben
>    seguir funcionando igual.** La app es un módulo más y escribe los
>    mismos archivos.

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
