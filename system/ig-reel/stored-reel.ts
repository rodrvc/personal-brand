/**
 * The reel engine's storage side, for a brand served from storage (D12). Everything a folder brand keeps on disk
 * between runs lives in storage instead, and every scratch dir is rebuilt from the blob cache per run (D6):
 *
 * - the recipe is the stored `reel-week` recipe; the input and the storyboard are one `recipe_runs` row;
 * - narration is looked up in `tts_cache` before it is synthesised, and each take is a blob plus an `audio` artifact;
 * - each rendered clip is a blob plus a `clip` artifact. Re-rendering a card appends a new artifact, the old clip stays
 *   in history, and assemble-only stages the current clips from the cache;
 * - scratch (Remotion staging, the clip dir) is a unique dir per run, linked from the cache. The engine removes only
 *   what it created and never touches the shared parent;
 * - the final MP4 is written once to the next `exports/reels/<runId>/v<NNN>/` key and verified by `head`.
 *
 * Invariant: staged files are hardlinks of read-only (0444) cache files, so nothing may write to a staged path; a
 * writer replaces the file under a new name. Every `record*`/`stage*` here expects a `runId` already checked by
 * `loadStoredReelRun` (the run belongs to the brand); they do not re-check it.
 *
 * Pure of the render itself: it takes repositories and a blob store, so tests run on memory storage with a stub
 * synthesiser. No brand data lives here.
 */

import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BlobHashMismatchError, putAt, putBlob, type BlobCache } from "@personal-brand/storage/blob";
import {
  InvalidInputError,
  NotFoundError,
  ObjectNotFoundError,
  reelExportKey,
  reelExportPrefix,
  type AssetRepository,
  type BlobStore,
  type RecipeRepository,
  type RecipeRunRepository,
  type RunArtifact,
  type RunArtifactRepository,
  type TtsCacheRepository,
} from "@personal-brand/storage/contracts";

import { clipFileForRange, type ClipRange } from "./assemble.js";
import { validateReelRecipe, type ReelRecipe } from "./recipe.js";
import { narrationCacheKey, synthesiseCards, type CardAudio, type Storyboard, type SynthesiseCardsOptions } from "./storyboard.js";
import type { ReelInput } from "./types.js";
import type { VoiceConfig } from "./voice.js";

export const REEL_RECIPE = "reel-week";

/** What a stored reel render needs, for one brand. Tests pass memory repositories and a fake object store. */
export interface ReelStorage {
  brandId: string;
  recipes: Pick<RecipeRepository, "get">;
  assets: Pick<AssetRepository, "get" | "list">;
  runs: Pick<RecipeRunRepository, "get" | "list">;
  artifacts: RunArtifactRepository;
  tts: TtsCacheRepository;
  store: BlobStore;
  cache: Pick<BlobCache, "read">;
}

const sha256Of = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

export async function loadStoredReelRecipe(storage: ReelStorage): Promise<ReelRecipe> {
  const path = `the stored recipe "${REEL_RECIPE}"`;
  try {
    const stored = await storage.recipes.get(storage.brandId, REEL_RECIPE, (body) => body);
    return validateReelRecipe(stored.value as Record<string, unknown>, path);
  } catch (error) {
    if (error instanceof NotFoundError) throw new Error(`No reel recipe: ${path} does not exist for this brand.`, { cause: error });
    throw error;
  }
}

export interface StoredReelRun {
  runId: string;
  periodStart: string;
  periodEnd: string;
  input: ReelInput;
  /** The storyboard as stored (a parsed map); `validateStoryboard` checks it. Null when the run has none. */
  storyboard: Record<string, unknown> | null;
}

/** A run of this brand's `reel-week` recipe: its input (without the importer's bookkeeping) and storyboard. */
export async function loadStoredReelRun(storage: ReelStorage, runId: string): Promise<StoredReelRun> {
  // `get` returns no brand, so membership comes from the brand's own list (the repository does not paginate it).
  const heads = await storage.runs.list(storage.brandId, { recipe: REEL_RECIPE });
  if (!heads.some((head) => head.id === runId)) throw new Error(`Run ${runId} is not a "${REEL_RECIPE}" run of this brand.`);
  const run = (await storage.runs.get(runId, (body) => body as Record<string, unknown>)).value;
  const { _imported: _ignored, ...input } = run.input;
  return { runId, periodStart: run.periodStart, periodEnd: run.periodEnd, input: input as unknown as ReelInput, storyboard: run.storyboard };
}

/** A unique scratch dir under `parent`. `remove` deletes exactly that dir and never its (shared) parent. */
export function createRunScratch(parent: string, label: string): { dir: string; remove(): void } {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `${label.replace(/[^a-z0-9-]/gi, "-")}-`));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Hardlinks a cache file into scratch (copy across filesystems). The destination must not exist; a partial copy is removed. */
function materialize(source: string, dest: string): void {
  try {
    linkSync(source, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    try {
      copyFileSync(source, dest, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") rmSync(dest, { force: true });
      throw copyError;
    }
  }
}

/** The measured length in a card's sidecar, when the sidecar is for exactly this narration hash; otherwise undefined. */
function sidecarSeconds(sidecarPath: string, hash: string): number | undefined {
  try {
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as { hash?: unknown; seconds?: unknown };
    return sidecar.hash === hash && typeof sidecar.seconds === "number" && Number.isFinite(sidecar.seconds) ? sidecar.seconds : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-card narration for a stored run. A card whose narration hash has a `tts_cache` take is laid into `audioDir` from
 * the blob cache (no API call); the rest are synthesised by the unchanged `synthesiseCards` into that same dir, then
 * stored as a blob + `tts_cache` take. Every spoken card is recorded as an `audio` artifact of the run.
 */
export async function synthesiseStoredCards(
  storage: ReelStorage,
  runId: string,
  storyboard: Storyboard,
  voice: VoiceConfig,
  audioDir: string,
  options: SynthesiseCardsOptions = {},
): Promise<CardAudio[]> {
  mkdirSync(audioDir, { recursive: true });
  const laid = new Map<string, string>(); // card id -> sha256 of a take laid from the cache (already stored)
  for (const card of storyboard.cards) {
    if (card.words === 0) continue;
    const [mp3, sidecarPath] = [join(audioDir, `${card.id}.mp3`), join(audioDir, `${card.id}.json`)];
    // A retry in the same dir: the card is already here for this very narration (laid before, or synthesised before the failure). Keep it.
    const hash = narrationCacheKey(card.narration, voice);
    if (existsSync(mp3) && sidecarSeconds(sidecarPath, hash) !== undefined) continue;
    // Files of another narration in this scratch dir (a stale retry): drop the links so nothing writes through a staged cache file.
    rmSync(mp3, { force: true });
    rmSync(sidecarPath, { force: true });
    let take;
    try {
      take = await storage.tts.get(storage.brandId, hash);
    } catch (error) {
      if (error instanceof NotFoundError) continue;
      throw error;
    }
    let cached: string;
    try {
      cached = await storage.cache.read(take.sha256);
    } catch (error) {
      // A take whose blob is gone or corrupt is a miss: the card is synthesised again and its new take becomes current.
      if (!(error instanceof ObjectNotFoundError) && !(error instanceof BlobHashMismatchError)) throw error;
      options.report?.(`  ${card.id}: stored take unusable (${(error as Error).message}); synthesising again`);
      continue;
    }
    materialize(cached, mp3);
    writeFileSync(sidecarPath, JSON.stringify({ hash, seconds: take.seconds }), { flag: "wx" });
    laid.set(card.id, take.sha256);
  }
  // Every complete take (an mp3 with its matching sidecar, written only after synthesis and measuring) is stored, also when a
  // later card fails: those takes were paid for, and the scratch dir that holds them goes away with the run.
  const persist = async (): Promise<void> => {
    for (const [cardIndex, card] of storyboard.cards.entries()) {
      const [mp3, sidecarPath] = [join(audioDir, `${card.id}.mp3`), join(audioDir, `${card.id}.json`)];
      if (card.words === 0 || !existsSync(mp3) || !existsSync(sidecarPath)) continue;
      const hash = narrationCacheKey(card.narration, voice);
      const seconds = sidecarSeconds(sidecarPath, hash);
      if (seconds === undefined) continue;
      let sha256 = laid.get(card.id);
      if (!sha256) {
        sha256 = (await putBlob(storage.store, storage.brandId, readFileSync(mp3), "audio/mpeg")).sha256;
        await storage.tts.record(storage.brandId, hash, { sha256, seconds, voice: { ...voice } });
      }
      await storage.artifacts.record(runId, { kind: "audio", cardIndex, cardId: card.id, sha256, inputsHash: hash });
    }
  };
  let results: CardAudio[];
  try {
    results = await synthesiseCards(storyboard, voice, audioDir, options);
  } catch (error) {
    await persist().catch(() => undefined); // the synthesis error is the one to report
    throw error;
  }
  await persist();
  return results;
}

/** What a clip was rendered from: the props file and its frame range. A changed storyboard or timeline changes it. */
export function clipInputsHash(propsJson: string, range: ClipRange): string {
  return sha256Of(`${sha256Of(propsJson)}:${range.startFrame}-${range.endFrame}`);
}

/** Stores a rendered clip as a blob and appends it as the card's current `clip` artifact; earlier takes stay in history. */
export async function recordStoredClip(storage: ReelStorage, runId: string, range: ClipRange, clipPath: string, inputsHash: string): Promise<RunArtifact> {
  const { sha256 } = await putBlob(storage.store, storage.brandId, readFileSync(clipPath), "video/mp4");
  return storage.artifacts.record(runId, { kind: "clip", cardIndex: range.index, cardId: range.cardId, sha256, inputsHash });
}

/**
 * Lays the run's current clips into `clipsDir` under the names the engine uses, from the blob cache. Returns the card ids
 * staged: a card with no clip is left for `validateClipsForAssembly` to name, as for a folder.
 */
export async function stageStoredClips(storage: ReelStorage, runId: string, ranges: readonly ClipRange[], clipsDir: string, expectedHash: (range: ClipRange) => string): Promise<string[]> {
  mkdirSync(clipsDir, { recursive: true });
  const current = await storage.artifacts.current(runId, { kind: "clip" });
  const staged: string[] = [];
  for (const range of ranges) {
    const clip = current.find((a) => a.cardIndex === range.index && a.cardId === range.cardId);
    if (!clip) continue;
    // A clip rendered from other props or frames (the storyboard or timeline changed) is stale. An imported clip has no known
    // render inputs (`import:` prefix) and is left to the duration check at assembly.
    if (!clip.inputsHash.startsWith("import:") && clip.inputsHash !== expectedHash(range)) {
      throw new Error(`The stored clip of card "${range.cardId}" was rendered from other inputs than the current storyboard and timeline. Re-render it with --card ${range.cardId}.`);
    }
    materialize(await storage.cache.read(clip.sha256), join(clipsDir, clipFileForRange(range, ranges.length)));
    staged.push(range.cardId);
  }
  return staged;
}

/** What a timeline was derived from: the storyboard and the measured length of each card's audio. */
export function timelineInputsHash(storyboard: Storyboard, audio: readonly CardAudio[]): string {
  return sha256Of(JSON.stringify({ storyboard, seconds: audio.map((a) => [a.id, a.seconds]) }));
}

/** The derived timeline as the run's `timeline` artifact (a blob; it has no card). */
export async function recordStoredTimeline(storage: ReelStorage, runId: string, timelineJson: string, inputsHash: string): Promise<RunArtifact> {
  const { sha256 } = await putBlob(storage.store, storage.brandId, Buffer.from(timelineJson), "application/json");
  return storage.artifacts.record(runId, { kind: "timeline", cardIndex: null, cardId: null, sha256, inputsHash });
}

const MAX_EXPORT_ATTEMPTS = 8;

/**
 * Writes the final MP4 to the next free `exports/reels/<runId>/v<NNN>/reel.mp4` and verifies it by `head` (size + sha256).
 * Versions are never overwritten: a number another render took first (different bytes) is skipped to the next one;
 * identical bytes may resolve to the same version. This relies on the backend honouring `If-None-Match: *` (S3 answers
 * 412, which `putAt` turns into the existing-object check); a backend that ignores it would overwrite. The check by `head`
 * compares size and the `sha256` metadata `putAt` wrote itself: that is the writer's own claim, not a content check.
 */
export async function exportStoredReel(storage: ReelStorage, runId: string, file: string): Promise<{ key: string; versionNo: number; sha256: string }> {
  const bytes = readFileSync(file);
  const sha256 = sha256Of(bytes);
  const taken = (await storage.store.list(reelExportPrefix(storage.brandId, runId))).map((entry) => /\/v(\d+)\/reel\.mp4$/.exec(entry.key)?.[1]);
  let versionNo = Math.max(0, ...taken.filter((v): v is string => v !== undefined).map(Number)) + 1;
  for (let attempt = 1; ; attempt++, versionNo++) {
    const key = reelExportKey(storage.brandId, runId, versionNo);
    try {
      await putAt(storage.store, key, bytes, "video/mp4");
      const head = await storage.store.head(key);
      if (head.size !== bytes.byteLength || head.metadata.sha256 !== sha256) throw new Error(`Export ${key} did not verify: size or sha256 differ from the rendered file.`);
      return { key, versionNo, sha256 };
    } catch (error) {
      if (!(error instanceof InvalidInputError) || attempt >= MAX_EXPORT_ATTEMPTS) throw error;
    }
  }
}

const ASSET_EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "font/woff2": ".woff2" };

/**
 * An asset of the brand (an item image or the logo font) laid into `dir` as `<baseName><extension of its type>` from the blob
 * cache. Null when the brand has no such visible asset; a type a reel cannot use is an error.
 */
export async function stageStoredAsset(storage: ReelStorage, assetId: string, dir: string, baseName: string): Promise<{ name: string; mime: string } | null> {
  let asset;
  try {
    asset = (await storage.assets.get(storage.brandId, assetId)).value;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  if (asset.status === "hidden") return null;
  const extension = ASSET_EXTENSIONS[asset.mime];
  if (!extension) throw new Error(`Asset ${assetId} is ${asset.mime}, which a reel cannot use (png, jpeg, webp, woff2).`);
  const name = `${baseName}${extension}`;
  materialize(await storage.cache.read(asset.sha256), join(dir, name));
  return { name, mime: asset.mime };
}

/** The visible `woff2` font asset of the brand with the lowest id, for the logo (deterministic); undefined when it has none. */
export async function findStoredLogoFont(storage: ReelStorage): Promise<string | undefined> {
  const fonts = await storage.assets.list(storage.brandId, { kind: "font" });
  return fonts.filter((row) => row.value.status !== "hidden" && row.value.mime === "font/woff2").map((row) => row.value.assetId).sort()[0];
}
