import { estimateImageCostCents, estimateTextCostCents, IMAGE_MODEL, TEXT_MODEL } from "./pricing.js";
import type {
  DraftCopyPlan,
  DraftCopyResult,
  DraftedSlideCopy,
  GenerateImageSpec,
  GeneratedImage,
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
  constructor(private readonly apiKey: string) {}

  async draftCopy(plan: DraftCopyPlan): Promise<DraftCopyResult> {
    const userPrompt = JSON.stringify({
      carouselPrompt: plan.carouselPrompt,
      slides: plan.slides,
    });

    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [
          { role: "system", content: COPY_SYSTEM_PROMPT },
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

  async generateImage(spec: GenerateImageSpec): Promise<GeneratedImage> {
    const prompt = `${spec.prompt}\n\n${NO_TEXT_INSTRUCTION}`;
    const response = await fetch(IMAGES_GENERATIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt,
        quality: "low",
        size: pickSize(spec.canvas),
        n: 1,
      }),
    });

    const json = await readJsonOrThrow(response, "image generation");
    const b64: string | undefined = json.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("OpenAI image generation response had no b64_json payload.");
    }

    return {
      buffer: Buffer.from(b64, "base64"),
      mime: "image/png",
      model: IMAGE_MODEL,
      costCents: estimateImageCostCents(),
    };
  }
}

/** OpenAI's image endpoint only accepts a fixed set of sizes; pick the closest aspect to the carousel canvas (portrait 4:5). */
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
