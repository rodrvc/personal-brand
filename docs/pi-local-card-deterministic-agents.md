# Agentes deterministas o no deterministas no es la pregunta correcta

> Artefacto local del piloto pi. Borrador preparado en local para luego moverlo a Notion en personal branch.

## Runtime
- pi_state: Review
- run_id: local-deterministic-agents-001
- iteration_count: 1
- active_step: none
- last_completed_step: review_round_1
- needs_owner_decision: false
- draft_base: Draft v1

## Brief
- canal: LinkedIn
- audiencia: devs e ingenieros que están construyendo agentes o evaluando cómo meterlos en flujos reales de producto
- objetivo: posicionar a Rodrigo con una opinión técnica clara sobre control de agentes, workflows y arquitectura real
- CTA: question
- constraints:
  - sonar técnico pero cercano
  - evitar tono de gurú o de “yo ya lo sé todo”
  - dejar una tesis clara y útil
  - conectar autonomía de agentes con diseño de sistemas y control operativo

## Strategy
- ángulo: la discusión útil no es si un agente es determinista o no, sino qué partes del sistema dejas probabilísticas y cuáles obligas a ser deterministas
- pilar: Agentes IA & LLMs
- por qué ahora: mucha gente habla de agentes autónomos, pero pocos distinguen entre libertad dentro del rol y control del workflow
- evidencia externa requerida: no
- criterio editorial: opinión técnica clara, con valor práctico para quien diseña sistemas con agentes

## Research
Status: not_required

Sources:
- No aplica; pieza basada en criterio de arquitectura y experiencia operativa

Claims supported:
- El post se plantea como postura técnica, no como benchmark universal

Claims still unverified:
- Ninguno

## Draft v1
Cada cierto tiempo vuelve la misma pregunta:

**¿Los agentes deberían ser deterministas o no deterministas?**

Mi impresión es que esa no es la pregunta correcta.

La pregunta útil es otra:

**¿Qué parte del sistema dejas probabilística y qué parte obligas a ser determinista?**

Porque si intentas hacer un agente “totalmente controlable”, te frustras rápido.

Un LLM no es una función pura.
No siempre responde igual.
No siempre prioriza igual.
No siempre falla igual.

Y está bien.

El problema empieza cuando también dejas probabilístico lo que no debería serlo:
- el flujo
- los permisos
- las transiciones
- el acceso a herramientas
- los criterios de salida
- el manejo de errores

Ahí es cuando un agente empieza a sentirse “incontrolable”.

No porque piense raro.

Porque el sistema alrededor le deja demasiado espacio para improvisar.

Para mí, la forma sana de construir agentes es esta:

- **probabilístico dentro del rol**
- **determinista en el sistema**

Por ejemplo:

El agente puede tener libertad para:
- redactar
- analizar
- resumir
- proponer opciones
- criticar un borrador

Pero no debería tener libertad para inventarse:
- en qué estado está el flujo
- cuándo pasa al siguiente paso
- qué tools puede usar
- qué acciones son irreversibles
- cuándo algo está realmente aprobado

Eso debería venir definido por arquitectura.

Ahí cambia todo.

Porque dejas de pedirle al agente que “se porte bien”
y empiezas a diseñar un sistema donde **no puede salirse fácilmente de ciertos límites**.

Cuando el workflow es determinista:
- puedes auditar mejor
- puedes reproducir fallos
- puedes meter observabilidad real
- puedes poner gates humanos
- puedes acotar costos
- puedes entender por qué algo avanzó, se bloqueó o se degradó

Por eso cada vez me convence más esta idea:

**no diseñes agentes para obedecer mejor.**
**Diseña sistemas donde el comportamiento importante no dependa solo de obediencia.**

Si el agente va a crear, revisar o investigar, perfecto: deja esa parte flexible.

Pero si va a mover estado, decidir transiciones, usar herramientas delicadas o afectar un flujo importante, ahí yo prefiero reglas claras, validaciones duras y caminos bastante más deterministas.

No porque quite “magia”.

Porque mete control.

Y en sistemas reales, control casi siempre termina valiendo más que autonomía aparente.

Tengo curiosidad:

**cuando un agente te dio problemas de verdad, fue por el modelo… o por haber dejado demasiado probabilístico el workflow?**

## Review Round 1 — Editorial
Verdict: ready

Critical:
- Ninguno

Important:
- La tesis está clara desde el inicio y se sostiene durante todo el post
- El contraste entre parte probabilística y parte determinista entrega una enseñanza concreta, no solo opinión
- El cierre conecta bien con conversación técnica sin cerrar el tema de forma dogmática

Minor:
- El bloque de listas centrales es largo, pero sigue siendo legible para LinkedIn

Required changes:
1. Ninguno

Suggested changes:
- Si luego quieres más retención, se puede compactar una de las listas centrales

## Review Round 1 — Style
Verdict: ready

Critical:
- Ninguno

Important:
- Suena técnico, cercano y con criterio propio
- No cae en humo ni en tono corporativo
- El mensaje tiene curiosidad y no suena demasiado sentencioso

Minor:
- `se porte bien` es coloquial; si luego quieres una versión más seria, se puede subir un poco el registro

Required changes:
1. Ninguno

Suggested changes:
- Ajustar una o dos frases si quieres una versión más sobria para article largo

## Review Round 1 — Channel Fit
Verdict: ready

Critical:
- Ninguno

Important:
- El hook abre una tensión técnica clara
- La escaneabilidad funciona con listas y bloques cortos
- El CTA final invita a respuesta con experiencia real, no a opinión vacía

Minor:
- El cuerpo está más cerca de post técnico largo que de post corto de feed

Required changes:
1. Ninguno

Suggested changes:
- Si luego quieres más alcance, sacar una versión más corta para feed rápido

## Final QA
- round: 1
- draft_base: Draft v1
- global_verdict: ready
- required_changes:
  - none
- persistent_critical_issues: none
- needs_owner_decision: false

## Owner Feedback
