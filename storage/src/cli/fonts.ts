import { basename } from "node:path";

/**
 * Network policy of `brand fonts fetch` (design §8, S8b3b3). It replaces `system/assets/fetch-fonts.ts`, which fetched any
 * URL with no limits. What that script did, made explicit:
 *  - the stylesheet URL is the tokens' `googleFontsHref` (a Google Fonts CSS endpoint, see `brand.schema.md`);
 *  - the font files are the `url(...)` of each `.woff2` `@font-face` in that stylesheet, which that service serves from its static host.
 * Everything else is refused: https only, hosts from a fixed list, no redirect to a host off the list, size caps, a timeout.
 */
export const ALLOWED_FONT_HOSTS: readonly string[] = ["fonts.googleapis.com", "fonts.gstatic.com"];
export const MAX_STYLESHEET_BYTES = 256 * 1024;
export const MAX_FONT_BYTES = 2 * 1024 * 1024;
export const MAX_FONT_FACES = 32;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;
/** One deadline for the whole run (stylesheet and every font), on top of the per-request timeout. */
export const RUN_DEADLINE_MS = 60_000;
/** The longest `--family` / font family name; `judgeBytes` in verbs.ts enforces the same limit by importing this constant. */
export const MAX_FAMILY_CHARS = 100;
// The CSS endpoint only serves woff2 (the format this repo standardizes on) to a recent browser.
const MODERN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** A URL, redirect, size or timeout the policy refuses. Nothing has been uploaded when it is thrown. */
export class FontPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontPolicyError";
  }
}

export interface FontFile { name: string; family: string; bytes: Buffer }

/**
 * `family: url` pairs of the `.woff2` rules of a stylesheet, one per distinct URL. Quoted and unquoted `url()` and family names are read;
 * a rule whose font URL carries a query or fragment after `.woff2` is refused, and so is a family name that could not become an asset family.
 */
export function extractFontFaces(css: string): Array<{ family: string; url: string }> {
  const faces = new Map<string, string>();
  for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const family = /font-family:\s*(?:'([^']*)'|"([^"]*)"|([^'";}]+))/.exec(block[1]);
    const url = /url\(\s*(['"]?)([^'"()\s?#]+\.woff2)\1\s*\)/.exec(block[1]);
    if (!url && /url\([^()]*\.woff2/.test(block[1])) throw new FontPolicyError("la URL de una fuente no termina en .woff2 (¿lleva query o fragmento?)");
    const name = (family?.[1] ?? family?.[2] ?? family?.[3])?.trim();
    if (!name || !url) continue;
    if (name.length > MAX_FAMILY_CHARS) throw new FontPolicyError(`un nombre de familia supera ${MAX_FAMILY_CHARS} caracteres`);
    if (!faces.has(url[2])) faces.set(url[2], name);
  }
  return [...faces].map(([url, family]) => ({ family, url }));
}

function checkUrl(raw: string, base?: string): URL {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new FontPolicyError(`URL no válida: ${raw.slice(0, 80)}`); }
  if (url.protocol !== "https:") throw new FontPolicyError(`solo se admite https (${url.protocol})`);
  if (url.username || url.password || url.port) throw new FontPolicyError("la URL no puede llevar credenciales ni puerto");
  if (!ALLOWED_FONT_HOSTS.includes(url.hostname)) throw new FontPolicyError(`el host ${url.hostname} no está permitido (${ALLOWED_FONT_HOSTS.join(", ")})`);
  return url;
}

/** GETs `raw` and follows redirects by hand: each hop is judged like the first, so none can leave the allowed hosts. */
async function get(doFetch: typeof fetch, raw: string, maxBytes: number, deadline: AbortSignal): Promise<Buffer> {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await doFetch(url.href, { redirect: "manual", signal: AbortSignal.any([deadline, AbortSignal.timeout(TIMEOUT_MS)]), headers: { "User-Agent": MODERN_UA } });
    } catch (error) {
      throw new FontPolicyError(`no se pudo descargar ${url.hostname} (${(error as Error).name === "TimeoutError" ? "tiempo agotado" : (error as Error).message})`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      const location = res.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new FontPolicyError("redirección inválida o demasiado larga");
      url = checkUrl(location, url.href);
      continue;
    }
    // Refusals below release the socket first, like the redirect branch.
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new FontPolicyError(res.ok ? `la respuesta supera ${maxBytes} bytes` : `${url.hostname} respondió HTTP ${res.status}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw new FontPolicyError(`la respuesta supera ${maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (error instanceof FontPolicyError) throw error;
      throw new FontPolicyError(`no se pudo leer la respuesta de ${url.hostname} (${(error as Error).message})`);
    }
    return Buffer.concat(chunks);
  }
}

/** Downloads the stylesheet and every font it names, all under the policy above; the caller registers the files afterwards. */
export async function downloadFonts(doFetch: typeof fetch, href: string, deadlineMs = RUN_DEADLINE_MS): Promise<FontFile[]> {
  const deadline = AbortSignal.timeout(deadlineMs); // `deadlineMs` is the test seam for the run deadline
  const faces = extractFontFaces((await get(doFetch, href, MAX_STYLESHEET_BYTES, deadline)).toString("utf8"));
  if (faces.length === 0) throw new FontPolicyError("la hoja de estilos no tiene reglas @font-face woff2");
  if (faces.length > MAX_FONT_FACES) throw new FontPolicyError(`la hoja de estilos declara más de ${MAX_FONT_FACES} fuentes`);
  // Every URL is judged before the first download: a refused one costs no request at all. The pathname check is a deliberate backstop
  // of the regex in extractFontFaces (which already rejects a query or fragment): keep both if the rule changes.
  const urls = faces.map((face) => {
    const url = checkUrl(face.url);
    if (!url.pathname.endsWith(".woff2") || url.search || url.hash) throw new FontPolicyError(`la URL de ${url.hostname} no termina en .woff2 (sin query ni fragmento)`);
    return url;
  });
  const files: FontFile[] = [];
  for (const [i, face] of faces.entries()) {
    const file = basename(urls[i].pathname).replace(/[^A-Za-z0-9._-]/g, "_");
    files.push({ family: face.family, name: `${face.family.replace(/[^A-Za-z0-9]/g, "")}-${file}`, bytes: await get(doFetch, urls[i].href, MAX_FONT_BYTES, deadline) });
  }
  return files;
}
