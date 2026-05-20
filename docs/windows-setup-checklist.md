# Windows setup checklist

## Primera vez en un nuevo equipo

1. Clonar el repo
2. Abrir el proyecto en el agente
3. Duplicar `profiles/example/` si aún no existe `profiles/<perfil>/`
4. Copiar `profiles/<perfil>/config.local.yaml.example` a `profiles/<perfil>/config.local.yaml`
5. Completar tus IDs privados de Notion en `config.local.yaml`
6. Verificar que el MCP de Notion esté disponible en ese entorno
7. Revisar `README.md` y `system/guides/workflow.md`

## Flujo normal

1. Leer `profiles/<perfil>/profile.md`
2. Revisar `profiles/<perfil>/config.yaml`
3. Si usarás Notion, confirmar también `profiles/<perfil>/config.local.yaml`
4. Trabajar ideas en `profiles/<perfil>/ideas/backlog.md`
5. Crear drafts en `profiles/<perfil>/content/drafts/`
6. Publicar manualmente
7. Mover a `profiles/<perfil>/content/published/`
8. Hacer sync a Notion si aplica

## Regla de privacidad

- `config.yaml` puede ir al repo
- `config.local.yaml` no se sube
- no guardar IDs reales, URLs privadas o tokens en markdown público
