/**
 * Approximate per-call cost, in US cents, for every model this editor calls.
 * Kept in exactly one place so a price change (or a model swap) never
 * requires touching more than this file. These are list-price
 * approximations as of when this editor was built, not a live price feed —
 * OpenAI's actual per-token/per-image billing can differ slightly (batching,
 * cached input tokens, regional pricing). Good enough for the status bar's
 * running total; not a substitute for the provider's own invoice.
 */

/** Cheap chat model used for `draftCopy`. Price per 1K tokens, input+output blended estimate. */
export const TEXT_MODEL = "gpt-4o-mini";
const TEXT_CENTS_PER_1K_TOKENS_BLENDED = 0.03;

/** Low-quality image model used for `generateImage`. Flat estimate per image at "low" quality, 1024x1024-class output. */
export const IMAGE_MODEL = "gpt-image-1-mini";
const IMAGE_CENTS_PER_CALL_LOW_QUALITY = 1;

/** Rough token estimate from character count (~4 chars/token in English/Spanish prose) — no tokenizer dependency for a status-bar estimate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateTextCostCents(promptText: string, responseText: string): number {
  const tokens = estimateTokens(promptText) + estimateTokens(responseText);
  return Math.max(1, Math.round((tokens / 1000) * TEXT_CENTS_PER_1K_TOKENS_BLENDED * 100) / 100);
}

export function estimateImageCostCents(): number {
  return IMAGE_CENTS_PER_CALL_LOW_QUALITY;
}
