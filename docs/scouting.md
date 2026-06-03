# Scouting — personal-brand

> Última revisión: 2026-06-03  
> Propósito: evitar reexplorar el repo antes de trabajar sobre arquitectura, agentes o flujo editorial.

## Resumen

Este repo define un sistema reusable de marca personal separado por perfiles.

- `system/` contiene templates, guías y convenciones compartidas.
- `profiles/` contiene identidad, configuración, ideas y contenido por autor o marca.
- `notion-sync/` documenta la integración opcional con Notion.
- `docs/spec-notion-agents.md` describe una arquitectura más ambiciosa y Notion-first.

## Arquitectura actual

El flujo base documentado sigue siendo principalmente repo-first:

`idea → draft → review → publicación manual → published → sync opcional a Notion`

Fuentes:
- `README.md`
- `system/guides/workflow.md`
- `notion-sync/README.md`

## Arquitectura futura / en diseño

La spec más nueva empuja hacia un modelo Notion-first:

- Notion como fuente de verdad operativa.
- Repo como definición del sistema: agentes, templates, workflow y guías.
- Agentes leyendo/escribiendo tarjetas de Notion.
- Orquestador que usa el campo `Estado` como puntero del pipeline.
- Escritura de cuerpo vía `ntn`.
- Movimiento de properties/estado vía MCP como solución transitoria.

Fuente principal:
- `docs/spec-notion-agents.md`

## Tensión principal

Hay una tensión activa entre:

1. Documentación repo-first actual: contenido fuente en archivos del repo + sync opcional.
2. Arquitectura futura Notion-first: contenido y perfil viven en Notion; el repo define el sistema.

Antes de implementar agentes o automatizaciones, decidir qué capa manda para ese flujo concreto.

## Madurez

Estado temprano/intermedio.

Ya existe:
- estructura reusable por perfiles
- onboarding de perfil vía Notion
- spec de agentes sobre Notion
- decisiones iniciales de arquitectura

Falta:
- reescribir agentes para `ntn`
- crear agente `researcher`
- implementar orquestador
- probar el flujo end-to-end con una pieza real
- resolver la deuda técnica de mover properties sin depender de MCP

## Regla práctica para futuros agentes

Antes de trabajar:
1. Leer `README.md`.
2. Leer `PLAN.md` si la tarea toca higiene o reusabilidad del repo.
3. Leer `docs/spec-notion-agents.md` si la tarea toca Notion, agentes u orquestación.
4. No duplicar perfil o contenido real en el repo si el flujo elegido es Notion-first.

## Referencias

- `README.md`
- `PLAN.md`
- `system/guides/workflow.md`
- `system/guides/profile-onboarding.md`
- `notion-sync/README.md`
- `docs/spec-notion-agents.md`
- `docs/agents-handoff.md`
- `docs/migration-notes.md`
