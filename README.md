# Personal Brand System

Sistema reusable para gestionar contenido de marca separado por perfiles.

## Qué resuelve

Separa dos capas:
- **system/** → templates, guías y convenciones compartidas
- **profiles/** → identidad, config, ideas y contenido de cada autor o marca

## Estructura

```text
.
├─ CLAUDE.md
├─ PLAN.md
├─ README.md
├─ system/
│  ├─ config/
│  ├─ guides/
│  ├─ ig-carousel/   # motor de render (genérico)
│  └─ templates/
├─ profiles/
│  └─ example/       # brand.json + carousels/ + config.yaml
├─ notion-sync/
└─ docs/
```

## Onboarding del perfil (vía Notion)

El **perfil** (identidad, posicionamiento, audiencia, pilares, tono, stack, canales)
es la fuente de verdad del sistema y vive en **Notion**, no en archivos del repo.

La primera vez, el agente:
1. Busca en Notion lo que ya existe (página del sistema, DB de contenido, bios previas).
2. Entrevista al usuario (posicionamiento, objetivo, audiencia, pilares, tono, canales).
3. Complementa con datos reales encontrados y los marca como inferidos.
4. Muestra el borrador y, con el OK, lo escribe en la página del sistema en Notion.

Requiere **MCP de Notion** conectado. Si falta algo que el flujo necesita, el agente
**pregunta antes de crear**. Guía completa: `system/guides/profile-onboarding.md`.

## Quick start

### En una máquina nueva

1. Clonar el repo
2. Abrir el proyecto en el agente
3. Duplicar `profiles/example/`
4. Renombrar la carpeta al slug deseado: `profiles/<perfil>/`
5. Revisar `profiles/<perfil>/config.yaml`
6. Si usarás Notion, copiar `profiles/<perfil>/config.local.yaml.example` a `profiles/<perfil>/config.local.yaml`
7. Completar tus IDs privados en `config.local.yaml`
8. Confirmar que el entorno tiene MCP de Notion configurado si quieres sync
9. Revisar `docs/windows-setup-checklist.md` si estás montando otro ambiente

### Flujo diario

1. Leer `profiles/<perfil>/profile.md`
2. Revisar `profiles/<perfil>/config.yaml`
3. Crear o refinar ideas en `profiles/<perfil>/ideas/backlog.md`
4. Escribir drafts en `profiles/<perfil>/content/drafts/`
5. Usar templates de `system/templates/`
6. Publicar manualmente
7. Mover la pieza a `profiles/<perfil>/content/published/`
8. Si `notion.enabled: true`, hacer sync a Notion

## Setup de Notion

1. Abrir `profiles/<perfil>/config.yaml`
2. Si quieres mantener los IDs fuera del repo, usar además `profiles/<perfil>/config.local.yaml`
3. Verificar en la config local:
   - `notion.enabled: true`
   - `notion.database_id`
   - `notion.parent_page_id`
4. Confirmar que el MCP de Notion está disponible en el entorno
5. Usar `notion-sync/README.md` como guía de sync

## Cómo añadir un perfil nuevo

1. Duplicar `profiles/example/`
2. Renombrar la carpeta al slug deseado
3. Editar `profile.md`
4. Editar `config.yaml`
5. Opcional: crear `config.local.yaml` desde el ejemplo
6. Empezar a cargar ideas y drafts

## Archivos clave

- `CLAUDE.md` → guía operativa del repo
- `system/guides/workflow.md` → flujo editorial
- `system/guides/profile-onboarding.md` → cómo se construye el perfil en Notion
- `system/config/brand.schema.md` → esquema de config
- `system/templates/` → templates compartidos
- `notion-sync/README.md` → integración opcional con Notion
- `docs/scouting.md` → resumen persistente del estado arquitectónico del repo
- `docs/windows-setup-checklist.md` → checklist para montar otro entorno sin fricción

## Estado actual

Perfil de referencia para clonar:
- `profiles/example/`
