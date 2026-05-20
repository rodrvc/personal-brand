# Plan de trabajo — mantener `personal-brand` agnóstico

## Objetivo

Mantener separado el **framework de contenido/marca** de cualquier **identidad específica** para que este repo pueda reutilizarse con otras personas o marcas con mínimos cambios.

## Regla base

El repo público o compartible debe contener solo:
- estructura
- templates reutilizables
- workflow editorial
- guías operativas
- ejemplos genéricos

No debe contener:
- nombres reales
- emails
- links de perfiles personales
- employers
- ubicaciones privadas
- IDs reales de Notion
- historial git con metadata sensible

## Checklist de higiene

- usar `profiles/example/` como base
- guardar datos privados solo en archivos locales no versionados
- evitar nombres propios en README, docs y guías
- revisar contenido histórico antes de publicar el repo
- reiniciar git si el historial expone datos sensibles

## Siguiente paso recomendado

Antes de compartir el repo:
1. correr una búsqueda de nombres, emails e IDs
2. revisar `profiles/`
3. revisar `docs/`
4. confirmar que `.git` no conserve metadata previa
