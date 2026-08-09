# Scouting — personal-brand

> Última revisión: 2026-06-03  
> Propósito: evitar reexplorar el repo antes de trabajar sobre arquitectura, agentes o flujo editorial.

## Resumen

Este repo define un sistema reusable de marca personal separado por perfiles.

- `system/` contiene templates, guías y convenciones compartidas.
- `profiles/` contiene identidad, configuración, ideas y contenido por autor o marca.
- `notion-sync/` documenta la integración opcional (sync explícito) con Notion.
- `docs/archive/spec-notion-agents.md` describe una arquitectura Notion-first alternativa, archivada/descartada el 2026-07-06.

## Arquitectura actual

El flujo base documentado sigue siendo principalmente repo-first:

`idea → draft → review → publicación manual → published → sync opcional a Notion`

Fuentes:
- `README.md`
- `system/guides/workflow.md`
- `notion-sync/README.md`

## Arquitectura descartada (histórica)

Una spec alternativa proponía un modelo Notion-first (Notion como fuente de verdad
operativa, orquestador gstack-style, escritura vía CLI `ntn`, agente `researcher`).
Nunca se implementó del todo (solo 1 de 7 agentes migrado, sin orquestador). Se
descartó el 2026-07-06 a favor de repo-first con sync explícito — ver sección
siguiente y `docs/project-state/DECISIONS.md`.

Fuente principal (archivada):
- `docs/archive/spec-notion-agents.md`

## Tensión principal (resuelta)

Existía una tensión entre:

1. Documentación repo-first: contenido fuente en archivos del repo + sync opcional.
2. Arquitectura Notion-first (`docs/spec-notion-agents.md`): contenido y perfil viven
   en Notion; el repo solo define el sistema.

**Resuelto el 2026-07-06** (ver `docs/project-state/DECISIONS.md`): gana repo-first.
El repo (`profiles/<perfil>/`) es la fuente de verdad para contenido, ideas y
publicaciones. Notion pasa a ser un sync explícito, disparado por el usuario (p. ej.
"sync con Notion") y ejecutado por el nuevo agente `notion-sync`
(`.claude/agents/notion-sync.md`). La spec Notion-first quedó archivada en
`docs/archive/spec-notion-agents.md`.

## Madurez

Estado temprano/intermedio.

Ya existe:
- estructura reusable por perfiles
- onboarding de perfil vía Notion
- equipo de agentes alineado al modelo repo-first, incluido `notion-sync` para sync explícito
- arquitectura resuelta (ver `docs/project-state/DECISIONS.md`)

Falta:
- probar el flujo end-to-end con una pieza real
- validar el agente `notion-sync` contra una base de datos real de Notion

## Regla práctica para futuros agentes

Antes de trabajar:
1. Leer `README.md`.
2. Leer `PLAN.md` si la tarea toca higiene o reusabilidad del repo.
3. Leer `notion-sync/README.md` solo si la tarea toca sync explícito con Notion.
4. Trabajar siempre sobre `profiles/<perfil>/` como fuente de verdad; no tratar Notion como fuente de datos por defecto.

## Referencias

- `README.md`
- `PLAN.md`
- `system/guides/workflow.md`
- `system/guides/profile-onboarding.md`
- `notion-sync/README.md`
- `docs/archive/spec-notion-agents.md` (archivada)
- `docs/agents-handoff.md`
- `docs/migration-notes.md`
