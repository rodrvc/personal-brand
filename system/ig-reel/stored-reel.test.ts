import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobCache, FakeObjectStore, putAt, putBlob } from "@personal-brand/storage/blob";
import { InvalidInputError, reelExportKey } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { clipRangesFor } from "./assemble.js";
import {
  assertReelRunId,
  clipInputsHash,
  copyExportToDir,
  createRunScratch,
  ExportCopyError,
  exportCopyName,
  isStoredAssetId,
  exportStoredReel,
  findStoredLogoFont,
  loadStoredReelRecipe,
  loadStoredReelRun,
  recordStoredClip,
  recordStoredTimeline,
  timelineInputsHash,
  stageStoredAsset,
  stageStoredClips,
  synthesiseStoredCards,
  type ReelStorage,
} from "./stored-reel.js";
import { buildTimeline, narrationCacheKey, validateStoryboard } from "./storyboard.js";

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
    assets: repos.assets,
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
    const hashOf = (range: (typeof ranges)[number]): string => clipInputsHash("props", range);
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
    assert.deepEqual(await stageStoredClips(storage, run.id, ranges, clips.dir, hashOf), ["intro", "first", "second", "outro"]);
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
    await Promise.all([stageStoredClips(storage, run.id, ranges, a.dir, () => "h"), stageStoredClips(storage, run.id, ranges, b.dir, () => "h")]);
    const sha = (await storage.artifacts.current(run.id, { kind: "clip" }))[0]!.sha256;
    a.remove();
    assert.equal(existsSync(a.dir), false);
    assert.equal(readdirSync(b.dir).length, 4);
    assert.equal(existsSync(await storage.cache.read(sha)), true, "removing scratch never removes the cached blob");
    assert.deepEqual(readdirSync(parent), [b.dir.slice(parent.length + 1)], "the shared parent keeps only the other run's dir");
    b.remove();
    assert.equal(statSync(parent).isDirectory(), true);
    await assert.rejects(() => stageStoredClips(storage, run.id, ranges, b.dir, () => "h").then(() => stageStoredClips(storage, run.id, ranges, b.dir, () => "h")), /EEXIST/, "staging never overwrites a file");
  }],
  ["assets: an image and the logo font are laid in with their type's extension; an unknown, hidden or unusable asset is not", async () => {
    const { storage, repos, brand } = await setup();
    const register = async (bytes: string, kind: "photo" | "font", mime: string) => {
      const blob = await putBlob(storage.store, brand.id, Buffer.from(bytes), mime);
      return repos.assets.register(brand.id, { sha256: blob.sha256, kind, mime, bytes: bytes.length, origin: "manual", status: "approved", tags: [], ...(kind === "font" ? { family: "Example Sans" } : {}) }, meta);
    };
    const image = await register("png-bytes", "photo", "image/png");
    const [fontB, fontA] = [await register("woff2-b", "font", "font/woff2"), await register("woff2-a", "font", "font/woff2")];
    const odd = await register("<svg/>", "photo", "image/svg+xml");
    const dir = tempDir();
    assert.deepEqual(await stageStoredAsset(storage, image.value.assetId, dir, "item1"), { name: "item1.png", mime: "image/png" });
    assert.equal(readFileSync(join(dir, "item1.png"), "utf8"), "png-bytes");
    assert.equal(await findStoredLogoFont(storage), [fontA, fontB].map((f) => f.value.assetId).sort()[0], "the logo font is the lowest id, not the first listed");
    assert.equal(await stageStoredAsset(storage, "0123456789abcdef", dir, "none"), null);
    await assert.rejects(() => stageStoredAsset(storage, odd.value.assetId, dir, "svg"), /cannot use/);
    await repos.assets.update(brand.id, image.value.assetId, { status: "hidden" }, { ...meta, expectedVersion: image.version });
    assert.equal(await stageStoredAsset(storage, image.value.assetId, dir, "hidden"), null);
    assert.equal(existsSync(join(dir, "hidden.png")), false);
  }],
  ["narration: a retry in the same dir reuses what is there, and a take whose blob is gone is synthesised again", async () => {
    const { storage, run, repos } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const dir = join(tempDir(), "audio");
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, dir, stubSynth());
    const again = stubSynth();
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, dir, again);
    assert.equal(again.calls.length, 0, "a retry in the same dir neither synthesises nor fails on the files already there");
    // A sidecar left by another narration is not "already here": the card is laid again from the cache over a fresh file.
    writeFileSync(join(dir, "first.json"), JSON.stringify({ hash: "stale", seconds: 9 }));
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, dir, stubSynth());
    assert.equal((JSON.parse(readFileSync(join(dir, "first.json"), "utf8")) as { hash: string }).hash, narrationCacheKey(storyboard.cards[1]!.narration, VOICE));
    const laidDir = join(tempDir(), "audio");
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, laidDir, stubSynth());
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, laidDir, stubSynth());
    // A take that points at a blob nobody has: that card alone is synthesised again, and its new take becomes current.
    const outro = storyboard.cards[3]!;
    const hash = narrationCacheKey(outro.narration, VOICE);
    const lost = await repos.tts.record(storage.brandId, hash, { sha256: "cd" + "0".repeat(62), seconds: 1, voice: {} });
    const healed = stubSynth();
    const fresh = async (text: string, out: string) => healed.synth(`${text} (take 2)`, out); // a real provider returns new bytes
    const messages: string[] = [];
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, join(tempDir(), "audio"), { synth: fresh, probe: healed.probe, report: (m) => messages.push(m) });
    assert.deepEqual(healed.calls, [`${outro.narration} (take 2)`]);
    assert.ok(messages.some((m) => /stored take unusable/.test(m)));
    assert.notEqual((await repos.tts.get(storage.brandId, hash)).sha256, lost.sha256);
  }],
  ["clips: a clip rendered from other inputs is refused at staging, an imported one is left to the duration check", async () => {
    const { storage, run } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const audio = storyboard.cards.map((card) => ({ id: card.id, seconds: 3, source: "mute" as const }));
    const ranges = clipRangesFor(buildTimeline(storyboard, audio).scenes, storyboard.cards.map((c) => c.id));
    const file = join(tempDir(), "c.mp4");
    writeFileSync(file, "clip");
    for (const range of ranges) await recordStoredClip(storage, run.id, range, file, clipInputsHash("old props", range));
    await assert.rejects(() => stageStoredClips(storage, run.id, ranges, join(tempDir(), "clips"), (range) => clipInputsHash("new props", range)), /Re-render it with --card intro/);
    const other = await setup();
    for (const range of ranges) await recordStoredClip(other.storage, other.run.id, range, file, "import:sha256:abc");
    assert.equal((await stageStoredClips(other.storage, other.run.id, ranges, join(tempDir(), "clips"), () => "x")).length, 4);
  }],
  ["export: collisions, identical bytes, give-up and head mismatch", async () => {
    const { storage, store } = await setup();
    const runId = "11111111-1111-4111-8111-111111111111";
    const dir = tempDir();
    const file = join(dir, "r.mp4");
    writeFileSync(file, "mine");
    // A list that cannot see what is there makes every attempt start at v001, as a concurrent render would.
    const blind = (extra: Record<string, unknown> = {}): typeof store =>
      new Proxy(store, {
        get: (target, key) => {
          if (key === "list") return async () => [];
          if (typeof key === "string" && key in extra) return extra[key];
          const value = (target as any)[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const exporter = { ...storage, store: blind() };
    await putAt(store, reelExportKey(storage.brandId, runId, 1), Buffer.from("theirs"));
    assert.equal((await exportStoredReel(exporter, runId, file)).versionNo, 2, "different bytes at v001: it moves to the next free version");
    assert.equal((await exportStoredReel(exporter, runId, file)).versionNo, 2, "identical bytes already at v002 resolve to v002");
    for (let v = 3; v <= 9; v++) await putAt(store, reelExportKey(storage.brandId, runId, v), Buffer.from(`theirs-${v}`));
    const other = join(dir, "o.mp4");
    writeFileSync(other, "another render");
    await assert.rejects(() => exportStoredReel(exporter, runId, other), InvalidInputError, "it gives up after the bounded attempts");
    const lying = { ...storage, store: blind({ head: async () => ({ etag: "e", size: 1, metadata: {} }) }) };
    await assert.rejects(() => exportStoredReel(lying, "22222222-2222-4222-8222-222222222222", file), /did not verify/);
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
  ["a run id is a UUID before it names a temp dir, and an asset id is 16 hex characters", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(assertReelRunId(id), id);
    for (const bad of ["", "../../etc", "123e4567", `${id}/x`, `${id}\n`, "x".repeat(5000)]) {
      assert.throws(() => assertReelRunId(bad), /not a run id/);
    }
    assert.throws(() => assertReelRunId("a".repeat(5000)), (error: Error) => error.message.length < 200, "a long value is cut in the message");
    assert.deepEqual([isStoredAssetId("0123456789abcdef"), isStoredAssetId("0123456789ABCDEF"), isStoredAssetId("short"), isStoredAssetId(undefined)], [true, false, false, false]);
  }],
  ["--out copy: the name carries the run id, an existing file is never overwritten, and another failure says the export is stored", async () => {
    const { storage, run } = await setup();
    const dir = tempDir();
    const file = join(dir, "r.mp4");
    writeFileSync(file, "reel-bytes");
    const exported = await exportStoredReel(storage, run.id, file);
    assert.equal(exported.versionLabel, "v001");
    const name = exportCopyName("2026-09-07", run.id, exported.versionLabel);
    assert.equal(name, `reel-2026-09-07-${run.id.slice(0, 8)}-v001.mp4`);
    assert.notEqual(name, exportCopyName("2026-09-07", "99999999-1111-4111-8111-111111111111", "v001"), "two runs of one period do not collide");
    const out = join(dir, "out");
    assert.equal(copyExportToDir(file, out, name, exported.key).result, "copied");
    assert.equal(copyExportToDir(file, out, name, exported.key).result, "exists-same");
    writeFileSync(join(out, name), "someone else's");
    assert.equal(copyExportToDir(file, out, name, exported.key).result, "exists-different");
    assert.equal(readFileSync(join(out, name), "utf8"), "someone else's", "left as it is");
    assert.deepEqual(readdirSync(out), [name], "no .partial is left behind");
    // A filesystem without hard links: the copy goes straight to the final name, still never overwriting, and no .partial stays.
    const noLinks = (code: string): typeof linkSync => (() => { throw Object.assign(new Error(code), { code }); }) as typeof linkSync;
    for (const code of ["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]) {
      const dirNoLinks = join(dir, `nolinks-${code}`);
      assert.equal(copyExportToDir(file, dirNoLinks, name, exported.key, noLinks(code)).result, "copied");
      assert.deepEqual([readFileSync(join(dirNoLinks, name), "utf8"), readdirSync(dirNoLinks)], ["reel-bytes", [name]]);
      writeFileSync(join(dirNoLinks, name), "someone else's");
    }
    assert.equal(copyExportToDir(file, join(dir, "nolinks-EPERM"), name, exported.key, noLinks("EPERM")).result, "exists-different");
    assert.equal(readFileSync(join(dir, "nolinks-EPERM", name), "utf8"), "someone else's");
    // Any other link failure is an ExportCopyError, and the partial this call created is removed.
    assert.throws(() => copyExportToDir(file, join(dir, "nolinks-EIO"), name, exported.key, noLinks("EIO")), ExportCopyError);
    assert.deepEqual(readdirSync(join(dir, "nolinks-EIO")), []);
    // A stale .partial (not ours) is named in the message and left alone.
    const stale = join(dir, "stale");
    mkdirSync(stale);
    writeFileSync(join(stale, `${name}.partial`), "old");
    assert.throws(() => copyExportToDir(file, stale, name, exported.key), (error: unknown) => error instanceof ExportCopyError && error.message.includes(`${name}.partial`) && /remove it by hand/.test(error.message));
    assert.deepEqual([readdirSync(stale), readFileSync(join(stale, `${name}.partial`), "utf8")], [[`${name}.partial`], "old"]);
    // A destination that cannot be written (the dir is a file) is an ExportCopyError that names the stored export and exits 3.
    const notADir = join(dir, "plain-file");
    writeFileSync(notADir, "x");
    assert.throws(() => copyExportToDir(file, notADir, name, exported.key), (error: unknown) => error instanceof ExportCopyError && error.exitCode === 3 && error.message.includes(exported.key) && /already exported and verified/.test(error.message));
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    try {
      if (process.getuid?.() !== 0) assert.throws(() => copyExportToDir(file, join(dir, "ro"), name, exported.key), ExportCopyError);
    } finally {
      chmodSync(join(dir, "ro"), 0o700);
    }
  }],
  ["narration: a card kept on a same-dir retry records no second take", async () => {
    const { storage, run } = await setup();
    const storyboard = validateStoryboard(STORYBOARD, "stored", 2);
    const dir = join(tempDir(), "audio");
    await synthesiseStoredCards(storage, run.id, storyboard, VOICE, dir, stubSynth());
    let recorded = 0;
    const counting = { ...storage, tts: { ...storage.tts, record: (...args: Parameters<typeof storage.tts.record>) => (recorded++, storage.tts.record(...args)) } } as ReelStorage;
    const retry = stubSynth();
    await synthesiseStoredCards(counting, run.id, storyboard, VOICE, dir, retry);
    assert.deepEqual([retry.calls.length, recorded], [0, 0], "nothing synthesised, no take recorded again");
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
