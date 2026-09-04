import {
  GenerationUnavailableError,
  type DraftCopyPlan,
  type DraftCopyResult,
  type GenerateImageSpec,
  type GeneratedImage,
  type PieceGenerator,
} from "./piece-generator.js";

/**
 * The `PieceGenerator` used when `OPENAI_API_KEY` is not configured. Every
 * call throws `GenerationUnavailableError`, naming the missing env var —
 * routes catch this and answer 503 (editor-api spec, "Secrets": "With no
 * key, the generation API responds 503 with a message naming the
 * variable"). Composing from the library and manual editing keep working;
 * only generation is disabled.
 */
export class NonePieceGenerator implements PieceGenerator {
  async draftCopy(_plan: DraftCopyPlan): Promise<DraftCopyResult> {
    throw new GenerationUnavailableError(
      "AI copy drafting is unavailable: OPENAI_API_KEY is not configured.",
    );
  }

  async generateImage(_spec: GenerateImageSpec): Promise<GeneratedImage> {
    throw new GenerationUnavailableError(
      "AI image generation is unavailable: OPENAI_API_KEY is not configured.",
    );
  }
}
