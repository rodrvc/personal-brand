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

export const VISION_MODEL = "gpt-4.1";

const CHAT_CENTS_PER_1M: Record<string, { input: number; output: number }> = {
  [TEXT_MODEL]: { input: 15, output: 60 },
  [VISION_MODEL]: { input: 200, output: 800 },
};

export function chatCostCents(model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined, prompt: string, response: string): number {
  const rate = CHAT_CENTS_PER_1M[model];
  if (!usage || !rate) return estimateTextCostCents(prompt, response);
  return Math.round((((usage.prompt_tokens ?? 0) * rate.input + (usage.completion_tokens ?? 0) * rate.output) / 1_000_000) * 100) / 100;
}

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

/**
 * The model, quality and output size of a poster recreated from a reference (reproduce mode). Chosen by a side-by-side
 * comparison on real layouts; `EDITOR_POSTER_IMAGE_MODEL` and `EDITOR_POSTER_IMAGE_QUALITY` override them.
 */
export const POSTER_IMAGE_MODEL = "gpt-image-2";
export const POSTER_IMAGE_QUALITY = "medium";

export function posterImageModel(): string {
  return process.env.EDITOR_POSTER_IMAGE_MODEL?.trim() || POSTER_IMAGE_MODEL;
}

export function posterImageQuality(): string {
  return process.env.EDITOR_POSTER_IMAGE_QUALITY?.trim() || POSTER_IMAGE_QUALITY;
}

/** List prices, US cents per 1M tokens (OpenAI pricing page, September 2026). */
const IMAGE_CENTS_PER_1M: Record<string, { textInput: number; imageInput: number; imageOutput: number }> = {
  "gpt-image-1-mini": { textInput: 200, imageInput: 250, imageOutput: 800 },
  "gpt-image-1": { textInput: 500, imageInput: 1000, imageOutput: 4000 },
  "gpt-image-1.5": { textInput: 500, imageInput: 800, imageOutput: 3200 },
  "gpt-image-2": { textInput: 500, imageInput: 800, imageOutput: 3000 },
  "gpt-image-2.5-flare": { textInput: 500, imageInput: 800, imageOutput: 3000 },
  "gpt-image-2.5-sunburst": { textInput: 500, imageInput: 800, imageOutput: 3000 },
};

type ImageRate = { textInput: number; imageInput: number; imageOutput: number };

/** The highest known price for each kind of token: an unlisted model is never priced below what it may really cost. */
const HIGHEST_IMAGE_RATE: ImageRate = Object.values(IMAGE_CENTS_PER_1M).reduce((max, rate) => ({
  textInput: Math.max(max.textInput, rate.textInput),
  imageInput: Math.max(max.imageInput, rate.imageInput),
  imageOutput: Math.max(max.imageOutput, rate.imageOutput),
}));

function imageRate(model: string): ImageRate {
  const known = Object.keys(IMAGE_CENTS_PER_1M)
    .filter((name) => model === name || model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return IMAGE_CENTS_PER_1M[known]!;
  console.warn(`pricing: no list price for image model "${model}"; estimating at the highest known rate`);
  return HIGHEST_IMAGE_RATE;
}

export function estimateImageCostFromUsage(
  usage?: {
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    output_tokens?: number;
  },
  model: string = IMAGE_MODEL,
): number {
  if (!usage) return IMAGE_CENTS_PER_CALL_LOW_QUALITY;
  const rate = imageRate(model);
  const cents =
    ((usage.input_tokens_details?.text_tokens ?? 0) * rate.textInput +
      (usage.input_tokens_details?.image_tokens ?? 0) * rate.imageInput +
      (usage.output_tokens ?? 0) * rate.imageOutput) /
    1_000_000;
  return Math.round(cents * 100) / 100;
}
