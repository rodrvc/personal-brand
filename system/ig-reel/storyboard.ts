/**
 * The storyboard: one card per scene, narration attached to the card.
 *
 * This is what ties sentence N to scene N. Before it, the reel's narration
 * was a single script synthesised into a single MP3 and laid over a video
 * with fixed scene times — nothing bound a sentence to the scene it spoke
 * about, so the voice drifted by construction. With a storyboard the engine
 * synthesises **one MP3 per card**, measures it, and derives each scene's
 * duration from its own audio ("audio first, video after"). The structure
 * holds because nothing else can happen.
 *
 * Everything in this file is engine contract: the card shape, the closed
 * `visual` enum, the word budget per visual, the cache key. The *words* are
 * the profile's — this module never knows what a card says, only that it
 * says it within budget.
 *
 * The file lives in the profile (`profiles/<slug>/reels/<date>/storyboard.yaml`,
 * gitignored with the rest of the profile); only the fictional
 * `profiles/example*` ship one.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.js";
import { parseYaml } from "./recipe.js";
import { resolveScenes, type Scene, type SceneSpec } from "./remotion/src/timeline.js";
import type { VoiceConfig } from "./voice.js";

export const STORYBOARD_KIND = "reel";
export const STORYBOARD_VERSIONS = [1];
export const STORYBOARD_VISUALS = ["cover", "item", "closing"] as const;
export type StoryboardVisual = (typeof STORYBOARD_VISUALS)[number];

/**
 * Words a card may carry, per visual. Engine constants, not profile ones:
 * they are what keeps a derived scene within the length the format holds.
 * An item card of 30 words is ~10s of speech — already the long side of a
 * card; a cover or closing is a line, not a paragraph.
 */
export const WORD_BUDGET: Record<StoryboardVisual, { min: number; max: number }> = {
  cover: { min: 4, max: 15 },
  item: { min: 8, max: 30 },
  closing: { min: 4, max: 15 },
};

/** Same range as `curation.count`, and for the same reason (see recipe.ts). */
export const MIN_ITEM_CARDS = 2;
export const MAX_ITEM_CARDS = 6;

const CARD_KEYS = ["id", "visual", "item", "narration", "min_seconds"];
const ROOT_KEYS = ["storyboard", "version", "voice", "cards"];
const VOICE_KEYS = ["voice_id", "model_id", "stability", "similarity_boost", "style", "speed", "use_speaker_boost"];

export interface StoryboardCard {
  id: string;
  visual: StoryboardVisual;
  /** Index into `reels/week-input.json` items. Present iff `visual === "item"`. */
  item?: number;
  /** What the narrator says on this card. Empty string = a mute card. */
  narration: string;
  /** Optional floor for the scene, in seconds; the engine minimum still applies. */
  min_seconds?: number;
  /** Word count of `narration`, as the budget sees it. */
  words: number;
}

export interface Storyboard {
  cards: StoryboardCard[];
  /** Partial override of the recipe's `voice:` block, same keys. */
  voice?: Partial<VoiceConfig>;
}

/** Whitespace-separated tokens that contain at least one letter or digit. */
export function countWords(text: string): number {
  return text
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

type Node = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}

/**
 * Validates a parsed storyboard. Pure: no disk, no network, no key. Every
 * rule fails naming the card it tripped on, so the author edits one card and
 * not the whole file. `itemCount` is how many items `week-input.json` holds.
 */
export function validateStoryboard(parsed: unknown, path: string, itemCount: number): Storyboard {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(path, "the storyboard must be a map at the root.");
  }
  const root = parsed as Node;
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.includes(key)) {
      fail(path, `unknown key ${JSON.stringify(key)}. Supported here: ${ROOT_KEYS.join(", ")}.`);
    }
  }
  if (root.storyboard !== STORYBOARD_KIND) {
    fail(path, `"storyboard" must be ${JSON.stringify(STORYBOARD_KIND)}, got ${JSON.stringify(root.storyboard)}.`);
  }
  if (typeof root.version !== "number" || !STORYBOARD_VERSIONS.includes(root.version)) {
    fail(
      path,
      `this storyboard asks for version ${JSON.stringify(root.version)}; this engine supports: ${STORYBOARD_VERSIONS.join(", ")}.`,
    );
  }

  let voice: Partial<VoiceConfig> | undefined;
  if (root.voice !== undefined) {
    if (!root.voice || typeof root.voice !== "object" || Array.isArray(root.voice)) {
      fail(path, "\"voice\" must be a map with the same keys as the recipe's voice: block.");
    }
    const node = root.voice as Node;
    for (const key of Object.keys(node)) {
      if (!VOICE_KEYS.includes(key)) {
        fail(path, `unknown key "voice.${key}". Supported here: ${VOICE_KEYS.join(", ")}.`);
      }
    }
    for (const key of ["stability", "similarity_boost", "style"] as const) {
      const value = node[key];
      if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
        fail(path, `voice.${key} must be a number between 0 and 1, got ${JSON.stringify(value)}.`);
      }
    }
    voice = node as Partial<VoiceConfig>;
  }

  if (!Array.isArray(root.cards) || root.cards.length === 0) {
    fail(path, "\"cards\" must be a non-empty list of cards.");
  }

  const cards: StoryboardCard[] = [];
  const seenIds = new Set<string>();
  const seenItems = new Map<number, string>();

  root.cards.forEach((raw, position) => {
    const label = `card #${position + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail(path, `${label}: each card must be a map with id, visual and narration.`);
    }
    const node = raw as Node;
    const id = typeof node.id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(node.id) ? node.id : undefined;
    if (!id) {
      fail(path, `${label}: "id" must be a slug (lowercase letters, digits, dashes), got ${JSON.stringify(node.id)}.`);
    }
    const name = `card ${id}`;
    for (const key of Object.keys(node)) {
      if (!CARD_KEYS.includes(key)) {
        fail(path, `${name}: unknown key ${JSON.stringify(key)}. Supported here: ${CARD_KEYS.join(", ")}.`);
      }
    }
    if (seenIds.has(id)) fail(path, `${name}: duplicate id — ids must be unique.`);
    seenIds.add(id);

    const visual = node.visual;
    if (typeof visual !== "string" || !(STORYBOARD_VISUALS as readonly string[]).includes(visual)) {
      fail(path, `${name}: "visual" must be one of ${STORYBOARD_VISUALS.join(" | ")}, got ${JSON.stringify(visual)}.`);
    }
    const kind = visual as StoryboardVisual;

    if (typeof node.narration !== "string") {
      fail(
        path,
        `${name}: "narration" must be a string (use "" for a mute card), got ${JSON.stringify(node.narration)}.`,
      );
    }
    const narration = node.narration.trim();
    const words = countWords(narration);
    const budget = WORD_BUDGET[kind];
    if (words > 0 && words < budget.min) {
      fail(path, `${name}: ${words} words, min ${budget.min} for visual=${kind}.`);
    }
    if (words > budget.max) {
      fail(path, `${name}: ${words} words, max ${budget.max} for visual=${kind}.`);
    }

    let item: number | undefined;
    if (kind === "item") {
      if (typeof node.item !== "number" || !Number.isInteger(node.item) || node.item < 0 || node.item >= itemCount) {
        fail(
          path,
          `${name}: "item" must be an integer index into week-input.json items (0..${itemCount - 1}), got ${JSON.stringify(node.item)}.`,
        );
      }
      const other = seenItems.get(node.item);
      if (other !== undefined) {
        fail(path, `${name}: item ${node.item} is already used by card ${other}.`);
      }
      seenItems.set(node.item, id);
      item = node.item;
    } else if (node.item !== undefined) {
      fail(path, `${name}: "item" only applies to visual=item.`);
    }

    let minSeconds: number | undefined;
    if (node.min_seconds !== undefined) {
      if (typeof node.min_seconds !== "number" || !Number.isFinite(node.min_seconds) || node.min_seconds < 0) {
        fail(path, `${name}: "min_seconds" must be a non-negative number, got ${JSON.stringify(node.min_seconds)}.`);
      }
      minSeconds = node.min_seconds;
    }

    cards.push({ id, visual: kind, item, narration, min_seconds: minSeconds, words });
  });

  if (cards[0]!.visual !== "cover") {
    fail(path, `card ${cards[0]!.id}: the first card must be visual=cover.`);
  }
  if (cards[cards.length - 1]!.visual !== "closing") {
    fail(path, `card ${cards[cards.length - 1]!.id}: the last card must be visual=closing.`);
  }
  const covers = cards.filter((card) => card.visual === "cover");
  if (covers.length !== 1) {
    fail(path, `card ${covers[1]!.id}: only one cover card is allowed, and it goes first.`);
  }
  const closings = cards.filter((card) => card.visual === "closing");
  if (closings.length !== 1) {
    fail(path, `card ${closings[0]!.id}: only one closing card is allowed, and it goes last.`);
  }
  const items = cards.filter((card) => card.visual === "item");
  if (items.length < MIN_ITEM_CARDS || items.length > MAX_ITEM_CARDS) {
    fail(
      path,
      `${items.length} item card(s); a reel needs between ${MIN_ITEM_CARDS} and ${MAX_ITEM_CARDS}. ` +
        "One does not read as a tour; above six it runs past the length a reel holds attention for.",
    );
  }

  return { cards, voice };
}

/** Where a profile's storyboard for a period lives by default. */
export function defaultStoryboardPath(profileDir: string, periodStart: string): string {
  return join(profileDir, "reels", periodStart, "storyboard.yaml");
}

/** Reads, parses and validates a storyboard file. */
export function loadStoryboard(path: string, itemCount: number): Storyboard {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(
        `No storyboard found at ${path}. See system/ig-reel/README.md → "Storyboard: audio primero" for its shape.`,
      );
    }
    throw error;
  }
  return validateStoryboard(parseYaml(text, path), path, itemCount);
}

/** The recipe's voice with the storyboard's partial override applied. */
export function effectiveVoice(recipeVoice: VoiceConfig, override?: Partial<VoiceConfig>): VoiceConfig {
  const merged: VoiceConfig = { ...recipeVoice };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined) (merged as unknown as Node)[key] = value;
  }
  return merged;
}

/** Collapses whitespace so a reflowed card does not re-synthesise. */
export function normaliseNarration(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Content hash of what actually reaches the TTS endpoint: normalised text,
 * the effective voice settings and the model. Same text + same voice = same
 * key, so editing one card re-synthesises only that card.
 */
export function narrationCacheKey(text: string, voice: VoiceConfig): string {
  const payload = {
    text: normaliseNarration(text),
    model_id: voice.model_id ?? "eleven_multilingual_v2",
    voice_id: voice.voice_id,
    stability: voice.stability ?? 0.5,
    similarity_boost: voice.similarity_boost ?? 0.75,
    style: voice.style ?? 0,
    speed: voice.speed ?? 1,
    use_speaker_boost: voice.use_speaker_boost ?? true,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Per-card result of synthesis: the file (if any) and its measured length. */
export interface CardAudio {
  id: string;
  path?: string;
  seconds: number;
  /** "cached" when the sidecar hash matched and the API was not called. */
  source: "cached" | "synthesised" | "mute";
}

export interface SynthesiseCardsOptions {
  /** Defaults to `synthesise()` from voice.ts; injectable so tests never hit the network. */
  synth?: (text: string, outPath: string, voice: VoiceConfig) => Promise<void>;
  /** Defaults to `durationOf()` (ffprobe). */
  probe?: (path: string) => number;
  report?: (message: string) => void;
}

interface Sidecar {
  hash: string;
  seconds: number;
}

/**
 * One MP3 per card under `audioDir/<card-id>.mp3`, with a `<card-id>.json`
 * sidecar holding the content hash and the measured duration. A card whose
 * hash matches an existing MP3 is not sent to the API. A mute card produces
 * no file and lasts 0s.
 */
export async function synthesiseCards(
  storyboard: Storyboard,
  voice: VoiceConfig,
  audioDir: string,
  options: SynthesiseCardsOptions = {},
): Promise<CardAudio[]> {
  const { report = () => {} } = options;
  const synth = options.synth ?? (await import("./voice.js")).synthesise;
  const probe = options.probe ?? (await import("./voice.js")).durationOf;
  mkdirSync(audioDir, { recursive: true });

  const results: CardAudio[] = [];
  for (const card of storyboard.cards) {
    if (card.words === 0) {
      results.push({ id: card.id, seconds: 0, source: "mute" });
      continue;
    }
    const mp3 = join(audioDir, `${card.id}.mp3`);
    const sidecarPath = join(audioDir, `${card.id}.json`);
    const hash = narrationCacheKey(card.narration, voice);

    if (existsSync(mp3) && existsSync(sidecarPath)) {
      try {
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as Sidecar;
        if (sidecar.hash === hash && Number.isFinite(sidecar.seconds)) {
          report(`  ${card.id}: cached (${sidecar.seconds.toFixed(2)}s)`);
          results.push({ id: card.id, path: mp3, seconds: sidecar.seconds, source: "cached" });
          continue;
        }
      } catch {
        // An unreadable sidecar is treated as a miss: re-synthesise.
      }
    }

    await synth(card.narration, mp3, voice);
    const seconds = probe(mp3);
    writeFileSync(sidecarPath, JSON.stringify({ hash, seconds } satisfies Sidecar, null, 2));
    report(`  ${card.id}: synthesised (${seconds.toFixed(2)}s)`);
    results.push({ id: card.id, path: mp3, seconds, source: "synthesised" });
  }
  return results;
}

/** One card of the derived timeline, as written to `timeline.json`. */
export interface TimelineEntry {
  id: string;
  visual: StoryboardVisual;
  /** Index into `week-input.json` (the storyboard's reference), when visual=item. */
  item?: number;
  words: number;
  narrationSeconds: number;
  /** Seconds into the scene where the narration starts (the music intro, on the cover). */
  narrationOffset: number;
  start: number;
  duration: number;
}

export interface ReelTimeline {
  cards: TimelineEntry[];
  total: number;
  /** The same timing as `scenes` the composition consumes; `itemIndex` is the position among item cards. */
  scenes: Scene[];
}

/**
 * Derives the timeline from the cards and their measured audio. Pure.
 *
 * `introSeconds` is the music bed's head start: it pushes the cover's
 * narration later *inside the cover*, and the cover grows to hold it, so
 * every later card still starts exactly where its scene does.
 */
export function buildTimeline(
  storyboard: Storyboard,
  audio: readonly CardAudio[],
  introSeconds = 0,
): ReelTimeline {
  const secondsOf = new Map(audio.map((entry) => [entry.id, entry.seconds]));
  let itemPosition = 0;
  const specs: SceneSpec[] = storyboard.cards.map((card) => {
    const narration = secondsOf.get(card.id) ?? 0;
    const offset = card.visual === "cover" ? introSeconds : 0;
    const spec: SceneSpec = {
      kind: card.visual,
      narrationSeconds: narration > 0 || offset > 0 ? offset + narration : 0,
      minSeconds: card.min_seconds,
    };
    if (card.visual === "item") spec.itemIndex = itemPosition++;
    return spec;
  });
  const scenes = resolveScenes(specs);
  const cards = storyboard.cards.map((card, index): TimelineEntry => ({
    id: card.id,
    visual: card.visual,
    item: card.item,
    words: card.words,
    narrationSeconds: secondsOf.get(card.id) ?? 0,
    narrationOffset: card.visual === "cover" ? introSeconds : 0,
    start: scenes[index]!.start,
    duration: scenes[index]!.duration,
  }));
  const total = scenes.length ? scenes[scenes.length - 1]!.end : 0;
  return { cards, total, scenes };
}

/** The readable printout of a derived timeline: voice vs scene seconds, and where each starts. */
export function formatTimelineTable(timeline: ReelTimeline): string {
  const rows = timeline.cards.map((card) => [
    card.id,
    card.visual + (card.item !== undefined ? `(${card.item})` : ""),
    String(card.words),
    card.narrationSeconds ? card.narrationSeconds.toFixed(2) : "-",
    card.duration.toFixed(2),
    card.start.toFixed(2),
  ]);
  return `${table(["id", "visual", "words", "voice s", "scene s", "start"], rows)}
  total: ${timeline.total.toFixed(2)}s`;
}

/** One row per card, for the `--check` / `--audio-only` printouts. */
export function formatStoryboardTable(storyboard: Storyboard): string {
  const rows = storyboard.cards.map((card) => [
    card.id,
    card.visual + (card.item !== undefined ? `(${card.item})` : ""),
    String(card.words),
    `${WORD_BUDGET[card.visual].min}-${WORD_BUDGET[card.visual].max}`,
  ]);
  return table(["id", "visual", "words", "budget"], rows);
}

export function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    "  " + cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// --- CLI: `npx tsx system/ig-reel/storyboard.ts --check <storyboard.yaml> [--items <week-input.json>]` ---
// Validates without network, key or ffmpeg and prints the table. The item
// count comes from the week input when given; otherwise any index is allowed
// only up to MAX_ITEM_CARDS.

const invokedDirectly = process.argv[1] && /storyboard\.ts$/.test(process.argv[1]);
if (invokedDirectly && process.argv.includes("--check")) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..", "..");
  const loaded = loadDotEnv(repoRoot);
  if (loaded.length > 0) {
    console.log(`env: loaded ${loaded.length} var(s) from .env`);
  }

  const path = process.argv[process.argv.indexOf("--check") + 1];
  if (!path || path.startsWith("--")) {
    console.error("Usage: --check <storyboard.yaml> [--items <week-input.json>]");
    process.exit(2);
  }
  const itemsFlag = process.argv.indexOf("--items");
  let itemCount = MAX_ITEM_CARDS;
  if (itemsFlag !== -1) {
    const input = JSON.parse(readFileSync(process.argv[itemsFlag + 1]!, "utf-8")) as { items?: unknown[] };
    itemCount = input.items?.length ?? 0;
  }
  try {
    const storyboard = loadStoryboard(path, itemCount);
    console.log(formatStoryboardTable(storyboard));
    console.log(`\n${storyboard.cards.length} cards, valid.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
