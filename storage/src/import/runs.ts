import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { clipFileName } from "@personal-brand/core/clips";
import { effectiveVoice, narrationCacheKey, type VoiceSettings } from "@personal-brand/core/narration";
import { parse as parseYaml } from "yaml";

import { putBlob } from "../blob/put-blob.ts";
import { blobKey, InvalidInputError, ObjectNotFoundError, VersionConflictError, type BlobStore, type RunArtifactInput } from "../contracts/index.ts";
import { nameRefusal } from "./allowlist.ts";
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
  /** Audio takes (card order) first, then clips: the order `run_artifacts.current` returns them in. */
  artifacts: Array<RunArtifactInput & { bytes: Buffer; mime: string; take?: { seconds: number; voice: VoiceSettings } }>;
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
    plans.push({ path: rel, recipe: "weekly-roundup", period, derived: { recipe: "flat carousels/*.json are weekly-roundup inputs", period: "the Monday-to-Sunday week holding every slide date" }, source: json, storyboard: null, raws: [raw], artifacts: [] });
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
        plans.push({ path: "reels/week-input.json", recipe: "reel-week", period: inputWeek, derived: { recipe: "reels are reel-week inputs", period: "the Monday-to-Sunday week holding every item date" }, source: input.json, storyboard: null, raws: [input.raw], artifacts: [] });
      } else skipped.push(input.json ? "reels/week-input.json (no run: items undated or spanning several weeks)" : "reels/week-input.json (not a JSON object)");
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
      const plan: RunPlan = { path: `${rel}/storyboard.yaml`, recipe: "reel-week", period, derived: { recipe: "a storyboard is a reel-week input", period: "the Monday-to-Sunday week holding the folder date" }, source: ownInput?.json ?? {}, storyboard, raws: [sb, ...(ownInput?.raw ? [ownInput.raw] : [])], artifacts: [] };
      for (const name of readdirSync(join(dir, rel)).sort()) if (name !== "storyboard.yaml" && name !== "audio") skipped.push(`${rel}/${name} (not part of a run)`);
      collectAudio(ctx, plan, rel, recipeRaw);
      collectClips(ctx, plan);
      plans.push(plan);
    }
  }

  const runs = runIndex(repos);
  return plans.map((plan) => toItem(plan, repos, runs, ctx.notices, blobs));
}

/** Audio of one storyboard folder: only narrations whose hash can be recomputed to the sidecar's become tts takes. */
function collectAudio(ctx: CollectContext, plan: RunPlan, rel: string, recipeRaw: Buffer | null): void {
  const { dir, root, blobs, skipped } = ctx;
  const audioDir = join(dir, rel, "audio");
  if (!existsSync(audioDir)) return;
  if (!statSync(audioDir).isDirectory()) {
    skipped.push(`${rel}/audio (not a directory)`);
    return;
  }
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
    plan.artifacts.push({ kind: "audio", cardIndex, cardId: id, sha256: sha256(mp3), inputsHash: sidecar.hash, bytes: mp3, mime: "audio/mpeg", take: { seconds: sidecar.seconds, voice } });
  });
  for (const name of files) if (!claimed.has(name)) skipped.push(`${rel}/audio/${name} (not the audio of a storyboard card)`);
}

/**
 * Rendered clips of the period, `<outputs.reels>/<periodStart>/clips/<name>.mp4` under the outputs root, where `<name>` is
 * exactly what the engine writes for the storyboard card at that index (`clipFileName`, zero-padded from 11 cards): any other
 * name is left to the legacy pass. Their `inputs_hash` is `import:sha256:<mp4 sha>`: how they were rendered is not known.
 */
function collectClips(ctx: CollectContext, plan: RunPlan): void {
  const { outputs, blobs, skipped, used } = ctx;
  const dir = outputs && join(outputs.real, outputs.reels, plan.period.start, "clips");
  if (!outputs || !dir || !blobs || !existsSync(dir)) return;
  const ids = (Array.isArray(plan.storyboard?.cards) ? (plan.storyboard!.cards as unknown[]) : []).map((c) => asObject(c)?.id);
  const names = new Set(readdirSync(dir));
  ids.forEach((id, index) => {
    const name = typeof id === "string" ? clipFileName(index, id, ids.length) : "";
    // A card id the name policy refuses (a suspicious word) is not guessed into a clip: the legacy pass reports it.
    if (!names.has(name) || nameRefusal(name, false)) return;
    used.add(join(dir, name)); // claimed even when the read fails, so the legacy pass does not report it a second time
    const bytes = readRegular(outputs.real, join(dir, name), `@outputs/${outputs.reels}/${plan.period.start}/clips/${name}`, skipped);
    if (!bytes) return;
    plan.raws.push(bytes);
    plan.artifacts.push({ kind: "clip", cardIndex: index, cardId: id as string, sha256: sha256(bytes), inputsHash: `import:sha256:${sha256(bytes)}`, bytes, mime: "video/mp4" });
  });
}

/** The `kind:cardIndex` slots a stored run's `_imported.artifacts` claims: the only ones the import owns. */
const slotOf = (a: { kind: string; cardIndex: number | null }) => `${a.kind}:${a.cardIndex}`;
function claimedSlots(input: unknown): Map<string, string> {
  const recorded = asObject(identity(input)._imported)?.artifacts;
  return new Map((Array.isArray(recorded) ? (recorded as Array<{ kind: string; cardIndex: number | null; sha256: string }>) : []).map((r) => [slotOf(r), r.sha256] as const));
}

function toItem(plan: RunPlan, repos: ImportRepos, runs: RunIndex, notices: string[], blobs?: BlobStore): Item {
  const json = { ...plan.source, _imported: { from: plan.path, recipe: plan.derived.recipe, period: plan.derived.period, artifacts: plan.artifacts.map(({ kind, cardIndex, sha256: sha }) => ({ kind, cardIndex, sha256: sha })) } };
  const shape = ({ kind, cardIndex, cardId, sha256: sha, inputsHash }: RunArtifactInput) => ({ kind, cardIndex, cardId, sha256: sha, inputsHash });
  const artifacts = plan.artifacts.map(shape);
  return {
    key: `run:${plan.path}`, entityType: "recipe_run",
    hash: sha256(plan.raws.map(sha256).join("\n")),
    payload: { recipe: plan.recipe, periodStart: plan.period.start, periodEnd: plan.period.end, input: json, storyboard: plan.storyboard, artifacts },
    read: async (brandId) => {
      const run = (await runs(brandId)).get(plan.path);
      if (!run) return null;
      // Only the slots the import owns (planned now, or claimed by the last import) are compared: a card that left the plan
      // is dropped from `_imported.artifacts` by the next write, so its old take stays in history but is no longer claimed.
      const owned = new Set([...plan.artifacts.map(slotOf), ...claimedSlots(run.value.input).keys()]);
      const stored = (await repos.runArtifacts.current(run.id)).filter((a) => owned.has(slotOf(a))).map(shape);
      return { id: run.id, version: run.version, value: { recipe: run.value.recipe, periodStart: run.value.periodStart, periodEnd: run.value.periodEnd, input: run.value.input, storyboard: run.value.storyboard, artifacts: stored } };
    },
    write: async (brandId, expectedVersion, meta) => {
      const existing = expectedVersion === null ? null : ((await runs(brandId)).get(plan.path) ?? null);
      // The period is fixed when the run is created; a source that now derives another one is reported, not moved.
      if (existing && existing.value.periodStart !== plan.period.start) throw new InvalidInputError(`run ${plan.path}: period changed in the folder from ${existing.value.periodStart} to ${plan.period.start}; a run's period cannot be updated`);
      // Never overwrite an artifact someone else produced: a slot whose current one is neither the planned one nor the one
      // the last import recorded in `_imported.artifacts` was changed in storage, so the run is left alone and reported.
      // (Before cutover the importer is the only artifact writer; this guard keeps that true if it ever stops being so.)
      if (existing) {
        const lastImported = claimedSlots(existing.value.input);
        const currentNow = await repos.runArtifacts.current(existing.id);
        const now = new Map(currentNow.map((a) => [slotOf(a), a.sha256] as const));
        for (const a of plan.artifacts) {
          const sha = now.get(slotOf(a));
          if (sha !== undefined && sha !== a.sha256 && sha !== lastImported.get(slotOf(a))) throw new InvalidInputError(`run ${plan.path}: ${a.kind} of card ${a.cardId} was changed in storage since the last import; not overwritten`);
        }
        // A card imported before that no longer has an artifact in the plan (narration edited after synthesis, file removed):
        // it is released, not deleted. Its take stays in history and the run stops claiming it.
        const planned = new Set(plan.artifacts.map(slotOf));
        for (const a of currentNow) {
          if (!lastImported.has(slotOf(a)) || planned.has(slotOf(a))) continue;
          notices.push(`${plan.path}: ${a.kind} of card ${a.cardId} is no longer in the source; its stored take is kept in history and no longer claimed by the import`);
        }
      }
      for (const a of plan.artifacts) {
        await putBlob(blobs as BlobStore, brandId, a.bytes, a.mime);
        if (a.take) await repos.tts.record(brandId, a.inputsHash, { sha256: a.sha256, seconds: a.take.seconds, voice: a.take.voice as unknown as Record<string, unknown> });
      }
      const body = { json, schemaVersion: 1 };
      // A run has no unique source key: two importers creating the same new run at once would both create it (one importer at a time, as with carousels).
      // The item hash only reaches storage with the LAST revisioned write, after the artifacts are recorded: an interrupted
      // pass is then never classified `unchanged` with artifacts missing (a new run's first write carries a derived hash).
      if (existing) {
        if (existing.version !== expectedVersion) throw new VersionConflictError(existing.version);
        for (const a of artifacts) await repos.runArtifacts.record(existing.id, a);
        await repos.runs.save(existing.id, { input: body, storyboard: plan.storyboard }, { ...meta, expectedVersion });
      } else {
        const fields = { recipe: plan.recipe, periodStart: plan.period.start, periodEnd: plan.period.end, input: body, ...(plan.storyboard ? { storyboard: plan.storyboard } : {}) };
        const made = await repos.runs.create(brandId, fields, { ...meta, expectedVersion: null, ...(artifacts.length ? { sourceHash: `${meta.sourceHash}:doc` } : {}) });
        if (artifacts.length) {
          for (const a of artifacts) await repos.runArtifacts.record(made.id, a);
          await repos.runs.save(made.id, { input: body, storyboard: plan.storyboard }, { ...meta, expectedVersion: made.version });
        }
      }
    },
    verifyBlobs: async (brandId) => {
      for (const a of plan.artifacts) {
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
