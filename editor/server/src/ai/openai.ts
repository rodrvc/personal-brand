import { padToSize } from "../image-tools.js";
import { chatCostCents, estimateImageCostFromUsage, estimateTextCostCents, IMAGE_MODEL, posterImageModel, posterImageQuality, TEXT_MODEL, VISION_MODEL } from "./pricing.js";
import type {
  DraftCopyPlan,
  DraftCopyResult,
  DraftedSlideCopy,
  GenerateImageSpec,
  AssetFileResolver,
  GeneratedImage,
  JsonCompletionRequest,
  JsonCompletionResult,
  PieceGenerator,
} from "./piece-generator.js";

/**
 * OpenAI implementation of `PieceGenerator`, talking to the REST API
 * directly via `fetch` (no SDK dependency for two endpoints). This is the
 * only file in the editor allowed to know the provider is OpenAI, the model
 * names, or the request/response shapes (design.md D15).
 */

const CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const IMAGES_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";
const EDIT_INPUT_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_EDIT_INPUTS = 16;

/**
 * The system instruction sent with every `draftCopy` call. Two hard rules,
 * both learned the hard way per `app/ESTADO.md`: never truncate a word to
 * fit the character budget (finish the thought shorter instead), and stay
 * strictly inside `limits` — never omit either since a slot that's too long
 * breaks layout in a way this editor cannot silently fix later.
 */
const COPY_SYSTEM_PROMPT = [
  "You write short, punchy carousel slide copy for an Instagram/LinkedIn carousel.",
  "For each slide you receive a brief and a character budget for headline (and, if present, body).",
  "Never truncate a word or cut a sentence mid-way to fit the budget — write a shorter, complete thought instead.",
  "Stay at or under every character limit given.",
  "Respond ONLY with a JSON object: {\"slides\":[{\"slideId\":string,\"headline\":string,\"body\"?:string}]}.",
].join(" ");

/**
 * The instruction appended to every image prompt. The AI never draws text
 * or the logo — both are placed by the template afterward (piece-generation
 * spec, "The AI does not draw text") — so every generated image must come
 * back with no letters, words, or logotype baked into the pixels.
 */
const NO_TEXT_INSTRUCTION =
  "Do not include any letters, words, numbers, or text of any kind in the image. No logos, no watermarks, no typography. Purely visual: background, characters, or decorative shapes only.";

/**
 * Logs the final prompt actually sent to the provider, gated behind
 * `DEBUG_AI_PROMPTS` (never the API key) — piece-generation spec's "Brand
 * style context in every generation" asks for this to be inspectable
 * without printing it unconditionally on every call.
 */
function logPrompt(label: string, prompt: string): void {
  if (process.env.DEBUG_AI_PROMPTS !== "1") return;
  // eslint-disable-next-line no-console
  console.debug(`[ai:${label}]`, prompt);
}

/** Turns a `DraftCopyBrandContext` into the extra system-prompt lines steering tone, positioning and language — omits any clause whose field is empty rather than emitting a hollow instruction. */
function brandContextForCopy(brand?: DraftCopyPlan["brand"]): string {
  if (!brand) return "";
  const lines: string[] = [];
  if (brand.toneStyle.length > 0) lines.push(`Write in this tone: ${brand.toneStyle.join(", ")}.`);
  if (brand.toneAvoid.length > 0) lines.push(`Avoid: ${brand.toneAvoid.join(", ")}.`);
  if (brand.positioning) lines.push(`Brand positioning/context: ${brand.positioning}`);
  if (brand.language) lines.push(`Write the copy in this language: ${brand.language}.`);
  return lines.length > 0 ? " " + lines.join(" ") : "";
}

/** Turns a `GenerateImageBrandContext` into the extra prompt clauses steering direction, style keywords, palette and the no-logo rule. */
function brandContextForImage(brand?: GenerateImageSpec["brand"]): string {
  if (!brand) return "";
  const clauses: string[] = [];
  if (brand.imageDirection) clauses.push(brand.imageDirection);
  if (brand.styleKeywords.length > 0) clauses.push(`Style: ${brand.styleKeywords.join(", ")}.`);
  if (brand.paletteWords) clauses.push(`Use ${brand.paletteWords}.`);
  clauses.push(brand.logoRules || "Never draw text or logos.");
  return clauses.length > 0 ? "\n\n" + clauses.join(" ") : "";
}

const CUTOUT_INSTRUCTION =
  "Only the isolated subject on a fully transparent background: no scene, no floor, no ground plane, no cast shadow.";

async function readJsonOrThrow(response: Response, context: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI ${context} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`OpenAI ${context} returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

export class OpenAiPieceGenerator implements PieceGenerator {
  constructor(
    private readonly apiKey: string,
    private readonly resolveAsset: AssetFileResolver = () => undefined,
  ) {}

  acceptsReference(_kind: GenerateImageSpec["kind"], mime: string): boolean {
    return EDIT_INPUT_MIMES.has(mime);
  }

  async draftCopy(plan: DraftCopyPlan): Promise<DraftCopyResult> {
    const userPrompt = JSON.stringify({
      carouselPrompt: plan.carouselPrompt,
      slides: plan.slides,
    });
    const systemPrompt = COPY_SYSTEM_PROMPT + brandContextForCopy(plan.brand);
    logPrompt("draftCopy", `${systemPrompt}\n\n${userPrompt}`);

    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    });

    const json = await readJsonOrThrow(response, "chat completion");
    const content: string = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: { slides?: DraftedSlideCopy[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`OpenAI returned copy that was not valid JSON: ${content.slice(0, 500)}`);
    }

    const slides = enforceLimits(parsed.slides ?? [], plan);
    return {
      slides,
      model: TEXT_MODEL,
      costCents: estimateTextCostCents(userPrompt, content),
    };
  }

  async completeJson(request: JsonCompletionRequest): Promise<JsonCompletionResult> {
    logPrompt("completeJson", `${request.instructions}\n\n${request.input}`);
    const model = request.tier === "vision" ? VISION_MODEL : TEXT_MODEL;
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: request.instructions },
          {
            role: "user",
            content: [
              { type: "text", text: request.input },
              ...(request.images ?? []).map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: request.tier === "vision" ? "high" : "auto" },
              })),
            ],
          },
        ],
        response_format: { type: "json_object" },
        temperature: request.tier === "vision" ? 0 : 0.2,
      }),
    });
    const json = await readJsonOrThrow(response, "chat completion");
    const content: string = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`OpenAI returned a completion that was not valid JSON: ${content.slice(0, 500)}`);
    }
    return {
      json: parsed,
      model,
      costCents: chatCostCents(model, json.usage, request.instructions + request.input, content),
    };
  }

  async generateImage(spec: GenerateImageSpec): Promise<GeneratedImage> {
    const reproduce = spec.mode === "reproduce";
    const cutout = !reproduce && spec.kind !== "background";
    const prompt = reproduce
      ? spec.prompt
      : `${spec.prompt}${brandContextForImage(spec.brand)}\n\n${NO_TEXT_INSTRUCTION}${cutout ? `\n\n${CUTOUT_INSTRUCTION}` : ""}`;
    logPrompt("generateImage", prompt);
    const model = reproduce ? posterImageModel() : IMAGE_MODEL;
    const fields: Record<string, string> = {
      model,
      prompt,
      quality: reproduce ? posterImageQuality() : "low",
      size: cutout ? "1024x1024" : reproduce ? sizeHolding(spec.canvas, model) : pickSize(spec.canvas),
      n: "1",
      ...(cutout ? { background: "transparent", output_format: "png" } : {}),
    };
    const references = (spec.referenceAssetIds ?? [])
      .map((id) => ({ id, file: this.resolveAsset(id) }))
      .filter((r) => r.file && this.acceptsReference(spec.kind, r.file.mime))
      .slice(0, MAX_EDIT_INPUTS);

    let response: Response;
    if (references.length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      references.forEach(({ id, file }, i) => {
        // The base image is letterboxed to the slide, then to the provider's size, so it is never stretched. A model that
        // takes any size gets the slide's own proportion and that second letterbox is a no-op; with a fixed set of
        // sizes the caller crops the slide back out of the result.
        const [w, h] = fields.size!.split("x").map(Number) as [number, number];
        const pad = spec.padColor ?? "FFFFFF";
        const bytes = reproduce && i === 0 ? padToSize(padToSize(file!.bytes, spec.canvas.w, spec.canvas.h, pad), w, h, pad) : file!.bytes;
        const mime = reproduce && i === 0 ? "image/png" : file!.mime;
        form.append("image[]", new Blob([new Uint8Array(bytes)], { type: mime }), `${id}.${mime.split("/")[1]}`);
      });
      response = await fetch(IMAGES_EDITS_URL, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}` }, body: form });
    } else {
      response = await fetch(IMAGES_GENERATIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...fields, n: 1 }),
      });
    }

    const json = await readJsonOrThrow(response, references.length > 0 ? "image edit" : "image generation");
    const b64: string | undefined = json.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("OpenAI image generation response had no b64_json payload.");
    }

    const generated = Buffer.from(b64, "base64");
    const costCents = estimateImageCostFromUsage(json.usage, model);
    // One line per paid image, never the key: what was asked and what it cost, to keep a spend ledger honest.
    console.info(`[ai:image] ${model} ${fields.size} ${fields.quality} usage=${JSON.stringify(json.usage ?? null)} cents=${costCents}`);
    return {
      buffer: generated,
      mime: "image/png",
      model,
      costCents,
      usedReferenceIds: references.map((r) => r.id),
    };
  }
}

/** OpenAI's image endpoint only accepts a fixed set of sizes; pick the closest aspect to the carousel canvas (portrait 4:5). */
const SIZES: Array<[number, number]> = [[1024, 1024], [1024, 1536], [1536, 1024]];

/** Models that take any output size (edges multiples of 16, between 655,360 and 8,294,400 pixels, aspect 1:3 to 3:1). */
const ANY_SIZE_MODELS = /^gpt-image-2/;
const ANY_SIZE_PIXELS = 1024 * 1280;

/**
 * The output size for a poster: the slide's own proportion at about 1.3 megapixels when the model takes any size,
 * else the fixed size that holds the largest region of that proportion.
 */
export function sizeHolding(canvas: { w: number; h: number }, model: string): string {
  const aspect = canvas.w / canvas.h;
  if (ANY_SIZE_MODELS.test(model) && aspect >= 1 / 3 && aspect <= 3) {
    const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
    const w = round16(Math.sqrt(ANY_SIZE_PIXELS * aspect));
    return `${w}x${round16(w / aspect)}`;
  }
  const area = ([w, h]: [number, number]) => Math.min(w, h * aspect) * Math.min(h, w / aspect);
  const [w, h] = SIZES.reduce((best, size) => (area(size) > area(best) ? size : best));
  return `${w}x${h}`;
}

function pickSize(canvas: { w: number; h: number }): string {
  return canvas.h > canvas.w ? "1024x1536" : "1536x1024";
}

/**
 * Defensive backstop for the "never truncate mid-word" rule: even though
 * the prompt instructs the model to respect `limits`, a response that
 * overshoots gets trimmed at a word boundary rather than mid-word, and a
 * missing slide is filled with an empty draft rather than dropped, so the
 * caller always gets exactly one entry per planned slide.
 */
function enforceLimits(slides: DraftedSlideCopy[], plan: DraftCopyPlan): DraftedSlideCopy[] {
  const bySlideId = new Map(slides.map((slide) => [slide.slideId, slide]));
  return plan.slides.map((planned) => {
    const drafted = bySlideId.get(planned.slideId);
    return {
      slideId: planned.slideId,
      headline: clampAtWordBoundary(drafted?.headline ?? "", planned.limits.headline),
      body:
        planned.limits.body !== undefined
          ? clampAtWordBoundary(drafted?.body ?? "", planned.limits.body)
          : undefined,
    };
  });
}

function clampAtWordBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const truncated = text.slice(0, limit);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trimEnd();
}
