import { NotFoundError, type BrandDocumentRepository } from "@personal-brand/storage/contracts";

import { parseBrandTokens, type BrandFeature, type BrandTokens } from "./brand-schema.js";
import { buildBrandStyle, type BrandStyle } from "./brand-style.js";
import { resolveLayoutTemplate, summarizeLayoutTemplates, type LayoutTemplate, type LayoutTemplateSummary } from "./layout-template.js";

/** What the stored-brand loaders read: the brand's documents, nothing else. */
export type BrandDocuments = Pick<BrandDocumentRepository, "get">;

/** Decoder that hands back the stored body untouched; the domain checks stay with the engine's own parsers. */
const rawBody = (body: unknown): unknown => body;

/** The document, or `undefined` when the brand has none of that kind/name. Any other failure propagates. */
async function optional(documents: BrandDocuments, brandId: string, kind: "tokens" | "config" | "identity" | "spec" | "template", name: string): Promise<unknown> {
  try {
    return (await documents.get(brandId, kind, name, rawBody)).value;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/**
 * `loadBrand` for a stored brand: the `tokens` document, run through the same validation as `brand.json`.
 * `slug` only names the brand in errors.
 */
export async function loadStoredBrand(documents: BrandDocuments, brandId: string, slug: string, features: BrandFeature[] = []): Promise<BrandTokens> {
  const tokens = await optional(documents, brandId, "tokens", "");
  if (tokens === undefined) {
    throw new Error(`Brand "${slug}" has no stored tokens document. Import it with the \`brand\` CLI (storage package); see system/config/brand.schema.md for the shape.`);
  }
  return parseBrandTokens(tokens, `storage:${slug}`, features);
}

/** `loadBrandStyle` for a stored brand. Every document is optional, as every file is for a folder. */
export async function loadStoredBrandStyle(documents: BrandDocuments, brandId: string): Promise<BrandStyle> {
  const [spec, identity, config, tokens] = await Promise.all(
    (["spec", "identity", "config", "tokens"] as const).map((kind) => optional(documents, brandId, kind, "")),
  );
  const tone = (config as { tone?: { style?: unknown; avoid?: unknown } } | undefined)?.tone;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  return buildBrandStyle({
    brandSpec: typeof spec === "string" ? spec : undefined,
    profileMd: typeof identity === "string" ? identity : undefined,
    tone: tone ? { style: strings(tone.style), avoid: strings(tone.avoid) } : undefined,
    brandJson: tokens,
  });
}

/** `loadLayoutTemplate` for a stored brand: the engine default, merged with the brand's stored `template` document of that id (if any). */
export async function loadStoredLayoutTemplate(
  documents: BrandDocuments,
  brandId: string,
  id: string,
  brand: BrandTokens,
  params?: Record<string, unknown>,
): Promise<LayoutTemplate> {
  const override = await optional(documents, brandId, "template", id);
  return resolveLayoutTemplate(id, override, `the stored template "${id}"`, brand, params);
}

/** `listLayoutTemplates` for a stored brand: the engine defaults, with the brand's stored `template` documents as overrides (same ids replace, new ids are added). */
export async function listStoredLayoutTemplates(documents: Pick<BrandDocumentRepository, "list">, brandId: string): Promise<LayoutTemplateSummary[]> {
  return summarizeLayoutTemplates((await documents.list(brandId, "template")).map((doc) => doc.name));
}
