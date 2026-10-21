import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { effectiveVoice, narrationCacheKey, type VoiceSettings } from "@personal-brand/core/narration";
import { parse as parseYaml } from "yaml";

import { putBlob } from "../blob/put-blob.ts";
import { blobKey, InvalidInputError, ObjectNotFoundError, type BlobStore, type RunArtifactInput } from "../contracts/index.ts";
import { readRegular, sha256, type CollectContext, type ImportRepos, type Item } from "./shared.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const identity = (b: unknown) => b as Record<string, unknown>;
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const toDate = (iso: string): Date | null => {
  const at = DATE.test(iso) ? new Date(`${iso}T00:00:00Z`) : null;
  return at && at.toISOString().slice(0, 10) === iso ? at : null;
};

/** The Monday-to-Sunday week (calendar dates) that holds `iso`, or null when `iso` is not a real date. */
export function weekHolding(iso: string): { start: string; end: string } | null {
  const day = toDate(iso);
  if (!day) return null;
  const monday = new Date(day);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

/** The one week that holds every date, or null when there are none, one is invalid, or they span several weeks. */
function singleWeek(dates: unknown[]): { start: string; end: string } | null {
  const weeks = dates.map((d) => (typeof d === "string" ? weekHolding(d) : null));
  return weeks.length && weeks.every((w) => w && w.start === weeks[0]!.start) ? weeks[0]! : null;
}

interface RunPlan {
  /** Folder-relative source path: the run's identity across re-imports. */
  path: string;
  recipe: string;
  period: { start: string; end: string };
  /** How the recipe and the period were derived, kept on the run. */
  derived: { recipe: string; period: string };
  source: Record<string, unknown>;
  storyboard: Record<string, unknown> | null;
  /** Every source file the run is made of, for the item hash. */
  raws: Buffer[];
  audio: Array<RunArtifactInput & { bytes: Buffer; mime: string; seconds: number; voice: VoiceSettings }>;
}

type StoredRun = Awaited<ReturnType<ImportRepos["runs"]["get"]>>;
/** The runs of one brand by the source path kept in their input, listed once per import (not once per item). */
type RunIndex = (brandId: string) => Promise<Map<string, StoredRun>>;

function runIndex(repos: ImportRepos): RunIndex {
  const cache = new Map<string, Promise<Map<string, StoredRun>>>();
  return (brandId) => {
    if (!cache.has(brandId)) {
      cache.set(brandId, (async () => {
        const byPath = new Map<string, StoredRun>();
        for (const head of await repos.runs.list(brandId)) {
          const run = await repos.runs.get(head.id, identity);
          const from = asObject(run.value.input._imported)?.from;
          if (typeof from === "string") byPath.set(from, run);
        }
        return byPath;
      })());
    }
    return cache.get(brandId)!;
  };
}

/**
 * Recipe runs, from the two inputs the engine keeps next to its outputs. The recipe and the period are derived
 * (neither file names them) and the derivation is recorded on the run in `input._imported`:
 * - `reels/<date>/storyboard.yaml` is a `reel-week` run for the Monday-to-Sunday week holding the folder date (the
 *   engine names the folder after the period start); its input is the root `reels/week-input.json`. Without a
 *   storyboard, `reels/week-input.json` alone is that run when all its item dates fall in one week.
 * - A flat `carousels/<name>.json` is a `weekly-roundup` run for the week holding all its slide dates.
 * Undated or multi-week inputs get no run: they are reported. The TTS cache of a storyboard (`audio/<card>.mp3` +
 * `<card>.json`) becomes blobs, `tts_cache` takes and `audio` artifacts, but only when the narration hash is
 * recomputed from the recipe voice and the storyboard override to the very value in the sidecar.
 */
export function collectRuns(ctx: CollectContext): Item[] {
  const { dir, root, repos, blobs, skipped, handled } = ctx;
  const plans: RunPlan[] = [];
  const readJson = (rel: string) => {
    const raw = readRegular(root, join(dir, rel), rel, skipped);
    try {
      return { raw, json: raw ? asObject(JSON.parse(raw.toString("utf-8"))) : null };
    } catch {
      return { raw, json: null };
    }
  };

  const flat = join(dir, "carousels");
  for (const file of existsSync(flat) ? readdirSync(flat).filter((f) => f.endsWith(".json")).sort() : []) {
    handled.add("carousels");
    const rel = `carousels/${file}`;
    const { raw, json } = readJson(rel);
    if (!raw) continue;
    const slides = Array.isArray(json?.slides) ? (json!.slides as unknown[]) : [];
    const period = singleWeek(slides.map((s) => asObject(s)?.date));
    if (!json || !period) {
      skipped.push(`${rel} (no run: not a carousel input with every slide dated within one week)`);
      continue;
    }
    plans.push({ path: rel, recipe: "weekly-roundup", period, derived: { recipe: "flat carousels/*.json are weekly-roundup inputs", period: "the Monday-to-Sunday week holding every slide date" }, source: json, storyboard: null, raws: [raw], audio: [] });
  }

  const reels = join(dir, "reels");
  if (existsSync(reels)) {
    handled.add("reels");
    const input = readJson("reels/week-input.json");
    const dated = (name: string) => weekHolding(name) !== null;
    const folders = readdirSync(reels).filter((f) => dated(f)).sort();
    for (const entry of readdirSync(reels).sort()) {
      if (entry !== "week-input.json" && !folders.includes(entry)) skipped.push(`reels/${entry} (not a period folder or the week input)`);
    }
    const inputItems = Array.isArray(input.json?.items) ? (input.json!.items as unknown[]) : [];
    const inputWeek = singleWeek(inputItems.map((i) => asObject(i)?.date));
    if (folders.length === 0 && input.raw) {
      if (input.json && inputWeek) {
        plans.push({ path: "reels/week-input.json", recipe: "reel-week", period: inputWeek, derived: { recipe: "reels are reel-week inputs", period: "the Monday-to-Sunday week holding every item date" }, source: input.json, storyboard: null, raws: [input.raw], audio: [] });
      } else skipped.push("reels/week-input.json (no run: items undated or spanning several weeks)");
    } else if (input.raw && !input.json) skipped.push("reels/week-input.json (not a JSON object)");
    else if (input.json && !folders.some((f) => weekHolding(f)!.start === inputWeek?.start)) {
      // The one root input belongs to the folder of its own week; with period folders present it is never guessed onto another.
      skipped.push(`reels/week-input.json (no run: ${inputWeek ? `its week starting ${inputWeek.start} has no period folder` : "items undated or spanning several weeks, so it fits no period folder"})`);
    }
    const recipeRaw = readRegular(root, join(dir, "recipes", "reel-week.yaml"), "recipes/reel-week.yaml", [], false);
    for (const folder of folders) {
      const rel = `reels/${folder}`;
      const sb = readRegular(root, join(dir, rel, "storyboard.yaml"), `${rel}/storyboard.yaml`, skipped, true);
      let storyboard: Record<string, unknown> | null = null;
      try {
        storyboard = sb ? asObject(parseYaml(sb.toString("utf-8"))) : null;
      } catch {
        storyboard = null;
      }
      if (!sb || !storyboard) {
        if (sb) skipped.push(`${rel}/storyboard.yaml (not a storyboard)`);
        continue;
      }
      const period = weekHolding(folder)!;
      const ownInput = input.json && inputWeek?.start === period.start ? input : null;
      const plan: RunPlan = { path: `${rel}/storyboard.yaml`, recipe: "reel-week", period, derived: { recipe: "a storyboard is a reel-week input", period: "the Monday-to-Sunday week holding the folder date" }, source: ownInput?.json ?? {}, storyboard, raws: [sb, ...(ownInput?.raw ? [ownInput.raw] : [])], audio: [] };
      for (const name of readdirSync(join(dir, rel)).sort()) if (name !== "storyboard.yaml" && name !== "audio") skipped.push(`${rel}/${name} (not part of a run)`);
      collectAudio(ctx, plan, rel, recipeRaw);
      plans.push(plan);
    }
  }

  const runs = runIndex(repos);
  return plans.map((plan) => toItem(plan, repos, runs, blobs));
}

/** Audio of one storyboard folder: only narrations whose hash can be recomputed to the sidecar's become tts takes. */
function collectAudio(ctx: CollectContext, plan: RunPlan, rel: string, recipeRaw: Buffer | null): void {
  const { dir, root, blobs, skipped } = ctx;
  const audioDir = join(dir, rel, "audio");
  if (!existsSync(audioDir)) return;
  const files = readdirSync(audioDir).sort();
  if (!blobs) {
    skipped.push(`${rel}/audio (no blob store configured: nothing imported)`);
    return;
  }
  let recipeVoice: VoiceSettings | null = null;
  try {
    recipeVoice = recipeRaw ? (asObject(asObject(parseYaml(recipeRaw.toString("utf-8")))?.voice) as VoiceSettings | null) : null;
  } catch {
    recipeVoice = null;
  }
  const cards = Array.isArray(plan.storyboard?.cards) ? (plan.storyboard!.cards as unknown[]).map(asObject) : [];
  const claimed = new Set<string>();
  cards.forEach((card, cardIndex) => {
    const id = card?.id;
    if (typeof id !== "string" || typeof card?.narration !== "string") return;
    const [mp3Name, jsonName] = [`${id}.mp3`, `${id}.json`];
    if (!files.includes(mp3Name)) return;
    [mp3Name, jsonName].forEach((f) => claimed.add(f));
    const [mp3, sidecarRaw] = [readRegular(root, join(audioDir, mp3Name), `${rel}/audio/${mp3Name}`, skipped), readRegular(root, join(audioDir, jsonName), `${rel}/audio/${jsonName}`, skipped, true)];
    let sidecar: Record<string, unknown> | null = null;
    try {
      sidecar = sidecarRaw ? asObject(JSON.parse(sidecarRaw.toString("utf-8"))) : null;
    } catch {
      sidecar = null;
    }
    if (!mp3 || !sidecarRaw) return;
    const voice = recipeVoice?.voice_id ? effectiveVoice(recipeVoice, asObject(plan.storyboard?.voice) as Partial<VoiceSettings> | undefined) : null;
    if (typeof sidecar?.hash !== "string" || typeof sidecar.seconds !== "number" || !voice || narrationCacheKey(card.narration, voice) !== sidecar.hash) {
      skipped.push(`${rel}/audio/${mp3Name} (narration hash cannot be recomputed from the recipe voice and the storyboard; kept as a plain file)`);
      return;
    }
    plan.raws.push(mp3, sidecarRaw);
    plan.audio.push({ kind: "audio", cardIndex, cardId: id, sha256: sha256(mp3), inputsHash: sidecar.hash, bytes: mp3, mime: "audio/mpeg", seconds: sidecar.seconds, voice });
  });
  for (const name of files) if (!claimed.has(name)) skipped.push(`${rel}/audio/${name} (not the audio of a storyboard card)`);
}

function toItem(plan: RunPlan, repos: ImportRepos, runs: RunIndex, blobs?: BlobStore): Item {
  const json = { ...plan.source, _imported: { from: plan.path, recipe: plan.derived.recipe, period: plan.derived.period, audio: plan.audio.map((a) => ({ cardIndex: a.cardIndex, sha256: a.sha256 })) } };
  const audio = plan.audio.map(({ kind, cardIndex, cardId, sha256: sha, inputsHash }) => ({ kind, cardIndex, cardId, sha256: sha, inputsHash }));
  return {
    key: `run:${plan.path}`, entityType: "recipe_run",
    hash: sha256(plan.raws.map(sha256).join("\n")),
    payload: { recipe: plan.recipe, periodStart: plan.period.start, periodEnd: plan.period.end, input: json, storyboard: plan.storyboard, audio },
    read: async (brandId) => {
      const run = (await runs(brandId)).get(plan.path);
      if (!run) return null;
      const current = await repos.runArtifacts.current(run.id, { kind: "audio" });
      const stored = current.map(({ kind, cardIndex, cardId, sha256: sha, inputsHash }) => ({ kind, cardIndex, cardId, sha256: sha, inputsHash }));
      return { id: run.id, version: run.version, value: { recipe: run.value.recipe, periodStart: run.value.periodStart, periodEnd: run.value.periodEnd, input: run.value.input, storyboard: run.value.storyboard, audio: stored } };
    },
    write: async (brandId, expectedVersion, meta) => {
      const existing = expectedVersion === null ? null : ((await runs(brandId)).get(plan.path) ?? null);
      // The period is fixed when the run is created; a source that now derives another one is reported, not moved.
      if (existing && existing.value.periodStart !== plan.period.start) throw new InvalidInputError(`run ${plan.path}: period changed in the folder from ${existing.value.periodStart} to ${plan.period.start}; a run's period cannot be updated`);
      // Never overwrite a take someone else produced: a slot whose current take is neither the planned one nor the one
      // the last import recorded in `_imported.audio` was changed in storage, so the run is left alone and reported.
      // (Before cutover the importer is the only artifact writer; this guard keeps that true if it ever stops being so.)
      if (existing) {
        const recorded = asObject(identity(existing.value.input)._imported)?.audio;
        const lastImported = new Map((Array.isArray(recorded) ? (recorded as Array<{ cardIndex: number | null; sha256: string }>) : []).map((r) => [r.cardIndex, r.sha256] as const));
        const now = new Map((await repos.runArtifacts.current(existing.id, { kind: "audio" })).map((a) => [a.cardIndex, a.sha256]));
        for (const a of plan.audio) {
          const sha = now.get(a.cardIndex);
          if (sha !== undefined && sha !== a.sha256 && sha !== lastImported.get(a.cardIndex)) throw new InvalidInputError(`run ${plan.path}: audio of card ${a.cardId} was changed in storage since the last import; not overwritten`);
        }
      }
      for (const a of plan.audio) {
        await putBlob(blobs as BlobStore, brandId, a.bytes, a.mime);
        await repos.tts.record(brandId, a.inputsHash, { sha256: a.sha256, seconds: a.seconds, voice: a.voice as unknown as Record<string, unknown> });
      }
      const body = { json, schemaVersion: 1 };
      // A run has no unique source key: two importers creating the same new run at once would both create it (one importer at a time, as with carousels).
      const run = existing
        ? await repos.runs.save(existing.id, { input: body, storyboard: plan.storyboard }, { ...meta, expectedVersion })
        : await repos.runs.create(brandId, { recipe: plan.recipe, periodStart: plan.period.start, periodEnd: plan.period.end, input: body, ...(plan.storyboard ? { storyboard: plan.storyboard } : {}) }, { ...meta, expectedVersion: null });
      for (const a of audio) await repos.runArtifacts.record(run.id, a);
    },
    verifyBlobs: async (brandId) => {
      for (const a of plan.audio) {
        try {
          if (sha256((await (blobs as BlobStore).get(blobKey(brandId, a.sha256))).body) !== a.sha256) return false;
        } catch (error) {
          if (error instanceof ObjectNotFoundError) return false;
          throw error;
        }
      }
      return true;
    },
  };
}
