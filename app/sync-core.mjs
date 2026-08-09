/**
 * Copia core/src/ dentro de app/src/core/ para que viaje en el paquete.
 *
 * core/ vive en la raíz porque no es solo de la app: los agentes y
 * cualquier script pueden usarlo. Pero Tauri solo empaqueta lo que hay
 * bajo app/src/, así que se copia antes de arrancar o compilar.
 */
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = dirname(fileURLToPath(import.meta.url))
const origen = join(aqui, '..', 'core', 'src')
const destino = join(aqui, 'src', 'core')

mkdirSync(destino, { recursive: true })
cpSync(origen, destino, { recursive: true })
console.log('core/ sincronizado en app/src/core/')
