---
kind: fact
scope: repo
source: notion-sync/README.md, .claude/agents/notion-sync.md, docs/project-state/DECISIONS.md
updated: 2026-07-06
---

# Notion routing

## Fuente de verdad operativa
El repo (`profiles/<perfil>/`) es la fuente de trabajo diaria: perfil, backlog de ideas,
drafts y publicados viven en archivos versionados. Notion es un destino de sync
explícito, no la fuente de verdad.

## Cuándo consultar o escribir en Notion
Solo cuando el usuario lo pide explícitamente (p. ej. "sync con Notion", "actualiza
Notion"). En ese caso usar el agente `notion-sync` (`.claude/agents/notion-sync.md`),
que lee `profiles/<perfil>/config.yaml` para confirmar `notion.enabled` y
`notion.database_id` antes de tocar nada, y usa los tools MCP de Notion
(`mcp__notion__*`) para leer/escribir.

## Qué recuperar del repo (no de Notion)
- identidad, posicionamiento, audiencia, pilares, voz y tono → `profiles/<perfil>/profile.md`
- configuración operativa y flags de Notion → `profiles/<perfil>/config.yaml` (y `config.local.yaml` si existe)
- temas ya cubiertos, ideas en progreso → `profiles/<perfil>/ideas/backlog.md`
- piezas publicadas (para no duplicar temas) → `profiles/<perfil>/content/published/`

## Regla de trabajo
No consultar Notion por defecto. Antes de proponer ideas o inferir el perfil del
owner, leer los archivos del perfil en el repo. Notion solo entra en juego cuando
el usuario pide explícitamente sincronizar.

## Si hay conflicto repo vs Notion
El repo manda siempre para contenido, workflow, templates y arquitectura del sistema.
Notion refleja el estado del repo después de un sync; no al revés.
