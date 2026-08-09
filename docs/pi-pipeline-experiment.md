# Spec — Experimento de pipeline editorial con pi

> Estado: propuesta revisada
> Última actualización: 2026-06-03
> Objetivo: validar si pi puede conducir el flujo editorial completo hasta `Review` en Notion, con routing determinista, revisiones multiagente, rewrites automáticos y convergencia observable.

---

## 1. Resumen

Este experimento prueba un modo alternativo de operar el sistema de contenido:

- **Notion** sigue siendo la fuente de verdad del contenido vivo.
- **El repo** sigue definiendo templates, guías, contratos de agentes y reglas del flujo.
- **pi** pasa a ser el runtime principal de agentes y orquestación.
- El pipeline deja de ser una secuencia simple `idea → draft → review` y pasa a ser un ciclo controlado de:

`strategy → research → draft → internal review → rewrite brief → rewrite → internal review → owner review`

El objetivo no es automatizar publicación ni analytics en esta fase. El objetivo es llegar a un **estado `Review` de alta calidad**, listo para revisión humana en Notion, sin intervención manual entre rondas internas salvo que el sistema agote límites o detecte estancamiento.

---

## 2. Objetivo del experimento

Validar cinco hipótesis:

1. **Calidad:** varios agentes especializados producen drafts mejores que un único paso de escritura.
2. **Control:** un orquestador determinista evita que los agentes se salten fases o mezclen responsabilidades.
3. **Trazabilidad:** el historial de strategy, research, reviews, rewrite briefs y rewrites queda visible dentro de la tarjeta de Notion.
4. **Operación:** el flujo es lo bastante estable como para considerar reemplazar el uso principal de Claude Code en esta parte del sistema.
5. **Convergencia:** el sistema aprende de bloqueos recurrentes y reduce iteraciones con el tiempo.

### Criterios de éxito

El experimento se considera exitoso si, con una pieza real:

- la pieza llega a `Review` sin intervención manual entre pasos internos
- el historial de decisiones queda visible en la tarjeta
- el owner puede entender qué cambió entre iteraciones
- no hay ambigüedad sobre qué agente hizo qué
- existe un `Rewrite Brief` claro por cada ronda fallida
- la calidad percibida del draft final es igual o superior al flujo actual
- los issues abiertos disminuyen entre rondas o el sistema escala correctamente por estancamiento

### No objetivos

Quedan fuera de esta fase:

- autoposting
- adaptación multicanal completa
- analytics post-publicación
- migrar todo el repo o todos los agentes de una vez
- reemplazar el flujo actual antes de validar el piloto

---

## 3. Principios de diseño

### P1. Routing determinista

El orquestador decide el siguiente paso por reglas, no por juicio libre del modelo.

### P2. Creatividad dentro del rol, no en el flujo

La parte creativa queda dentro de cada agente:

- investigar
- escribir
- criticar
- reescribir

Pero el flujo, las transiciones y las salidas permitidas quedan fijadas por contrato.

### P3. Notion como artefacto compartido

La tarjeta de Notion es el artefacto de paso entre roles.

Cada agente:

- lee el contexto relevante desde la tarjeta
- escribe solo en su sección asignada
- no modifica secciones ajenas salvo el writer al crear una nueva versión del draft y el orquestador al actualizar bloques operativos

### P4. Revisión separada de escritura

Los reviewers no reescriben el draft directamente.

Los reviewers producen hallazgos estructurados. El orquestador consolida esos hallazgos en un **`Rewrite Brief` único**. El `draft-writer` solo reescribe contra ese brief consolidado.

### P5. Parada obligatoria en owner review

El sistema siempre se detiene en `Review`.

Ningún agente aprueba en nombre del owner.

### P6. Idempotencia antes que conveniencia

El pipeline debe tolerar reintentos sin duplicar bloques ni avanzar dos veces el estado.

### P7. Aprendizaje explícito, no implícito

Si un feedback reaparece varias veces, debe promoverse a memoria de perfil/canal o a contrato del writer. Repetir el mismo comentario en silencio no cuenta como aprendizaje.

---

## 4. Alcance del piloto

El piloto debe ser pequeño y vertical.

### Incluye

- 1 perfil
- 1 canal principal
- 1 tipo de contenido principal
- 1 pieza real en Notion
- pipeline hasta `Review`

### Recomendación inicial

- perfil: el perfil principal ya usado en Notion
- canal: LinkedIn
- formato: post

### Excluye por ahora

- TikTok/Reels
- múltiples piezas concurrentes
- publicación automática
- adaptación a otros canales
- métricas posteriores

---

## 5. Modelo de estado del experimento

### Decisión de compatibilidad

El experimento **no reutiliza directamente** el campo `Estado` del sistema actual como puntero del piloto.

Para evitar colisiones con la spec vigente (`Idea`, `Borrador`, `Revisión`, `Aprobado`, `Programado`, `Publicado`), el piloto usa **metadata operativa separada** dentro de la misma tarjeta o en properties auxiliares de Notion.

### Opción recomendada

Mantener:

- `Estado` → estado editorial principal del sistema actual
- `PI Estado` → puntero del experimento

Metadata operativa recomendada:

- `PI Run ID`
- `PI Review Round`
- `PI Rewrite Count`
- `PI Active Step`
- `PI Needs Owner Decision`
- `PI Last Completed Step`
- `PI Stagnation Detected`
- `PI Rewrite Budget Used`
- `PI Technical Retry Budget Used`
- `PI Context Budget Used`
- `PI Memory Version`
- `PI Thesis Version`

### Estados visibles del piloto

| `PI Estado` | Responsable principal | Descripción |
|---|---|---|
| `Idea` | content-strategist | pieza existe pero aún no tiene brief/strategy cerrados |
| `Drafting` | draft-writer | strategy cerrada o existe rewrite brief abierto |
| `Internal Review` | reviewers + consolidación | el draft se evalúa y se consolida un rewrite brief |
| `Review` | owner | pieza lista para revisión humana o requiere decisión humana |
| `Blocked` | owner/orquestador | error operativo o inconsistencia del artefacto |

### Loop permitido

`Drafting → Internal Review → Drafting → Internal Review → ... → Review`

### Límites del loop

El loop puede terminar por cualquiera de estas condiciones:

1. `global_verdict = ready`
2. `rewrite_count >= max_rewrites`
3. `rewrite_budget_used >= rewrite_budget_limit`
4. `stagnation_detected = true`
5. `blocked = true`

### Límites recomendados para el piloto

- `max_rewrites = 3`
- `technical_retry_budget = 2` por transición crítica
- `context_budget` suficientemente bajo para obligar compacción si el artefacto crece demasiado

### Salida del caso fallido

Si se agotan límites o se detecta estancamiento:

- el draft candidato sigue siendo el último `Draft vN`
- `Final QA` debe explicar por qué no salió limpio
- `PI Needs Owner Decision = true`
- el owner recibe la pieza en `Review`, no en silencio ni en un estado ambiguo

---

## 6. Contrato de datos de la tarjeta

La tarjeta debe ser legible para humanos y operable por máquina.

### Encabezados canónicos

```md
# <Título>

## Runtime
## Brief
## Strategy
## Research
## Draft v1
## Review Round 1 — Editorial
## Review Round 1 — Style
## Review Round 1 — Channel Fit
## Rewrite Brief Round 1
## Draft v2
## Review Round 2 — Editorial
## Review Round 2 — Style
## Review Round 2 — Channel Fit
## Rewrite Brief Round 2
## Final QA
## Owner Feedback
```

### Reglas de estructura

1. `## Runtime` es bloque operativo del orquestador.
2. `## Brief`, `## Strategy`, `## Research` aparecen una sola vez.
3. Cada `## Draft vN` es inmutable después de creado.
4. Cada reviewer escribe exactamente un bloque por ronda.
5. Cada ronda fallida genera exactamente un `## Rewrite Brief Round N`.
6. `## Final QA` es reemplazable por el orquestador en cada consolidación.
7. `## Owner Feedback` solo lo toca el owner.

### Runtime mínimo

```md
## Runtime
- pi_state: Idea | Drafting | Internal Review | Review | Blocked
- run_id: <uuid>
- review_round: 0
- rewrite_count: 0
- active_step: none
- last_completed_step: none
- needs_owner_decision: false
- stagnation_detected: false
- rewrite_budget_used: 0
- technical_retry_budget_used: 0
- context_budget_used: 0
- draft_base: none
- strategy_version: 1
- thesis_version: 1
- memory_version: 1
```

### Política de actualización

Como `ntn pages update` reemplaza el cuerpo completo, el orquestador debe operar con parseo por headings y aplicar estas invariantes:

- localizar bloques por heading exacto
- reemplazar solo bloques autorizados
- rechazar la ejecución si faltan headings obligatorios del paso actual
- no duplicar headings ya existentes para la misma ronda
- compactar snapshots cuando `context_budget_used` supere el umbral definido

### Snapshot de lectura por ronda

En cada ronda de review existe un único `draft_base`.

- todos los reviewers leen el mismo `Draft vN`
- reviewers de la misma ronda no leen reviews de otros reviewers de esa misma ronda
- reviewers leen también la misma `strategy_version`, `thesis_version` y `memory_version`
- el writer lee el `Rewrite Brief Round N` como fuente principal y los bloques raw de review solo como auditoría

---

## 7. Strategy canónica

La `## Strategy` debe fijar la tesis que los reviewers usarán como base común.

Formato mínimo:

```md
## Strategy
- angle:
- pillar:
- why_now:
- evidence_required: yes | no
- editorial_criterion:
- core_thesis:
- audience_problem:
- promise:
- allowed_claims:
- required_support:
- must_keep_points:
- non_goals:
```

### Regla

Si la strategy no fija `core_thesis`, `allowed_claims` y `non_goals`, el pipeline no debe pasar a `Drafting`.

---

## 8. Roles del piloto

### 8.1 content-strategist

Responsabilidad:

- convertir la idea en un brief accionable
- definir ángulo, audiencia, promesa, criterio editorial, tesis canónica y tipo de evidencia esperada

Lee:

- perfil
- config del perfil
- contenido previo relevante
- memoria por perfil/canal si existe
- tarjeta actual

Escribe:

- `## Brief`
- `## Strategy`

No hace:

- escribir el draft final
- aprobar la pieza

### 8.2 researcher

Responsabilidad:

- reunir y fijar sustento visible cuando la pieza hace afirmaciones técnicas, comparativas o factuales

Lee:

- `## Brief`
- `## Strategy`

Escribe:

- `## Research`

No hace:

- escribir el draft
- decidir tono o estructura final

### Regla de ejecución del researcher

- si la pieza requiere evidencia verificable, `researcher` corre antes de `draft-writer`
- si la pieza es puramente experiencial y no necesita claims externos, `## Research` puede quedar explícitamente marcado como `Not required`

### 8.3 draft-writer

Responsabilidad:

- producir el draft inicial y las reescrituras posteriores

Lee:

- `## Brief`
- `## Strategy`
- `## Research`
- memoria activa de `profile × channel × format`
- el último `## Draft vN` si existe
- el último `## Rewrite Brief Round N` como entrada principal

Escribe:

- `## Draft v1`, `## Draft v2`, `## Draft v3`, ...

Debe incluir al final de cada draft una `Resolution note` que responda **issue por issue** al rewrite brief previo.

No hace:

- decidir avance de estado
- editar bloques de review
- leer reviews crudas como fuente principal si ya existe rewrite brief

### 8.4 draft-reviewer

Responsabilidad exclusiva:

- estructura argumental
- claridad
- progresión
- hook en términos editoriales
- cierre en términos editoriales
- coherencia con `core_thesis`

Escribe:

- `## Review Round N — Editorial`

### 8.5 style-reviewer

Responsabilidad exclusiva:

- tono
- voz
- naturalidad
- precisión verbal
- humo o genericidad

Escribe:

- `## Review Round N — Style`

### 8.6 channel-reviewer

Responsabilidad exclusiva:

- adecuación al canal
- longitud
- escaneabilidad
- CTA del canal
- legibilidad superficial

Escribe:

- `## Review Round N — Channel Fit`

---

## 9. Contrato de issue y review

Todos los reviewers deben producir hallazgos comparables.

```md
Verdict: rewrite_required | ready

Issues:
- issue_id: ED-001
  dimension: editorial | style | channel | factual
  severity: critical | important | minor
  scope: hook | body | closing | cta | claim | structure | tone | scanability
  excerpt_or_anchor: <texto o bloque>
  request: <cambio pedido>
  rationale: <por qué importa>
  pass_condition: <cómo saber que quedó resuelto>
  status: open

Strengths to preserve:
- ...

Optional suggestions:
- ...
```

### Reglas por reviewer

- opinar solo dentro de su dimensión principal
- si detecta algo fuera de su dimensión que bloquea, marcarlo como `critical` y `dimension: cross-cutting`
- no reescribir el draft completo
- todo `rewrite_required` MUST venir acompañado por al menos un `issue` `open`
- `ready` MUST implicar cero `issues` `critical` y cero cambios obligatorios abiertos

### Gate factual

La pieza no puede pasar a `Review` si contiene afirmaciones importantes sin sustento visible en `## Research` o sin base experiencial explícita en el draft.

Owner operativo del gate factual:

- primario: `researcher`
- secundario: `draft-reviewer` puede bloquear si detecta claims sin sustento

---

## 10. Consolidación determinista y Rewrite Brief

El orquestador consolida resultados con estas reglas:

1. Si cualquier reviewer reporta un `issue` `critical` → resultado global `rewrite_required`.
2. Si no hay `critical` pero existe al menos un `issue` `open` con cambio obligatorio → resultado global `rewrite_required`.
3. Si todos los reviewers marcan `ready` y no hay `issues` obligatorios abiertos → resultado global `ready`.
4. Contradicciones se resuelven por severidad máxima y por alineación con `core_thesis`, no por promedio.

### Rewrite Brief Round N

Toda ronda con `rewrite_required` MUST generar un bloque así:

```md
## Rewrite Brief Round N
- draft_base: Draft vN
- thesis_canonical:
- review_round: N
- rewrite_targets:
  - priority: P1
    issue_id: ED-001
    dimension: editorial
    required_action:
    acceptance_check:
    carryover_status: new | carried
- strengths_to_preserve:
  - ...
- disallowed_changes:
  - ...
- closing_mode: question | conclusion
- allowed_frame: prompts | roles | stages
- stagnation_status: none | warning | detected
```

### Regla de input del writer

El `draft-writer` MUST usar `Rewrite Brief Round N` como entrada operativa principal.

### Salida de `Final QA`

`## Final QA` debe registrar:

- ronda actual
- draft base revisado
- verdict global
- issues abiertos
- issues resueltos
- issues waived
- `rewrite_decision`
- `stagnation_detected`
- `needs_owner_decision`

---

## 11. Estancamiento, presupuesto y memoria

### Detector de estancamiento

El orquestador MUST marcar `stagnation_detected = true` si ocurre cualquiera de estas condiciones:

- el mismo `issue_id` obligatorio persiste en dos rondas consecutivas
- el writer no resuelve ningún `issue` obligatorio de la ronda previa
- dos rondas consecutivas dejan drafts semánticamente casi idénticos

Si `stagnation_detected = true`, el sistema MUST escalar a `Review` con `needs_owner_decision = true` como máximo en la siguiente transición.

### Modelo de presupuesto

El pipeline separa tres presupuestos:

- `rewrite_budget`: número máximo de rewrites editoriales
- `technical_retry_budget`: reintentos por parseo/escritura/idempotencia
- `context_budget`: límite operativo del tamaño del artefacto/snapshot

Reglas:

- un retry técnico MUST NOT consumir `rewrite_budget`
- exceder `context_budget` MUST forzar compacción del snapshot antes de otra ronda
- agotar `rewrite_budget` MUST mover a `Review` con `needs_owner_decision = true`

### Memoria de aprendizaje

Debe existir una memoria separada por `profile × channel × format` con:

- feedback aprobado por owner
- patrones recurrentes de bloqueo
- hooks que convergen / no convergen
- CTA preferidos
- límites de tono
- reglas promovidas al contrato del writer

### Contract promotion queue

Si un patrón reaparece en >=2 piezas o en >=2 rondas de la misma pieza, SHOULD entrar a una `contract-promotion queue`.

Tras aprobación del owner, MUST convertirse en:

- regla persistente del `draft-writer`, o
- guía persistente del perfil/canal

---

## 12. Lógica del orquestador

El orquestador no genera contenido. Coordina.

### Reglas operativas mínimas

- toda corrida genera un `run_id`
- no se inicia una corrida si `active_step` ya está ocupado por otra corrida viva
- un retry con el mismo `run_id` debe ser idempotente
- si el owner cambia el artefacto durante la corrida y rompe invariantes, el sistema mueve a `Blocked`
- el loop interno se ejecuta automáticamente hasta converger o agotar límites

### Pseudoflujo

```text
leer tarjeta
parsear headings
leer Runtime

si active_step != none y run_id es ajeno:
  abortar

si pi_state = Idea:
  active_step = strategy
  correr content-strategist

  si Strategy exige evidencia:
    active_step = research
    correr researcher
  sino:
    asegurar Research = Not required

  last_completed_step = strategy_or_research
  pi_state = Drafting
  active_step = none

si pi_state = Drafting:
  active_step = draft_writer
  correr draft-writer sobre Draft vN+1
  draft_base = Draft vN+1
  rewrite_count += 1 si no es Draft v1
  last_completed_step = draft_writer
  pi_state = Internal Review
  active_step = none

si pi_state = Internal Review:
  active_step = review_round_N
  review_round += 1
  correr draft-reviewer sobre draft_base
  correr style-reviewer sobre draft_base
  correr channel-reviewer sobre draft_base
  consolidar issues

  si global = rewrite_required:
    emitir Rewrite Brief Round N
    detectar estancamiento

    si stagnation_detected = true:
      needs_owner_decision = true
      last_completed_step = review_round_N
      pi_state = Review
      active_step = none

    si stagnation_detected = false y rewrite_count < max_rewrites y rewrite_budget_used < rewrite_budget_limit:
      last_completed_step = review_round_N
      pi_state = Drafting
      active_step = none

    si rewrite_count >= max_rewrites o rewrite_budget_used >= rewrite_budget_limit:
      needs_owner_decision = true
      last_completed_step = review_round_N
      pi_state = Review
      active_step = none

  si global = ready:
    needs_owner_decision = false
    last_completed_step = review_round_N
    pi_state = Review
    active_step = none

si pi_state = Review:
  detenerse

si falta un bloque obligatorio o el parseo falla:
  pi_state = Blocked
  active_step = none
  registrar motivo en Final QA
```

---

## 13. Herramientas y runtime

### Lectura / escritura de contenido

Prioridad:

1. `ntn` para leer y escribir el cuerpo de la tarjeta
2. MCP de Notion o API directa para mover properties si `ntn` no cubre ese paso

### Runtime del experimento

- pi ejecuta los agentes
- el repo guarda prompts, contracts, templates y spec
- Notion guarda el artefacto vivo

### Decisión operativa

Mientras el flujo no esté estable, se tolera usar MCP para mover properties del piloto (`PI Estado`, budgets, memoria, etc.). Una vez validado, conviene migrar ese paso a una llamada más barata vía API.

---

## 14. Cambios necesarios en el repo

### Nuevas piezas documentales

- esta spec: `docs/pi-pipeline-experiment.md`
- contratos: `docs/pi-pilot-agent-contracts.md`
- plan: `docs/pi-pipeline-implementation-plan.md`

### Agentes nuevos o revisados

- `researcher` si aún no existe en pi para este flujo
- `style-reviewer`
- `channel-reviewer`
- ajustes a `content-strategist`
- ajustes a `draft-writer`
- ajustes a `draft-reviewer`
- `rewrite-brief synthesizer` si no vive dentro del orquestador
- futuro `pi-orchestrator` o skill equivalente

### Cambios de contrato

Los agentes del experimento deben dejar de asumir edición directa de archivos en `profiles/<perfil>/content/drafts/` como flujo principal del piloto. Para este experimento, la pieza viva está en Notion.

---

## 15. Compatibilidad con el flujo actual

Este experimento no reemplaza inmediatamente el flujo actual.

Durante el piloto:

- el flujo actual queda intacto
- el flujo pi-orquestado vive como camino alternativo
- `Estado` conserva el significado del sistema actual
- `PI Estado` y metadata asociada pertenecen solo al experimento

### Criterio de promoción

Se considera promover el flujo pi-orquestado si:

- al menos una pieza real llega a `Review` con calidad satisfactoria
- el owner percibe mejor trazabilidad que en el flujo actual
- la operación no requiere correcciones manuales entre pasos internos
- no aparecen duplicaciones ni corrupción del cuerpo de la tarjeta
- existe convergencia observable o escalado correcto por estancamiento
- las reglas promovidas reducen iteraciones en piezas posteriores

---

## 16. Riesgos

### R1. Divergencia con el estado editorial principal

Mitigación:
- usar `PI Estado` separado
- no reinterpretar `Estado` durante el piloto

### R2. Reviewers demasiado solapados

Mitigación:
- contratos explícitos por dimensión
- tesis canónica compartida
- rewrite brief consolidado

### R3. Loops largos sin convergencia

Mitigación:
- `max_rewrites`
- detector de estancamiento
- escalado a `needs_owner_decision`

### R4. La tarjeta se vuelve demasiado larga

Mitigación:
- `context_budget`
- compacción de snapshots
- rewrite briefs breves y machine-readable

### R5. Dependencia parcial de MCP

Mitigación:
- usar MCP solo para properties mientras no haya sustituto más barato

### R6. Corridas concurrentes o retries defectuosos

Mitigación:
- `run_id`
- `active_step`
- budgets separados
- reglas de exclusión e idempotencia

### R7. Falta de aprendizaje entre piezas

Mitigación:
- memoria por `profile × channel × format`
- contract promotion queue

---

## 17. Próximos pasos

1. Validar esta spec a nivel arquitectónico.
2. Definir el formato final del `Rewrite Brief Round N`.
3. Definir la memoria por `profile × channel × format` y la `contract-promotion queue`.
4. Ajustar el contrato de `content-strategist`, `draft-writer`, `draft-reviewer`, `style-reviewer` y `channel-reviewer`.
5. Implementar un orquestador mínimo con budgets y detector de estancamiento.
6. Ejecutar el flujo completo hasta `Review` con una pieza real.
7. Medir convergencia y decidir si conviene expandirlo o reemplazar el flujo actual.
