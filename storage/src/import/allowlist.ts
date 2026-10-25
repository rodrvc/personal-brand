/**
 * What the legacy pass may upload into the never-delete bucket. An ALLOWLIST of known brand content types, with a
 * hard refusal list on top (names and content that look like secrets). The repo's commit gate only checks brand
 * literals, it has no secret patterns, so this file is the one place those patterns live.
 *
 * Nothing refused is ever uploaded, but the two kinds of refusal differ at cutover. `secret` is proven (dotfiles, `.git`, key and
 * certificate files, a precise secret signature in the content): deliberate, it never blocks. `unknown` is a guess (a type the
 * allowlist does not know, a name that merely looks sensitive): it may be real brand content, so it blocks without `--partial`.
 */
export interface Refusal {
  kind: "secret" | "unknown";
  why: string;
  /** Machine-readable reason for the refusals callers treat specially; `why` is English prose and may be reworded. */
  code?: "unknown-type" | "svg-allowlist";
}

/** Spanish remedy for an SVG the allowlist screen refused; the importer adds its own `--partial` way out. */
export const SVG_REEXPORT_HINT = "reexporta como SVG plano (sin DOCTYPE ni <style>, atributos con comillas; p. ej. SVGO o Figma) o conviértelo a PNG";

const ALLOWED = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a", "pdf", "ttf", "otf", "woff", "woff2", "json", "yaml", "yml", "md", "txt"]);
const TEXT = new Set(["svg", "json", "yaml", "yml", "md", "txt"]);
const KEY_EXT = /\.(pem|key|p12|pfx|p8|crt|cer|jks|keystore)$/i;
// `token` only as a whole word (`token.txt`, `deploy-token.json`): `tokens.json` and `design-tokens/` are brand tokens.
const SECRET_NAME = /credential|secret|password|api[_-]?key|(^|[-_.])token($|[-_.])/i;
const PRIVATE_KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.|$)|config\.local\.)/; // the machine-local config is by design at the top level only; nested, it can still hold secrets
// Text-only signatures: loose enough that a binary (a font name table holds `http://x.commailto:y@`) would trip them.
// Every quantifier is bounded: an open `{n,}` over a multi-megabyte run overflows the regex stack.
const TEXT_ONLY = [
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,256}:[^\s@/]{1,1024}@/i, // credentials in a URL (the scheme is bounded: no quadratic scan on `a-a-a-...`)
  /\bsk-[A-Za-z0-9_-]{20}/,
];
// Fixed-prefix tokens: precise enough to run over the raw bytes of any file. Each carries the literals it starts with, so a
// binary is searched with `Buffer.indexOf` and the regex only runs on a small window around a hit.
const FIXED: { re: RegExp; literals: string[] }[] = [
  { re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY/, literals: ["-----BEGIN "] },
  { re: /\bAKIA[0-9A-Z]{16}\b/, literals: ["AKIA"] },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30}/, literals: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10}/, literals: ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] },
  { re: /\b[sr]k_live_[A-Za-z0-9]{16}/, literals: ["k_live_"] }, // Stripe secret and restricted live keys
  { re: /\bAIza[0-9A-Za-z_-]{35}/, literals: ["AIza"] }, // Google API key
  { re: /"auth"\s{0,64}:\s{0,64}"[A-Za-z0-9+/]{12,16384}={0,2}"/, literals: ['"auth"'] }, // a container registry login (`.docker/config.json`): base64 of user:password
  // JWT: header and payload are both base64url JSON (`eyJ`), so ordinary JSON never matches; anchored on the dot so a long `eyJ-eyJ-` run is not rescanned from every start
  { re: /(?<=\beyJ[A-Za-z0-9_-]{8,4096})\.eyJ[A-Za-z0-9_-]{8,12000}\.[A-Za-z0-9_-]{8}/, literals: [".eyJ"] },
];
const CONTENT = [...TEXT_ONLY, ...FIXED.map((f) => f.re)];
// The window around a literal hit in a binary: the longest match after a literal is the `"auth"` value (about 16.5 KB; a JWT's tail is
// about 12 KB), and the JWT header sits up to 4 KB before its dot.
const WINDOW_BEFORE = 4200;
const WINDOW_AFTER = 17_000;
const MAX_BINARY_HITS = 10_000;

/** Whether a binary holds a fixed-prefix token. No string of the whole file is built (a `latin1` string of 512 MB or more throws): only a window around each literal hit. */
function binaryHasToken(bytes: Buffer): boolean | "too-many" {
  let hits = 0;
  for (const { re, literals } of FIXED) {
    for (const literal of literals) {
      for (let at = bytes.indexOf(literal, 0, "latin1"); at !== -1; at = bytes.indexOf(literal, at + 1, "latin1")) {
        if (++hits > MAX_BINARY_HITS) return "too-many";
        if (re.test(bytes.subarray(Math.max(0, at - WINDOW_BEFORE), at + WINDOW_AFTER).toString("latin1"))) return true;
      }
    }
  }
  return false;
}
// A guess, not a proof: a `key: value` assignment may be a brand token (`"accentToken": "var(--brand-accent)"`, `data-token="..."`).
const ASSIGNMENT = /(secret|api[_-]?key|password|passwd|token)["']?\s{0,64}[:=]\s{0,64}["']?[^\s"',]{8}/i;

// A positive screen for SVG (an allowlist, not a sanitizer): the file is accepted only if every tag is a plain drawing element
// and every attribute is inert. Anything it does not recognize is refused. Comments are cut out by a strict scanner that
// refuses the malformed forms parsers read differently (`<!-->`, `<!--->`, `--!>`, markup inside a comment).
const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "defs", "symbol", "use", "image", "title", "desc", "metadata",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood",
  "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
]);
// A tag is read in three steps (name, one attribute at a time, the end), each a sticky match, so a tag with a million attributes
// is a loop and not a regex recursion. A plain name (no prefix, no dot) and only quoted `name="value"` attributes.
const SVG_HEAD = /<(\/?)([A-Za-z][A-Za-z0-9]*)/y;
const SVG_ATTR = /\s+([\w:-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/y;
const SVG_TAIL = /\s*\/?>/y;
const SVG_HREF_OK = /^\s*(#[\w.-]+|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+)$/;
const SVG_URL_OK = /url\(\s*#[\w.-]+\s*\)/gi;
// A CSS function in an attribute value may only be one of these (`url` only as `url(#id)`, stripped before the check); `image-set`, `cross-fade`, `element`, `src` and the rest can fetch.
// Modern colours, 3d transforms, `min`/`max`/`clamp` and the CSS basic shapes only describe geometry or colour; none of them fetches.
const SVG_CSS_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "calc", "var", "min", "max", "clamp",
  "matrix", "matrix3d", "translate", "translate3d", "translatex", "translatey", "translatez", "scale", "scale3d", "scalex", "scaley", "scalez", "rotate", "rotate3d", "rotatex", "rotatey", "rotatez", "skewx", "skewy",
  "circle", "ellipse", "inset", "polygon",
]);
const SVG_XMLNS_OK = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);

/** Whether the comment starting at `open` is well formed; returns the index after its `-->`, or -1. Linear: `indexOf` only moves forward. */
function commentEnd(s: string, open: number): number {
  const close = s.indexOf("-->", open + 4);
  if (close === -1) return -1;
  const body = s.slice(open + 4, close);
  return body.startsWith("-") || body.endsWith("-") || /--|[<>]/.test(body) ? -1 : close + 3;
}

/** Whether `text` is a static SVG drawing: known tags only, no references, no scripts or styles, every link pointing inside the file. Linear time. */
function svgAccepted(text: string): boolean {
  // Only comments (recognized where a tag would start, never inside one) and a leading `<?xml ...?>` may stand outside the elements.
  const s = text.replace(/^\s*<\?xml\s[^?>]*\?>/, "");
  // Character and entity references can spell anything: only the five XML entities pass.
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(s)) return false;
  let pos = 0;
  for (let at = s.indexOf("<"); at !== -1; at = s.indexOf("<", pos)) {
    pos = at;
    if (s.startsWith("<!--", at)) {
      pos = commentEnd(s, at);
      if (pos === -1) return false;
      continue;
    }
    SVG_HEAD.lastIndex = at;
    const head = SVG_HEAD.exec(s);
    if (!head || !SVG_TAGS.has(head[2])) return false;
    pos = SVG_HEAD.lastIndex;
    for (;;) {
      SVG_ATTR.lastIndex = pos;
      const attr = SVG_ATTR.exec(s);
      if (!attr) break;
      pos = SVG_ATTR.lastIndex;
      const [whole, name, double, single] = attr;
      const value = double ?? single;
      const key = name.toLowerCase();
      if (whole.includes("\\") || key.slice(key.lastIndexOf(":") + 1).startsWith("on") || key === "xml:base" || /@import/i.test(value)) return false;
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (!SVG_XMLNS_OK.has(value)) return false;
      } else if (key === "href" || key.endsWith(":href")) {
        if (!SVG_HREF_OK.test(value)) return false;
      } else if (/url\s*\(/i.test(value.replace(SVG_URL_OK, "")) || [...value.matchAll(/(?<![\w-])([\w-]+)\(/g)].some((f) => !SVG_CSS_FUNCTIONS.has(f[1].toLowerCase()) && f[1].toLowerCase() !== "url")) return false;
    }
    SVG_TAIL.lastIndex = pos;
    if (!SVG_TAIL.test(s)) return false;
    pos = SVG_TAIL.lastIndex;
  }
  return true;
}

/** Why a path segment is never uploaded whatever its content, or null. */
export function nameRefusal(name: string, isDir: boolean): Refusal | null {
  if (name === ".git" || name === "node_modules" || (name.startsWith(".") && !isDir)) return { kind: "secret", why: "secret-like: dotfile, .git or node_modules" };
  if (name.startsWith(".")) return { kind: "unknown", why: "dot-directory: may hold brand content" };
  if (KEY_EXT.test(name) || PRIVATE_KEY_NAME.test(name)) return { kind: "secret", why: "secret-like: key, certificate or machine-local config" };
  if (SECRET_NAME.test(name)) return { kind: "unknown", why: "suspicious name" };
  if (!isDir && !ALLOWED.has(name.split(".").slice(1).pop()?.toLowerCase() ?? "")) return { kind: "unknown", why: "not a known content type", code: "unknown-type" };
  return null;
}

/**
 * Why a file's content is refused: a precise secret signature (`secret`) or a generic guess (`unknown`), or null. A binary
 * file is scanned only for the fixed-prefix tokens and a hit is a guess: a font or image may contain such bytes by chance.
 */
export function contentRefusal(name: string, bytes: Buffer): Refusal | null {
  try {
    return scan(name, bytes);
  } catch {
    // A file too large to decode, or a regex that overflowed: unreadable here, so a guess, never uploaded.
    return { kind: "unknown", why: "suspicious content: could not be scanned" };
  }
}

function scan(name: string, bytes: Buffer): Refusal | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!TEXT.has(ext)) {
    const found = binaryHasToken(bytes);
    return found === "too-many" ? { kind: "unknown", why: "suspicious content: too many token-like sequences in a binary file" } : found ? { kind: "unknown", why: "suspicious content: secret-like token inside a binary file" } : null;
  }
  // UTF-16 text (BOM) or any NUL byte hides every pattern below from a UTF-8 decode: unreadable here, so a guess, never uploaded.
  if (bytes.includes(0) || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return { kind: "unknown", why: "suspicious content: not plain UTF-8 text" };
  const text = bytes.toString("utf-8");
  if (CONTENT.some((p) => p.test(text))) return { kind: "secret", why: "secret-like: secret pattern in content" };
  if (ext === "svg" && !svgAccepted(text)) return { kind: "unknown", why: "SVG outside the static-drawing allowlist (unknown tag, DOCTYPE, <style>, script, entity, event handler or external reference)", code: "svg-allowlist" };
  return ASSIGNMENT.test(text) ? { kind: "unknown", why: "suspicious content: key-value assignment" } : null;
}
