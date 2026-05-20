# Agents handoff

## Objetivo

Este repo incluye un equipo de agentes agnóstico para operar un sistema de marca personal por perfil.

## Dónde están

- `.claude/agents/content-strategist.md`
- `.claude/agents/idea-capture.md`
- `.claude/agents/draft-writer.md`
- `.claude/agents/draft-reviewer.md`
- `.claude/agents/channel-adapter.md`
- `.claude/agents/content-publisher.md`
- `.claude/agents/analytics-reviewer.md`

## Requisitos por perfil

Antes de usarlos, crear o completar:
- `profiles/<perfil>/profile.md`
- `profiles/<perfil>/config.yaml`
- `profiles/<perfil>/ideas/backlog.md`
- `profiles/<perfil>/content/drafts/`
- `profiles/<perfil>/content/published/`

Opcional:
- `profiles/<perfil>/config.local.yaml`

## Flujo recomendado

1. `content-strategist`
   - define prioridades, temas y gaps

2. `idea-capture`
   - captura ideas sueltas o propone ideas nuevas
   - guarda o prepara entradas para backlog

3. `draft-writer`
   - convierte una idea en borrador
   - guarda en `profiles/<perfil>/content/drafts/`

4. `draft-reviewer`
   - aprueba o rechaza con feedback accionable
   - si rechaza, volver a `draft-writer`

5. `channel-adapter`
   - adapta la pieza a otro canal o formato

6. `content-publisher`
   - prepara la pieza aprobada
   - mueve de `drafts/` a `published/`
   - hace sync opcional a Notion

7. `analytics-reviewer`
   - analiza resultados y propone siguientes experimentos

## Cómo invocarlos

Al pedir trabajo al agente principal, indicar:
- perfil objetivo
- canal objetivo
- tema o idea
- output esperado

Ejemplos:
- "Usa `content-strategist` para proponer 10 temas para `profiles/example/`."
- "Usa `idea-capture` para convertir esta idea en backlog para `profiles/example/`."
- "Usa `draft-writer` para escribir un LinkedIn post desde la idea 3 del backlog de `profiles/example/`."
- "Usa `draft-reviewer` para revisar este draft y dar feedback."
- "Usa `channel-adapter` para convertir este post a script corto."
- "Usa `content-publisher` para archivar esta pieza aprobada."
- "Usa `analytics-reviewer` para resumir aprendizajes de los publicados."

## Reglas

- todos trabajan sobre `profiles/<perfil>/`
- leer siempre `profile.md` y `config.yaml`
- usar `system/templates/` y `system/guides/workflow.md`
- no inventar experiencia personal
- no meter datos privados en archivos versionados
- tratar Notion como opcional
