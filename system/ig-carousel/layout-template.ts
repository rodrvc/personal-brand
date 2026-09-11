import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { BrandTokens } from "./brand-schema.js";
import { FREE_TEMPLATE_ID, humanizeId } from "./object-reset.js";

/**
 * A layout template: `system/ig-carousel/layouts/<id>.json` (the generic
 * default, shipped with the engine) deep-merged with
 * `profiles/<slug>/templates/<id>.json` (a brand's override), when present.
 *
 * Templates declare *geometry*, brand *role* names (`colorRole`, resolved
 * against `brand.roles` at render time — see brand-schema.ts's `color()`)
 * and copy *keys* — never a hex value, a literal brand name, or real copy.
 * That is what keeps `system/ig-carousel/layouts/*.json` inside the "no
 * brand literals under system/" rule design.md and CLAUDE.md both state.
 */

/** Matches a `#rgb`/`#rrggbb`/`#rrggbbaa` literal anywhere inside a string. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

/**
 * A non-empty string that must name a role/policy, never a color literal —
 * an override that puts a hex value where `colorRole` or a zone policy goes
 * would silently defeat design.md D5 (no hex outside `brand.json`). `key`
 * names the offending field in the error message so a failing override
 * points straight at the field to fix.
 */
function roleStringSchema(key: string) {
  return z
    .string()
    .min(1)
    .refine((value) => !HEX_LITERAL.test(value), {
      message: `${key} must be a role/policy name, not a hex color literal`,
    });
}

const geometrySchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int().optional(),
  rotation: z.number(),
});

const textSlotSchema = z.object({
  name: z.string().min(1),
  type: z.literal("text"),
  geometry: geometrySchema,
  fontKey: z.string().min(1),
  fontSize: z.number().int().positive(),
  lineHeight: z.number().positive(),
  align: z.enum(["left", "center", "right"]),
  /** A brand ROLE name (brand.roles keys, e.g. "onSurface", "accent") — never a color key or hex. */
  colorRole: roleStringSchema("colorRole"),
});

const assetSlotSchema = z.object({
  name: z.string().min(1),
  type: z.literal("asset"),
  geometry: geometrySchema,
  fit: z.enum(["cover", "contain"]).optional(),
});

const slotSchema = z.discriminatedUnion("type", [textSlotSchema, assetSlotSchema]);
export type LayoutSlot = z.infer<typeof slotSchema>;

const marginsSchema = z.object({
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
  left: z.number().int(),
});

/**
 * The footer's optional fixed signature line: a single string painted by the
 * engine (`renderFooterZone`), never a document object, so it stays
 * unreachable from any composition (design.md's "signature becomes a footer
 * zone property, not a slot"). `copyKey` names a key in `brand.copy`,
 * `fontKey` a key in `brand.fonts`, `colorRole` a role in `brand.roles` —
 * never a literal string, family or hex, matching how slots already name
 * brand data by key instead of by value.
 */
const footerSignatureSchema = z.object({
  /** Key into `brand.copy` (e.g. "wordmark", "site") whose string value is painted. */
  copyKey: z.string().min(1),
  /** Key into `brand.fonts` the signature is set in. */
  fontKey: z.string().min(1),
  /** A brand ROLE name (brand.roles keys) — never a color key or hex. */
  colorRole: roleStringSchema("zones.footer.signature.colorRole"),
  /** Follows the footer's existing left/right convention (logo sits left, pagination right). */
  align: z.enum(["left", "right"]),
});
export type FooterSignature = z.infer<typeof footerSignatureSchema>;

const zonesSchema = z.object({
  background: z.object({
    /** How the background zone is painted; the engine interprets the policy name, the template only names it. */
    policy: roleStringSchema("zones.background.policy"),
  }),
  footer: z.object({
    height: z.number().int().nonnegative(),
    /** "auto" picks a logo variant from the library by contrast (D8); "none" lets a profile disable the footer logo entirely. */
    logo: z.enum(["auto", "none"]),
    /** "all" shows i/total on every slide; "steps" only on `kind: step` slides; "none" shows no pagination at all. */
    pagination: z.enum(["all", "steps", "none"]),
    /** Optional fixed signature line. A template that omits this paints none (layout-template spec's "Footer signature"). */
    signature: footerSignatureSchema.optional(),
  }),
  margins: marginsSchema,
});
export type LayoutZones = z.infer<typeof zonesSchema>;

const slideKindSchema = z.enum(["cover", "step", "closing"]);

const layoutTemplateSchema = z.object({
  id: z.string().min(1),
  canvas: z.object({
    w: z.literal(1080),
    h: z.literal(1350),
  }),
  zones: zonesSchema,
  slides: z.record(slideKindSchema, z.object({ slots: z.array(slotSchema) })),
  // Number of `step` slides to compose when the prompt names no explicit
  // count (piece-generation spec's "the slide count is editable
  // afterward"; editor-ui's "Composition from the prompt"). Optional so an
  // older or minimal template still validates — callers fall back to a
  // hardcoded default (3) when it's absent.
  defaultSlideCount: z.number().int().positive().optional(),
});

export type LayoutTemplate = z.infer<typeof layoutTemplateSchema>;

export class LayoutTemplateError extends Error {}

function zodPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      out += out.length === 0 ? key : `.${key}`;
    }
  }
  return out || "(root)";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `override` onto `base`. Arrays are replaced wholesale (a
 * profile that overrides `slides.cover.slots` supplies the full slot list
 * for that kind, not a patch of one slot by index) — plain objects merge
 * key by key. This is what lets `zones.footer.height: 140` alone override
 * the default without the profile repeating `logo`/`pagination`.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return merged;
  }
  return override;
}

/**
 * Loads the default template from `system/ig-carousel/layouts/<id>.json`
 * and, if `profiles/<slug>/templates/<id>.json` exists, deep-merges it on
 * top. A brand may also declare a template the engine has no default for
 * at all — `listLayoutTemplates` lists those — in which case the override
 * is loaded standalone, with nothing to merge onto. Only an id backed by
 * neither file is an error, so listing and loading agree on exactly which
 * ids exist. When `params` is given (a carousel document's `template.params`,
 * layout-template spec's "Per-carousel template parameters"), it is
 * deep-merged again, last, so a single carousel can nudge a parameter (e.g.
 * `zones.footer.height`) without touching the profile's own override or any
 * other carousel using the same template id. The resolved result — default,
 * then profile override, then per-carousel params — is validated as a
 * whole so an invalid override (a typo'd key, a missing geometry field)
 * fails naming that key, regardless of which layer introduced it.
 *
 * `brand` is REQUIRED (not optional): a resolved template can declare a
 * `zones.footer.signature` whose `copyKey`/`fontKey`/`colorRole` only make
 * sense against a brand, and an optional param here would let a caller
 * skip that cross-check by omission — exactly the silent "color: undefined"
 * failure mode the architect review flagged. Callers with no brand to
 * check against (there are none left in this codebase) would need to load
 * one first, the same way every real call site already does.
 */
export function loadLayoutTemplate(
  profileDir: string,
  id: string,
  brand: BrandTokens,
  params?: Record<string, unknown>,
): LayoutTemplate {
  const engineDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = join(engineDir, "layouts", `${id}.json`);
  const overridePath = join(profileDir, "templates", `${id}.json`);

  let defaultRaw: unknown;
  let hasDefault = true;
  try {
    defaultRaw = JSON.parse(readFileSync(defaultPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
    // No engine default for this id. That is not automatically an error:
    // `listLayoutTemplates` deliberately lists ids a brand declares on its
    // own, with no engine counterpart, and a picker that offers them must
    // be able to load them. Refusing here made every brand-only template
    // unloadable — listed, then a raw error on selection. A brand-only
    // template simply has nothing to merge onto, so it stands alone; it
    // still parses against the full schema and is still cross-validated
    // against the brand below, so "standalone" buys it no leniency.
    if (!existsSync(overridePath)) {
      throw new LayoutTemplateError(
        `No layout template found for id "${id}": no engine default at ${defaultPath} and no profile override at ${overridePath}`,
      );
    }
    hasDefault = false;
    defaultRaw = undefined;
  }

  let resolved = defaultRaw;
  if (existsSync(overridePath)) {
    let overrideRaw: unknown;
    try {
      overrideRaw = JSON.parse(readFileSync(overridePath, "utf-8"));
    } catch (error) {
      throw new LayoutTemplateError(`Invalid JSON in template override at ${overridePath}: ${(error as Error).message}`);
    }
    resolved = hasDefault ? deepMerge(defaultRaw, overrideRaw) : overrideRaw;
  }

  if (params && Object.keys(params).length > 0) {
    resolved = deepMerge(resolved, params);
  }

  const result = layoutTemplateSchema.safeParse(resolved);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new LayoutTemplateError(
      `Invalid layout template "${id}" (resolved from ${hasDefault ? defaultPath : overridePath}${
        hasDefault && existsSync(overridePath) ? ` + ${overridePath}` : ""
      }${params && Object.keys(params).length > 0 ? " + carousel template.params" : ""}): ${zodPath(
        issue.path,
      )} — ${issue.message}`,
    );
  }

  validateTemplateAgainstBrand(result.data, brand);

  return result.data;
}

/**
 * Cross-checks the resolved template against the loaded brand: every
 * `zones.footer.signature` key (`copyKey` into `brand.copy`, `fontKey` into
 * `brand.fonts`, `colorRole` into `brand.roles`) must resolve. A template's
 * own schema (`layoutTemplateSchema` above) only knows the key is a
 * non-empty, non-hex string — it has no `brand` to check it against, so
 * this runs as a second pass once both are in hand, right where
 * `loadLayoutTemplate` already resolves the template. Always runs, because
 * `brand` is now a required parameter of `loadLayoutTemplate` (architect
 * review: an optional brand let this check be silently skipped).
 */
function validateTemplateAgainstBrand(template: LayoutTemplate, brand: BrandTokens): void {
  const signature = template.zones.footer.signature;
  if (!signature) return;

  const copy = brand.copy as Record<string, unknown>;
  if (typeof copy[signature.copyKey] !== "string") {
    throw new LayoutTemplateError(
      `Layout template "${template.id}" declares zones.footer.signature.copyKey "${signature.copyKey}", ` +
        `which the brand does not define as a string: zones.footer.signature.copyKey → brand.copy.${signature.copyKey}`,
    );
  }
  if (!(signature.fontKey in brand.fonts)) {
    throw new LayoutTemplateError(
      `Layout template "${template.id}" declares zones.footer.signature.fontKey "${signature.fontKey}", ` +
        `which the brand does not define: zones.footer.signature.fontKey → brand.fonts.${signature.fontKey}`,
    );
  }
  if (!(signature.colorRole in brand.roles)) {
    throw new LayoutTemplateError(
      `Layout template "${template.id}" declares zones.footer.signature.colorRole "${signature.colorRole}", ` +
        `which the brand does not define: zones.footer.signature.colorRole → brand.roles.${signature.colorRole}`,
    );
  }
}

export type LayoutTemplateOrigin = "engine-default" | "brand-override";

/** One entry in `listLayoutTemplates`'s result — enough for a picker to show and distinguish templates without loading each one's full geometry. */
export interface LayoutTemplateSummary {
  id: string;
  /** Human-readable name. Templates carry no `name` field of their own (per design.md D5, no brand copy under `system/`), so this is always derived from `id` (e.g. "explicativo" -> "Explicativo"). */
  displayName: string;
  origin: LayoutTemplateOrigin;
}

function idsFromJsonDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => basename(name, ".json"));
}

/**
 * Lists every template available to a profile: the engine's own defaults
 * (`system/ig-carousel/layouts/*.json`) merged with that profile's overrides
 * (`profiles/<slug>/templates/*.json`). An override sharing an id with a
 * default REPLACES it in the result — same id, `origin: "brand-override"` —
 * rather than appearing twice, mirroring how `loadLayoutTemplate` treats an
 * override as replacing (by deep merge) the default it names, not adding a
 * second template.
 *
 * A brand-only id (a template the engine ships no default for) is listed
 * too, with `origin: "brand-override"` — nothing here requires an engine
 * default to exist first. Returns `[]`, never throws, when a profile has
 * neither defaults (impossible in practice) nor overrides, so a caller can
 * always render "no templates" rather than handle an exception.
 */
export function listLayoutTemplates(profileDir: string): LayoutTemplateSummary[] {
  const engineDir = dirname(fileURLToPath(import.meta.url));
  const defaultIds = idsFromJsonDir(join(engineDir, "layouts"));
  const overrideIds = idsFromJsonDir(join(profileDir, "templates"));

  const byId = new Map<string, LayoutTemplateSummary>();
  for (const id of defaultIds) {
    byId.set(id, { id, displayName: humanizeId(id), origin: "engine-default" });
  }
  for (const id of overrideIds) {
    // Present in both -> the override replaces the default entry (same id,
    // origin flips to brand-override), matching loadLayoutTemplate's merge
    // rule instead of listing the same id twice.
    byId.set(id, { id, displayName: humanizeId(id), origin: "brand-override" });
  }

  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sentinel id for "no template" — defined in `object-reset.ts`, which has
 * no value imports, so `editor/web` can name the free choice in a picker
 * without pulling this module's `node:fs` into its bundle. Re-exported here
 * because this is where callers expect template identity to live.
 */
export { FREE_TEMPLATE_ID, humanizeId };

/**
 * The template used for a document with no template reference (carousel-
 * document spec's "Template reference on the document"): every zone is
 * inert (zero-height footer, no logo, no pagination, zero margins) and no
 * slide kind declares any slot, so `resolveSlide` never has a slot to look
 * up and every object in the document is necessarily a free object. Not
 * read from disk and never registered anywhere `loadLayoutTemplate` or
 * `listLayoutTemplates` search, which is what keeps it out of any listing
 * by construction rather than by filtering.
 */
export function freeLayoutTemplate(): LayoutTemplate {
  return {
    id: FREE_TEMPLATE_ID,
    canvas: { w: 1080, h: 1350 },
    zones: {
      background: { policy: "fill" },
      footer: { height: 0, logo: "none", pagination: "none" },
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    slides: {
      cover: { slots: [] },
      step: { slots: [] },
      closing: { slots: [] },
    },
  };
}
