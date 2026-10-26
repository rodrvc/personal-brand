import { NotFoundError, type DocumentKind } from "../contracts/index.ts";
import type { ImportRepos } from "../import/importer.ts";

/** The fictional, tracked brands: they never contribute terms (the gate would block itself with its own examples). */
const EXAMPLE_BRAND = /^example(-[a-z0-9-]+)?$/;
/** Platforms a brand publishes to; the engine may name them, so they are not the brand's terms. */
const THIRD_PARTY = ["linkedin.com", "instagram.com", "facebook.com", "twitter.com", "x.com", "threads.net", "tiktok.com", "youtube.com", "github.com", "medium.com", "substack.com", "notion.so", "behance.net", "dribbble.com", "bsky.app"];
const TLDS = [".cl.com", ".com", ".cl", ".net", ".org", ".io", ".dev", ".app", ".co", ".ai", ".es", ".mx", ".ar", ".pe", ".me", ".xyz"].sort((a, b) => b.length - a.length);
/** Schema field names written after an at sign cite the concept, never a real handle. */
const SCHEMA_FIELDS = new Set(["handle", "handles", "usuario", "user", "username", "slug", "wordmark", "site", "hashtag", "hashtags", "nombre", "name"]);
const HANDLE = /@([A-Za-z0-9._]{3,30})\b/g;

/** `example.cl` -> the full host and its base name (prose names the brand without the TLD). Third-party hosts yield nothing. */
export function domainTerms(value: string): string[] {
  const host = value.trim().replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].toLowerCase();
  if (!host.includes(".")) return host ? [host] : [];
  if (THIRD_PARTY.some((t) => host === t || host.endsWith(`.${t}`))) return [];
  const tld = TLDS.find((t) => host.endsWith(t));
  const base = (tld ? host.slice(0, -tld.length) : host).split(".").pop();
  return base ? [host, base] : [host];
}

/** A compound hashtag (CamelCase, digit or separator) identifies a brand; a single plain word is topic vocabulary. */
const identifying = (tag: string): boolean => /[\d_.-]/.test(tag) || /[A-Z]/.test(tag.slice(1));

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Raw candidate terms for the commit gate, from storage alone (no folder is read): for every brand that is not an example,
 * its slug and display name, the tokens' wordmark and owned domains, the config's name and identifying hashtags, and the
 * @handles written in its identity and spec text. The gate applies its own length and generic-word filters on top.
 */
export async function brandTerms(repos: ImportRepos): Promise<string[]> {
  const terms = new Set<string>();
  const doc = async (brandId: string, kind: DocumentKind): Promise<unknown> => {
    try {
      const d = (await repos.documents.get(brandId, kind, "", (b) => b)).value as unknown;
      return record(d).json ?? record(d).text ?? d;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
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
    const config = record(await doc(brand.id, "config"));
    strings(record(config.content).default_hashtags ?? config.default_hashtags).filter(identifying).forEach((t) => terms.add(t.replace(/^#/, "")));
    strings(record(config.profile).name).forEach((t) => terms.add(t));
    for (const kind of ["identity", "spec"] as const) {
      const text = await doc(brand.id, kind);
      for (const m of typeof text === "string" ? text.matchAll(HANDLE) : []) if (!m[1].includes(".") && !SCHEMA_FIELDS.has(m[1].toLowerCase())) terms.add(m[1]);
    }
  }
  return [...terms].map((t) => t.trim()).filter((t) => t && !/[\r\n]/.test(t)).sort((a, b) => a.localeCompare(b));
}
