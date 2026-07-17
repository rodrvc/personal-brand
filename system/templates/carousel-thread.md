# Template Carrusel / Hilo

Para LinkedIn (carrusel de imágenes o documento PDF) o X/Threads (hilo de texto).
Usar cuando una pieza larga tiene 3+ ideas separables que cada una aguanta su propio slide/tweet.

## Variables sugeridas

- `{author_name}`
- `{audience}`
- `{content_pillar}`
- `{topic}`
- `{tone}`
- `{cta_style}`
- `{source_piece}` (artículo/post del que se deriva, si aplica)

---

## Estructura (6-10 slides/tweets)

**SLIDE 1 — GANCHO**
- Una sola afirmación o pregunta que detiene el scroll.
- Sin logo, sin "swipe para más" como única razón — el gancho debe funcionar solo.
- Máximo 1-2 líneas.

**SLIDES 2-8 — UNA IDEA POR SLIDE**
- Cada slide es autocontenido: alguien que solo ve ese slide debe entender algo.
- Nada de continuar una frase de un slide al siguiente.
- Preferir: dato concreto, contraste (antes/después), paso accionable, error+corrección.
- Texto corto — un slide con más de 3 líneas ya es denso de más.

**SLIDE FINAL — CIERRE + CTA**
- Resumen en una frase de la tesis central.
- Cerrar con `{cta_style}`.
- Si el objetivo es negocio (cliente potencial), el último slide puede invitar a seguir o comentar, no vender directo.

---

## Parámetros

- **Slides**: 6-10 (menos de 6 no justifica el formato; más de 10 pierde retención)
- **Texto por slide**: máximo 3 líneas
- **Idioma**: usar `{primary_language}` salvo que el tema pida otro

## Cómo derivar de una pieza larga (`{source_piece}`)

1. Identificar la tesis central (una frase).
2. Listar los 3-6 puntos que sostienen esa tesis en el original.
3. Cada punto → un slide, reescrito para ser autocontenido (no copiar párrafos literales).
4. Descartar todo lo que sea contexto/transición — el carrusel no tiene espacio para eso.

## Checklist rápido

- ¿El slide 1 funciona sin el resto del carrusel?
- ¿Cada slide se entiende aislado?
- ¿Hay una sola idea por slide, no varias mezcladas?
- ¿El cierre deja clara la tesis central en una frase?
