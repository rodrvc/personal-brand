import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { clipRangesFor } from "./assemble.js";
import {
  clipInputsHash,
  createRunScratch,
  exportStoredReel,
  loadStoredReelRecipe,
  loadStoredReelRun,
  recordStoredClip,
  recordStoredTimeline,
  timelineInputsHash,
  stageStoredClips,
  synthesiseStoredCards,
  type ReelStorage,
} from "./stored-reel.js";
import { buildTimeline, validateStoryboard } from "./storyboard.js";

// Fictional data only; memory storage, a fake object store and a stub synthesiser: no network, no profile dir.
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const VOICE = { voice_id: "voice-a" };
const RECIPE = { recipe: "reel-week", version: 1, map: { bbox: [0, 0, 1, 1] }, render: { script: "render-reel-week" }, voice: VOICE };
const STORYBOARD = {
  storyboard: "reel",
  version: 1,
  cards: [
    { id: "intro", visual: "cover", narration: "A short tour of the week" },
    { id: "first", visual: "item", item: 0, narration: "The first thing happening this week is a market by the pier" },
    { id: "second", visual: "item", item: 1, narration: "The second one is an open air concert in the main square" },
    { id: "outro", visual: "closing", narration: "See you at the next one" },
  ],
};
const INPUT = { city: "Exampleton", items: [{ title: "a" }, { title: "b" }] };

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "stored-reel-"));
  scratch.push(dir);
  return dir;
};

async function setup() {
  const repos = createMemoryRepositories();
  const brand = await repos.brands.create({ slug: "acme-coffee", displayName: "Acme" }, meta);
  const store = new FakeObjectStore();
  await repos.recipes.put(brand.id, "reel-week", { params: RECIPE, schemaVersion: 1 }, meta);
  const run = await repos.runs.create(
    brand.id,
    { recipe: "reel-week", periodStart: "2026-09-07", periodEnd: "2026-09-13", input: { json: { ...INPUT, _imported: { from: "x" } }, schemaVersion: 1 }, storyboard: STORYBOARD },
    meta,
  );
  const storage: ReelStorage = {
    brandId: brand.id,
    recipes: repos.recipes,
    runs: repos.runs,
    artifacts: repos.runArtifacts,
    tts: repos.tts,
    store,
    cache: new BlobCache(store, brand.id, tempDir()),
  };
  return { repos, storage, store, run, brand };
}

/** A stub synthesiser: writes deterministic bytes and counts calls. */
function stubSynth() {
  const calls: string[] = [];
  return {
    calls,
    synth: async (text: string, out: string) => {
      calls.push(text);
      writeFileSync(out, `mp3:${text}`);
    },
    probe: () => 2,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  ["recipe and run load from storage; a run of another recipe or brand is refused", async () => {
    const { storage, run, repos } = await setup();
    assert.equal((await loadStoredReelRecipe(storage)).voice?.voice_id, "voice-a");
    const loaded = await loadStoredReelRun(storage, run.id);
    assert.deepEqual([loaded.periodStart, loaded.input.city, "_imported" in loaded.input], ["2026-09-07", "Exampleton", false]);
    assert.equal(validateStoryboard(loaded.storyboard, "stored", 2).cards.length, 4);
    await assert.rejects(() => loadStoredReelRun(storage, "00000000-0000-4000-8000-000000000000"), /not a "reel-week" run/);
    const other = await repos.brands.create({ slug: "other-brand", displayName: "Other" }, meta);
    await assert.rejects(() => loadStoredReelRun({ ...storage, brandId: other.id }, run.id), /not a "reel-week" run/);
    await assert.rejects(() => loadStoredReelRecipe({ ...storage, brandId: other.id }), /No reel recipe/);
  }],
  ["narration: a miss synthesises and stores a take; the next run is served from the cache with no synthesis", async () => {
    const { storage, run, repos } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const first = stubSynth();
    const one = await synthesiseStoredCards(storage, run.id, storyboard, VOICE, join(tempDir(), "audio"), first);
    assert.deepEqual(one.map((a) => a.source), ["synthesised", "synthesised", "synthesised", "synthesised"]);
    const second = stubSynth();
    const audioDir = join(tempDir(), "audio");
    const two = await synthesiseStoredCards(storage, run.id, storyboard, VOICE, audioDir, second);
    assert.deepEqual([second.calls.length, two.map((a) => a.source)], [0, ["cached", "cached", "cached", "cached"]]);
    assert.equal(readFileSync(join(audioDir, "first.mp3"), "utf8"), `mp3:${storyboard.cards[1]!.narration}`);
    assert.deepEqual((await repos.runArtifacts.current(run.id, { kind: "audio" })).map((a) => a.cardId), ["intro", "first", "second", "outro"]);
  }],
  ["narration: a failure on a later card keeps the takes already paid for", async () => {
    const { storage, run, repos } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const failing = stubSynth();
    const synth = async (text: string, out: string) => {
      if (failing.calls.length === 2) throw new Error("provider down");
      await failing.synth(text, out);
    };
    await assert.rejects(() => synthesiseStoredCards(storage, run.id, storyboard, VOICE, join(tempDir(), "audio"), { synth, probe: failing.probe }), /provider down/);
    assert.deepEqual((await repos.runArtifacts.current(run.id, { kind: "audio" })).map((a) => a.cardId), ["intro", "first"]);
    const retry = stubSynth();
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, join(tempDir(), "audio"), retry);
    assert.deepEqual(retry.calls.length, 2, "only the two missing cards are synthesised again");
  }],
  ["clips: re-rendering one card keeps the old clip, and assemble-only stages the current ones from the cache", async () => {
    const { storage, run, repos } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const audio = storyboard.cards.map((card) => ({ id: card.id, seconds: 3, source: "mute" as const }));
    const ranges = clipRangesFor(buildTimeline(storyboard, audio).scenes, storyboard.cards.map((c) => c.id));
    const work = tempDir();
    const render = async (range: (typeof ranges)[number], content: string) => {
      const file = join(work, `${range.cardId}.mp4`);
      writeFileSync(file, content);
      return recordStoredClip(storage, run.id, range, file, clipInputsHash("props", range));
    };
    for (const range of ranges) await render(range, `v1:${range.cardId}`);
    const old = (await repos.runArtifacts.history(run.id, "clip", 1))[0]!;
    const redone = await render(ranges[1]!, "v2:first");
    assert.notEqual(redone.sha256, old.sha256);
    assert.deepEqual((await repos.runArtifacts.history(run.id, "clip", 1)).map((a) => a.sha256), [old.sha256, redone.sha256]);
    assert.equal(readFileSync(await storage.cache.read(old.sha256), "utf8"), "v1:first", "the old clip is still in storage");
    // Nothing from the render dir is needed to assemble: the stage reads the cache only.
    rmSync(work, { recursive: true, force: true });
    const clips = createRunScratch(tempDir(), "clips");
    assert.deepEqual(await stageStoredClips(storage, run.id, ranges, clips.dir), ["intro", "first", "second", "outro"]);
    assert.equal(readFileSync(join(clips.dir, "1-first.mp4"), "utf8"), "v2:first");
    assert.equal(readFileSync(join(clips.dir, "0-intro.mp4"), "utf8"), "v1:intro");
    await recordStoredTimeline(storage, run.id, "{}", timelineInputsHash(storyboard, audio));
    assert.equal((await repos.runArtifacts.current(run.id, { kind: "timeline" })).length, 1);
  }],
  ["scratch: two concurrent runs get distinct dirs, and removing one leaves the other and the cache", async () => {
    const { storage, run } = await setup();
    const parent = tempDir();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const audio = storyboard.cards.map((card) => ({ id: card.id, seconds: 3, source: "mute" as const }));
    const ranges = clipRangesFor(buildTimeline(storyboard, audio).scenes, storyboard.cards.map((c) => c.id));
    const file = join(tempDir(), "c.mp4");
    writeFileSync(file, "clip");
    for (const range of ranges) await recordStoredClip(storage, run.id, range, file, "h");
    const [a, b] = [createRunScratch(parent, run.id), createRunScratch(parent, run.id)];
    assert.notEqual(a.dir, b.dir);
    await Promise.all([stageStoredClips(storage, run.id, ranges, a.dir), stageStoredClips(storage, run.id, ranges, b.dir)]);
    const sha = (await storage.artifacts.current(run.id, { kind: "clip" }))[0]!.sha256;
    a.remove();
    assert.equal(existsSync(a.dir), false);
    assert.equal(readdirSync(b.dir).length, 4);
    assert.equal(existsSync(await storage.cache.read(sha)), true, "removing scratch never removes the cached blob");
    assert.deepEqual(readdirSync(parent), [b.dir.slice(parent.length + 1)], "the shared parent keeps only the other run's dir");
    b.remove();
    assert.equal(statSync(parent).isDirectory(), true);
    await assert.rejects(() => stageStoredClips(storage, run.id, ranges, b.dir).then(() => stageStoredClips(storage, run.id, ranges, b.dir)), /EEXIST/, "staging never overwrites a file");
  }],
  ["export: each render takes the next version, concurrent renders never share one, and the object is verified", async () => {
    const { storage, run, store } = await setup();
    const dir = tempDir();
    const [one, two] = [join(dir, "a.mp4"), join(dir, "b.mp4")];
    writeFileSync(one, "reel-one");
    writeFileSync(two, "reel-two");
    const both = await Promise.all([exportStoredReel(storage, run.id, one), exportStoredReel(storage, run.id, two)]);
    assert.deepEqual(both.map((e) => e.versionNo).sort(), [1, 2]);
    const third = await exportStoredReel(storage, run.id, one);
    assert.equal(third.versionNo, 3);
    assert.equal((await store.head(third.key)).metadata.sha256, third.sha256);
    assert.equal((await store.get(both.find((e) => e.versionNo === 1)!.key)).body.byteLength, 8);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n${error instanceof Error ? error.stack : error}`);
  }
}
for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
console.log(`stored-reel: ${tests.length} ok`);
