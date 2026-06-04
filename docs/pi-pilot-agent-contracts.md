# Contratos — agentes del piloto pi

> Estado: draft revisado
> Última actualización: 2026-06-03
> Scope: contratos del experimento descrito en `docs/pi-pipeline-experiment.md`

---

## 1. Reglas globales

Todos los agentes del piloto deben respetar estas reglas:

1. La fuente de verdad viva es la tarjeta de Notion.
2. Cada agente trabaja sobre un snapshot explícito del artefacto.
3. Ningún agente decide transiciones de estado salvo el orquestador.
4. Ningún reviewer reescribe el draft directamente.
5. Nadie toca secciones ajenas fuera de su contrato.
6. El owner sigue siendo el único aprobador final.
7. Si faltan bloques obligatorios, el agente debe fallar de forma explícita; no improvisar.
8. Todo agente de rewrite trabaja contra una tesis canónica fija para esa ronda.
9. Todo feedback obligatorio debe poder rastrearse con `issue_id` estable.
10. Repetir el mismo feedback en silencio no cuenta como aprendizaje: debe entrar a memoria o a contract promotion.

---

## 2. content-strategist

### Objetivo
Convertir una idea en un brief accionable y una strategy usable por el writer.

### Lee
- perfil fuente
- contenido previo relevante
- memoria activa `profile × channel × format`
- tarjeta actual
- contexto del canal

### Debe producir
- `## Brief`
- `## Strategy`

### Debe decidir
- audiencia principal
- promesa del contenido
- ángulo
- objetivo de la pieza
- CTA deseado
- si la pieza requiere evidencia externa verificable
- `core_thesis`
- `allowed_claims`
- `required_support`
- `must_keep_points`
- `non_goals`

### No debe hacer
- escribir el draft
- opinar sobre calidad del draft
- mover estados
- crear claims sin marcar si requieren research

### Señal de salida
- strategy cerrada y suficiente para que otro agente escriba
- tesis canónica explícita y auditable

---

## 3. researcher

### Objetivo
Aportar evidencia o referencias cuando la strategy lo requiera.

### Lee
- `## Brief`
- `## Strategy`

### Debe producir
- `## Research`

### Formato mínimo
```md
Status: verified | not_required | partial

Sources:
- [Título] — URL

Claims supported:
- ...

Claims still unverified:
- ...

Claims prohibited until verified:
- ...
```

### No debe hacer
- escribir el draft
- adaptar tono
- decidir estructura narrativa final
- aprobar paso a review

### Señal de salida
- el writer sabe qué claims puede usar y cuáles no

---

## 4. draft-writer

### Objetivo
Escribir el draft inicial o reescribir una nueva versión integrando feedback.

### Lee
- `## Brief`
- `## Strategy`
- `## Research`
- memoria activa `profile × channel × format`
- último `## Draft vN` si existe
- `## Rewrite Brief Round N` como entrada operativa principal
- reviews raw de la ronda previa solo como auditoría cuando haga falta

### Debe producir
- nuevo bloque `## Draft vN`

### Resolution note obligatoria
```md
---
Resolution note:
- issue_id: ED-001
  status: resolved | partially_resolved | not_resolved | waived
  evidence:
  rationale_if_not_resolved:
- issue_id: ST-002
  status: resolved
  evidence:
```

### No debe hacer
- editar reviews existentes
- mover estados
- autocalificarse como listo
- borrar drafts anteriores
- ignorar un `issue_id` abierto sin marcarlo como `waived` o `not_resolved`

### Reglas duras
- MUST trabajar contra una sola tesis canónica por ronda
- MUST priorizar `rewrite_targets` P1 antes que cualquier sugerencia menor
- MUST preservar las fortalezas listadas en el rewrite brief
- MUST evitar cambios fuera de scope marcados como `disallowed_changes`

### Señal de salida
- existe un draft completo y coherente listo para review interna
- cada `issue_id` previo tiene respuesta explícita

---

## 5. draft-reviewer

### Objetivo
Evaluar arquitectura editorial del draft.

### Evalúa exclusivamente
- claridad
- estructura
- progresión
- fuerza del hook en términos editoriales
- fuerza del cierre en términos editoriales
- coherencia del argumento
- alineación con `core_thesis`

### No evalúa como responsabilidad principal
- tono fino
- voz personal
- ajuste de longitud del canal
- CTA como optimización específica de canal

### Debe producir
- `## Review Round N — Editorial`

### Formato obligatorio
```md
Verdict: rewrite_required | ready

Issues:
- issue_id: ED-001
  dimension: editorial
  severity: critical | important | minor
  scope: hook | body | closing | structure | thesis
  excerpt_or_anchor:
  request:
  rationale:
  pass_condition:
  status: open

Strengths to preserve:
- ...

Optional suggestions:
- ...
```

### Reglas adicionales
- si marca `rewrite_required`, MUST abrir al menos un `issue`
- si marca `ready`, MUST dejar cero `issues` obligatorios abiertos
- SHOULD proponer `closing_mode` cuando el problema esté en el cierre
- SHOULD explicitar si el bloqueo viene de tesis ambigua

---

## 6. style-reviewer

### Objetivo
Evaluar voz, tono y naturalidad.

### Evalúa exclusivamente
- alineación con el perfil
- naturalidad
- precisión verbal
- ausencia de humo
- ausencia de frases corporativas o vacías

### No evalúa como responsabilidad principal
- estructura argumental
- longitud del canal
- layout escaneable

### Debe producir
- `## Review Round N — Style`

### Formato obligatorio
Igual al contrato común de review con `dimension: style`.

### Reglas adicionales
- SHOULD aterrizar observaciones abstractas con ejemplos concretos de frase o bloque
- MAY marcar `critical` si el tono contradice directamente la voz del perfil

---

## 7. channel-reviewer

### Objetivo
Evaluar si la pieza funciona en el canal objetivo.

### Evalúa exclusivamente
- longitud
- escaneabilidad
- hook desde la lógica del canal
- CTA del canal
- ritmo superficial de lectura

### No evalúa como responsabilidad principal
- voz profunda del perfil
- arquitectura argumental interna

### Debe producir
- `## Review Round N — Channel Fit`

### Formato obligatorio
Igual al contrato común de review con `dimension: channel`.

### Reglas adicionales
- SHOULD sugerir `closing_mode` o patrón de CTA cuando el problema esté en el remate
- MUST diferenciar claramente entre bloqueos de canal y mejoras opcionales

---

## 8. Contrato común de review

Todos los reviewers comparten este contrato:

```md
Verdict: rewrite_required | ready

Issues:
- issue_id: <DIM>-NNN
  dimension: editorial | style | channel | factual | cross-cutting
  severity: critical | important | minor
  scope: hook | body | closing | cta | claim | structure | tone | scanability | thesis
  excerpt_or_anchor:
  request:
  rationale:
  pass_condition:
  status: open

Strengths to preserve:
- ...

Optional suggestions:
- ...
```

### Reglas adicionales
- opinar solo dentro de su dimensión
- si detectan un bloqueo fuera de dimensión, marcar `dimension: cross-cutting`
- no reescribir el draft completo
- cada comentario debe ser accionable
- MUST usar `issue_id` estable cuando un issue reaparece entre rondas
- `Optional suggestions` nunca deben bloquear por sí mismas

---

## 9. Rewrite Brief

### Objetivo
Convertir múltiples reviews en una única instrucción operativa de reescritura.

### Owner
- primario: orquestador
- secundario: `rewrite-brief synthesizer` si se separa como rol

### Formato obligatorio
```md
## Rewrite Brief Round N
- draft_base: Draft vN
- thesis_canonical:
- review_round: N
- rewrite_targets:
  - priority: P1 | P2
    issue_id:
    dimension:
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

### Reglas
- MUST resolver contradicciones entre reviewers antes de llegar al writer
- MUST limitar `rewrite_targets` prioritarios para evitar briefs infinitos
- MUST distinguir entre cambios obligatorios y opcionales
- MUST registrar si un `issue_id` viene arrastrado de una ronda previa

---

## 10. Orquestador

### Objetivo
Coordinar el flujo y consolidar resultados.

### Lee
- `## Runtime`
- headings de la tarjeta
- `PI Estado`
- metadata operativa
- memoria activa

### Debe hacer
- elegir el siguiente rol según reglas deterministas
- garantizar snapshot común para reviewers
- consolidar issues
- emitir `Rewrite Brief Round N`
- actualizar `Final QA`
- mover `PI Estado`
- manejar `run_id`, `review_round`, `rewrite_count`, budgets y `stagnation_detected`
- promover feedback recurrente a `contract-promotion queue`

### No debe hacer
- escribir contenido creativo del draft
- reinterpretar feedback libremente sin dejar rastro en el brief
- saltarse fases

### Reglas de consolidación
- cualquier `issue` `critical` => `rewrite_required`
- cualquier `issue` obligatorio abierto => `rewrite_required`
- todos `ready` y sin issues obligatorios abiertos => `ready`
- contradicciones se resuelven por severidad máxima y alineación con `core_thesis`

### Reglas de estancamiento
- MUST marcar `stagnation_detected` si el mismo `issue_id` persiste en dos rondas consecutivas
- MUST marcar `stagnation_detected` si ningún issue obligatorio previo queda resuelto
- al detectar estancamiento, MUST escalar a `Review` con `needs_owner_decision = true` como máximo en la siguiente transición

---

## 11. Memoria y promotion queue

### Memoria activa
Debe existir una memoria por `profile × channel × format` con:

- feedback aprobado por owner
- hooks preferidos / rechazados
- CTA preferidos / rechazados
- límites de tono
- patrones de bloqueo recurrente
- reglas persistentes del writer

### Contract-promotion queue
Un feedback recurrente entra a la cola si:

- reaparece en >=2 piezas, o
- reaparece en >=2 rondas de una misma pieza

### Regla
Tras aprobación del owner, el item MUST convertirse en:

- regla persistente del `draft-writer`, o
- guía persistente de perfil/canal

---

## 12. Criterio de handoff entre roles

### Strategy → Research
Ocurre si `content-strategist` marca necesidad de evidencia verificable.

### Strategy/Research → Draft
Ocurre cuando el writer tiene brief suficiente, thesis canónica y claims permitidos claramente delimitados.

### Draft → Internal Review
Ocurre al crear un nuevo `Draft vN`.

### Internal Review → Rewrite
Ocurre si la consolidación global es `rewrite_required` y no se agotaron límites.

### Internal Review → Review
Ocurre si la consolidación global es `ready`.

### Internal Review → Review (forced)
Ocurre si se agotan iteraciones, presupuesto o se detecta estancamiento.

---

## 13. Preguntas cerradas para implementación

Estas respuestas ya quedan fijadas por este contrato:

- ¿Quién escribe el draft? → `draft-writer`
- ¿Quién revisa estructura? → `draft-reviewer`
- ¿Quién revisa voz? → `style-reviewer`
- ¿Quién revisa ajuste al canal? → `channel-reviewer`
- ¿Quién decide el siguiente paso? → orquestador
- ¿Quién aprueba finalmente? → owner
- ¿Quién valida sustento factual? → `researcher` como owner primario; `draft-reviewer` puede bloquear
- ¿Quién consolida el feedback para rewrite? → orquestador vía `Rewrite Brief`
- ¿Quién aprende de bloqueos recurrentes? → orquestador + memoria + owner
