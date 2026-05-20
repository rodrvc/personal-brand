# Migration notes

## Qué cambió

- La identidad del autor salió de `CLAUDE.md`
- Los templates se movieron a `system/templates/`
- Las ideas y drafts se organizaron por perfil en `profiles/<perfil>/`
- Se añadió `config.yaml` por perfil
- Notion pasó a ser una integración opcional
- Los valores privados deben vivir en `config.local.yaml` fuera del control de versiones

## Estructura actual

- `system/` = core reusable
- `profiles/` = instancias concretas

## Convención

Cualquier perfil nuevo debe crearse clonando `profiles/example/`.
