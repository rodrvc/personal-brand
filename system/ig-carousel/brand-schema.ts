import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Brand data the engine consumes. This file defines the *shape*; the values
 * live in `profiles/<slug>/brand.json`. Nothing here names a specific brand —
 * adding a second profile must never require editing the engine.
 */

export interface CategoryStyle {
  solid: string;
  /** Optional flourish some categories layer on instead of a flat fill. */
  gradient?: string;
}

/**
 * Semantic color roles. Templates ask for a *role* ("the accent color") rather
 * than a palette name ("terracotta"), so a profile whose palette uses entirely
 * different color names still renders correctly without engine changes.
 */
export interface BrandRoles {
  accent: string;
  wordmark: string;
  surface: string;
  onSurface: string;
  onSurfaceMuted: string;
  flourish: string;
  /** Secondary accent for eyebrow/meta text over a dark surface. */
  highlight: string;
}

const ROLE_KEYS: (keyof BrandRoles)[] = [
  "accent",
  "wordmark",
  "surface",
  "onSurface",
  "onSurfaceMuted",
  "flourish",
  "highlight",
];

/**
 * Copy blocks are keyed by template name and every one of them is optional at
 * the type level. A profile declares only the blocks for the templates it
 * actually renders; `loadBrand` then *proves* the declared ones are present
 * for the specific templates a script asks for (see `BrandFeature`).
 *
 * This is what keeps a sixth template from being a breaking change: adding
 * `copy.myNewTemplate` requires no edit to any existing profile's brand.json,
 * because nothing validates a block the caller never requested.
 */
export interface ListFormatCopy {
  headerTitle: string;
  headerLabelFallback: string;
  headerSubtitle: string;
  footerLocation: string;
  footerCta: string;
  timeSuffix: string;
  categoryFallbackLabel: string;
}

export interface BrandMessageCopy {
  footerCta: string;
}

/**
 * Copy for the reel's cover and closing cards.
 *
 * `coverTitle` and `coverSubtitle` are two spans, not one string with the city
 * spliced in, because they carry different type: the title is set in the logo
 * face and the subtitle in the body face. `coverSubtitle` and `coverCount`
 * interpolate `{city}` and `{count}` — the city comes from the reel input
 * (content geography), never from a brand token.
 */
export interface ReelCopy {
  coverTitle: string;
  coverSubtitle: string;
  coverCount: string;
  closingCta: string;
}

export interface BrandTokens {
  locale: string;
  colors: Record<string, string>;
  roles: BrandRoles;
  fonts: { logo: string; body: string; handwritten: string };
  /** Omit for profiles using system fonts — no font stylesheet is emitted. */
  googleFontsHref?: string;
  radius: { card: string };
  gradients?: Record<string, string>;
  /** Only needed by templates that color-code content by category. */
  categories?: {
    fallback: CategoryStyle;
    byName: Record<string, CategoryStyle>;
  };
  copy: {
    wordmark: string;
    site: string;
    /** Only needed by templates whose copy interpolates `{region}`. */
    region?: string;
    listFormat?: ListFormatCopy;
    brandMessage?: BrandMessageCopy;
    /** Only needed by the reel engine (cover + closing cards). */
    reel?: ReelCopy;
  };
  /** Only needed by scripts that render a date range (e.g. render-week). */
  dates?: {
    /** Exactly 12 entries, January first. */
    monthAbbr: string[];
    weekRangeSameMonth: string;
    weekRangeCrossMonth: string;
  };
}

/**
 * A capability a script needs from a profile's brand data, beyond the core
 * every profile must have (colors, roles, fonts, radius, copy.wordmark,
 * copy.site).
 *
 * Callers pass the features the templates they invoke actually consume, so a
 * profile is only ever asked for data that will be read. A personal-brand
 * profile rendering only `brand-message` declares no category taxonomy, no
 * month names and no list copy — and loads fine.
 */
export type BrandFeature = "categories" | "dates" | "listFormat" | "brandMessage" | "reel";

/**
 * A renderer that states which brand data it reads.
 *
 * Templates carry their own `features` so the requirement lives next to the
 * code that consumes the data, and callers pass the *template* to `loadBrand`
 * rather than retyping a feature list. Without this the mapping survived only
 * as a hand-maintained argument at each call site: a script that rendered
 * list-format but forgot to declare "listFormat" still worked when tested
 * against a data-rich profile, and only failed later, at render time, on a
 * leaner one. The declaration is now impossible to forget, because it isn't
 * written at the call site at all.
 *
 * Required, not optional: a template that reads `categories` or a copy block
 * but forgets to declare it would otherwise contribute nothing to the derived
 * set and still render fine against a data-rich profile — the same
 * silently-passing failure this mechanism exists to remove, relocated from the
 * call site to the template. Templates that read only core data declare `[]`,
 * which says "I checked" rather than "nobody wrote this down".
 */
export interface DeclaresBrandFeatures {
  features: readonly BrandFeature[];
}

/**
 * Collects the features required by every renderer passed in, plus any extra
 * a *script* needs beyond its templates (e.g. render-week reads `dates` to
 * build the header label itself — no template asks for it).
 */
export function featuresOf(
  renderers: readonly DeclaresBrandFeatures[],
  ...extra: readonly BrandFeature[]
): BrandFeature[] {
  const all = new Set<BrandFeature>(extra);
  for (const renderer of renderers) {
    for (const feature of renderer.features) {
      all.add(feature);
    }
  }
  return [...all];
}

/**
 * The per-template copy blocks, derived from `BrandTokens["copy"]` rather than
 * spelled out again — the optional object-valued keys are exactly those blocks.
 * Adding a template's block to the interface extends this automatically, so
 * there is no second list to keep in sync.
 */
export type TemplateCopyKey = {
  [K in keyof BrandTokens["copy"]]-?: NonNullable<BrandTokens["copy"][K]> extends object
    ? K
    : never;
}[keyof BrandTokens["copy"]];

/** Resolves a semantic role to its literal color value. */
export function color(brand: BrandTokens, role: keyof BrandRoles): string {
  return brand.colors[brand.roles[role]]!;
}

/**
 * Looks up a category's style, falling back for unknown or missing categories.
 * `byName` is a plain Record, so the category taxonomy is runtime data — a
 * profile can use any category names it likes without the engine knowing them.
 *
 * Throws if the profile declares no `categories` at all. A template that calls
 * this must list "categories" among the features it loads, which turns that
 * throw into an unreachable branch — it exists so a future caller that forgets
 * fails loudly here rather than emitting `undefined` into a PNG's CSS.
 */
export function categoryStyle(brand: BrandTokens, category?: string): CategoryStyle {
  const categories = brand.categories;
  if (!categories) {
    throw new Error(
      "This template color-codes by category, but brand.json declares no `categories`. " +
        'Add a categories block, or load the brand with the "categories" feature to get a clearer error.',
    );
  }
  return (category ? categories.byName[category] : undefined) ?? categories.fallback;
}

/**
 * Returns a copy block a template depends on, naming the missing key if the
 * profile never declared it. Templates read their copy through this rather
 * than `brand.copy.x!` so a profile that skipped an optional block gets a
 * sentence explaining what to add, not a `TypeError` on `undefined`.
 */
export function templateCopy<K extends TemplateCopyKey>(
  brand: BrandTokens,
  key: K,
): NonNullable<BrandTokens["copy"][K]> {
  const block = brand.copy[key];
  if (!block) {
    throw new Error(
      `This template needs copy.${key} in brand.json, which this profile does not define.`,
    );
  }
  return block as NonNullable<BrandTokens["copy"][K]>;
}

/** Replaces `{placeholder}` tokens. Deliberately not a template engine. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Converts `#rrggbb` to `rgba(r, g, b, alpha)` so templates can derive
 * translucent overlays from a brand color instead of hardcoding a second,
 * hand-converted copy of the same hex.
 */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`withAlpha expects #rrggbb, got: ${hex}`);
  }
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fail(profileDir: string, problem: string): never {
  throw new Error(`Invalid brand.json in ${profileDir}: ${problem}`);
}

function requireString(value: unknown, path: string, profileDir: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(profileDir, `${path} must be a non-empty string`);
  }
  return value;
}

/**
 * Like `requireString` but accepts "" — for copy that is legitimately empty in
 * some locales (e.g. `timeSuffix`: Spanish renders "20:00 HRS", English just
 * "20:00"). Still rejects a missing key or a non-string.
 */
function requirePresentString(value: unknown, path: string, profileDir: string): string {
  if (typeof value !== "string") {
    fail(profileDir, `${path} must be a string`);
  }
  return value;
}

function requireCategoryStyle(value: unknown, path: string, profileDir: string): CategoryStyle {
  const style = value as CategoryStyle | undefined;
  if (!style || typeof style !== "object") {
    fail(profileDir, `${path} must be an object`);
  }
  requireString(style.solid, `${path}.solid`, profileDir);
  return style;
}

/** Validates the `categories` block. Only called when a caller asks for it. */
function validateCategories(brand: BrandTokens, profileDir: string): void {
  requireCategoryStyle(brand.categories?.fallback, "categories.fallback", profileDir);
  const byName = brand.categories!.byName;
  if (!byName || typeof byName !== "object") {
    fail(profileDir, "categories.byName must be an object");
  }
  for (const [name, style] of Object.entries(byName)) {
    requireCategoryStyle(style, `categories.byName["${name}"]`, profileDir);
  }
}

/** Validates the `dates` block. Only called when a caller asks for it. */
function validateDates(brand: BrandTokens, profileDir: string): void {
  if (!Array.isArray(brand.dates?.monthAbbr) || brand.dates.monthAbbr.length !== 12) {
    fail(profileDir, "dates.monthAbbr must be an array of exactly 12 month abbreviations");
  }
  requireString(brand.dates.weekRangeSameMonth, "dates.weekRangeSameMonth", profileDir);
  requireString(brand.dates.weekRangeCrossMonth, "dates.weekRangeCrossMonth", profileDir);
}

/** Validates `copy.listFormat`. Only called when a caller asks for it. */
function validateListFormatCopy(brand: BrandTokens, profileDir: string): void {
  const list = brand.copy?.listFormat;
  if (!list) {
    fail(profileDir, "copy.listFormat is missing");
  }
  for (const key of [
    "headerTitle",
    "headerLabelFallback",
    "headerSubtitle",
    "footerLocation",
    "footerCta",
    "categoryFallbackLabel",
  ] as const) {
    requireString(list[key], `copy.listFormat.${key}`, profileDir);
  }
  requirePresentString(list.timeSuffix, "copy.listFormat.timeSuffix", profileDir);
  // `copy.region` is deliberately NOT required: region is geography of the
  // content, so it travels in the carousel input beside `city`. The token
  // remains readable as a fallback for profiles that still declare one.
}

/** Validates `copy.brandMessage`. Only called when a caller asks for it. */
function validateBrandMessageCopy(brand: BrandTokens, profileDir: string): void {
  requireString(brand.copy?.brandMessage?.footerCta, "copy.brandMessage.footerCta", profileDir);
}

/**
 * Validates what the reel engine reads: its copy block and the `cover`
 * gradient its opening and closing cards are painted with.
 *
 * The gradient is required rather than defaulted to a flat role color. The
 * cover and closing are the two full-bleed cards in the piece, and a profile
 * that never declared one would get a silently duller video than the engine
 * can produce — the kind of degradation this repo's load-time validation
 * exists to refuse. Naming the key is cheap; discovering the flat card after
 * publishing is not.
 */
function validateReel(brand: BrandTokens, profileDir: string): void {
  const reel = brand.copy?.reel;
  if (!reel) {
    fail(profileDir, "copy.reel is missing");
  }
  for (const key of ["coverTitle", "coverSubtitle", "coverCount", "closingCta"] as const) {
    requireString(reel[key], `copy.reel.${key}`, profileDir);
  }
  requireString(brand.gradients?.cover, "gradients.cover", profileDir);
}

/**
 * Rejects `sourceImageHosts` (and near-misses like the singular form) if it is
 * still sitting in a brand.json.
 *
 * The key used to live here and now belongs to the carousel input, beside the
 * `image` URLs it constrains — it asserts *where the data came from*, which is
 * the recipe's `source` concern, not a presentation token like a color or a
 * font. Moving it silently would be the worst outcome: a brand.json left with
 * the old key still *reads* as if the host check were on, while nothing reads
 * it and every invented image URL renders. So the stale location is an error
 * that names the new one, rather than an ignored key.
 */
function rejectMovedSourceImageHosts(brand: BrandTokens, profileDir: string): void {
  const stale = Object.keys(brand).find(
    (key) => key.toLowerCase().replace(/s$/, "") === "sourceimagehost",
  );
  if (stale) {
    fail(
      profileDir,
      `"${stale}" no longer belongs in brand.json — it is a claim about the data's ` +
        `origin, not a brand token. Declare the hosts in the profile's recipe ` +
        `(source.image_hosts) and let them travel to the engine as "sourceImageHosts" ` +
        `at the top of the carousel input JSON, next to "city". Left here it would read ` +
        `as if the image-host check were running when nothing reads it.`,
    );
  }
}

const FEATURE_VALIDATORS: Record<
  BrandFeature,
  (brand: BrandTokens, profileDir: string) => void
> = {
  categories: validateCategories,
  dates: validateDates,
  listFormat: validateListFormatCopy,
  brandMessage: validateBrandMessageCopy,
  reel: validateReel,
};

/**
 * Reads and validates `<profileDir>/brand.json`.
 *
 * Validation is deliberate rather than a bare `as BrandTokens` cast: a missing
 * key would otherwise surface as the string "undefined" baked into the CSS of
 * a rendered PNG, which is both easy to miss and expensive to discover after
 * publishing. Failing here names the profile and the exact missing key.
 *
 * `features` scopes that validation to what the calling script will actually
 * read. The core below (colors, roles, fonts, radius, copy.wordmark,
 * copy.site) is what *every* template consumes, so it is always required;
 * everything else is opt-in. Without this, a profile that only ever renders
 * one simple template still had to declare an event-category taxonomy, twelve
 * month names and a full set of list-format copy just to load — data the
 * render would never read. The engine's data demands now follow from the
 * template being invoked, not from the union of every template that exists.
 */
export function loadBrand(profileDir: string, features: BrandFeature[] = []): BrandTokens {
  const path = join(profileDir, "brand.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `No brand.json found at ${path}. Every profile needs one — see system/config/brand.schema.md for the expected shape.`,
      );
    }
    throw error;
  }

  const brand = parsed as BrandTokens;

  if (!brand.colors || typeof brand.colors !== "object") {
    fail(profileDir, "colors must be an object of name -> hex");
  }
  if (!brand.roles || typeof brand.roles !== "object") {
    fail(profileDir, "roles must be an object");
  }
  for (const role of ROLE_KEYS) {
    const colorName = brand.roles[role];
    if (typeof colorName !== "string") {
      fail(profileDir, `roles.${role} is missing`);
    }
    if (!brand.colors[colorName]) {
      fail(profileDir, `roles.${role} points at "${colorName}", which is not defined in colors`);
    }
  }

  requireString(brand.fonts?.body, "fonts.body", profileDir);
  requireString(brand.fonts?.logo, "fonts.logo", profileDir);
  requireString(brand.fonts?.handwritten, "fonts.handwritten", profileDir);
  requireString(brand.radius?.card, "radius.card", profileDir);

  // Wordmark and site are the two pieces of copy every template renders
  // (header lettering and footer link), so they stay part of the core.
  if (!brand.copy || typeof brand.copy !== "object") {
    fail(profileDir, "copy must be an object");
  }
  requireString(brand.copy.wordmark, "copy.wordmark", profileDir);
  requireString(brand.copy.site, "copy.site", profileDir);

  // Always, not feature-gated: a key left behind after the move would read as
  // an active check while nothing consumes it.
  rejectMovedSourceImageHosts(brand, profileDir);

  for (const feature of features) {
    FEATURE_VALIDATORS[feature](brand, profileDir);
  }

  return brand;
}
