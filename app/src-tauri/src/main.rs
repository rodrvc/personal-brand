// Brand Studio — backend de escritorio
//
// Regla de oro: la app lee y escribe los MISMOS archivos que usa el
// sistema de agentes. No hay base de datos propia ni formato paralelo.
// Si la app se desinstala, el repo sigue funcionando igual que hoy.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ia;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
struct Perfil {
    slug: String,
    /// Contenido crudo de config.yaml (estrategia)
    config: String,
    /// Contenido crudo de brand.yaml, si existe (apariencia)
    brand: Option<String>,
    /// Contenido de profile.md (narrativa)
    profile: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Pieza {
    /// Ruta relativa a la raíz del repo
    ruta: String,
    nombre: String,
    /// "drafts" o "published" — el estado se deduce de la carpeta,
    /// igual que hoy
    carpeta: String,
    cuerpo: String,
}

/// Raíz del repo de contenido.
///
/// Por defecto, la carpeta que el usuario elija. En desarrollo apunta al
/// repo actual para no tener que configurar nada.
fn raiz(estado: &tauri::State<Config>) -> PathBuf {
    estado.raiz.clone()
}

struct Config {
    raiz: PathBuf,
}

#[tauri::command]
fn listar_perfiles(estado: tauri::State<Config>) -> Result<Vec<Perfil>, String> {
    let dir = raiz(&estado).join("profiles");
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut out = Vec::new();
    let entradas = fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for e in entradas.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let slug = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Un perfil válido tiene config.yaml
        let cfg = p.join("config.yaml");
        if !cfg.exists() {
            continue;
        }
        out.push(Perfil {
            config: fs::read_to_string(&cfg).map_err(|e| e.to_string())?,
            brand: fs::read_to_string(p.join("brand.yaml")).ok(),
            profile: fs::read_to_string(p.join("profile.md")).ok(),
            slug,
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Guarda brand.yaml. Es lo que escribe el editor visual de la app.
///
/// Escritura atómica: primero a un temporal, luego rename. Así un corte
/// a mitad de escritura no deja el archivo a medias.
#[tauri::command]
fn guardar_brand(
    estado: tauri::State<Config>,
    slug: String,
    contenido: String,
) -> Result<(), String> {
    if !slug_valido(&slug) {
        return Err("Slug inválido".into());
    }
    let dir = raiz(&estado).join("profiles").join(&slug);
    if !dir.is_dir() {
        return Err(format!("No existe el perfil {slug}"));
    }
    escribir_atomico(&dir.join("brand.yaml"), &contenido)
}

#[tauri::command]
fn listar_piezas(estado: tauri::State<Config>, slug: String) -> Result<Vec<Pieza>, String> {
    if !slug_valido(&slug) {
        return Err("Slug inválido".into());
    }
    let base = raiz(&estado).join("profiles").join(&slug).join("content");
    let mut out = Vec::new();

    for carpeta in ["drafts", "published"] {
        let dir = base.join(carpeta);
        if !dir.exists() {
            continue;
        }
        for e in fs::read_dir(&dir).map_err(|x| x.to_string())?.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let nombre = match p.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // README.md es documentación de la carpeta, no una pieza
            if nombre.eq_ignore_ascii_case("README.md") {
                continue;
            }
            out.push(Pieza {
                ruta: format!("profiles/{slug}/content/{carpeta}/{nombre}"),
                nombre,
                carpeta: carpeta.to_string(),
                cuerpo: fs::read_to_string(&p).unwrap_or_default(),
            });
        }
    }
    out.sort_by(|a, b| b.nombre.cmp(&a.nombre)); // más reciente primero
    Ok(out)
}

#[tauri::command]
fn guardar_pieza(
    estado: tauri::State<Config>,
    ruta: String,
    cuerpo: String,
) -> Result<(), String> {
    let destino = resolver_dentro(&raiz(&estado), &ruta)?;
    if destino.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err("Solo se pueden guardar archivos .md".into());
    }
    escribir_atomico(&destino, &cuerpo)
}

/// Mueve una pieza de drafts a published. Es lo único que hace el
/// "ya lo publiqué": mover el archivo, igual que a mano.
#[tauri::command]
fn marcar_publicado(estado: tauri::State<Config>, ruta: String) -> Result<String, String> {
    let origen = resolver_dentro(&raiz(&estado), &ruta)?;
    if !origen.exists() {
        return Err("No existe el archivo".into());
    }
    let nombre = origen
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Nombre inválido")?;
    // La pieza tiene que venir de drafts/. Sin esta comprobación se
    // podría crear un published/ en cualquier carpeta del perfil.
    let carpeta = origen.parent().ok_or("Ruta inesperada")?;
    if carpeta.file_name().and_then(|s| s.to_str()) != Some("drafts") {
        return Err("Solo se publican piezas que estén en drafts/".into());
    }
    let destino_dir = carpeta.parent().ok_or("Ruta inesperada")?.join("published");
    fs::create_dir_all(&destino_dir).map_err(|e| e.to_string())?;
    let destino = destino_dir.join(nombre);
    fs::rename(&origen, &destino).map_err(|e| e.to_string())?;
    Ok(destino.to_string_lossy().to_string())
}

// ─── utilidades ─────────────────────────────────────────────────────

fn slug_valido(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Resuelve una ruta relativa a la raíz, confinada a `profiles/`.
///
/// Dos cercos, no uno:
///   1. No salir de la raíz del repo — bloquea `../../etc/passwd`.
///   2. No salir de `profiles/` — este módulo NO puede escribir en
///      `system/` (el motor) ni en `.claude/agents/` (otro módulo).
///
/// El cerco 2 es la prohibición dura de docs/ARQUITECTURA.md. Sin él,
/// bastaba con pedir `system/templates/x.md` para pisar el motor: la
/// ruta no contiene `..` y cae dentro de la raíz.
fn resolver_dentro(raiz: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains("..") || Path::new(rel).is_absolute() {
        return Err("Ruta no permitida".into());
    }
    // Solo se escribe dentro de profiles/. Se comprueba por componentes
    // y no con starts_with sobre la cadena, para que "profilesX/" no
    // cuele por prefijo.
    let mut comps = Path::new(rel).components();
    match comps.next().and_then(|c| c.as_os_str().to_str()) {
        Some("profiles") => {}
        _ => return Err("Este módulo solo puede escribir dentro de profiles/".into()),
    }
    if comps.next().is_none() {
        return Err("Falta el perfil en la ruta".into());
    }

    let full = raiz.join(rel);
    let raiz_c = raiz.canonicalize().map_err(|e| e.to_string())?;
    // El archivo puede no existir todavía: se valida el directorio padre
    let padre = full.parent().ok_or("Ruta sin directorio")?;
    let padre_c = padre.canonicalize().map_err(|e| e.to_string())?;
    if !padre_c.starts_with(&raiz_c) {
        return Err("Ruta fuera del proyecto".into());
    }
    // Y que tras resolver symlinks siga dentro de profiles/
    if !padre_c.starts_with(raiz_c.join("profiles")) {
        return Err("Ruta fuera de profiles/".into());
    }
    Ok(full)
}

fn escribir_atomico(destino: &Path, contenido: &str) -> Result<(), String> {
    let tmp = destino.with_extension("tmp");
    fs::write(&tmp, contenido).map_err(|e| e.to_string())?;
    fs::rename(&tmp, destino).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Repo de prueba con la estructura real del proyecto.
    fn repo() -> PathBuf {
        let base = std::env::temp_dir().join("bs-test-rutas");
        for d in [
            "profiles/ejemplo/content/drafts",
            "profiles/ejemplo/content/published",
            "system/templates",
            ".claude/agents",
        ] {
            fs::create_dir_all(base.join(d)).unwrap();
        }
        base
    }

    #[test]
    fn permite_escribir_dentro_de_un_perfil() {
        let r = repo();
        assert!(resolver_dentro(&r, "profiles/ejemplo/content/drafts/x.md").is_ok());
        assert!(resolver_dentro(&r, "profiles/ejemplo/brand.yaml").is_ok());
    }

    #[test]
    fn bloquea_el_motor_y_los_demas_modulos() {
        let r = repo();
        // La prohibición dura de docs/ARQUITECTURA.md
        assert!(resolver_dentro(&r, "system/templates/evil.md").is_err());
        assert!(resolver_dentro(&r, ".claude/agents/evil.md").is_err());
        assert!(resolver_dentro(&r, "CLAUDE.md").is_err());
    }

    #[test]
    fn bloquea_salir_del_repo() {
        let r = repo();
        assert!(resolver_dentro(&r, "../../etc/passwd").is_err());
        assert!(resolver_dentro(&r, "/etc/passwd").is_err());
        assert!(resolver_dentro(&r, "profiles/../system/x.md").is_err());
    }

    #[test]
    fn no_cuela_por_prefijo_de_nombre() {
        let r = repo();
        fs::create_dir_all(r.join("profilesX")).unwrap();
        // "profilesX" empieza por "profiles" pero es otra carpeta
        assert!(resolver_dentro(&r, "profilesX/x.md").is_err());
    }

    #[test]
    fn exige_nombrar_el_perfil() {
        let r = repo();
        assert!(resolver_dentro(&r, "profiles").is_err());
    }

    #[test]
    fn valida_el_slug() {
        assert!(slug_valido("mi-marca_2"));
        assert!(!slug_valido(""));
        assert!(!slug_valido("../otro"));
        assert!(!slug_valido("con espacio"));
        assert!(!slug_valido(&"x".repeat(65)));
    }
}

fn main() {
    // En desarrollo, la raíz es el repo actual. En producción será la
    // carpeta que elija el usuario.
    let raiz = std::env::var("BRAND_STUDIO_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_dir()
                .unwrap_or_default()
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default()
        });

    tauri::Builder::default()
        .manage(Config { raiz })
        .invoke_handler(tauri::generate_handler![
            listar_perfiles,
            guardar_brand,
            listar_piezas,
            guardar_pieza,
            marcar_publicado,
            ia::generar_afiche,
            ia::hay_clave_ia,
            ia::generar_fondo
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Brand Studio");
}
