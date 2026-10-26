import { NotFoundError, type DocumentKind } from "../contracts/index.ts";
import type { ImportRepos } from "../import/importer.ts";

/** The fictional, tracked brands: they never contribute terms (the gate would block itself with its own examples). */
const EXAMPLE_BRAND = /^example(-[a-z0-9-]+)?$/;
/** Platforms a brand publishes to; the engine may name them, so they are not the brand's terms. */
const THIRD_PARTY = ["linkedin.com", "instagram.com", "facebook.com", "twitter.com", "x.com", "threads.net", "tiktok.com", "youtube.com", "github.com", "medium.com", "substack.com", "notion.so", "behance.net", "dribbble.com", "bsky.app"];
/** Second-level labels under a country code (`example.co.uk`, `example.com.au`); generic, not tied to any market. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
/**
 * Twin of `SCHEMA_FIELD_NAMES` in `scripts/validate_commit_guardian.py` (the test compares the two lists, so they cannot drift).
 * Schema field names written after an at sign cite the concept, never a real handle.
 */
export const SCHEMA_FIELDS = new Set(["handle", "handles", "usuario", "user", "username", "slug", "wordmark", "site", "hashtag", "hashtags", "nombre", "name"]);
/** CSS and Tailwind at-rules that look like handles in stored style text. */
const AT_RULES = new Set(["media", "import", "keyframes", "font", "charset", "supports", "page", "layer", "container", "property", "namespace", "apply", "tailwind", "config", "screen", "variants"]);
/** Shared hosting suffixes: the brand label sits before the suffix, not in it (`brand.github.io`). */
const PRIVATE_SUFFIX = ["github.io", "vercel.app", "netlify.app", "pages.dev"];
/** Generic top-level domains that can follow a two-letter label that is a registry prefix (`brand.zz.com`). */
const GENERIC_TLD = new Set(["com", "net", "org"]);
/**
 * An at sign not glued to a word (so `person@host.test` is an email, not a handle), then 3 to 30 handle characters that
 * start and end on a letter, digit or underscore, with at least one letter somewhere and not a resolution like `1080p`.
 * A word character right after the 30 is no match (an id or hash is not a truncated handle); a dotted run over 30 characters
 * may backtrack to a shorter handle that ends at a dot (`@a.b.c...`), which errs on the side of watching. Dots inside are kept
 * (`first.last`); a trailing dot is sentence punctuation. A dot before the at sign does not glue it (`end.@handle` is a
 * handle: leaking one is worse than watching one too many). `isSkippedHandle` holds the exclusions that need the text around the match.
 *
 * The Python folder derivation (`HANDLE` in the gate) is deliberately simpler: same lookbehind and the same schema-field
 * list, but it skips every dotted handle and has no letter, resolution, at-rule or npm-scope rules. The two sides watch
 * different handle sets on purpose; the union is what the gate checks (design doc, "Decided in S11a2b").
 */
const HANDLE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.]{1,28}[A-Za-z0-9_])(?![A-Za-z0-9_])/g;
/** A capture needs a letter somewhere (`@400;600` is a font weight list) and is not a resolution (`@1080p`); `@_name` and `@1name` stay. */
const handleLike = (h: string): boolean => /[A-Za-z]/.test(h) && !/^\d+p$/i.test(h);

/** A match followed by a slash is an npm scope (`@scope/pkg`), unless a slash precedes the at sign (`site.test/@handle/post` is a profile URL). */
const isNpmScope = (text: string, m: RegExpMatchArray): boolean => text[m.index! + m[0].length] === "/" && text[m.index! - 1] !== "/";
/** Everything that is not a real handle: no letter or a resolution, an npm scope, a schema field name, a CSS at-rule. */
const isSkippedHandle = (text: string, m: RegExpMatchArray): boolean => {
  const word = m[1].toLowerCase();
  return !handleLike(m[1]) || isNpmScope(text, m) || SCHEMA_FIELDS.has(word) || AT_RULES.has(word);
};

/**
 * A `url` value worth parsing as a host: no spaces, a dot in the host part, not a relative path (`./x`, `~/x`). With a scheme
 * or a leading `//` (protocol-relative) the first segment is a host whatever its TLD (`https://brand.md`); a bare value that
 * looks like a file name (`logo.png`, `notes.md`) is not one.
 */
const hostLike = (value: string): boolean => {
  const v = value.trim();
  const explicit = /^([a-z]+:)?\/\//i.test(v);
  const host = v.replace(/^([a-z]+:)?\/\//i, "").split(/[/?#]/)[0];
  const fileName = !explicit && /\.(png|jpe?g|gif|svg|webp|json|ya?ml|md|txt|css|js|ts|html?|mp[34])$/i.test(host);
  return !/\s/.test(v) && (explicit || !/^[./~]/.test(v)) && host.includes(".") && !fileName;
};

/**
 * `www.example.test` -> the full host and its base name (prose names the brand without the TLD). Third-party hosts yield nothing.
 * The base name is the registrable label: the one before the public suffix, whatever the suffix is (a TLD missing from any
 * list, such as `.store`, still yields the brand label), going back one more label under a two-letter country code's `co`/`com`/..., under a two-letter label before a generic
 * `com`/`net`/`org` (`brand.zz.com`), and before a shared hosting suffix. Userinfo, port and a trailing FQDN dot are dropped.
 */
export function domainTerms(value: string): string[] {
  const host = (value.trim().replace(/^([a-z]+:)?\/\//i, "").split(/[/?#]/)[0].split("@").pop() ?? "").replace(/:\d{1,5}$/, "").replace(/\.$/, "").toLowerCase();
  if (!host.includes(".")) return host ? [host] : [];
  if (PRIVATE_SUFFIX.includes(host)) return [host]; // the suffix itself names no brand
  if (THIRD_PARTY.some((t) => host === t || host.endsWith(`.${t}`))) return [];
  const labels = host.split(".");
  let at = labels.length - 2;
  const last = labels[labels.length - 1];
  const hosting = PRIVATE_SUFFIX.find((s) => host.endsWith(`.${s}`));
  if (hosting) at = labels.length - hosting.split(".").length - 1;
  else if (at >= 1 && ((SECOND_LEVEL.has(labels[at]) && last.length === 2) || (labels[at].length === 2 && GENERIC_TLD.has(last)))) at--;
  const base = labels[at];
  return base ? [host, base] : [host];
}

/** A compound hashtag body, without its `#` (CamelCase, digit or separator), identifies a brand; a single plain word is topic vocabulary. */
const identifying = (body: string): boolean => /[\d_.-]/.test(body) || /[A-Z]/.test(body.slice(1));

/** Reads in flight at once per kind of stored text. */
const READ_CONCURRENCY = 8;
/** Runs `fn` over `items` with at most `limit` in flight; the first failure rejects. */
export async function forEachLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Every string value of a stored body (depth-bounded, 64), with the key it sits under: how `name`, `city` and `url` are found at any depth. */
function* walk(v: unknown, key = "", depth = 0): Generator<[string, string]> {
  if (typeof v === "string") yield [key, v];
  else if (depth < 64 && v && typeof v === "object") for (const [k, child] of Object.entries(v)) yield* walk(child, Array.isArray(v) ? key : k, depth + 1);
}

/**
 * Raw candidate terms for the commit gate, from storage alone (no folder is read), mirroring the gate's folder derivation
 * (`derive_terms` in `scripts/validate_commit_guardian.py`): the same sources, not the same handle rules (see `HANDLE`). For every brand that is not an example: its slug and display
 * name; the tokens' wordmark and owned domains; the identifying hashtags of the config; any `name` key of the config and
 * tokens; every recipe's `city` and `url` (domain and base name); every carousel's `city`; and the @handles written in any
 * stored text (identity, spec, templates, guidance, recipes, config, tokens, carousels, content items). The gate applies its own length and
 * generic-word filters on top.
 */
export async function brandTerms(repos: ImportRepos): Promise<string[]> {
  const terms = new Set<string>();
  const doc = async (brandId: string, kind: DocumentKind, name = ""): Promise<unknown> => {
    try {
      const d = (await repos.documents.get(brandId, kind, name, (b) => b)).value as unknown;
      return record(d).json ?? record(d).text ?? d;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  };
  const handles = (text: string): void => {
    for (const m of text.matchAll(HANDLE)) if (!isSkippedHandle(text, m)) terms.add(m[1]);
  };
  const scan = (body: unknown, onKey?: (key: string, value: string) => void): void => {
    for (const [key, value] of walk(body)) {
      handles(value);
      onKey?.(key, value);
    }
  };
  for (const brand of await repos.brands.list({ includeArchived: true })) {
    if (EXAMPLE_BRAND.test(brand.value.slug)) continue;
    terms.add(brand.value.slug);
    terms.add(brand.value.displayName);
    const tokens = record(await doc(brand.id, "tokens"));
    const copy = record(tokens.copy);
    strings(copy.wordmark).forEach((t) => terms.add(t));
    for (const host of [...strings(copy.site), ...strings(tokens.sourceImageHosts)]) domainTerms(host).forEach((t) => terms.add(t));
    const addName = (key: string, value: string): void => void (key === "name" && terms.add(value));
    scan(tokens, addName);
    const config = record(await doc(brand.id, "config"));
    for (const tag of strings(record(config.content).default_hashtags ?? config.default_hashtags)) {
      const body = tag.trim().replace(/^#/, "");
      if (identifying(body)) terms.add(body);
    }
    scan(config, addName);
    // One list per kind, then bounded-concurrency reads (the gate gives this whole command a few seconds). An item that vanished
    // between the list and its read (deleted, purged, renamed) is skipped: one race must not fail the whole command.
    const each = async <T,>(list: Promise<T[]>, read: (x: T) => Promise<void>): Promise<void> =>
      void (await forEachLimited(await list, READ_CONCURRENCY, (x) => read(x).catch((e) => (e instanceof NotFoundError ? undefined : Promise.reject(e)))));
    await Promise.all([
      Promise.all((["identity", "spec"] as const).map(async (kind) => scan(await doc(brand.id, kind)))),
      each(repos.documents.list(brand.id, "template"), async (t) => scan(await doc(brand.id, "template", t.name))),
      each(repos.content.list(brand.id), async (c) => {
        const item = (await repos.content.get(brand.id, c.value.slug)).value;
        scan([item.title, item.bodyMd, item.meta]);
      }),
      each(repos.guidance.list(brand.id), async (g) => scan((await repos.guidance.get(brand.id, g.name)).body)),
      each(repos.recipes.list(brand.id), async (r) => {
        scan((await repos.recipes.get(brand.id, r.recipe, (b) => b)).value, (key, value) => {
          if (key === "city") terms.add(value);
          else if (key === "url" && hostLike(value)) domainTerms(value).forEach((t) => terms.add(t));
        });
      }),
      each(repos.carousels.list(brand.id), async (c) => {
        const document = (await repos.carousels.get(brand.id, c.value.slug, (b) => b)).value.document;
        scan(document, (key, value) => void (key === "city" && terms.add(value)));
      }),
    ]);
  }
  return [...terms].map((t) => t.trim()).filter((t) => t && !/[\r\n]/.test(t)).sort((a, b) => a.localeCompare(b));
}
