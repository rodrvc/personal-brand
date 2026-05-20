# Como hacer una extension para Pi

## Que es Pi

Pi (`badlogic/pi-mono`) es un coding agent minimalista para terminal, similar a Claude Code pero open source. Corre en tu maquina, llama a modelos via API, y es extensible desde cero via TypeScript. El repo real esta en `github.com/badlogic/pi-mono`, bajo `packages/coding-agent`.

---

## Como funciona el sistema de extensiones

Pi carga automaticamente archivos `.ts` desde carpetas predefinidas al arrancar. Cada extension es un modulo TypeScript que recibe una instancia de `ExtensionAPI` y la usa para registrar herramientas, comandos, o suscribirse a eventos del ciclo de vida del agente.

La logica es simple:
- Pi ve tus archivos `.ts` en la carpeta de extensiones
- Los ejecuta como modulos al iniciar
- Tu extension "engancha" comportamientos del agente usando la API

---

## Estructura de una extension

Una extension es un solo archivo `.ts` (o una carpeta con `index.ts`).

**Archivo minimo:**

```
~/.pi/agent/extensions/mi-extension.ts
```

**Estructura interna del archivo:**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // aqui registras herramientas, comandos, o eventos
}
```

El export default es la funcion que Pi invoca al cargar tu extension. Puede ser `async` si necesitas hacer setup inicial (leer configs, conectar a APIs, etc.).

---

## Que puedes hacer con la API

La instancia `pi` que recibes expone estos metodos principales:

| Metodo | Para que sirve |
|---|---|
| `pi.registerTool(def)` | Agregar una herramienta que el LLM puede llamar |
| `pi.registerCommand(name, opts)` | Agregar un comando tipo `/micomando` |
| `pi.on(event, handler)` | Suscribirse a eventos (tool calls, sesion, etc.) |
| `pi.registerShortcut(keys, opts)` | Atajos de teclado |
| `pi.registerFlag(name, opts)` | Feature flags |
| `pi.exec(cmd, args)` | Ejecutar comandos de shell desde la extension |
| `pi.sendMessage(msg)` | Inyectar un mensaje al agente |
| `pi.appendEntry(type, data)` | Persistir estado en la sesion |

Cada handler recibe tambien un objeto `ctx` con:
- `ctx.ui` — notificaciones, confirmaciones, selects, widgets
- `ctx.cwd` — directorio actual
- `ctx.signal` — AbortSignal para cancelacion
- `ctx.isIdle()` / `ctx.abort()` — control del agente

---

## Pasos para crear tu extension

1. **Crea el archivo** en `~/.pi/agent/extensions/mi-extension.ts`
   (para que sea global) o en `.pi/extensions/` dentro de tu proyecto (solo para ese proyecto).

2. **Escribe el export default** con la funcion que recibe `ExtensionAPI`.

3. **Registra lo que necesites**: una herramienta, un comando, o un event handler.

4. **Reinicia Pi** o abre una nueva sesion. Pi carga las extensiones al arrancar.

5. **Verifica** que la extension cargo sin errores. Pi muestra errores de carga en la consola.

---

## Ejemplo conceptual: herramienta de saludo

Una extension que agrega una herramienta `hello` que el LLM puede llamar:

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
  name: "hello",
  description: "Saluda a alguien por nombre",
  parameters: Type.Object({
    name: Type.String({ description: "Nombre a saludar" }),
  }),
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hola, ${params.name}!` }],
      details: { greeted: params.name },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

Cuando el agente necesite saludar a alguien, llamara a esta herramienta automaticamente. `Type.Object` (de `@earendil-works/pi-ai`) define el schema de parametros que el LLM debe respetar.

---

## Ejemplo conceptual: interceptar comandos peligrosos

Una extension que pide confirmacion antes de ejecutar `rm -rf`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const cmd = event.input.command as string;
    if (/\brm\s+-rf/i.test(cmd)) {
      const ok = await ctx.ui.select(`Comando peligroso:\n${cmd}\n\nPermitir?`, ["Si", "No"]);
      if (ok !== "Si") return { block: true, reason: "Bloqueado por usuario" };
    }

    return undefined; // dejar pasar
  });
}
```

Retornar `undefined` deja que el comando siga. Retornar `{ block: true, reason: "..." }` lo cancela.

---

## Como instalar la extension en Pi

### Opcion 1: archivo directo (mas simple)

Copia tu `.ts` a la carpeta de extensiones globales:

```
~/.pi/agent/extensions/mi-extension.ts
```

Pi lo carga automaticamente al iniciar.

### Opcion 2: extension de proyecto

Copia a la carpeta local del proyecto:

```
.pi/extensions/mi-extension.ts
```

Solo aplica cuando Pi corre en ese directorio.

### Opcion 3: Pi package (para distribuir)

Si quieres compartir tu extension como paquete npm o repo git:

1. Crea un repo con tu extension en `./extensions/mi-extension.ts`
2. Agrega en `package.json`:
   ```json
   {
     "keywords": ["pi-package"],
     "pi": { "extensions": ["./extensions"] }
   }
   ```
3. Instala con:
   ```bash
   pi install npm:tu-usuario/tu-paquete
   pi install git:github.com/tu-usuario/tu-repo
   pi install /ruta/local/al/paquete
   ```

Otros comandos utiles: `pi list`, `pi update`, `pi remove`.

**Nota de seguridad**: las extensiones corren con permisos completos de tu sistema. Revisa el codigo antes de instalar extensiones de terceros.

---

## Eventos disponibles (referencia rapida)

| Evento | Cuando se dispara |
|---|---|
| `session_start` | Al iniciar o retomar sesion |
| `session_shutdown` | Al cerrar sesion |
| `before_agent_start` | Antes de invocar al LLM |
| `tool_call` | Antes de ejecutar cualquier tool (puede bloquear) |
| `tool_result` | Despues de ejecutar un tool (puede modificar resultado) |
| `input` | Al recibir input del usuario (puede interceptar) |
| `session_before_compact` | Antes de compactar el contexto |

---

## Recursos

- Repo principal: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
- Docs de extensiones: `packages/coding-agent/docs/extensions.md`
- Ejemplos: `packages/coding-agent/examples/extensions/`
- Docs de packages: `packages/coding-agent/docs/packages.md`
- Extensiones de la comunidad: https://github.com/badlogic/pi-skills
- Lista de recursos: https://github.com/qualisero/awesome-pi-agent
