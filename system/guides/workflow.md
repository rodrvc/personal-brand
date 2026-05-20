# Workflow editorial

## Flujo base

```text
Idea → profiles/<perfil>/ideas/backlog.md
  ↓
Investigación + borrador → profiles/<perfil>/content/drafts/<YYYY-MM-DD-slug>.md
  ↓
Revisión + aprobación del owner
  ↓
Publicación manual en la plataforma
  ↓
Archivar → profiles/<perfil>/content/published/<YYYY-MM-DD-slug>.md
  ↓
Sync opcional a Notion
```

## Reglas

- Mantener ideas, drafts y publicados dentro del perfil correspondiente.
- Revisar `profiles/<perfil>/config.yaml` antes de crear contenido.
- Si existe, revisar también `profiles/<perfil>/config.local.yaml` para integraciones privadas.
- Usar los templates compartidos de `system/templates/`.
- No mezclar identidad del autor con las guías del sistema.
- Tratar Notion como integración opcional, no como dependencia obligatoria.

## Estructura mínima por perfil

- `profiles/<perfil>/profile.md`
- `profiles/<perfil>/config.yaml`
- `profiles/<perfil>/ideas/backlog.md`
- `profiles/<perfil>/content/drafts/`
- `profiles/<perfil>/content/published/`
