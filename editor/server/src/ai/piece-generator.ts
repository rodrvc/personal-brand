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

export interface DraftCopyPlan {
  carouselPrompt: string;
  slides: DraftCopyPlanSlide[];
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

export interface GenerateImageSpec {
  /** Plain description of the desired background/figure/decoration. MUST NOT ask for text — the caller (planner) is responsible for stripping any headline/body wording out of this before it reaches here. */
  prompt: string;
  kind: "background" | "character" | "photo" | "decoration";
  /** Target canvas the image will be placed into, for aspect-ratio guidance only — the provider is not asked to crop precisely. */
  canvas: { w: number; h: number };
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
