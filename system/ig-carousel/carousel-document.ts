import { z } from "zod";

import type { BrandTokens } from "./brand-schema.js";

/**
 * The persisted, editable unit of a carousel: `profiles/<slug>/carousels/<id>/carousel.json`.
 *
 * This is deliberately a *document* schema, not a render-time schema: it
 * carries editing state (`pinned`, `locked`, `source`, optional `slot` /
 * `geometry` overrides) that `VerifiedSlide` (system/ig-carousel/types.ts)
 * has no notion of and never will — the two stay unrelated on purpose (see
 * design.md D10). Turning a `CarouselDocument` into pixels is a separate
 * concern (`render-batch.ts`'s `CarouselDocument` overload), reached only
 * after `resolveSlide` (carousel-document-resolve.ts) has merged each
 * object against its template slot.
 *
 * No hex color ever appears here: every color is a *key* into
 * `brand.colors`, resolved to a literal value only at render time via
 * `color()` / `brand.colors[key]`. This is what lets a carousel outlive a
 * palette edit (design.md D5) and is enforced twice — structurally (colors
 * are typed as `colorKey: string`, never `color: string`) and defensively
 * (`rejectHexLiterals` walks the whole document so a hex string pasted into
 * any string field, not just a color field, is refused).
 */

const SLUG = /^[a-z0-9-]+$/;

/** Matches a `#rgb`/`#rrggbb`/`#rrggbbaa` literal anywhere inside a string. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

const geometrySchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int().optional(),
  rotation: z.number(),
});
export type Geometry = z.infer<typeof geometrySchema>;

const pieceSourceSchema = z.enum(["ai", "library", "manual"]);
export type PieceSource = z.infer<typeof pieceSourceSchema>;

const backgroundSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("color"),
    colorKey: z.string().min(1),
    pinned: z.boolean(),
    source: pieceSourceSchema,
    // Set only while `mode: "color"` is standing in for a background whose
    // AI generation hasn't run yet (the immediate-build compose flow:
    // editor-ui spec's "Composition from the prompt" placeholder phase).
    // The role surface color is the real, renderable value in the
    // meantime, so a document with `pending: true` is always valid and
    // paintable — this flag exists purely so the UI can show a shimmer
    // instead of the color as final. Cleared to `false` (never removed)
    // once the compose job either fills in the real asset or gives up.
    pending: z.boolean().optional(),
    // Owner decision: image generation never happens automatically. When
    // the compose job reaches a background slot with no library
    // candidate, it stops here rather than calling the AI provider:
    // `pending` clears to `false` (the placeholder is final, not "still
    // working") and `awaitingImage: true` marks that this background
    // still needs an explicit, user-approved generate call.
    // `suggestion` carries the planner's own idea of what to generate,
    // shown pre-filled in the editable prompt field the UI opens for it
    // (piece-generation spec, "Library first, generate later").
    awaitingImage: z.boolean().optional(),
    suggestion: z.string().optional(),
  }),
  z.object({
    mode: z.literal("asset"),
    assetId: z.string().min(1),
    pinned: z.boolean(),
    source: pieceSourceSchema,
    pending: z.boolean().optional(),
    awaitingImage: z.boolean().optional(),
    suggestion: z.string().optional(),
  }),
]);
export type SlideBackground = z.infer<typeof backgroundSchema>;

const baseObjectFields = {
  id: z.string().min(1),
  /** References a template slot by name; absent for a free (unslotted) object. */
  slot: z.string().min(1).optional(),
  geometry: geometrySchema.optional(),
  pinned: z.boolean(),
  locked: z.boolean(),
  source: pieceSourceSchema,
  // Placeholder marker used only by the immediate-build compose flow
  // (editor-ui spec's "Composition from the prompt"): a `pending: true`
  // text object carries `text: ""` and a `pending: true` asset object
  // carries no `assetId` yet (see `assetObjectSchema` below), both standing
  // in for a piece the background compose job hasn't generated/drafted
  // yet. The UI renders these with a shimmer; the job flips this to
  // `false` (never removes it) on every object it touches, whether it
  // succeeded or gave up, so nothing is left showing a spinner forever.
  pending: z.boolean().optional(),
  // Only meaningful on an `asset`-kind object (see the background schema's
  // matching fields above for the full reasoning): owner decision that
  // image generation never happens automatically. Set when this slot has
  // no library candidate and needs an explicit, user-approved generate
  // call; `suggestion` is the planner's prompt idea for it.
  awaitingImage: z.boolean().optional(),
  suggestion: z.string().optional(),
};

const textObjectSchema = z.object({
  ...baseObjectFields,
  kind: z.literal("text"),
  text: z.string(),
  // Style fields are optional here: a slotted object with no style of its
  // own inherits fontKey/fontSize/lineHeight/align/colorRole from the
  // template slot at resolve time (design.md D4, carousel-document-resolve
  // `resolveSlide`). `colorKey` stays separate from `colorRole` — a
  // document object can pin its own brand.colors key, while the slot only
  // ever names a brand.roles role. A free object (no `slot`) that omits a
  // style field simply resolves with that field left unset; callers that
  // require full styling for unslotted objects enforce it themselves.
  fontKey: z.string().min(1).optional(),
  fontSize: z.number().int().positive().optional(),
  lineHeight: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  colorKey: z.string().min(1).optional(),
});
export type TextObject = z.infer<typeof textObjectSchema>;

const assetObjectSchema = z.object({
  ...baseObjectFields,
  kind: z.literal("asset"),
  // Optional, not a sentinel string: an asset object created as a
  // placeholder for an image the compose job hasn't generated yet has no
  // `assetId` at all (rather than e.g. `assetId: ""` or a fake id that
  // `assetExists` would have to special-case). This is the less invasive
  // choice against the existing zod schema and every caller that already
  // does `object.assetId` on an `asset`-kind object elsewhere in this
  // codebase. An asset object with no `assetId` stays valid whether or not
  // it's still `pending`: the "skipped" compose-job path (no AI key
  // configured) deliberately clears `pending` back to `false` on a slot it
  // never filled, so the document is not stuck showing a spinner forever —
  // it just renders as an empty box (free-layout.ts's `renderAssetObject`).
  // `validateDocument` only ever checks `assetExists` when an `assetId` IS
  // present, never requires one.
  assetId: z.string().min(1).optional(),
  fit: z.enum(["cover", "contain"]),
});
export type AssetObject = z.infer<typeof assetObjectSchema>;

const slideObjectSchema = z.discriminatedUnion("kind", [textObjectSchema, assetObjectSchema]);
export type SlideObject = z.infer<typeof slideObjectSchema>;

const slideKindSchema = z.enum(["cover", "step", "closing"]);
export type SlideKind = z.infer<typeof slideKindSchema>;

const slideSchema = z.object({
  id: z.string().min(1),
  kind: slideKindSchema,
  background: backgroundSchema,
  /** Stacking order: later entries paint on top of earlier ones. */
  objects: z.array(slideObjectSchema),
});
export type Slide = z.infer<typeof slideSchema>;

const promptRunSchema = z.object({
  at: z.string(),
  text: z.string(),
});

const promptSchema = z.object({
  text: z.string(),
  createdAt: z.string(),
  /** History of "redo the prompt" runs, most recent last. Optional: a brand-new document has none yet. */
  runs: z.array(promptRunSchema).optional(),
});
export type Prompt = z.infer<typeof promptSchema>;

const templateRefSchema = z.object({
  id: z.string().min(1),
  /** Per-carousel overrides of template-declared params (e.g. footer height). Never per-slide — see layout-template spec. */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type TemplateRef = z.infer<typeof templateRefSchema>;

export const carouselDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(SLUG, "must be a slug: lowercase letters, digits and hyphens only"),
  title: z.string(),
  status: z.enum(["draft", "exported", "published"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  canvas: z.object({
    w: z.literal(1080),
    h: z.literal(1350),
  }),
  prompt: promptSchema,
  /**
   * Optional: a document with no key has no template — a valid, deliberate
   * choice, not an error state (see layout-template spec, "Template
   * reference on the document"). `null` is not accepted; absence is the
   * only way to say "no template".
   */
  template: templateRefSchema.optional(),
  slides: z.array(slideSchema),
});

/** The validated document shape. Always produce this via `validateDocument`, never `as CarouselDocument`. */
export type CarouselDocument = z.infer<typeof carouselDocumentSchema>;

export interface ValidateDocumentOptions {
  brand: BrandTokens;
  /** Injected rather than imported so this module does not depend on the asset-index API. */
  assetExists: (assetId: string) => boolean;
}

export interface DocumentFieldError {
  /** Dot/bracket path into the document, e.g. `slides[2].objects[1].colorKey`. */
  path: string;
  message: string;
}

export type ValidateDocumentResult =
  | { valid: true; document: CarouselDocument }
  | { valid: false; errors: DocumentFieldError[] };

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
  return out;
}

/**
 * Walks the parsed document for `#`-prefixed hex literals in any string
 * field. Catches an import or a hand-edit that slips a hex value into a
 * field the schema does not specifically type as a color (e.g. `text`,
 * `title`), which is the failure mode design.md D5 calls out.
 */
function findHexLiterals(value: unknown, path: (string | number)[], errors: DocumentFieldError[]): void {
  if (typeof value === "string") {
    if (HEX_LITERAL.test(value)) {
      errors.push({
        path: zodPath(path),
        message: `must not contain a hex color literal; use a brand.colors key instead (got: ${value})`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findHexLiterals(item, [...path, index], errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      findHexLiterals(item, [...path, key], errors);
    }
  }
}

/**
 * Validates a raw document against the schema, then against the brand
 * (`colorKey` must resolve in `brand.colors`, `fontKey` in `brand.fonts`)
 * and the injected asset resolver (`assetId` must exist). Every failure
 * names the field path so a caller (UI, API, test) can point at the exact
 * offending value.
 */
export function validateDocument(
  doc: unknown,
  { brand, assetExists }: ValidateDocumentOptions,
): ValidateDocumentResult {
  const result = carouselDocumentSchema.safeParse(doc);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      path: zodPath(issue.path),
      message: issue.message,
    }));
    return { valid: false, errors };
  }

  const document = result.data;
  const errors: DocumentFieldError[] = [];

  findHexLiterals(document, [], errors);

  const fontKeys = new Set(Object.keys(brand.fonts));

  document.slides.forEach((slide, slideIndex) => {
    if (slide.background.mode === "color" && !(slide.background.colorKey in brand.colors)) {
      errors.push({
        path: `slides[${slideIndex}].background.colorKey`,
        message: `unknown color key "${slide.background.colorKey}"`,
      });
    }
    if (slide.background.mode === "asset" && !assetExists(slide.background.assetId)) {
      errors.push({
        path: `slides[${slideIndex}].background.assetId`,
        message: `unknown asset id "${slide.background.assetId}"`,
      });
    }

    slide.objects.forEach((object, objectIndex) => {
      const base = `slides[${slideIndex}].objects[${objectIndex}]`;
      if (object.kind === "text") {
        // Style fields are optional (slot-inherited, see D4); only
        // validate against the brand when the document itself states one.
        if (object.colorKey !== undefined && !(object.colorKey in brand.colors)) {
          errors.push({ path: `${base}.colorKey`, message: `unknown color key "${object.colorKey}"` });
        }
        if (object.fontKey !== undefined && !fontKeys.has(object.fontKey)) {
          errors.push({ path: `${base}.fontKey`, message: `unknown font key "${object.fontKey}"` });
        }
      } else if (object.assetId !== undefined) {
        // Whenever an assetId IS present it's still checked like any other
        // asset reference, pending or not.
        if (!assetExists(object.assetId)) {
          errors.push({ path: `${base}.assetId`, message: `unknown asset id "${object.assetId}"` });
        }
      }
      // No `else` branch requiring `assetId` when it's absent: an asset
      // object with no image is always valid, not just while `pending`.
      // The immediate-build compose flow (carousel-document.ts's
      // `assetObjectSchema` comment) creates these as `pending: true`, but a
      // compose job that ends up with no library candidate AND no AI key
      // (the "skipped" path, compose-job.ts) deliberately leaves the same
      // object with `pending: false` and still no `assetId` — piece-
      // generation's "with no key, generation is disabled" behavior means
      // that slot simply renders as an empty box (free-layout.ts's
      // `renderAssetObject`) rather than the document becoming invalid.
    });
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, document };
}
