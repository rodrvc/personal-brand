# Plan — Implementación del experimento pi pipeline

> Estado: draft revisado
> Última actualización: 2026-06-03
> Rama objetivo: `experiment/pi-orchestrated-content-pipeline`

---

## 1. Objetivo

Implementar un piloto mínimo del pipeline editorial orquestado con pi descrito en `docs/pi-pipeline-experiment.md`, de modo que una pieza real pueda avanzar desde `Idea` hasta `Review` en Notion con routing determinista, rewrites automáticos, convergencia observable y escalado correcto cuando no converja.

---

## 2. Entregables del piloto

### E1. Contratos de agentes del piloto

Definir contratos concretos para:

- `content-strategist`
- `researcher`
- `draft-writer`
- `draft-reviewer`
- `style-reviewer`
- `channel-reviewer`
- consolidación de `Rewrite Brief`

### E2. Template canónico de tarjeta

Definir la estructura parseable por headings para el artefacto en Notion.

### E3. Orquestador mínimo

Implementar un runtime que:

- lea una tarjeta
- parsee `## Runtime`
- enrute por `PI Estado`
- ejecute el rol correcto
- consolide reviews en `Rewrite Brief`
- actualice cuerpo y metadata sin duplicar bloques
- itere solo hasta `ready`, estancamiento, agotamiento de presupuesto o bloqueo

### E4. Memoria del piloto

Definir memoria por `profile × channel × format` y una `contract-promotion queue` para aprendizaje persistente.

### E5. Piloto end-to-end con una pieza real

Ejecutar una corrida real hasta `Review`.

---

## 3. Fases de implementación

## Fase 1 — Contratos y artefacto

### Objetivo
Cerrar el contrato del sistema antes de escribir el orquestador.

### Trabajo
1. Congelar template de tarjeta.
2. Congelar formato común de issues de review.
3. Congelar semántica de `PI Estado`, `review_round`, `rewrite_count` y budgets.
4. Congelar formato de `Rewrite Brief Round N`.
5. Ajustar o crear prompts/agentes para el piloto.

### Criterio de salida
- existe spec de contratos usable sin ambigüedad
- existe template de tarjeta con headings exactos
- cada agente tiene input/output y límites claros
- el writer ya no depende de reviews crudas como input principal

---

## Fase 2 — Librería de manipulación de tarjeta

### Objetivo
Tener primitivas seguras para leer y actualizar la tarjeta sin corromper el cuerpo.

### Trabajo
1. Parsear Markdown por headings canónicos.
2. Localizar bloques por nombre exacto.
3. Reemplazar bloques autorizados.
4. Crear nuevos bloques `Draft vN`, `Review Round N — ...` y `Rewrite Brief Round N`.
5. Validar invariantes antes de persistir.
6. Soportar compacción de snapshots si crece el artefacto.

### Criterio de salida
- el parser detecta faltantes y duplicados
- actualizar un bloque no modifica bloques ajenos
- reintentar una operación no duplica headings de la misma ronda
- el runtime puede compactar contexto sin romper trazabilidad

---

## Fase 3 — Orquestador determinista

### Objetivo
Implementar el motor de transición.

### Trabajo
1. Leer `PI Estado`, `run_id`, `review_round`, `rewrite_count`, `active_step`, `draft_base`.
2. Implementar exclusión básica por `active_step`.
3. Enrutar `Idea → strategy/research → Drafting`.
4. Enrutar `Drafting → draft-writer → Internal Review`.
5. Enrutar `Internal Review → reviewers → consolidación → Rewrite Brief`.
6. Detectar `ready`, `stagnation_detected`, agotamiento de rewrites y fallos estructurales.
7. Mover a `Drafting`, `Review` o `Blocked` según reglas.

### Criterio de salida
- el routing sigue solo reglas, no juicio libre
- existe consolidación determinista
- existe `Rewrite Brief` por ronda fallida
- el loop automático se corta correctamente por `ready`, estancamiento o presupuesto
- fallos estructurales mandan a `Blocked`

---

## Fase 4 — Presupuesto, memoria y promotion queue

### Objetivo
Hacer que el sistema aprenda y no gaste rondas ciegamente.

### Trabajo
1. Implementar `rewrite_budget`, `technical_retry_budget` y `context_budget`.
2. Implementar detector de estancamiento por `issue_id` persistente y por falta de progreso.
3. Implementar memoria por `profile × channel × format`.
4. Implementar `contract-promotion queue`.
5. Definir reglas de activación tras aprobación del owner.

### Criterio de salida
- el sistema puede distinguir reintentos técnicos de rewrites editoriales
- el sistema detecta no convergencia
- feedback recurrente puede promoverse a regla persistente

---

## Fase 5 — Integración con Notion

### Objetivo
Conectar el runtime con el artefacto vivo.

### Trabajo
1. Leer cuerpo con `ntn`.
2. Persistir cuerpo completo con `ntn pages update`.
3. Actualizar properties del piloto (`PI Estado`, budgets, memoria, etc.) con MCP o API.
4. Definir estrategia de recovery si una escritura parcial falla.

### Criterio de salida
- una corrida puede leer/escribir la tarjeta real
- cuerpo y metadata quedan sincronizados
- los retries técnicos no consumen rewrites

---

## Fase 6 — Piloto con pieza real

### Objetivo
Probar el sistema completo en una pieza concreta.

### Trabajo
1. Elegir una pieza en `Idea`.
2. Ejecutar strategy.
3. Ejecutar research si aplica.
4. Ejecutar draft.
5. Ejecutar review interna.
6. Ejecutar rewrite si corresponde.
7. Repetir automáticamente hasta `ready` o escalado.
8. Dejar la pieza en `Review`.

### Criterio de salida
- la pieza llega a `Review`
- el historial es legible
- no hay duplicaciones ni estados ambiguos
- cada ronda reduce issues abiertos o el sistema escala correctamente

---

## 4. Orden recomendado de archivos a tocar

1. `docs/pi-pipeline-experiment.md`
2. `docs/pi-pilot-agent-contracts.md`
3. `docs/pi-pipeline-implementation-plan.md`
4. prompt files / agent files del piloto
5. runtime/orchestrator code
6. helpers de parsing/patching Notion body
7. memoria / promotion queue

---

## 5. Decisiones que deben mantenerse

- `Estado` del sistema actual no cambia de significado durante el piloto.
- `PI Estado` controla solo el experimento.
- reviewers no reescriben drafts.
- writer no decide transiciones.
- el sistema siempre se detiene en `Review` o `Blocked`.
- el writer trabaja contra `Rewrite Brief`, no contra reviews crudas como fuente principal.

---

## 6. Riesgos de implementación

### R1. Corrupción del cuerpo de la tarjeta
Mitigación: parser por headings + invariantes estrictas.

### R2. Contracts drift entre prompts y spec
Mitigación: una fuente de verdad de contratos antes de editar prompts.

### R3. Reviews contradictorias
Mitigación: consolidación por severidad máxima + `core_thesis` compartida.

### R4. Reintentos inseguros
Mitigación: `run_id`, `active_step`, reemplazo idempotente de bloques.

### R5. Mezcla con el flujo actual
Mitigación: mantener aislado el piloto con metadata `PI *`.

### R6. No convergencia silenciosa
Mitigación: detector de estancamiento + budgets + escalado a `needs_owner_decision`.

### R7. Aprendizaje nulo entre piezas
Mitigación: memoria por `profile × channel × format` + `contract-promotion queue`.

---

## 7. Checklist de aceptación final del piloto

- [ ] existe template canónico de tarjeta
- [ ] existen contratos claros para los 6 roles y el `Rewrite Brief`
- [ ] el orquestador lee `PI Estado`
- [ ] el orquestador consolida reviewers con reglas deterministas
- [ ] el sistema soporta hasta 3 rewrites
- [ ] el sistema distingue retries técnicos de rewrites editoriales
- [ ] el sistema detecta estancamiento
- [ ] el caso agotado deja `needs_owner_decision`
- [ ] existe memoria por `profile × channel × format`
- [ ] existe `contract-promotion queue`
- [ ] una pieza real llega a `Review`
- [ ] el owner puede auditar qué cambió en cada ronda
- [ ] el owner puede ver por qué un issue persistió o fue resuelto
