# Spec — Sistema de agentes sobre Notion

> Estado: en progreso · Última actualización: 2026-06-02
> Esta spec documenta la arquitectura del sistema de marca personal y las
> decisiones tomadas para que los agentes operen contra Notion.

---

## 1. Resumen

El sistema de marca personal opera un flujo editorial (idea → draft → revisión →
publicado → análisis) mediante un equipo de agentes. La **fuente de verdad es
Notion**; el **repo define el flujo** (agentes, templates, guías). Los agentes
hablan con Notion vía la **CLI oficial `ntn`** por eficiencia de tokens.

---

## 2. Decisiones de arquitectura

| # | Decisión | Razón |
|---|---|---|
| D1 | La fuente de verdad es **Notion**, no archivos del repo | El usuario ya gestiona perfil y contenido en Notion; evitar duplicación |
| D2 | El **repo define el flujo** (agentes, workflow, templates) | Separar sistema (versionado) de datos (vivos) |
| D3 | Los agentes usan la **CLI `ntn`** (no el MCP de Notion) | La CLI usa ~94% menos tokens; el MCP vuelca schemas enormes al contexto |
| D4 | `ntn` oficial sobre `@sakasegawa/ncli` | `ntn` es wrapper REST puro (más eficiente); `ncli` envuelve el Remote MCP |
| D5 | **Preguntar antes de crear** en Notion | Si el flujo necesita algo que no existe, el agente pide OK antes de modificar |
| D6 | Se añade un agente **`researcher`** con acceso web | El contenido técnico requiere datos reales verificados antes de escribir |
| D7 | El flujo lo conduce un **orquestador** que lee el `Estado` de la tarjeta y delega al agente del paso | Modelo "single-agent re-roling" tipo gstack: la tarjeta es el artefacto que se pasa entre roles; el `Estado` es el puntero del pipeline |
| D8 | Cada agente escribe su output como una **sección `## ...` en el cuerpo** de la tarjeta de Notion | El estado compartido entre roles vive en la propia página (no en archivos del repo); historial visible y editable por el owner |
| D9 | Se **rediseñan los estados** a 6 (ver §3) | Los 3 actuales no distinguen los pasos del pipeline; el owner necesita un estado propio de revisión |

---

## 3. Recursos en Notion

| Recurso | ID | Notas |
|---|---|---|
| Página "🌆 Sistema marca personal" | `3565a3ab-e3e8-80c2-bc35-c291cd6fae2a` | Contiene el perfil (arriba) + DB embebida + (pendiente) dashboard |
| DB "Contenido Marca Personal" | `a02b72e1-f317-4df2-81f8-73dcd76d8694` | Database |
| Data source de la DB | `688e3182-30a2-4685-9d7e-9fe2690e023c` | Para `datasources query` |

### Esquema de la DB

| Campo | Tipo | Valores |
|---|---|---|
| Título | Title | texto |
| Canal | Select | LinkedIn / TikTok / Instagram / YouTube |
| Formato | Select | Artículo / Post / Reel / Video / Script |
| Estado | **Status** | (rediseñado, ver abajo) |
| Fecha publicación | Date | YYYY-MM-DD |
| Link | URL | link público |
| Notas | Text | ángulo, métricas, aprendizajes |

#### Estados del pipeline (D9 — rediseño)

El campo `Estado` (tipo `status`) es el **puntero del pipeline**: define qué agente
actúa sobre cada tarjeta. Set de 6 estados:

| Estado | Grupo Notion | Agente que actúa | Avanza a |
|---|---|---|---|
| `Idea` | To-do | content-strategist / researcher | Borrador |
| `Borrador` | In progress | draft-writer | Revisión |
| `Revisión` | In progress | **owner (humano)** | Aprobado |
| `Aprobado` | In progress | content-publisher | Programado |
| `Programado` | In progress | content-publisher | Publicado |
| `Publicado` | Complete | analytics-reviewer | — |

Migración de las 16 piezas actuales: `Sin empezar`→`Idea`, `En progreso`→`Borrador`,
`Listo`→`Aprobado` (o `Publicado` si ya salió).

> **REQ-2 (manual):** los campos `status` de Notion **no permiten crear/renombrar
> opciones vía API**. Crear estos 6 estados es un paso manual del owner en la UI
> (una vez). Los agentes solo los *usan*.

---

## 4. Comandos `ntn` usados por los agentes

```bash
# Leer perfil o un draft como Markdown
ntn pages get <page_id>

# Resolver una DB a su data source
ntn datasources resolve <database_id>

# Listar piezas (filtro/orden/límite opcionales)
ntn datasources query <data_source_id> --filter '<json>' --sort '<spec>' --limit N

# Crear una pieza nueva
ntn pages create ...

# Actualizar el CUERPO de una pieza (sección por rol). NO mueve properties.
ntn pages update <page_id> --content '<markdown>'
```

Setup: `npm i -g ntn` + `ntn login` (OAuth, una vez). Ver `notion-sync/README.md`.

### Mover el `Estado` (properties) — vía MCP, no `ntn`

> **REQ-1:** `ntn pages update` solo reemplaza el **cuerpo** (`--content`). NO puede
> setear properties (Estado, Canal, Fecha, Link). Verificado 2026-06-02.

Por tanto el reparto es:

- **Cuerpo de la tarjeta** (las secciones `## ...` de cada rol, D8) → **`ntn pages update`**.
- **Mover el `Estado`** y demás properties (Fecha, Link) → **MCP de Notion** (`notion-update-page`).

Decisión (2026-06-02): el orquestador usa el **MCP de Notion** para mover el Estado,
por ahora, para no bloquear el pipeline.

> **Deuda técnica DT-1:** el MCP gasta más tokens (vuelca schemas grandes), lo que va
> contra D3. Migrar a una vía barata para escribir properties (`curl PATCH /pages/{id}`
> con un Internal Integration token guardado como `NOTION_API_TOKEN`) cuando el flujo
> esté estable. Hasta entonces, MCP solo para el paso de mover-Estado.

---

## 5. Equipo de agentes (flujo)

```
content-strategist  →  researcher  →  idea-capture  →  draft-writer
        ↓                                                    ↓
   (web + DB)                                          draft-reviewer
                                                            ↓ (rechazo → draft-writer)
                                                       channel-adapter
                                                            ↓
                                                       content-publisher
                                                            ↓
                                                       analytics-reviewer
```

| Agente | Lee | Escribe | Web |
|---|---|---|---|
| content-strategist | perfil, piezas existentes | propone temas | sí (tendencias) |
| researcher 🆕 | tema + perfil | dossier con fuentes | sí |
| idea-capture | perfil, ideas | crea piezas estado "Sin empezar" | no |
| draft-writer | perfil, dossier, templates | escribe draft, estado "En progreso" | no |
| draft-reviewer | el draft | feedback; aprueba o devuelve | no |
| channel-adapter | pieza aprobada | nueva pieza adaptada a otro canal | no |
| content-publisher | pieza lista | estado "Listo" + Link + Fecha | no |
| analytics-reviewer | piezas publicadas | resumen + próximos experimentos | opcional |

---

## 5.bis El orquestador (D7) — la tarjeta como artefacto que se pasa

Inspirado en el modelo de **gstack** (https://github.com/garrytan/gstack): un solo
agente que se "re-rolea", donde el estado compartido entre roles vive en un
**artefacto** que cada paso lee y reescribe. En gstack ese artefacto es un archivo
markdown en disco; **aquí es la tarjeta de Notion**.

**El `Estado` de la tarjeta es el puntero del pipeline.** El orquestador no decide con
IA qué sigue: lee el `Estado` y delega al agente que corresponde, de forma determinista.

```
orquestador(tarjeta):
  Estado = leer property "Estado" (vía MCP)
  según Estado:
    Idea       → content-strategist + researcher  → escribe "## Estrategia"  → Estado=Borrador
    Borrador   → draft-writer                      → escribe "## Borrador"    → Estado=Revisión
    Revisión   → SE DETIENE  (le toca al owner humano)
    Aprobado   → content-publisher                 → setea Fecha/Link         → Estado=Programado
    Programado → content-publisher                 → publica                  → Estado=Publicado
    Publicado  → analytics-reviewer (opcional)     → escribe "## Métricas"
```

Reparto de herramientas por paso (ver §4):
- **leer** la tarjeta (cuerpo + estrategia previa) → `ntn pages get`
- **escribir la sección del rol** (cuerpo) → `ntn pages update --content`
- **mover el `Estado`** (avanzar el puntero) → **MCP de Notion** `notion-update-page` *(DT-1)*

Diferencia con gstack: ellos invocan cada skill a mano, en orden; aquí el orquestador
recorre el `Estado` solo y **se detiene en `Revisión`** para que el owner apruebe.

Secciones por rol en el cuerpo de la tarjeta (D8):

```
# <Título de la pieza>
## Estrategia   (content-strategist: ángulo, pilar, por qué ahora, fuentes)
## Borrador     (draft-writer: el post listo para revisar)
## Feedback     (owner: correcciones — opcional)
## Métricas     (analytics-reviewer: resultados tras publicar — opcional)
```

---

## 6. Progreso

- [x] Perfil escrito en Notion (página del sistema)
- [x] CLI `ntn` instalada, autenticada y probada contra la DB real
- [x] Guía de onboarding de perfil (`system/guides/profile-onboarding.md`)
- [x] Memorias de contexto guardadas
- [x] Modelo de orquestación definido (gstack-style: tarjeta = artefacto, Estado = puntero) — §5.bis
- [x] Estados del pipeline rediseñados a 6 (D9) — §3
- [ ] **Manual (owner):** crear los 6 estados en la UI de Notion (REQ-2) y migrar las 16 piezas
- [ ] Reescribir agentes para `ntn` + escribir su sección `## ...` (piloto: content-strategist)
- [ ] Crear agente `researcher`
- [ ] Implementar el **orquestador** (recorre Estado, delega, mueve estado vía MCP)
- [ ] Probar el flujo completo end-to-end con una pieza real

---

## 7. Pendientes / decisiones abiertas

- Validar con el usuario los datos inferidos del perfil (Falabella/6 años, stack, ubicación).
- Definir cómo se registran métricas para `analytics-reviewer` (campo Notas vs. campos nuevos).

### Deuda técnica

- **DT-1:** el orquestador mueve el `Estado` vía **MCP de Notion** (decisión 2026-06-02),
  lo que va contra D3 (eficiencia de tokens). Migrar a `curl PATCH /pages/{id}` con un
  Internal Integration token (`NOTION_API_TOKEN`) cuando el flujo esté estable. Ver §4.
