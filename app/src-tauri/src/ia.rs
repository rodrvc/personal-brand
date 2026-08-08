// Puente a OpenAI.
//
// La clave NO vive en este repo. Se lee, por orden:
//   1. variable de entorno OPENAI_API_KEY
//   2. archivo ~/.brand-studio/openai.key
//   3. archivo .env de otro proyecto local (solo en desarrollo)
//
// Control de gasto: el modelo por defecto es barato y el máximo de
// tokens de salida está acotado. Un afiche cuesta menos de un centavo.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Modelo barato: suficiente para rellenar plantillas de texto.
const MODELO: &str = "gpt-4o-mini";
/// Tope de salida. Un afiche son ~200 tokens; 900 deja margen sin
/// permitir que una respuesta se desboque.
const MAX_TOKENS: u32 = 900;

#[derive(Serialize)]
struct Peticion<'a> {
    model: &'a str,
    messages: Vec<Mensaje<'a>>,
    max_tokens: u32,
    temperature: f32,
    response_format: Formato,
}

#[derive(Serialize)]
struct Mensaje<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct Formato {
    #[serde(rename = "type")]
    tipo: &'static str,
}

#[derive(Deserialize)]
struct Respuesta {
    choices: Vec<Eleccion>,
    usage: Option<Uso>,
}

#[derive(Deserialize)]
struct Eleccion {
    message: ContenidoMensaje,
}

#[derive(Deserialize)]
struct ContenidoMensaje {
    content: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Uso {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Serialize)]
pub struct ResultadoIA {
    /// JSON crudo devuelto por el modelo
    pub contenido: String,
    pub uso: Option<Uso>,
    /// Costo estimado en USD, para que se vea el gasto
    pub costo_usd: f64,
}

fn leer_clave() -> Result<String, String> {
    if let Ok(k) = std::env::var("OPENAI_API_KEY") {
        if k.starts_with("sk-") {
            return Ok(k);
        }
    }

    // Archivo propio del usuario
    if let Some(home) = dirs_home() {
        let p = home.join(".brand-studio").join("openai.key");
        if let Ok(s) = std::fs::read_to_string(&p) {
            let s = s.trim().to_string();
            if s.starts_with("sk-") {
                return Ok(s);
            }
        }
    }

    // Desarrollo: reutiliza la clave de otro proyecto local
    if let Ok(ruta) = std::env::var("BRAND_STUDIO_ENV_FILE") {
        if let Ok(txt) = std::fs::read_to_string(&ruta) {
            for linea in txt.lines() {
                if let Some(v) = linea.strip_prefix("OPENAI_API_KEY=") {
                    let v = v.trim().trim_matches('"').trim_matches('\'');
                    if v.starts_with("sk-") {
                        return Ok(v.to_string());
                    }
                }
            }
        }
    }

    Err("No hay clave de OpenAI. Ponla en ~/.brand-studio/openai.key o en la variable OPENAI_API_KEY.".into())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Precio de gpt-4o-mini (USD por millón de tokens), a agosto de 2026.
/// Si cambia, solo hay que tocar estas dos constantes.
const USD_ENTRADA_POR_M: f64 = 0.15;
const USD_SALIDA_POR_M: f64 = 0.60;

fn estimar_costo(u: &Option<Uso>) -> f64 {
    match u {
        Some(u) => {
            (u.prompt_tokens as f64 / 1_000_000.0) * USD_ENTRADA_POR_M
                + (u.completion_tokens as f64 / 1_000_000.0) * USD_SALIDA_POR_M
        }
        None => 0.0,
    }
}

/// Genera contenido para un afiche.
///
/// `sistema` describe el template y la marca; `usuario` es lo que pide
/// la persona. El modelo devuelve JSON, que la interfaz mapea a los
/// bloques del template.
#[tauri::command]
pub async fn generar_afiche(sistema: String, usuario: String) -> Result<ResultadoIA, String> {
    let clave = leer_clave()?;

    let cuerpo = Peticion {
        model: MODELO,
        messages: vec![
            Mensaje { role: "system", content: &sistema },
            Mensaje { role: "user", content: &usuario },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.8,
        response_format: Formato { tipo: "json_object" },
    };

    let cliente = reqwest::Client::new();
    let r = cliente
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {clave}"))
        .header("Content-Type", "application/json")
        .json(&cuerpo)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con OpenAI: {e}"))?;

    let estado = r.status();
    let texto = r.text().await.map_err(|e| e.to_string())?;

    if !estado.is_success() {
        return Err(format!("OpenAI respondió {estado}: {texto}"));
    }

    let parsed: Respuesta =
        serde_json::from_str(&texto).map_err(|e| format!("Respuesta inesperada: {e}"))?;

    let contenido = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .ok_or("OpenAI no devolvió contenido")?;

    let costo_usd = estimar_costo(&parsed.usage);

    Ok(ResultadoIA { contenido, uso: parsed.usage, costo_usd })
}

/// ¿Hay clave configurada? La interfaz lo usa para mostrar u ocultar
/// el panel de IA sin intentar una llamada que va a fallar.
#[tauri::command]
pub fn hay_clave_ia() -> bool {
    leer_clave().is_ok()
}

// ─── Generación de imagen de fondo ──────────────────────────────────
//
// La IA genera SOLO el fondo. El texto y el logo los pone la app encima,
// con el template. Motivo: los modelos de imagen escriben mal —letras
// deformes, palabras inventadas— y así el texto sale nítido y editable.

/// Modelo barato de imagen. Una imagen ~4 centavos de dólar.
const MODELO_IMG: &str = "gpt-image-1-mini";

#[derive(Serialize)]
struct PeticionImg<'a> {
    model: &'a str,
    prompt: &'a str,
    size: &'a str,
    quality: &'a str,
    n: u8,
}

#[derive(Deserialize)]
struct RespuestaImg {
    data: Vec<DatoImg>,
    usage: Option<UsoImg>,
}

#[derive(Deserialize)]
struct DatoImg {
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct UsoImg {
    pub total_tokens: u32,
}

#[derive(Serialize)]
pub struct ResultadoImagen {
    /// data URI listo para usar como fondo
    pub data_uri: String,
    pub costo_usd: f64,
}

/// Genera una imagen de fondo para el afiche.
///
/// `descripcion` es lo que pide la persona ("luces de neón"). La app le
/// añade las reglas de composición: sin texto, con espacio libre donde
/// va el título.
#[tauri::command]
pub async fn generar_fondo(descripcion: String, formato: String) -> Result<ResultadoImagen, String> {
    let clave = leer_clave()?;

    // El modelo solo acepta estos tamaños. Se elige el que mejor calce
    // con el formato del afiche.
    let size = match formato.as_str() {
        "9:16" | "4:5" | "A4" => "1024x1536",
        "16:9" => "1536x1024",
        _ => "1024x1024",
    };

    let prompt = format!(
        "Fondo abstracto para afiche: {descripcion}. \
         SIN texto, SIN letras, SIN palabras, SIN logos, SIN marcas de agua. \
         Composición con la zona central despejada para superponer un titular. \
         Calidad fotográfica, sin bordes ni marcos."
    );

    let cuerpo = PeticionImg {
        model: MODELO_IMG,
        prompt: &prompt,
        size,
        quality: "low",
        n: 1,
    };

    let cliente = reqwest::Client::new();
    let r = cliente
        .post("https://api.openai.com/v1/images/generations")
        .header("Authorization", format!("Bearer {clave}"))
        .header("Content-Type", "application/json")
        .json(&cuerpo)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con OpenAI: {e}"))?;

    let estado = r.status();
    let texto = r.text().await.map_err(|e| e.to_string())?;
    if !estado.is_success() {
        return Err(format!("OpenAI respondió {estado}: {texto}"));
    }

    let parsed: RespuestaImg =
        serde_json::from_str(&texto).map_err(|e| format!("Respuesta inesperada: {e}"))?;
    let dato = parsed.data.into_iter().next().ok_or("No se generó ninguna imagen")?;

    let b64 = match (dato.b64_json, dato.url) {
        (Some(b), _) => b,
        (None, Some(u)) => {
            // Algunos modelos devuelven URL en vez de base64
            let bytes = reqwest::get(&u)
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            usar_base64(&bytes)
        }
        _ => return Err("La respuesta no traía imagen".into()),
    };

    // gpt-image-1-mini: ~$0.04 por imagen en calidad baja
    let costo_usd = match &parsed.usage {
        Some(u) => (u.total_tokens as f64 / 1_000_000.0) * 8.0,
        None => 0.04,
    };

    Ok(ResultadoImagen {
        data_uri: format!("data:image/png;base64,{b64}"),
        costo_usd,
    })
}

fn usar_base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for c in bytes.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}
