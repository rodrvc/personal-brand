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
}

const ALLOWED = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a", "pdf", "ttf", "otf", "woff", "woff2", "json", "yaml", "yml", "md", "txt"]);
const TEXT = new Set(["svg", "json", "yaml", "yml", "md", "txt"]);
const KEY_EXT = /\.(pem|key|p12|pfx|p8|crt|cer|jks|keystore)$/i;
// `token` only as a whole word (`token.txt`, `deploy-token.json`): `tokens.json` and `design-tokens/` are brand tokens.
const SECRET_NAME = /credential|secret|password|api[_-]?key|(^|[-_.])token($|[-_.])/i;
const PRIVATE_KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.|$)|config\.local\.)/; // the machine-local config is by design at the top level only; nested, it can still hold secrets
const CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];
// A guess, not a proof: a `key: value` assignment may be a brand token (`"accentToken": "var(--brand-accent)"`, `data-token="..."`).
const ASSIGNMENT = /(secret|api[_-]?key|password|passwd|token)["']?\s*[:=]\s*["']?[^\s"',]{8,}/i;

/** Why a path segment is never uploaded whatever its content, or null. */
export function nameRefusal(name: string, isDir: boolean): Refusal | null {
  if (name === ".git" || name === "node_modules" || (name.startsWith(".") && !isDir)) return { kind: "secret", why: "secret-like: dotfile, .git or node_modules" };
  if (name.startsWith(".")) return { kind: "unknown", why: "dot-directory: may hold brand content" };
  if (KEY_EXT.test(name) || PRIVATE_KEY_NAME.test(name)) return { kind: "secret", why: "secret-like: key, certificate or machine-local config" };
  if (SECRET_NAME.test(name)) return { kind: "unknown", why: "suspicious name" };
  if (!isDir && !ALLOWED.has(name.split(".").slice(1).pop()?.toLowerCase() ?? "")) return { kind: "unknown", why: "not a known content type" };
  return null;
}

/** Why a file's content is refused: a precise secret signature (`secret`) or a generic assignment guess (`unknown`), or null. */
export function contentRefusal(name: string, bytes: Buffer): Refusal | null {
  if (!TEXT.has(name.split(".").pop()?.toLowerCase() ?? "")) return null;
  const text = bytes.toString("utf-8");
  if (CONTENT.some((p) => p.test(text))) return { kind: "secret", why: "secret-like: secret pattern in content" };
  return ASSIGNMENT.test(text) ? { kind: "unknown", why: "suspicious content: key-value assignment" } : null;
}
