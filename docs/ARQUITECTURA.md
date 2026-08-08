# La plataforma y sus módulos

Actualizado: 2026-08-08

## Qué es esto en realidad

No es una app de afiches. Es una **plataforma propia de contenido**: crear,
gestionar y hacer seguimiento de lo que se publica en redes. Publicaciones,
videos, guiones, y con el tiempo métricas.

La app de escritorio (`app/`) es **un módulo** de esa plataforma, el primero
que existe. No es el producto entero.

> Es nuestra isla: tiene que funcionar en nuestro ecosistema y nuestros
> agentes tienen que saber usarla sin fricción.

## Las tres capas

```
┌─ system/ ──────────────────────────────────────────┐
│  El motor. Genérico, sin literales de marca.       │
│  Templates y guías compartidas por TODOS los       │
│  módulos: publicaciones, videos, guiones.          │
└────────────────────────────────────────────────────┘
┌─ profiles/<marca>/ ────────────────────────────────┐
│  El negocio. La identidad de cada marca y su       │
│  contenido. Es el punto de encuentro: cualquier    │
│  módulo o agente lee y escribe AQUÍ.               │
└────────────────────────────────────────────────────┘
┌─ módulos ──────────────────────────────────────────┐
│  .claude/agents/   agentes de contenido (existe)   │
│  app/              editor de afiches   (existe)    │
│  ...               videos, guiones, métricas       │
└────────────────────────────────────────────────────┘
```

**La regla que lo sostiene:** los módulos no se hablan entre ellos. Se
comunican por los archivos de `profiles/`. Un módulo puede desaparecer y el
resto sigue funcionando.

## Regla dura: el proyecto es AGNÓSTICO

**Ninguna marca, ni su lógica ni sus datos, vive en el repo.**

El repo contiene el **motor**: estructura, templates, código y guías que
sirven para cualquier marca. Nada de una marca concreta.

### Qué NO puede entrar al repo, nunca

- Nombres de marcas o personas reales
- Colores, tipografías o logos de una marca concreta
- Ciudades, países o mercados específicos
- Copy real: titulares, bajadas, hashtags de una marca
- Enlaces a perfiles, IDs de Notion, tokens, claves
- Reglas de negocio que solo apliquen a un cliente

Las marcas viven en `profiles/<marca>/`, **fuera del control de versiones**.
El `.gitignore` ya lo hace: solo se versiona `profiles/example/`.

### Cómo se cumple

| Necesitas | Dónde va |
|---|---|
| Un color | token en `profiles/<m>/brand.yaml` |
| Un nombre | campo en `config.yaml` o variable `{author_name}` |
| Una ciudad | input del usuario, nunca constante en el código |
| Un ejemplo para la interfaz | placeholder genérico: "Tu marca", "Tu ciudad" |
| Un dato de prueba | `profiles/example/`, con valores obviamente falsos |

### Verificación

```bash
# Colores hex fuera de los perfiles
grep -rE '#[0-9A-Fa-f]{6}' system/

# Nombres propios en el código de los módulos
grep -rniE '<marca real>|<ciudad>|<persona>' app/ core/ system/
```

`profiles/example/` es la excepción: existe para clonarlo. Sus valores son
deliberadamente genéricos ("Nombre Apellido", "Ciudad, País").

### El test que lo resume

> Si alguien clona este repo, no debe poder deducir para qué marca se
> construyó. Y una segunda marca debe funcionar sin tocar una línea de
> `system/`, `core/` ni `app/`.

## Fronteras: quién puede tocar qué

| Ruta | Quién escribe | Quién lee |
|---|---|---|
| `system/` | **nadie en runtime** — se edita a mano | todos |
| `profiles/<m>/config.yaml` | a mano | todos |
| `profiles/<m>/brand.yaml` | la app | todos |
| `profiles/<m>/content/**` | app y agentes | todos |
| `core/` | a mano | app, y cualquier módulo JS |
| `app/**` | solo la app | — |
| `.claude/agents/` | a mano | Claude Code |

**Prohibiciones duras:**

1. Ningún módulo escribe en `system/`. Es el motor, se versiona con el
   proyecto, no con los datos del usuario.
2. Ningún módulo escribe dentro de otro módulo.
3. `system/` no contiene literales de marca. Verificable:
   `grep -rE '#[0-9A-Fa-f]{6}' system/` debe salir vacío.
4. La app no puede escribir fuera de la raíz del repo. Ya implementado en
   `resolver_dentro()` de `app/src-tauri/src/main.rs`, con 5 casos probados.

## Estado de aislamiento — verificado 2026-08-08

La app **no menciona** `system/` ni `.claude/agents/`. Solo escribe:

- `profiles/<m>/brand.yaml`
- `profiles/<m>/content/**/*.md`
- mover un `.md` de `drafts/` a `published/`

El sistema de markdown y los 7 agentes funcionan igual con la app instalada
o sin ella. **Se puede subir el módulo incompleto sin romper nada.**

## Cómo añadir un módulo nuevo

Cuando toque videos, guiones o métricas:

1. Carpeta propia en la raíz (`video/`, `scripts/`, `insights/`).
2. Lee de `profiles/<marca>/` y escribe ahí. **Nada de base de datos
   propia ni formato paralelo.**
3. Lógica compartida a `core/`; lo específico se queda en el módulo.
4. Un `ESTADO.md` propio, con el mismo formato que `app/ESTADO.md`:
   qué hace, decisiones con su porqué, qué falta, trampas conocidas.
5. Nada de importar código de otro módulo. Si dos necesitan lo mismo,
   va a `core/`.

## Cómo se conectan los agentes

Hoy los agentes de `.claude/agents/` leen y escriben markdown directo. Con
más módulos eso se queda corto: hace falta un contrato tipado.

**La idea, cuando haga falta:** un servidor MCP local sobre `profiles/`, con
herramientas como `listar_marcas`, `leer_marca`, `crear_pieza`,
`generar_afiche`. Ventajas sobre el markdown suelto:

- El contrato es un esquema, no prosa en un `.md`
- Las prohibiciones son estructurales: si la herramienta no existe, el
  agente no puede hacerlo
- Sirve para cualquier cliente MCP, no solo para los agentes de este repo

**No está construido.** Es la dirección, no el estado.

## Estado por módulo

| Módulo | Estado | Documento |
|---|---|---|
| Agentes de contenido | funcionando | `.claude/agents/README.md` |
| Editor de afiches | usable, incompleto | `app/ESTADO.md` |
| Videos | no existe | — |
| Guiones | template en `system/templates/script-short.md` | — |
| Métricas / seguimiento | no existe | — |

## Para publicar el módulo de afiches tal como está

Se puede. Está aislado y no rompe nada.

Lo que le falta para ser **usable** está en `app/ESTADO.md`. Lo más urgente:
no guarda el perfil — cambias colores, cierras, se pierden.
