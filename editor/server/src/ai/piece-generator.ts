/**
 * The provider-agnostic interface every AI generation call in the editor
 * goes through (design.md D15, specs/piece-generation "Provider behind an
 * interface"). No provider literal (model name, endpoint, request shape)
 * may appear outside an implementation of this interface — `openai.ts` is
 * the only file allowed to know it's OpenAI; `none.ts` is the no-key
 * fallback that keeps the rest of the editor working.
 */

export interface DraftCopyPlanSlide {
  slideId: string;
  kind: "cover" | "step" | "closing";
  /** What this slide's text should communicate — derived from the carousel prompt and slide position, not free text from the user. */
  brief: string;
  /** Character budget the slot allows, per field. The provider must never truncate mid-word to fit this (see the piece-generation spec's "does not mutilate words"). */
  limits: { headline: number; body?: number };
}

/**
 * Brand-voice context injected into every `draftCopy` call (piece-generation
 * spec's "Brand style context in every generation"), sourced from
 * `system/ig-carousel/brand-style.ts`'s `loadBrandStyle`. Every field is
 * optional — a profile with no style files still drafts copy, just without
 * this steering.
 */
export interface DraftCopyBrandContext {
  toneStyle: string[];
  toneAvoid: string[];
  positioning?: string;
  /** e.g. "es" — the copy must be written in this language. */
  language?: string;
}

export interface DraftCopyPlan {
  carouselPrompt: string;
  slides: DraftCopyPlanSlide[];
  brand?: DraftCopyBrandContext;
}

export interface DraftedSlideCopy {
  slideId: string;
  headline: string;
  body?: string;
}

export interface DraftCopyResult {
  slides: DraftedSlideCopy[];
  /** Recorded verbatim into the document's `prompt.runs[]` / cost ledger. */
  model: string;
  costCents: number;
}

/**
 * Brand-voice context injected into every `generateImage` call (same spec
 * requirement as `DraftCopyBrandContext`). `paletteWords` and
 * `styleKeywords` are already brand-agnostic prose by the time they reach
 * here — `paletteWords` never carries a hex value, only words derived from
 * one (`core/color.js`'s `describePaletteInWords`).
 */
export interface GenerateImageBrandContext {
  imageDirection?: string;
  styleKeywords: string[];
  /** e.g. "a warm palette of amber and cream" — never a raw hex. */
  paletteWords?: string;
  logoRules?: string;
}

export interface GenerateImageSpec {
  /** Plain description of the desired background/figure/decoration. MUST NOT ask for text — the caller (planner) is responsible for stripping any headline/body wording out of this before it reaches here. */
  prompt: string;
  kind: "background" | "character" | "photo" | "decoration";
  /** Target canvas the image will be placed into, for aspect-ratio guidance only — the provider is not asked to crop precisely. */
  canvas: { w: number; h: number };
  brand?: GenerateImageBrandContext;
}

export interface GeneratedImage {
  buffer: Buffer;
  mime: string;
  model: string;
  costCents: number;
}

/**
 * Two operations, matching what the piece-generation spec needs and nothing
 * more: drafting basic editable copy, and generating a text-free image.
 * Both are async and may throw — callers (the planner, the regenerate
 * route) are responsible for turning a thrown error into a user-facing
 * message; this interface itself carries no retry or fallback policy.
 */
export interface PieceGenerator {
  draftCopy(plan: DraftCopyPlan): Promise<DraftCopyResult>;
  generateImage(spec: GenerateImageSpec): Promise<GeneratedImage>;
}

/** Thrown by `NonePieceGenerator` and caught by routes to answer 503. */
export class GenerationUnavailableError extends Error {}
