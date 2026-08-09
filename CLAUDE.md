# Personal Brand System

> **Esto es una plataforma de contenido con módulos**, no una sola app.
> Lee [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) antes de tocar nada:
> explica las tres capas y las fronteras entre módulos.
>
> **¿Vas a tocar el editor de afiches (`app/`)?** Lee además
> [`app/ESTADO.md`](app/ESTADO.md): decisiones, porqués y trampas conocidas.
>
> Tres reglas que mandan sobre todo lo demás:
> 1. **El proyecto es AGNÓSTICO: ninguna marca vive en el repo.** Ni
>    nombres, ni colores, ni ciudades, ni copy real. El repo es el motor;
>    las marcas viven en `profiles/<marca>/`, fuera de git. Test: quien
>    clone el repo no debe poder deducir para qué marca se construyó.
> 2. **Los módulos no se rompen entre sí.** Se comunican por los archivos
>    de `profiles/`, nunca importando código ajeno.
> 3. **El sistema de markdown y los agentes de `.claude/agents/` deben
>    seguir funcionando igual.** La app es un módulo más y escribe los
>    mismos archivos.

## Propósito

Este repo guarda un **sistema reusable de contenido/marca** separado de los **perfiles específicos** que lo usan.

La idea es distinguir entre:
- **system/** → templates, guías y reglas compartidas
- **profiles/** → identidad, backlog y contenido de cada perfil

---

## Estructura del proyecto

| Ruta | Propósito |
|---|---|
| `system/templates/` | Templates reutilizables para posts y scripts |
| `system/guides/` | Guías operativas del sistema |
| `system/config/` | Esquemas y convenciones de configuración |
| `system/ig-carousel/` | Motor de render de carruseles (genérico, sin datos de marca) |
| `system/ig-reel/` | Motor de render de reels en video (genérico, sin datos de marca) |
| `system/recipes/` | Contratos de flujo: qué etapas fija el motor y qué huecos llena el perfil |
| `profiles/<perfil>/profile.md` | Identidad, posicionamiento y tono del perfil |
| `profiles/<perfil>/config.yaml` | Configuración operativa del perfil |
| `profiles/<perfil>/config.local.yaml` | Overrides locales y privados opcionales |
| `profiles/<perfil>/brand-spec.md` | Decisiones de marca y su procedencia (para humanos) |
| `profiles/<perfil>/brand.json` | Esas decisiones compiladas, que consume el motor |
| `profiles/<perfil>/carousels/` | Inputs de carrusel del perfil |
| `profiles/<perfil>/ideas/` | Backlog de ideas del perfil |
| `profiles/<perfil>/content/drafts/` | Borradores en progreso |
| `profiles/<perfil>/content/published/` | Archivo de contenido publicado |
| `notion-sync/` | Notas de integración con Notion |
| `docs/` | Documentación adicional |

---

## Motor vs negocio

**`system/` y `.claude/` son el motor.** Ninguno de los dos puede contener
literales de una marca concreta: ni colores, ni categorías, ni copy, ni
ciudad, ni el slug o nombre de un perfil, ni su dominio o URL de API, ni su
@handle, ni sus hashtags, ni una ruta de salida con su nombre dentro. Todo
eso llega como input desde el perfil.

En la capa genérica esos valores se escriben **siempre** parametrizados:
`<marca>`, `<ciudad>`, `--profile <slug>`, `profiles/<perfil>/`.

Aplica igual a la prosa: comentarios de código, ejemplos en docs,
descripciones de skills y cuerpos de agentes. **La fuga histórica de este
repo no ocurrió en el motor TypeScript — ocurrió en la capa de prosa**, que
es la que nadie revisa en un diff. Un `examples/` dentro de una skill no es
lugar para el contenido real de un perfil: usa una marca ficticia o apunta
al template genérico.

La prueba: agregar un perfil nuevo con otra paleta y otro idioma debe
renderizar bien **sin editar un solo archivo bajo `system/` ni
`.claude/`**. Si para soportar una marca hay que tocar el motor, el dato
está en el lugar equivocado.

### Dónde vive un perfil real, y sus skills

Un perfil real vive en `profiles/<slug>/` **dentro del repo, ignorado por
git**. Está en disco y el motor lo encuentra solo; no aparece en
`git status` ni se publica. Solo los ficticios `profiles/example*` se
trackean.

**La carpeta del perfil es la unidad transportable completa**, y eso incluye
su comportamiento de negocio:

```
profiles/<slug>/
  brand.json          tokens: colores, fuentes, categorías, copy
  brand-spec.md       las decisiones de marca y su procedencia
  config.yaml         operativa: hashtags, rutas de salida
  recipes/*.yaml      parametrización declarativa de un flujo del system/
  skills/*/SKILL.md   LAS SKILLS DE NEGOCIO DE LA MARCA
```

Una skill que contenga criterio de una marca —qué contenido sirve, su tono,
su fuente de datos, sus reglas de producto— va en `profiles/<slug>/skills/`,
**no** en `.claude/skills/`. Ahí quedan solo los orquestadores genéricos.

Consecuencia para cualquier agente: **las reglas de negocio no están en este
repo.** Hay que ir a buscarlas al perfil. La skill `usar-perfil` existe
justo para eso — invócala antes de generar contenido de una marca.

`BRAND_PROFILES_DIR` permite mover la raíz de perfiles a otra ubicación, pero
el default (`<repo>/profiles`) es lo normal y lo que se usa hoy.

Un perfil real **nunca** se agrega al allow-list del `.gitignore`. Un
`!profiles/<marca>/` gana en silencio sobre cualquier regla escrita en
prosa — así se colaron los perfiles reales al repo.

### Esto es verificable, no una convención

La regla ya existía en prosa (aquí y en `docs/public-repo-rules.md`) y no
impidió la fuga, porque el commit gate delegaba todo el juicio a la
revisión de un agente y nunca abría el contenido de un archivo. Ahora
`scripts/validate_commit_guardian.py` lo comprueba de forma determinista:

- literales de `scripts/brand-denylist.txt` bajo `system/` o `.claude/`
- archivos de un perfil que no sea `profiles/example*`
- negaciones `!profiles/<algo>/` en `.gitignore`

**Al dar de alta una marca real, agrega su slug, dominio, @handle y ciudad
a `scripts/brand-denylist.txt`.** Es lo que evita que se filtre después.

Auditoría de todo el árbol antes de publicar (sale 0 si está limpio):

```bash
python3 scripts/validate_commit_guardian.py --scan
```

Ver `system/config/brand.schema.md` para el esquema de `brand.json`.

---

## Cómo trabajar con un perfil

Cuando se trabaje contenido para un autor concreto:
1. leer su `profile.md`
2. revisar su `config.yaml`
3. si existe, revisar también `config.local.yaml`
4. usar los templates de `system/templates/`
5. guardar ideas y drafts dentro de su carpeta de perfil

---

## Workflow

Ver guía principal en:
- `system/guides/workflow.md`

Resumen:
- idea → backlog del perfil
- draft → `profiles/<perfil>/content/drafts/`
- revisión del owner
- publicación manual
- archivo en `published/`

---

## Regla de separación

No meter en este archivo:
- datos personales del autor
- narrativa personal específica
- stack individual
- diferenciadores de una sola persona
- IDs privados, tokens o enlaces internos

Eso debe vivir en el perfil correspondiente o en archivos locales fuera del repo.
