---
kind: summary
scope: repo
source: README.md, notion-sync/README.md, docs/scouting.md, docs/project-state/DECISIONS.md
updated: 2026-07-06
---

# Start here

## Qué proyecto es este
Repo del sistema de marca personal. Es repo-first: el contenido real (perfil, ideas,
drafts, publicados) vive en archivos versionados bajo `profiles/<perfil>/`. Notion es
un sync explícito y opcional, no la fuente de verdad.

## Error a evitar
No asumir que `profiles/example/` contiene el contexto real del owner. Esa carpeta
sirve como plantilla reusable.

## Orden mínimo de arranque
1. Leer `profiles/<perfil>/profile.md` y `profiles/<perfil>/config.yaml`.
2. Si la tarea toca contenido o backlog real, revisar `profiles/<perfil>/ideas/backlog.md`
   y `profiles/<perfil>/content/published/` (no Notion).
3. Leer `system/guides/workflow.md` si hace falta el flujo editorial base.
4. Consultar `.pi/context/notion-routing.md` solo si la tarea menciona Notion o sync.

## Cuándo usar el repo (siempre, por defecto)
Usa los archivos del repo para:
- ideas nuevas de posts
- revisar contenido existente
- entender perfil, pilares, tono o audiencia
- evitar duplicados
- trabajar sobre el pipeline editorial real

## Cuándo entra Notion
Solo cuando el usuario pide explícitamente sincronizar (p. ej. "sync con Notion").
En ese caso usa el agente `notion-sync` (`.claude/agents/notion-sync.md`), que refleja
el estado actual del repo hacia la base de datos de Notion descrita en
`notion-sync/README.md`.
