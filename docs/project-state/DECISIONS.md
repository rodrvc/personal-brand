# DECISIONS

## Pending decisions
- ¿Cuál es el objetivo actual más importante?
- ¿Qué trabajo está bloqueado por dependencias externas o por decisiones no tomadas?

## Log

### 2026-07-06 — Arquitectura: repo-first con sync explícito a Notion
Coexistían dos diseños contradictorios: el original repo-first (contenido en
`profiles/<perfil>/`, Notion como sync opcional) y uno más nuevo Notion-first
(`docs/spec-notion-agents.md`, nunca implementado del todo: solo 1 de 7 agentes
migrado, sin orquestador, sin agente `researcher`).

**Decisión:** gana el modelo repo-first. El repo (`profiles/<perfil>/`) es la fuente
de verdad y el sistema de trabajo diario. Notion deja de ser "fuente de verdad
operativa" y pasa a ser un destino de sync explícito: solo se actualiza cuando el
usuario lo pide (p. ej. "sync con Notion"), a través del nuevo agente `notion-sync`.

**Por qué:** evitar mantenimiento doble del mismo contenido en dos lugares, y evitar
la ambigüedad de qué agente/fuente usar en cada tarea. El modelo Notion-first
requería un orquestador y un agente adicional que nunca se construyeron, y duplicaba
la gestión de estado (properties de Notion vs. archivos del repo).

**Consecuencias:**
- `docs/spec-notion-agents.md` se archivó en `docs/archive/spec-notion-agents.md`.
- `.claude/agents/content-strategist.md` volvió a leer del repo (no de Notion vía `ntn`).
- Se creó `.claude/agents/notion-sync.md` como único mecanismo de sync a Notion.
- `.pi/context/notion-routing.md` y `.pi/context/start-here.md` se reescribieron para
  reflejar este modelo.
