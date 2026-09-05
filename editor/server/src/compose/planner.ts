import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type {
  CarouselDocument,
  Slide,
  SlideKind,
  SlideObject,
} from "../../../../system/ig-carousel/carousel-document.js";
import type { LayoutTemplate, LayoutSlot } from "../../../../system/ig-carousel/layout-template.js";
import { hashContent, loadIndex, registerFile, type AssetEntry } from "../../../../system/assets/index.js";
import { contrast, passesAA } from "@personal-brand/core/color";

import type { PieceGenerator, DraftCopyPlanSlide } from "../ai/piece-generator.js";
import type { ProfileStore } from "../profile-store.js";

/** Absolute fallback step count when a template declares no `defaultSlideCount` at all. */
const FALLBACK_STEP_COUNT = 3;
const MIN_STEP_COUNT = 1;
const MAX_STEP_COUNT = 8;

/**
 * Matches a number followed by a Spanish/English word for "step" — the
 * phrase means "N steps", so the cover/closing (when the template has them)
 * are added on top of N, not counted within it.
 */
const STEP_PHRASE = /\b(\d+)\s*(pasos?|steps?)\b/i;

/**
 * Matches a number followed by a Spanish/English word for "slide" — the
 * phrase means "N slides TOTAL", including cover/closing when the template
 * has them. Deliberately narrowed to the cover+step*N+closing shape (see
 * `resolveStepCount`'s comment): this repo ships exactly one template
 * (explicativo.json) with that shape, so "N láminas" - 2 for the step count
 * is the only case worth handling generically today.
 */
const SLIDE_PHRASE = /\b(\d+)\s*(láminas?|laminas?|slides?|diapositivas?)\b/i;

function clampStepCount(n: number): number {
  return Math.max(MIN_STEP_COUNT, Math.min(MAX_STEP_COUNT, n));
}

/**
 * Resolves how many `step` slides to compose, in priority order:
 * 1. An explicit `slideCountOverride` (API-client-only field, never sent by
 *    the web UI — see routes/compose.ts) is used directly as the step
 *    count.
 * 2. The prompt names an explicit count itself — either "N pasos/steps"
 *    (N steps directly) or "N láminas/slides/diapositivas" (N total slides;
 *    step count = N minus 2, for the template's cover and closing, floored
 *    at 0). The two phrasings are deliberately handled with a single,
 *    narrow assumption: the template is shaped cover + step*N + closing,
 *    which is the only shape `explicativo.json` (this repo's only shipped
 *    template) has. A template with a different shape (no cover, multiple
 *    closings, etc.) would need this logic generalized — not attempted
 *    here since there is nothing yet to generalize against.
 * 3. `template.defaultSlideCount ?? 3` (piece-generation spec's "the slide
 *    count is editable afterward" — the number is always just a starting
 *    point, never final).
 */
function resolveStepCount(promptText: string, template: LayoutTemplate, slideCountOverride?: number): number {
  if (typeof slideCountOverride === "number" && Number.isInteger(slideCountOverride) && slideCountOverride > 0) {
    return clampStepCount(slideCountOverride);
  }

  const stepMatch = promptText.match(STEP_PHRASE);
  if (stepMatch) {
    return clampStepCount(Number(stepMatch[1]));
  }

  const slideMatch = promptText.match(SLIDE_PHRASE);
  if (slideMatch) {
    const hasCover = Boolean(template.slides.cover);
    const hasClosing = Boolean(template.slides.closing);
    const nonStepSlides = (hasCover ? 1 : 0) + (hasClosing ? 1 : 0);
    return clampStepCount(Number(slideMatch[1]) - nonStepSlides);
  }

  return clampStepCount(template.defaultSlideCount ?? FALLBACK_STEP_COUNT);
}

/**
 * Turns a free-text prompt (plus the resolved template) into an ordered
 * plan of slide kinds. Deliberately simple (not itself an AI call): the
 * number and kind of slides is a structural decision the user can edit
 * afterward (piece-generation spec's "the slide count is editable
 * afterward"), so guessing a reasonable default here — a cover (if the
 * template has one), N steps, a closing (if the template has one) — is
 * enough to seed the plan. Generic on purpose: this only assumes the
 * template *may* declare `cover`/`closing` kinds, not that it must —
 * `explicativo.json` happens to declare all three.
 */
function planSlideKinds(promptText: string, template: LayoutTemplate, slideCountOverride?: number): SlideKind[] {
  const stepCount = resolveStepCount(promptText, template, slideCountOverride);
  const kinds: SlideKind[] = [];
  if (template.slides.cover) kinds.push("cover");
  for (let i = 0; i < stepCount; i++) kinds.push("step");
  if (template.slides.closing) kinds.push("closing");
  return kinds;
}

export interface PlannedVisualSlot {
  slideIndex: number;
  slot: string;
  source: "library" | "generate";
  /** Present only when `source === "library"`. */
  assetId?: string;
  /** Present only when `source === "generate"`. */
  estimatedCostCents?: number;
  kind: AssetEntry["kind"];
}

export interface CompositionPlan {
  promptText: string;
  slideKinds: SlideKind[];
  visualSlots: PlannedVisualSlot[];
  textSlots: Array<{ slideIndex: number; slot: string; limits: { headline: number; body?: number } }>;
}

const VISUAL_SLOT_KIND_HINT: Record<string, AssetEntry["kind"]> = {
  media: "photo",
  background: "background",
  character: "character",
  decoration: "decoration",
};

function guessAssetKindForSlot(slotName: string): AssetEntry["kind"] {
  return VISUAL_SLOT_KIND_HINT[slotName] ?? "photo";
}

/** Lowercased, punctuation-stripped words of length > 2 — short enough to keep matching cheap, long enough to skip stopword-ish noise like "un"/"de". */
function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

/**
 * Scores a library candidate against the prompt/slot hint by tag
 * intersection, and picks the best match. Score = number of the
 * candidate's `tags` that also appear as a word in the prompt text or in
 * the slot's own name (a slot named `"character"` should favor a
 * `character`-tagged piece over an untagged one even if the free-text
 * prompt never says the word). Kind was already filtered by the caller, so
 * every candidate here is already a same-`kind` match; tags only refine
 * *which* same-kind piece wins. Ties keep the index order (first found)
 * so the result is deterministic. When no candidate has any matching tag
 * (score 0 for all, including untagged pieces), this falls back to
 * kind-only selection — the first approved candidate of that kind — same
 * as before tags were considered.
 */
function pickBestCandidate(
  candidates: AssetEntry[],
  promptText: string,
  slotName: string,
): AssetEntry | undefined {
  if (candidates.length === 0) return undefined;
  const hintWords = new Set([...wordsOf(promptText), ...wordsOf(slotName)]);

  let best: { entry: AssetEntry; score: number } | undefined;
  for (const entry of candidates) {
    const score = entry.tags.reduce((count, tag) => (hintWords.has(tag.toLowerCase()) ? count + 1 : count), 0);
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }
  // best.score === 0 for every candidate means no tag matched anything —
  // kind-only fallback, which `best` already holds (the first candidate,
  // since equal scores keep the earliest one found above).
  return best?.entry;
}

/**
 * Builds the per-slide/per-slot plan: for each visual slot, search the
 * approved library by kind/tags first; only when nothing qualifies does the
 * slot become a `generate` entry (piece-generation spec, "Library first,
 * generate after"). Text slots are collected too so the caller knows their
 * character budget when it later calls `draftCopy`.
 */
export function buildCompositionPlan(
  store: ProfileStore,
  promptText: string,
  template: LayoutTemplate,
  slideCountOverride?: number,
  /** Asset ids the user explicitly chose from the library picker (NewCarouselDialog's optional, collapsed-by-default picker) — tried before the general tag-matching search, kind permitting, for each visual slot in order. */
  preferredAssetIds?: string[],
): CompositionPlan {
  const slideKinds = planSlideKinds(promptText, template, slideCountOverride);
  const index = loadIndex(store.roots.profileDir);
  const approvedByKind = new Map<AssetEntry["kind"], AssetEntry[]>();
  for (const entry of index.entries) {
    if (entry.status !== "approved") continue;
    const list = approvedByKind.get(entry.kind) ?? [];
    list.push(entry);
    approvedByKind.set(entry.kind, list);
  }
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]));

  const used = new Set<string>();
  const preferredQueue = [...(preferredAssetIds ?? [])];
  const visualSlots: PlannedVisualSlot[] = [];
  const textSlots: CompositionPlan["textSlots"] = [];

  slideKinds.forEach((kind, slideIndex) => {
    const slots = template.slides[kind]?.slots ?? [];
    for (const slot of slots) {
      if (slot.type === "text") {
        textSlots.push({
          slideIndex,
          slot: slot.name,
          limits: textLimitsForSlot(slot),
        });
        continue;
      }
      const assetKind = guessAssetKindForSlot(slot.name);

      // A user-picked asset of the right kind, not already used, takes
      // priority over the tag-matching search below — this is the only
      // wiring the "optional library pieces" picker in NewCarouselDialog
      // needs: a straight ordered list of ids to try first.
      const preferredIndex = preferredQueue.findIndex((id) => {
        const entry = byId.get(id);
        return entry && entry.kind === assetKind && entry.status === "approved" && !used.has(id);
      });
      if (preferredIndex !== -1) {
        const [id] = preferredQueue.splice(preferredIndex, 1);
        used.add(id!);
        visualSlots.push({ slideIndex, slot: slot.name, source: "library", assetId: id!, kind: assetKind });
        continue;
      }

      const candidates = (approvedByKind.get(assetKind) ?? []).filter((entry) => !used.has(entry.id));
      const candidate = pickBestCandidate(candidates, promptText, slot.name);
      if (candidate) {
        used.add(candidate.id);
        visualSlots.push({ slideIndex, slot: slot.name, source: "library", assetId: candidate.id, kind: assetKind });
      } else {
        visualSlots.push({ slideIndex, slot: slot.name, source: "generate", estimatedCostCents: 1, kind: assetKind });
      }
    }
  });

  return { promptText, slideKinds, visualSlots, textSlots };
}

/** Rough character budget per slot geometry — width in px / an average glyph width, floored to something usable. Good enough to keep the AI from writing paragraphs into a headline slot. */
function textLimitsForSlot(slot: LayoutSlot & { type: "text" }): { headline: number; body?: number } {
  const approxCharsPerLine = Math.max(8, Math.round(slot.geometry.w / (slot.fontSize * 0.55)));
  const lines = slot.name === "body" ? 4 : slot.name === "title" ? 3 : 1;
  return { headline: approxCharsPerLine * lines };
}

/** Resolves the best-contrast `brand.colors` key for a role's default ink against a real background hex, per piece-generation's "Color assignment from the palette". */
export function bestContrastColorKey(brand: BrandTokens, roleColorHex: string, backgroundHex: string): string {
  if (passesAA(roleColorHex, backgroundHex)) {
    const key = Object.entries(brand.colors).find(([, hex]) => hex === roleColorHex)?.[0];
    if (key) return key;
  }
  let best: { key: string; ratio: number } | undefined;
  for (const [key, hex] of Object.entries(brand.colors)) {
    const ratio = contrast(hex, backgroundHex);
    if (!best || ratio > best.ratio) best = { key, ratio };
  }
  return best?.key ?? brand.roles.onSurface;
}

/**
 * Real hex for a slide's background, for contrast purposes only (not a
 * general-purpose background resolver). `mode: "color"` resolves directly
 * through `brand.colors`. `mode: "asset"` has no measured dominant color
 * available today — the sidecar schema (`system/assets/index.ts`) carries
 * no such field — so per this task's "keep it simple" instruction this
 * falls back to the color-mode key (`brand.roles.surface`) rather than
 * inventing a color-extraction step; a future sidecar field can slot in
 * here without touching any caller.
 */
function backgroundHexForContrast(brand: BrandTokens, background: Slide["background"]): string {
  if (background.mode === "color") {
    return brand.colors[background.colorKey] ?? brand.colors[brand.roles.surface]!;
  }
  return brand.colors[brand.roles.surface]!;
}

/**
 * Assigns `colorKey` to every text object on a slide that doesn't already
 * carry an explicit one, picking the brand color key with the best
 * measured contrast against the slide's real background
 * (piece-generation spec's "Color assignment from the palette"). Objects
 * that already declare a `colorKey` — whether from a hand edit or a prior
 * assignment — are left untouched, since this only fills in what the AI
 * left unset.
 */
export function assignTextColorKeys(brand: BrandTokens, slide: Slide): Slide {
  const backgroundHex = backgroundHexForContrast(brand, slide.background);
  const roleHex = brand.colors[brand.roles.onSurface]!;
  const bestKey = bestContrastColorKey(brand, roleHex, backgroundHex);
  const objects = slide.objects.map((object) =>
    object.kind === "text" && !object.colorKey ? { ...object, colorKey: bestKey } : object,
  );
  return { ...slide, objects };
}

/**
 * Executes a `CompositionPlan`: drafts copy for every text slot and
 * generates (or reuses) every visual slot, assembling a full
 * `CarouselDocument`. Every generated image is registered into
 * `assets/generated/` as a `candidate` with a sidecar (piece-generation
 * spec, design.md D7); every object records its `source`.
 */
export async function applyCompositionPlan(
  store: ProfileStore,
  brand: BrandTokens,
  template: LayoutTemplate,
  templateId: string,
  plan: CompositionPlan,
  carouselId: string,
  generator: PieceGenerator,
): Promise<CarouselDocument> {
  const draftPlanSlides: DraftCopyPlanSlide[] = plan.textSlots
    .filter((t) => t.slot === "title" || t.slot === "eyebrow" || t.slot === "subtitle" || t.slot === "body" || t.slot === "cta")
    .map((t) => ({
      slideId: `slide-${t.slideIndex + 1}`,
      kind: plan.slideKinds[t.slideIndex]!,
      brief: plan.promptText,
      limits: { headline: t.limits.headline },
    }));

  // Draft once per slide (not per text slot): the copy call returns a
  // headline/body per slideId, which every text slot on that slide then
  // draws from by name.
  const uniqueBySlide = new Map<string, DraftCopyPlanSlide>();
  for (const s of draftPlanSlides) uniqueBySlide.set(s.slideId, s);
  const draftResult = uniqueBySlide.size > 0
    ? await generator.draftCopy({ carouselPrompt: plan.promptText, slides: [...uniqueBySlide.values()] })
    : { slides: [], model: "none", costCents: 0 };

  const draftedBySlide = new Map(draftResult.slides.map((s) => [s.slideId, s]));

  const now = new Date().toISOString();
  const slides: Slide[] = plan.slideKinds.map((kind, slideIndex) => {
    const slideId = `slide-${slideIndex + 1}`;
    const objects: SlideObject[] = [];

    const textSlotsForSlide = plan.textSlots.filter((t) => t.slideIndex === slideIndex);
    for (const t of textSlotsForSlide) {
      const drafted = draftedBySlide.get(slideId);
      const text =
        t.slot === "title"
          ? drafted?.headline ?? ""
          : t.slot === "body"
            ? drafted?.body ?? ""
            : t.slot === "eyebrow"
              ? drafted?.headline ?? ""
              : drafted?.body ?? drafted?.headline ?? "";
      objects.push({
        id: `obj-${slideId}-${t.slot}`,
        kind: "text",
        slot: t.slot,
        pinned: false,
        locked: false,
        source: "ai",
        text,
      });
    }

    const visualForSlide = plan.visualSlots.filter((v) => v.slideIndex === slideIndex);
    let backgroundAssetId: string | undefined;
    for (const v of visualForSlide) {
      if (v.source === "library" && v.assetId) {
        if (v.slot === "background") {
          backgroundAssetId = v.assetId;
        } else {
          objects.push({
            id: `obj-${slideId}-${v.slot}`,
            kind: "asset",
            slot: v.slot,
            pinned: false,
            locked: false,
            source: "library",
            assetId: v.assetId,
            fit: "cover",
          });
        }
      }
      // `generate` visual slots are filled by applyCompositionPlan's
      // caller invoking `generateForSlot` per missing piece (kept
      // separate so the planner's preview can show cost before any
      // generation call actually runs — see plan/apply's two-phase design
      // in the route).
    }

    const background: Slide["background"] = backgroundAssetId
      ? { mode: "asset", assetId: backgroundAssetId, pinned: false, source: "library" }
      : { mode: "color", colorKey: brand.roles.surface, pinned: false, source: "manual" };

    // Text objects with no explicit colorKey pick the best-contrast brand
    // key against this slide's real background (piece-generation spec's
    // "Color assignment from the palette"). A `generate`-sourced background
    // isn't known yet at this point (see the comment above) — the route
    // re-runs this same assignment after attaching each generated
    // background, so those slides get it too, just one step later.
    return assignTextColorKeys(brand, { id: slideId, kind, background, objects });
  });

  return {
    schemaVersion: 1,
    id: carouselId,
    title: plan.promptText.slice(0, 80),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    canvas: { w: 1080, h: 1350 },
    prompt: { text: plan.promptText, createdAt: now, runs: [] },
    template: { id: templateId },
    slides,
  };
}

/**
 * Builds the initial `CarouselDocument` for the immediate-build compose
 * flow (editor-ui spec's "Composition from the prompt"): assembles every
 * `library`-sourced visual piece exactly like `applyCompositionPlan` does,
 * but instead of calling the AI provider for a `generate`-sourced slot or a
 * text slot, it creates a `pending: true` placeholder — empty text, no
 * `assetId` yet, or a temporary color background — so the document is
 * immediately valid and paintable. This function makes NO network/AI call
 * of any kind; it's pure library composition, which is what keeps it fast
 * regardless of whether an API key is configured (routes/compose.ts's
 * `compose-job.ts` fills these placeholders in afterward, in the
 * background).
 */
export function buildImmediateDocument(
  brand: BrandTokens,
  templateId: string,
  plan: CompositionPlan,
  carouselId: string,
): CarouselDocument {
  const now = new Date().toISOString();
  const slides: Slide[] = plan.slideKinds.map((kind, slideIndex) => {
    const slideId = `slide-${slideIndex + 1}`;
    const objects: SlideObject[] = [];

    const textSlotsForSlide = plan.textSlots.filter((t) => t.slideIndex === slideIndex);
    for (const t of textSlotsForSlide) {
      objects.push({
        id: `obj-${slideId}-${t.slot}`,
        kind: "text",
        slot: t.slot,
        pinned: false,
        locked: false,
        source: "ai",
        text: "",
        pending: true,
      });
    }

    const visualForSlide = plan.visualSlots.filter((v) => v.slideIndex === slideIndex);
    let backgroundAssetId: string | undefined;
    let backgroundPending = false;
    for (const v of visualForSlide) {
      if (v.source === "library" && v.assetId) {
        if (v.slot === "background") {
          backgroundAssetId = v.assetId;
        } else {
          objects.push({
            id: `obj-${slideId}-${v.slot}`,
            kind: "asset",
            slot: v.slot,
            pinned: false,
            locked: false,
            source: "library",
            assetId: v.assetId,
            fit: "cover",
          });
        }
        continue;
      }
      // `generate`-sourced slot: no AI call here — a pending placeholder
      // stands in until the background compose job fills it in.
      if (v.slot === "background") {
        backgroundPending = true;
      } else {
        objects.push({
          id: `obj-${slideId}-${v.slot}`,
          kind: "asset",
          slot: v.slot,
          pinned: false,
          locked: false,
          source: "ai",
          fit: "cover",
          pending: true,
        });
      }
    }

    const background: Slide["background"] = backgroundAssetId
      ? { mode: "asset", assetId: backgroundAssetId, pinned: false, source: "library" }
      : {
          mode: "color",
          colorKey: brand.roles.surface,
          pinned: false,
          source: "manual",
          ...(backgroundPending ? { pending: true } : {}),
        };

    return assignTextColorKeys(brand, { id: slideId, kind, background, objects });
  });

  return {
    schemaVersion: 1,
    id: carouselId,
    title: plan.promptText.slice(0, 80),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    canvas: { w: 1080, h: 1350 },
    prompt: { text: plan.promptText, createdAt: now, runs: [] },
    template: { id: templateId },
    slides,
  };
}

/**
 * Generates the image for one missing visual slot and registers it into the
 * library as an AI-origin `candidate` (design.md D7): the file always lands
 * on disk with a sidecar, even before anyone approves it.
 */
export async function generateForSlot(
  store: ProfileStore,
  generator: PieceGenerator,
  spec: { prompt: string; kind: AssetEntry["kind"]; canvas: { w: number; h: number }; carouselId: string; slot: string },
): Promise<AssetEntry> {
  const generateKind =
    spec.kind === "font" || spec.kind === "logo" || spec.kind === "unclassified" ? "background" : spec.kind;
  const image = await generator.generateImage({ prompt: spec.prompt, kind: generateKind, canvas: spec.canvas });
  // registerFile identifies the file by its own content hash (design.md
  // D7's `assets/generated/<hash>.<ext>`); this file's destination path
  // must be derived from that same hash, not an unrelated random id, so a
  // second call producing identical bytes dedups instead of doubling up.
  const contentHash = hashContent(image.buffer);
  const ext = image.mime === "image/png" ? "png" : image.mime === "image/jpeg" ? "jpg" : "webp";
  const entry = registerFile(store.roots.profileDir, image.buffer, {
    kind: spec.kind,
    origin: "ai",
    status: "candidate",
    destRelPath: `assets/generated/${contentHash}.${ext}`,
  });
  store.writeJson(`assets/generated/${entry.id}.json`, {
    prompt: spec.prompt,
    model: image.model,
    costCents: image.costCents,
    createdAt: new Date().toISOString(),
    carouselId: spec.carouselId,
    slot: spec.slot,
  });
  return entry;
}
