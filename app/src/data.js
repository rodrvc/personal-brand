/**
 * Capa de datos: la misma interfaz, dos implementaciones.
 *
 * En la app de escritorio lee y escribe archivos de verdad.
 * En el navegador usa datos de ejemplo, para poder seguir iterando el
 * diseño sin instalar nada.
 *
 * La interfaz de arriba no sabe cuál está activa. Por eso la maqueta
 * sirve igual en los dos sitios.
 */

const enTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function invoke(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(cmd, args)
}

/* ── Implementación de escritorio: archivos reales ───────────────── */

const escritorio = {
  async listarPerfiles() {
    return invoke('listar_perfiles')
  },
  async guardarBrand(slug, contenido) {
    return invoke('guardar_brand', { slug, contenido })
  },
  async listarPiezas(slug) {
    return invoke('listar_piezas', { slug })
  },
  async guardarPieza(ruta, cuerpo) {
    return invoke('guardar_pieza', { ruta, cuerpo })
  },
  async marcarPublicado(ruta) {
    return invoke('marcar_publicado', { ruta })
  },
}

/* ── Implementación de navegador: datos de ejemplo ───────────────── */

const EJEMPLO = {
  perfiles: [
    {
      slug: 'example',
      config: 'profile:\n  slug: example\n  name: Nombre Apellido\n',
      brand: null,
      profile: '# Perfil — Example\n',
    },
  ],
  piezas: {},
}

const navegador = {
  async listarPerfiles() {
    return structuredClone(EJEMPLO.perfiles)
  },
  async guardarBrand(slug, contenido) {
    const p = EJEMPLO.perfiles.find((x) => x.slug === slug)
    if (!p) throw new Error(`No existe el perfil ${slug}`)
    p.brand = contenido
    console.info(`[demo] brand.yaml de ${slug} guardado en memoria`)
  },
  async listarPiezas(slug) {
    return structuredClone(EJEMPLO.piezas[slug] || [])
  },
  async guardarPieza(ruta, cuerpo) {
    console.info(`[demo] ${ruta} guardado en memoria (${cuerpo.length} car.)`)
  },
  async marcarPublicado(ruta) {
    console.info(`[demo] ${ruta} marcado como publicado`)
    return ruta.replace('/drafts/', '/published/')
  },
}

/* ── Lo que se exporta ───────────────────────────────────────────── */

export const datos = enTauri ? escritorio : navegador

/** Para mostrar un aviso cuando se está en modo demo */
export const esDemo = !enTauri
