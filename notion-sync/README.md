# Sync con Notion

## Objetivo

Usar Notion como base opcional para seguir ideas, borradores y publicaciones por perfil.

## Setup

La integración debe tratarse como **opcional**.

Antes de hacer sync para un perfil:
1. Revisar `profiles/<perfil>/config.yaml`
2. Si existe, revisar `profiles/<perfil>/config.local.yaml`
3. Confirmar que `notion.enabled` esté en `true`
4. Confirmar `notion.database_id`
5. Confirmar si `notion.parent_page_id` aplica o no
6. Verificar que el entorno local tenga MCP de Notion configurado

## Estructura sugerida de la base de datos

| Campo | Tipo | Valores |
|---|---|---|
| Título | Title | texto libre |
| Canal | Select | LinkedIn / TikTok / Instagram / YouTube |
| Formato | Select | Post texto / Carrusel / Script corto / Guión largo |
| Estado | Select | Idea / Borrador / Listo / Publicado / Archivado |
| Fecha publicación | Date | YYYY-MM-DD |
| Link | URL | link al post publicado |
| Notas | Text | observaciones, métricas, aprendizajes |

## Crear la base de datos

Si no existe:
- crearla manualmente en Notion, o
- pedir al agente que use MCP de Notion con la estructura de arriba

## Flujo de sync

Después de publicar una pieza:
1. Mover el archivo desde `profiles/<perfil>/content/drafts/` a `profiles/<perfil>/content/published/`
2. Crear o actualizar el registro en Notion
3. Marcar `Estado = Publicado`
4. Guardar el link público si existe

## Cómo disparar el sync

El sync a Notion es siempre explícito, nunca automático. El usuario lo dispara
pidiéndolo directamente, por ejemplo:

- "sync con Notion"
- "actualiza Notion con lo publicado"
- "refleja el backlog en Notion"

Cuando el usuario pide esto, se usa el agente `notion-sync`
(`.claude/agents/notion-sync.md`). Ese agente:
1. Confirma `notion.enabled` y `notion.database_id` en `config.yaml` (o `config.local.yaml`).
2. Lee el estado actual de `profiles/<perfil>/content/published/` (y opcionalmente
   drafts/ideas si el usuario lo pide).
3. Usa los tools MCP de Notion (`mcp__notion__*`) para crear o actualizar los
   registros correspondientes en la base de datos descrita arriba.
4. Pregunta antes de crear una base de datos nueva si todavía no existe.

El repo sigue siendo la fuente de verdad: el sync empuja el estado del repo hacia
Notion, no al revés.

## Regla práctica

- Los valores públicos pueden vivir en `config.yaml`
- Los IDs reales y overrides privados deben vivir en `config.local.yaml`
- La estructura de la base vive en esta guía
- El contenido fuente sigue viviendo en el repo, no en Notion
