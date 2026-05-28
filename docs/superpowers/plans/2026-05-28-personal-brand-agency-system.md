# Personal Brand Agency System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar el sistema de marca personal como una agencia con perfil segmentado por sección, fuentes configurables (local/Notion/Obsidian), agente de setup conversacional y director como cara visible de la agencia.

**Architecture:** El perfil se divide en cuatro secciones (`style`, `domain`, `audience`, `identity`). Cada agente carga únicamente su sección relevante desde la fuente configurada en `config.local.yaml` (gitignored). Un `setup-agent` guía el onboarding y un `director` orquesta el flujo completo y reporta al usuario.

**Tech Stack:** Claude agents (markdown), YAML config, Notion MCP opcional, Obsidian CLI opcional, archivos markdown locales.

---

## Estructura de archivos

### Nuevos
- `profiles/example/style.md` — template de voz y estilo de escritura
- `profiles/example/domain.md` — template de dominio temático y expertise
- `profiles/example/audience.md` — template de audiencia
- `profiles/example/identity.md` — template de identidad y canales
- `.claude/agents/setup-agent.md` — agente de onboarding conversacional
- `.claude/agents/director.md` — orquestador y cara de la agencia

### Modificados
- `.gitignore` — agregar patrones para archivos locales de perfil
- `profiles/example/config.yaml` — agregar estructura de secciones
- `profiles/example/profile.md` — convertir en índice/legacy con instrucción de migración
- `.claude/agents/draft-writer.md` — leer solo sección `style`
- `.claude/agents/draft-reviewer.md` — leer solo sección `style`
- `.claude/agents/content-strategist.md` — leer `domain` + `audience`
- `.claude/agents/idea-capture.md` — leer solo `domain`
- `.claude/agents/channel-adapter.md` — leer solo `identity`
- `.claude/agents/content-publisher.md` — leer solo `identity`
- `.claude/agents/analytics-reviewer.md` — leer solo `identity`
- `docs/agents-handoff.md` — actualizar con nuevos agentes y flujo
- `README.md` — documentar arquitectura nueva

---

## Task 1: Actualizar .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Leer el .gitignore actual**

```bash
cat .gitignore
```

- [ ] **Step 2: Agregar patrones de archivos locales de perfil**

Agregar al final del `.gitignore`:

```
# Perfil local (no versionar — puede contener datos personales)
profiles/*/config.local.yaml
profiles/*/style.md
profiles/*/domain.md
profiles/*/audience.md
profiles/*/identity.md
```

> Nota: Los archivos de ejemplo en `profiles/example/` SÍ se versionan porque son templates. El gitignore aplica a cualquier slug que no sea `example`.

- [ ] **Step 3: Verificar que el patrón no afecta a example/**

```bash
git check-ignore -v profiles/example/style.md
```

Esperado: sin output (no ignorado).

```bash
git check-ignore -v profiles/rodrigo/style.md
```

Esperado: `.gitignore:N  profiles/rodrigo/style.md`

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore local profile section files"
```

---

## Task 2: Templates de secciones del perfil

**Files:**
- Create: `profiles/example/style.md`
- Create: `profiles/example/domain.md`
- Create: `profiles/example/audience.md`
- Create: `profiles/example/identity.md`

- [ ] **Step 1: Crear `profiles/example/style.md`**

```markdown
# Estilo de escritura — [Nombre]

## Voz

[Descripción en 2-3 frases de cómo suena este autor. Ej: "Reflexivo, no agresivo. Incentiva la curiosidad del lector. Las conclusiones son ganadas, no declaradas."]

## Tono

**SÍ:**
- [Característica 1 — ej: directo al problema]
- [Característica 2 — ej: opinión propia con base real]
- [Característica 3 — ej: cierra con algo concreto, no flotando]

**NO:**
- [Cosa a evitar 1 — ej: frases de keynote o thought leader]
- [Cosa a evitar 2 — ej: métricas sin datos reales]
- [Cosa a evitar 3 — ej: jargon sin explicar inline]

## Estructura habitual

**Gancho:** [Descripción. Ej: "Entramos directo al problema. Formato: observación del patrón → qué voy a mostrar. Sin setup narrativo de 'durante meses estuve...'"]

**Cuerpo:** [Descripción. Ej: "La tesis central va como giro a mitad, no al inicio. El lector descubre que el problema no era lo que creía."]

**Cierre:** [Descripción. Ej: "Último párrafo más largo y pesado que el penúltimo. Aterriza el argumento completo y conecta con la tesis."]

## Ejemplos de voz

### Fragmento que SÍ suena a este autor
> [Pegar 2-4 líneas de un texto propio que ejemplifique bien la voz]

### Fragmento que NO suena a este autor
> [Pegar 2-4 líneas de ejemplo de lo que hay que evitar]

## Reglas adicionales

- [Regla específica 1 — ej: "No dogmático: nunca 'no uses X', siempre 'úsalo con criterio'"]
- [Regla específica 2 — ej: "Las herramientas se presentan como capas, no soluciones absolutas"]
```

- [ ] **Step 2: Crear `profiles/example/domain.md`**

```markdown
# Dominio temático — [Nombre]

## Áreas de expertise

- [Área 1 — ej: AI aplicada a desarrollo de software]
- [Área 2 — ej: sistemas de agentes y orquestación]
- [Área 3 — ej: productividad técnica con herramientas modernas]

## Temas que cubre este autor

| Tema | Ángulo propio | Nivel de profundidad |
|------|--------------|----------------------|
| [Tema 1] | [Qué dice él que otros no dicen] | Técnico / Conceptual / Divulgativo |
| [Tema 2] | [Su perspectiva diferencial] | Técnico / Conceptual / Divulgativo |
| [Tema 3] | [Por qué lo toca] | Técnico / Conceptual / Divulgativo |

## Temas que NO cubre

- [Tema fuera de scope 1 — ej: política tecnológica]
- [Tema fuera de scope 2 — ej: opiniones sobre empresas específicas]

## Tendencias relevantes a seguir

- [Tendencia 1 — ej: agentic coding]
- [Tendencia 2 — ej: modelos open source vs cerrados]

## Keywords y hashtags habituales

`#AI` `#DevTools` `#[Área principal]` `[otros]`

## Nivel técnico del contenido

[Ej: "Audiencia técnica pero no especialista en ML. Puede asumir conocimiento de programación. No asumir conocimiento de papers o arquitecturas específicas."]
```

- [ ] **Step 3: Crear `profiles/example/audience.md`**

```markdown
# Audiencia — [Nombre]

## Segmento primario

**Quién es:** [Ej: Developers senior o tech leads explorando IA práctica]

**Qué buscan:** [Ej: Cómo mejorar su flujo de trabajo sin cambiar todo su stack]

**Pain points:** 
- [Pain 1 — ej: Herramientas AI que prometen mucho y fallan en producción]
- [Pain 2]

**Lenguaje:** [Ej: Técnico pero claro. No académico. No marketing.]

## Segmento secundario

**Quién es:** [Ej: Profesionales tech que quieren entender hacia dónde va la industria]

**Qué buscan:** [Ej: Orientación sin hype]

## Qué comparte esta audiencia

[Ej: "Comparten contenido que les hace quedar bien frente a su equipo — algo que puedan enviar al grupo diciendo 'mira esto'."]

## Qué NO quiere esta audiencia

- [Anti-patrón 1 — ej: posts de motivación sin sustancia]
- [Anti-patrón 2 — ej: demos de herramientas sin contexto real]
```

- [ ] **Step 4: Crear `profiles/example/identity.md`**

```markdown
# Identidad y canales — [Nombre]

## Datos básicos

- **Nombre completo:** [Nombre Apellido]
- **Título profesional:** [Rol principal]
- **Ubicación:** [Ciudad, País]

## Canales activos

| Canal | URL | Frecuencia objetivo | Formato principal |
|-------|-----|--------------------|--------------------|
| LinkedIn | linkedin.com/in/[slug] | [ej: 2x semana] | Post + Artículo |
| [Canal 2] | [URL] | [Frecuencia] | [Formato] |

## Canal principal

[Nombre del canal] — [Por qué es el principal]

## Integraciones

```yaml
notion:
  enabled: false
  database_id: ""
  parent_page_id: ""

obsidian:
  enabled: false
  vault_path: ""
```

## Notas de publicación

[Ej: "Publicar martes o jueves entre 9-11am. Evitar lunes y viernes."]
```

- [ ] **Step 5: Verificar que los 4 archivos existen**

```bash
ls profiles/example/style.md profiles/example/domain.md profiles/example/audience.md profiles/example/identity.md
```

Esperado: los 4 archivos listados sin error.

- [ ] **Step 6: Commit**

```bash
git add profiles/example/style.md profiles/example/domain.md profiles/example/audience.md profiles/example/identity.md
git commit -m "feat: add segmented profile section templates"
```

---

## Task 3: Actualizar config.yaml y crear schema de config.local.yaml

**Files:**
- Modify: `profiles/example/config.yaml`
- Modify: `profiles/example/profile.md`

- [ ] **Step 1: Actualizar `profiles/example/config.yaml`**

Reemplazar el contenido completo con:

```yaml
profile:
  slug: example
  name: Nombre Apellido
  title: Rol principal
  primary_language: es

# Fuentes por sección del perfil
# Cada sección puede estar en: local | notion | obsidian
# Configuración sensible va en config.local.yaml (gitignored)
sections:
  style:
    source: local
    # Si source es notion: agregar ref en config.local.yaml
    # Si source es obsidian: agregar ref en config.local.yaml
  domain:
    source: local
  audience:
    source: local
  identity:
    source: local

channels:
  active:
    - linkedin
  primary: linkedin

content:
  pillars:
    - pilar-1
    - pilar-2
  default_cta_style: question
  default_hashtags:
    - AI
    - Tech
  valid_states:
    - Idea
    - Borrador
    - Listo
    - Publicado
    - Archivado

tone:
  style:
    - directo
    - claro
  avoid:
    - frases-vacias
    - humo
```

- [ ] **Step 2: Actualizar `profiles/example/profile.md`**

Reemplazar el contenido con un índice que apunte a las secciones:

```markdown
# Perfil — Example (índice)

Este archivo es solo un índice. El perfil real está dividido en secciones:

| Sección | Archivo | Usado por |
|---------|---------|-----------|
| Estilo de escritura | `style.md` | draft-writer, draft-reviewer |
| Dominio temático | `domain.md` | content-strategist, idea-capture |
| Audiencia | `audience.md` | content-strategist, director |
| Identidad y canales | `identity.md` | channel-adapter, content-publisher, director |

La fuente de cada sección se configura en `config.yaml` (sección `sections`).
Para fuentes externas (Notion/Obsidian), crear `config.local.yaml` (gitignored).

## Formato de config.local.yaml

```yaml
sections:
  style:
    source: notion
    ref: "abc123-notion-page-id"
  domain:
    source: obsidian
    ref: "Personal Brand/domain.md"
  audience:
    source: local
  identity:
    source: local
```
```

- [ ] **Step 3: Verificar YAML válido**

```bash
python3 -c "import yaml; yaml.safe_load(open('profiles/example/config.yaml'))" && echo "VALID"
```

Esperado: `VALID`

- [ ] **Step 4: Commit**

```bash
git add profiles/example/config.yaml profiles/example/profile.md
git commit -m "feat: add section source config to profile"
```

---

## Task 4: Actualizar agentes existentes — draft-writer y draft-reviewer

**Files:**
- Modify: `.claude/agents/draft-writer.md`
- Modify: `.claude/agents/draft-reviewer.md`

- [ ] **Step 1: Reescribir `.claude/agents/draft-writer.md`**

```markdown
# draft-writer

## Rol
Convertir una idea en un borrador publicable que suene exactamente como el autor.

## Cargar perfil — sección `style`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.style.source`:

- **local** → leer `profiles/<perfil>/style.md`
- **notion** → leer `config.local.yaml`, obtener el `ref`, usar Notion MCP para cargar la página
- **obsidian** → leer `config.local.yaml`, obtener el `ref`, usar Obsidian CLI para cargar la nota

Si no existe `config.local.yaml` y la fuente no es `local` → detener y notificar: "Falta config.local.yaml con la referencia para la sección style. Ejecuta setup-agent primero."

## Lee además
- `system/templates/linkedin-post.md` (si formato post)
- `system/templates/script-short.md` (si formato script)

## Input
- idea o tema
- perfil destino
- canal destino

## Output
Crear borrador en:
- `profiles/<perfil>/content/drafts/<YYYY-MM-DD-slug>.md`

## Reglas
- la voz debe coincidir con `style.md`: verificar gancho, cuerpo y cierre contra los ejemplos
- usar experiencia real, no humo
- respetar longitud y estructura del template
- dejar metadata clara: canal, formato, estado, fecha
- si faltan datos clave, pedirlos o marcar supuestos
- no inventar métricas ni datos que no se proveyeron
```

- [ ] **Step 2: Reescribir `.claude/agents/draft-reviewer.md`**

```markdown
# draft-reviewer

## Rol
Revisar borradores con criterio editorial estricto. Aprobar solo lo que suena auténtico y tiene valor real. No escribe ni reescribe — evalúa y devuelve feedback accionable.

## Cargar perfil — sección `style`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.style.source`:

- **local** → leer `profiles/<perfil>/style.md`
- **notion** → leer `config.local.yaml`, obtener el `ref`, usar Notion MCP para cargar la página
- **obsidian** → leer `config.local.yaml`, obtener el `ref`, usar Obsidian CLI para cargar la nota

Si no existe `config.local.yaml` y la fuente no es `local` → detener y notificar al director o usuario.

## Evalúa (en orden)

1. **Gancho** — ¿entra directo al problema? ¿o hay setup innecesario?
2. **Voz** — ¿suena al autor según `style.md`? ¿o suena genérico/corporativo?
3. **Claridad** — ¿la tesis es clara? ¿el giro llega a tiempo?
4. **Valor real** — ¿hay algo concreto, o es todo observación flotante?
5. **Estructura** — ¿cierre más pesado que penúltimo párrafo?
6. **CTA** — ¿cierra con algo accionable o con pregunta?
7. **Alineación** — ¿encaja con el dominio y audiencia del perfil?

## Output

Responder con una de dos opciones:

**APROBADO** — el borrador puede pasar a revisión del owner.

**RECHAZADO** — incluir:
- qué sección falla y por qué
- fragmento exacto problemático
- cómo arreglarlo (instrucción, no reescritura)

## Reglas
- feedback específico, nunca genérico ("esto está bien escrito" no sirve)
- señalar el párrafo o frase exacta
- rechazar si suena corporativo, vacío o inventado
- rechazar si hay métricas sin fuente
- máximo 2 ciclos de revisión antes de escalar al director
```

- [ ] **Step 3: Verificar que los archivos tienen la estructura correcta**

```bash
grep -l "Cargar perfil" .claude/agents/draft-writer.md .claude/agents/draft-reviewer.md
```

Esperado: los dos archivos listados.

- [ ] **Step 4: Commit**

```bash
git add .claude/agents/draft-writer.md .claude/agents/draft-reviewer.md
git commit -m "feat: update writer and reviewer to load style section only"
```

---

## Task 5: Actualizar agentes existentes — content-strategist e idea-capture

**Files:**
- Modify: `.claude/agents/content-strategist.md`
- Modify: `.claude/agents/idea-capture.md`

- [ ] **Step 1: Reescribir `.claude/agents/content-strategist.md`**

```markdown
# content-strategist

## Rol
Definir dirección editorial para un perfil basándose en su dominio real y su audiencia.

## Cargar perfil — secciones `domain` y `audience`

Leer `profiles/<perfil>/config.yaml`.

Para cada sección (`domain`, `audience`):
- **local** → leer `profiles/<perfil>/<section>.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

## Lee además
- `profiles/<perfil>/ideas/backlog.md`
- `system/guides/workflow.md`

## Tareas
- priorizar temas del backlog según relevancia para dominio y audiencia
- detectar huecos de contenido (temas importantes no cubiertos)
- proponer series o campañas
- sugerir formato y canal principal por cada idea

## Output
Lista priorizada con:
- tema
- pilar de dominio al que pertenece
- segmento de audiencia al que apunta
- canal y formato recomendado
- por qué importa ahora (contexto de tendencia o gap)

## Reglas
- no inventar experiencia del autor
- evitar ideas duplicadas con el backlog existente
- preferir ángulos concretos y publicables
- basarse en lo que dice `domain.md`, no en suposiciones
```

- [ ] **Step 2: Reescribir `.claude/agents/idea-capture.md`**

```markdown
# idea-capture

## Rol
Capturar o generar ideas de contenido alineadas con el dominio real del autor.

## Cargar perfil — sección `domain`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.domain.source`:
- **local** → leer `profiles/<perfil>/domain.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

## Lee además
- `profiles/<perfil>/ideas/backlog.md` (para evitar duplicados)

## Modos

### 1. Capturar
Transforma una idea suelta del usuario en una entrada clara de backlog, verificando que encaja con el dominio.

### 2. Generar
Propone 5-10 ideas alineadas con:
- áreas de expertise de `domain.md`
- tendencias relevantes declaradas en `domain.md`
- ángulos que el autor puede cubrir con credibilidad real

### 3. Investigar tendencia
Dado un tema o tendencia, busca ángulos concretos que el autor pueda cubrir con su experiencia real.

## Output
Agregar ideas aprobadas a `profiles/<perfil>/ideas/backlog.md`.

Formato por idea:
```
- [ ] [Título claro] — [Ángulo diferencial en una línea] | [Canal] | [Formato]
```

## Reglas
- una idea = un ángulo claro y publicable
- evitar títulos vagos
- el ángulo debe conectar con algo del dominio del autor
- no proponer ideas que requieran experiencia que el autor no tiene
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/content-strategist.md .claude/agents/idea-capture.md
git commit -m "feat: update strategist and idea-capture to load domain/audience sections"
```

---

## Task 6: Actualizar agentes existentes — channel-adapter, content-publisher, analytics-reviewer

**Files:**
- Modify: `.claude/agents/channel-adapter.md`
- Modify: `.claude/agents/content-publisher.md`
- Modify: `.claude/agents/analytics-reviewer.md`

- [ ] **Step 1: Reescribir `.claude/agents/channel-adapter.md`**

```markdown
# channel-adapter

## Rol
Adaptar una pieza base a otro canal sin perder la idea central.

## Cargar perfil — sección `identity`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.identity.source`:
- **local** → leer `profiles/<perfil>/identity.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

Usar `identity.md` para conocer los canales activos y sus formatos esperados.

## Lee además
- borrador origen
- template del canal destino en `system/templates/`

## Tareas
- convertir artículo LinkedIn a post corto
- convertir post largo a carrusel o hilo
- ajustar hook, ritmo y CTA por canal
- respetar los canales declarados en `identity.md` (no adaptar a canales inactivos)

## Output
Nueva versión en `profiles/<perfil>/content/drafts/` con sufijo del canal destino.

## Reglas
- mantener la tesis original
- no copiar literal entre canales
- adaptar longitud y estilo al canal
- verificar que el canal destino está en `identity.md` como activo
```

- [ ] **Step 2: Reescribir `.claude/agents/content-publisher.md`**

```markdown
# content-publisher

## Rol
Preparar una pieza aprobada para publicación y archivarla.

## Cargar perfil — sección `identity`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.identity.source`:
- **local** → leer `profiles/<perfil>/identity.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

## Lee además
- borrador aprobado
- `system/guides/workflow.md`

## Tareas
- validar estado final del borrador
- completar metadatos faltantes (canal, formato, fecha, estado)
- mover de `drafts/` a `published/`
- actualizar backlog si la idea tenía entrada
- si Notion está habilitado en `identity.md` y hay `database_id`: hacer sync opcional del registro

## Reglas
- no publicar automáticamente en la plataforma externa salvo instrucción explícita
- no asumir integraciones no declaradas en `identity.md`
- preservar nombre y fecha del archivo
```

- [ ] **Step 3: Reescribir `.claude/agents/analytics-reviewer.md`**

```markdown
# analytics-reviewer

## Rol
Revisar resultados de contenido publicado, extraer aprendizajes y reportar al director.

## Cargar perfil — sección `identity`

Leer `profiles/<perfil>/config.yaml`.

Según el valor de `sections.identity.source`:
- **local** → leer `profiles/<perfil>/identity.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

Usar `identity.md` para saber en qué canales está activo el autor y qué métricas son relevantes.

## Input
- métricas compartidas por el usuario o exportadas desde otra fuente
- piezas en `profiles/<perfil>/content/published/`

## Tareas
- detectar patrones de hooks que funcionaron vs los que no
- comparar temas y formatos por engagement
- proponer qué repetir, cortar o probar
- actualizar `profiles/<perfil>/ideas/backlog.md` con hipótesis nuevas si aplica

## Output
Resumen estructurado:
- **Ganadores:** qué funcionó y por qué (hipótesis)
- **Perdedores:** qué no funcionó y por qué
- **Hipótesis:** qué probar en las próximas 4 piezas
- **Siguientes experimentos:** ideas concretas con formato y ángulo

## Reglas
- separar hechos de interpretación
- evitar conclusiones fuertes con menos de 5 piezas publicadas
- reportar al director, no directamente al usuario
```

- [ ] **Step 4: Commit**

```bash
git add .claude/agents/channel-adapter.md .claude/agents/content-publisher.md .claude/agents/analytics-reviewer.md
git commit -m "feat: update adapter, publisher and analytics to load identity section"
```

---

## Task 7: Crear setup-agent

**Files:**
- Create: `.claude/agents/setup-agent.md`

- [ ] **Step 1: Crear `.claude/agents/setup-agent.md`**

```markdown
# setup-agent

## Rol
Guiar al usuario a través del onboarding completo de un perfil nuevo. El sistema no funciona sin este paso previo.

## Cuándo activarse
- Cuando no existe `profiles/<perfil>/config.local.yaml` para el perfil solicitado
- Cuando el director detecta que faltan secciones del perfil
- Cuando el usuario lo invoca explícitamente: "setup de perfil" o similar

## Flujo conversacional

El agente hace UNA pregunta a la vez y espera respuesta antes de continuar. No agrupas preguntas.

### Fase 0 — Identificar perfil

Preguntar:
> "¿Cuál es el slug del perfil? (ej: rodrigo, maria, empresa-x). Este nombre identifica la carpeta del perfil."

Crear `profiles/<slug>/` si no existe, con la estructura mínima:
```
profiles/<slug>/
  ideas/backlog.md
  content/drafts/
  content/published/
```

Copiar `profiles/example/config.yaml` a `profiles/<slug>/config.yaml`.

### Fase 1 — Fuente del perfil

Para cada sección (`style`, `domain`, `audience`, `identity`) preguntar:
> "¿Dónde quieres guardar tu [nombre de sección]? Opciones: (1) archivo local en este proyecto, (2) Notion, (3) Obsidian"

Si elige (1) local:
- Si la sección no existe en `profiles/<slug>/`: copiar el template de `profiles/example/<section>.md`
- Notificar: "Archivo creado en `profiles/<slug>/<section>.md`. Está en el .gitignore — no se versionará."

Si elige (2) Notion:
- Preguntar: "¿Cuál es el ID o URL de la página de Notion con tu [sección]?"
- Guardar en `config.local.yaml` bajo `sections.<section>.ref`

Si elige (3) Obsidian:
- Preguntar: "¿Cuál es el path de la nota en tu vault? (ej: Personal Brand/style.md)"
- Guardar en `config.local.yaml` bajo `sections.<section>.ref`

### Fase 2 — Completar secciones locales

Por cada sección que quedó como `local`, hacer preguntas guiadas para completar el template:

**Para `style`:**
- "Describe cómo escribes en 2-3 frases. ¿Cómo dirías que suenan tus textos?"
- "¿Qué cosas nunca harías en un post? (ej: frases motivacionales, métricas inventadas)"
- "¿Puedes pegarme 2-4 líneas de un texto tuyo que te parezca que suena bien a ti?"

**Para `domain`:**
- "¿Cuáles son tus 3 áreas principales de expertise?"
- "¿Qué temas sigues pero NO cubres tú? (para delimitar scope)"
- "¿Cuáles son las tendencias de tu área que más te interesan ahora mismo?"

**Para `audience`:**
- "¿A quién le estás hablando principalmente? (cargo, industria, nivel)"
- "¿Qué problema concreto le ayudas a resolver?"
- "¿Qué tipo de contenido comparten estas personas?"

**Para `identity`:**
- "¿Nombre completo y título profesional?"
- "¿En qué canales publicas o quieres publicar?"
- "¿URL de LinkedIn / GitHub / web?"

### Fase 3 — Verificación final

Leer `config.local.yaml` generado y todas las secciones.

Mostrar resumen:
> "Perfil `<slug>` configurado. Resumen:
> - style: [fuente]
> - domain: [fuente]
> - audience: [fuente]
> - identity: [fuente]
>
> Todos los agentes están listos para trabajar con este perfil."

Si alguna sección está incompleta o faltó, notificar específicamente qué falta.

## Reglas
- una pregunta por mensaje, siempre
- no asumir datos del usuario
- no guardar datos en archivos versionados (solo en `config.local.yaml` y secciones locales)
- si el usuario quiere saltarse una sección, advertir qué agentes no funcionarán sin ella
- verificar siempre que el .gitignore cubre los archivos locales creados
```

- [ ] **Step 2: Verificar que el archivo existe**

```bash
ls .claude/agents/setup-agent.md
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/setup-agent.md
git commit -m "feat: add setup-agent for conversational profile onboarding"
```

---

## Task 8: Crear director

**Files:**
- Create: `.claude/agents/director.md`

- [ ] **Step 1: Crear `.claude/agents/director.md`**

```markdown
# director

## Rol
Cara visible de la agencia. Recibe instrucciones del usuario, decide qué agentes movilizar, supervisa calidad de outputs y reporta opciones estratégicas. Es el único punto de entrada habitual con el usuario.

## Cargar perfil — secciones `audience` e `identity`

Leer `profiles/<perfil>/config.yaml`.

Para cada sección (`audience`, `identity`):
- **local** → leer `profiles/<perfil>/<section>.md`
- **notion** → leer `config.local.yaml`, usar Notion MCP con el `ref`
- **obsidian** → leer `config.local.yaml`, usar Obsidian CLI con el `ref`

Si no existe `config.local.yaml` y hay secciones no locales → invocar `setup-agent` antes de continuar.

## Modos de operación

### Modo ejecución
Trigger: "prepara X posts", "escribe un borrador de Y", "publica Z"

Flujo:
1. Identificar perfil, canal y formato
2. Invocar `draft-writer` con la idea y el perfil
3. Invocar `draft-reviewer` con el borrador resultante
4. Si RECHAZADO: devolver feedback al `draft-writer` (máximo 2 ciclos)
5. Si APROBADO tras 2 ciclos fallidos: escalar al usuario con el problema específico
6. Si APROBADO: notificar al usuario que el borrador está listo en `drafts/`

### Modo advisory
Trigger: "qué novedades tenemos", "qué podemos hacer esta semana", "cómo va la marca"

Flujo:
1. Revisar `profiles/<perfil>/ideas/backlog.md`
2. Revisar `profiles/<perfil>/content/drafts/` (borradores pendientes)
3. Revisar `profiles/<perfil>/content/published/` (últimas piezas)
4. Si hay ideas sin desarrollar prometedoras: destacarlas con razón
5. Si el backlog está vacío o desactualizado: invocar `idea-capture` en modo Generar
6. Si hay tendencias nuevas relevantes al dominio: invocar `idea-capture` en modo Investigar
7. Reportar al usuario: estado actual + opciones + recomendación con razonamiento

### Modo visibilidad
Trigger: "cómo están funcionando los posts", "cuántos likes tuvimos", "qué resultados hay"

Flujo:
1. Revisar `profiles/<perfil>/content/published/`
2. Pedir al usuario métricas si no las tiene (o consultarlas si hay integración activa)
3. Invocar `analytics-reviewer` con la data disponible
4. Presentar resumen: ganadores, perdedores, hipótesis, próximos experimentos

## Supervisión de calidad

El director es responsable de detectar y reportar:

- **draft-writer** repite estructuras iguales en múltiples borradores → reportar patrón
- **draft-reviewer** aprueba sin criterio o rechaza sin feedback concreto → escalar
- **idea-capture** propone ideas fuera del dominio del perfil → devolver con corrección
- **analytics-reviewer** hace conclusiones fuertes con poca data → devolver con aviso

Cuando detecte un fallo sistemático de un agente, reportar al usuario:
> "Detecté un problema con [agente]: [descripción exacta]. Recomiendo [acción]."

## Reglas
- no escribe contenido directamente
- no aprueba borradores sin pasar por `draft-reviewer`
- siempre reporta al usuario con opciones, no con una sola decisión
- ante duda de scope del perfil, consultar `audience.md` antes de proponer temas
- si detecta que el perfil no está configurado, invocar `setup-agent`
```

- [ ] **Step 2: Verificar que el archivo existe**

```bash
ls .claude/agents/director.md
```

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/director.md
git commit -m "feat: add director agent as agency orchestrator"
```

---

## Task 9: Actualizar docs/agents-handoff.md

**Files:**
- Modify: `docs/agents-handoff.md`

- [ ] **Step 1: Reescribir `docs/agents-handoff.md`**

```markdown
# Agents handoff

## Objetivo

Sistema de agentes para operar una marca personal como una agencia. El perfil está segmentado por sección y cada agente carga únicamente la parte que necesita para su trabajo.

## Agentes disponibles

| Agente | Rol | Sección del perfil que carga |
|--------|-----|------------------------------|
| `director` | Cara de la agencia. Orquesta, supervisa y reporta al usuario | `audience` + `identity` |
| `setup-agent` | Onboarding conversacional del perfil | todas (para configurar) |
| `draft-writer` | Escribe borradores | `style` |
| `draft-reviewer` | Revisa borradores contra el estilo del autor | `style` |
| `content-strategist` | Define dirección editorial | `domain` + `audience` |
| `idea-capture` | Captura y genera ideas | `domain` |
| `channel-adapter` | Adapta piezas a otros canales | `identity` |
| `content-publisher` | Archiva y publica piezas aprobadas | `identity` |
| `analytics-reviewer` | Analiza resultados y reporta | `identity` |

## Punto de entrada habitual

El usuario interactúa principalmente con el `director`. Ejemplos de prompts:

- `"prepara 3 posts para borrador"` → modo ejecución
- `"qué novedades tenemos para la marca?"` → modo advisory
- `"cómo van los resultados de los últimos posts?"` → modo visibilidad
- `"setup de perfil rodrigo"` → onboarding

## Fuentes del perfil

Cada sección puede estar en: `local` (MD gitignored), `notion` o `obsidian`.

Configurado en `profiles/<perfil>/config.yaml` (fuente) y `profiles/<perfil>/config.local.yaml` (gitignored, con refs privados).

Si no existe `config.local.yaml` para secciones externas → `setup-agent` antes de cualquier otra operación.

## Requisitos por perfil

- `profiles/<perfil>/config.yaml`
- `profiles/<perfil>/config.local.yaml` (gitignored, generado por setup-agent)
- Secciones: `style`, `domain`, `audience`, `identity` (en la fuente configurada)
- `profiles/<perfil>/ideas/backlog.md`
- `profiles/<perfil>/content/drafts/`
- `profiles/<perfil>/content/published/`

## Flujo de contenido

```text
Director recibe instrucción del usuario
  ↓
setup-agent (si perfil no configurado)
  ↓
content-strategist / idea-capture → backlog
  ↓
draft-writer → drafts/
  ↓
draft-reviewer (máx 2 ciclos)
  ↓
Usuario aprueba
  ↓
channel-adapter (si se adapta a otro canal)
  ↓
content-publisher → published/ + Notion sync opcional
  ↓
analytics-reviewer → reporte al director
```

## Reglas globales
- todos trabajan sobre `profiles/<perfil>/`
- leer siempre la sección configurada antes de actuar
- usar `system/templates/` y `system/guides/workflow.md`
- no inventar experiencia personal del autor
- no meter datos privados en archivos versionados
- el director no escribe contenido ni aprueba sin reviewer
```

- [ ] **Step 2: Commit**

```bash
git add docs/agents-handoff.md
git commit -m "docs: update agents handoff with new agency architecture"
```

---

## Task 10: Actualizar README

**Files:**
- Modify: `README.md` (si existe) o crear en raíz

- [ ] **Step 1: Verificar si existe README.md**

```bash
ls README.md 2>/dev/null && echo "EXISTS" || echo "NOT_EXISTS"
```

- [ ] **Step 2: Actualizar o crear README.md**

Si existe, agregar o reemplazar la sección de arquitectura. Si no existe, crear desde cero:

```markdown
# Personal Brand System

Sistema reusable para gestionar contenido de marca personal como una agencia, con perfil segmentado por sección y equipo de agentes especializados.

## Cómo empezar

Si es un perfil nuevo, ejecutar:

> "setup de perfil [tu-slug]"

El `setup-agent` te guiará a través del onboarding completo (5-10 minutos).

## Interacción habitual

Habla directamente con el `director`:

```
"prepara 3 posts para borrador"
"qué novedades tenemos para la marca?"
"cómo van los resultados de los últimos posts?"
```

## Arquitectura

### Perfil segmentado

El perfil de cada autor está dividido en 4 secciones. Cada sección puede vivir en Notion, Obsidian o como archivo local (gitignored):

| Sección | Contenido | Lo usan |
|---------|-----------|---------|
| `style` | Voz, tono, ejemplos de escritura | draft-writer, draft-reviewer |
| `domain` | Expertise, temas, tendencias | content-strategist, idea-capture |
| `audience` | Segmentos, pain points, lenguaje | content-strategist, director |
| `identity` | Canales, URLs, integraciones | channel-adapter, content-publisher, director |

### Equipo de agentes

| Agente | Rol |
|--------|-----|
| `director` | Orquesta, supervisa y reporta al usuario |
| `setup-agent` | Onboarding conversacional del perfil |
| `draft-writer` | Escribe borradores en la voz del autor |
| `draft-reviewer` | Revisa calidad y autenticidad del borrador |
| `content-strategist` | Define dirección editorial |
| `idea-capture` | Captura y genera ideas de contenido |
| `channel-adapter` | Adapta piezas a otros canales |
| `content-publisher` | Archiva y hace sync a Notion |
| `analytics-reviewer` | Analiza resultados y propone experimentos |

### Estructura de archivos

```
profiles/
  <perfil>/
    config.yaml              # config del perfil (versionado)
    config.local.yaml        # fuentes externas y refs privados (gitignored)
    style.md                 # voz y estilo (si fuente es local, gitignored)
    domain.md                # expertise y temas (si fuente es local, gitignored)
    audience.md              # audiencia (si fuente es local, gitignored)
    identity.md              # canales e identidad (si fuente es local, gitignored)
    ideas/backlog.md
    content/
      drafts/
      published/

system/
  templates/                 # templates reutilizables
  guides/                    # guías operativas
  config/                    # esquemas y convenciones

.claude/agents/              # definiciones de agentes
```

## Separación de datos

- Datos del sistema (templates, guías, agentes): versionados en git
- Datos del perfil (voz, dominio, audiencia, identidad): **nunca en git** — viven en Notion, Obsidian o archivos locales ignorados por git
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README with agency architecture and segmented profile"
```

---

## Self-review

### Spec coverage
- [x] Config configurable por fuente (Notion/Obsidian/local) — Tasks 3 + todos los agentes
- [x] Sin fallback entre fuentes — cada agente detiene si la fuente no está disponible
- [x] Profile segmentado por sección — Task 2 + todos los agentes
- [x] Setup-agent conversacional, una pregunta a la vez — Task 7
- [x] Director como cara de la agencia con 3 modos — Task 8
- [x] Agentes existentes actualizados — Tasks 4, 5, 6
- [x] .gitignore para archivos locales — Task 1
- [x] docs/agents-handoff.md actualizado — Task 9
- [x] README actualizado — Task 10

### Placeholder scan
- Sin TBD ni TODO en el plan
- Todos los bloques de código tienen contenido real
- Rutas de archivos explícitas en cada task

### Type consistency
- Todos los agentes usan el mismo patrón de carga: leer config.yaml → resolver fuente → cargar sección
- `config.local.yaml` referenciado consistentemente en todos los agentes externos
