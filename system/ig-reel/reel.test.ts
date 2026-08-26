/**
 * Runtime tests for the reel engine's load-time guards.
 *
 * Plain `tsx` execution with no framework, matching the carousel's tests. What
 * is worth testing here is the same thing worth testing there: the places
 * where a wrong answer would be *silent* — a pin at the wrong coordinate, a
 * period nobody verified, an unknown key that reads as a working setting, a
 * camera that never actually arrives over the item.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLIP_DURATION_TOLERANCE_SECONDS,
  assertRangesTileComposition,
  clipFileName,
  clipRangesFor,
  concatListContents,
  framesArg,
  validateClipsForAssembly,
  type ExistingClip,
} from "./assemble.js";
import { loadDotEnv } from "./env.js";
import { isInsideBBox, validateBBox, wideFraming, MAX_BBOX_SIDE_DEGREES } from "./geo.js";
import { withCache } from "./osm-cache.js";
import { loadReelRecipe } from "./recipe.js";
import {
  BREATH_SECONDS,
  CAMERA_MOVE_SECONDS,
  CLOSE_ZOOM,
  FPS,
  TIMING,
  activeItemIndex,
  cameraAt,
  closingStart,
  defaultScenes,
  itemStart,
  mapStart,
  opacityBetween,
  resolveScenes,
  totalFrames,
  totalFramesOf,
  totalSeconds,
  totalSecondsOf,
  type Scene,
} from "./remotion/src/timeline.js";
import {
  WORD_BUDGET,
  buildTimeline,
  countWords,
  effectiveVoice,
  narrationCacheKey,
  synthesiseCards,
  validateStoryboard,
  type Storyboard,
} from "./storyboard.js";
import { parseYaml } from "./recipe.js";
import { verifyOrThrow } from "./verify-items.js";
import type { ReelInput } from "./types.js";

let passed = 0;
let failed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throws(run: () => unknown, expected: RegExp, message: string): void {
  try {
    run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert(expected.test(text), `${message}\n       expected /${expected.source}/, got: ${text}`);
    return;
  }
  throw new Error(`${message} — nothing was thrown`);
}

console.log("\nenv — load .env file");

test("missing .env file returns empty list and does not error", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-missing-"));
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 0, "expected no keys loaded");
});

test("a .env with KEY=value is parsed and loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-simple-"));
  writeFileSync(join(dir, ".env"), "TEST_KEY=test_value\n");
  // Clear the key from environment first
  delete process.env.TEST_KEY;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 1 && loaded[0] === "TEST_KEY", `expected ["TEST_KEY"], got ${JSON.stringify(loaded)}`);
  assert(process.env.TEST_KEY === "test_value", `expected test_value, got ${process.env.TEST_KEY}`);
  delete process.env.TEST_KEY;
});

test("double-quoted values have quotes stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-quotes-"));
  writeFileSync(join(dir, ".env"), 'QUOTED="hello world"\n');
  delete process.env.QUOTED;
  loadDotEnv(dir);
  assert(process.env.QUOTED === "hello world", `expected unquoted value, got ${process.env.QUOTED}`);
  delete process.env.QUOTED;
});

test("single-quoted values have quotes stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-single-"));
  writeFileSync(join(dir, ".env"), "SQUOTED='single quoted'\n");
  delete process.env.SQUOTED;
  loadDotEnv(dir);
  assert(process.env.SQUOTED === "single quoted", `expected unquoted value, got ${process.env.SQUOTED}`);
  delete process.env.SQUOTED;
});

test("export KEY=value syntax is recognized", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-export-"));
  writeFileSync(join(dir, ".env"), "export EXPORTED=exported_value\n");
  delete process.env.EXPORTED;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 1, `expected 1 key, got ${loaded.length}`);
  assert(process.env.EXPORTED === "exported_value", `expected exported_value, got ${process.env.EXPORTED}`);
  delete process.env.EXPORTED;
});

test("empty lines are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-empty-"));
  writeFileSync(join(dir, ".env"), "\n\nKEY1=value1\n\n\nKEY2=value2\n\n");
  delete process.env.KEY1;
  delete process.env.KEY2;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 2, `expected 2 keys, got ${loaded.length}`);
  delete process.env.KEY1;
  delete process.env.KEY2;
});

test("lines starting with # are treated as comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-comment-"));
  writeFileSync(join(dir, ".env"), "# This is a comment\nKEY=value\n# Another comment\n");
  delete process.env.KEY;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 1 && loaded[0] === "KEY", `expected ["KEY"], got ${JSON.stringify(loaded)}`);
  delete process.env.KEY;
});

test("environment variables already set are not overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-precedence-"));
  writeFileSync(join(dir, ".env"), "PRECEDENCE=from_file\n");
  process.env.PRECEDENCE = "from_env";
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 0, `expected no keys loaded (env wins), got ${loaded.length}`);
  assert(process.env.PRECEDENCE === "from_env", "environment variable should not be overwritten");
  delete process.env.PRECEDENCE;
});

test("multiple keys on separate lines are all loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-multi-"));
  writeFileSync(join(dir, ".env"), "KEY1=value1\nKEY2=value2\nKEY3=value3\n");
  delete process.env.KEY1;
  delete process.env.KEY2;
  delete process.env.KEY3;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 3, `expected 3 keys, got ${loaded.length}`);
  assert(process.env.KEY1 === "value1", "KEY1 should be loaded");
  assert(process.env.KEY2 === "value2", "KEY2 should be loaded");
  assert(process.env.KEY3 === "value3", "KEY3 should be loaded");
  delete process.env.KEY1;
  delete process.env.KEY2;
  delete process.env.KEY3;
});

test("whitespace around the = is trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-whitespace-"));
  writeFileSync(join(dir, ".env"), "  KEY  =  value_with_spaces  \n");
  delete process.env.KEY;
  const loaded = loadDotEnv(dir);
  assert(loaded.length === 1, `expected 1 key, got ${loaded.length}`);
  assert(process.env.KEY === "value_with_spaces", `expected "value_with_spaces", got "${process.env.KEY}"`);
  delete process.env.KEY;
});

// A bbox roughly one hundredth of a degree, in the southern/western hemisphere
// so the Mercator maths is exercised with negative values.
const BBOX = validateBBox([-23.72, -70.44, -23.58, -70.36]);

console.log("\ngeo — bbox validation");

test("a well-formed bbox round-trips", () => {
  assert(validateBBox([-23.72, -70.44, -23.58, -70.36]).length === 4, "expected four numbers back");
});

test("a bbox with swapped corners is rejected, naming the expected order", () => {
  throws(() => validateBBox([1, 2, -1, -2]), /not a rectangle/, "swapped corners should fail");
});

test("a bbox that is not four numbers is rejected", () => {
  throws(() => validateBBox([1, 2, 3]), /four finite numbers/, "three numbers should fail");
  throws(() => validateBBox(["a", 2, 3, 4]), /four finite numbers/, "a string should fail");
});

test("an oversized bbox fails at load, before any request", () => {
  const side = MAX_BBOX_SIDE_DEGREES + 0.1;
  throws(() => validateBBox([0, 0, side, side]), /longest side/, "an oversized box should fail");
});

test("isInsideBBox rejects a coordinate outside the declared box", () => {
  assert(isInsideBBox(BBOX, -23.65, -70.4), "a point inside should be inside");
  assert(!isInsideBBox(BBOX, -33.45, -70.66), "a point in another city should be outside");
});

console.log("\ngeo — the wide framing the camera starts from");

// Points spread over most of the test bbox, and a cluster in its south half.
const SPREAD_POINTS = [
  { lat: -23.71, lng: -70.43 },
  { lat: -23.6, lng: -70.37 },
  { lat: -23.66, lng: -70.4 },
];
const SOUTH_POINTS = [
  { lat: -23.715, lng: -70.43 },
  { lat: -23.7, lng: -70.42 },
  { lat: -23.69, lng: -70.41 },
];

/** The same fit formula as the engine's, as an independent oracle for the clamp. */
function bboxFitZoom(bbox: readonly [number, number, number, number]): number {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
  const latFrac = (mercY(latMax) - mercY(latMin)) / (2 * Math.PI);
  const zoomForWidth = Math.log2(((1080 / 512) * 360) / (lonMax - lonMin));
  const zoomForHeight = Math.log2(1920 / 512 / latFrac);
  return Math.min(zoomForWidth, zoomForHeight) - 0.3;
}

test("wideFraming yields a city-scale zoom with its centre inside the bbox", () => {
  const wide = wideFraming(BBOX, SPREAD_POINTS);
  assert(Number.isFinite(wide.zoom), "zoom must be a finite number");
  assert(wide.zoom > 10 && wide.zoom < 15, `expected a city-scale zoom between 10 and 15, got ${wide.zoom}`);
  const [lng, lat] = wide.center;
  assert(isInsideBBox(BBOX, lat, lng), `centre (${lat}, ${lng}) must fall inside the bbox`);
  const [lonSpan, latSpan] = wide.span;
  // The span is the frame's own: the points' box inflated ×1.4 (above the floor here).
  assert(Math.abs(lonSpan - 0.06 * 1.4) < 1e-9, `lonSpan must be the padded points span, got ${lonSpan}`);
  assert(Math.abs(latSpan - 0.11 * 1.4) < 1e-9, `latSpan must be the padded points span, got ${latSpan}`);
});

test("items clustered in the south half pull the frame onto them, closer than the bbox fit", () => {
  const wide = wideFraming(BBOX, SOUTH_POINTS);
  const [lng, lat] = wide.center;
  assert(
    lat >= -23.715 && lat <= -23.69 && lng >= -70.43 && lng <= -70.41,
    `centre (${lat}, ${lng}) must fall inside the points' own bounding box, not the bbox's midpoint`,
  );
  assert(
    wide.zoom > bboxFitZoom(BBOX),
    `a clustered week must open closer than the whole-bbox fit (${bboxFitZoom(BBOX).toFixed(2)}), got ${wide.zoom}`,
  );
});

test("a single point hits the half-span floor: finite zoom, still a wide shot", () => {
  const wide = wideFraming(BBOX, [{ lat: -23.66, lng: -70.4 }]);
  assert(Number.isFinite(wide.zoom), `zoom must be finite for one point, got ${wide.zoom}`);
  assert(wide.zoom <= 14, `one point must not zoom past 14, got ${wide.zoom}`);
  const [lonSpan, latSpan] = wide.span;
  assert(Math.abs(lonSpan - 0.07) < 1e-9 && Math.abs(latSpan - 0.07) < 1e-9, "the floor gives a 0.07° frame");
});

test("no points is a legible error, not a NaN camera", () => {
  throws(() => wideFraming(BBOX, []), /at least one verified item/, "empty points should fail");
});

test("the zoom never falls below the fit of the declared bbox", () => {
  // Points at the bbox corners: padded they overflow it, so the clamp engages.
  const corners = [
    { lat: -23.72, lng: -70.44 },
    { lat: -23.58, lng: -70.36 },
  ];
  const wide = wideFraming(BBOX, corners);
  assert(
    wide.zoom >= Number(bboxFitZoom(BBOX).toFixed(2)),
    `zoom must never be farther out than the declared city (${bboxFitZoom(BBOX).toFixed(2)}), got ${wide.zoom}`,
  );
});

console.log("\ntimeline — the rhythm the render actually runs");

test("a four-item reel is 24.2s / 726 frames long", () => {
  assert(totalSeconds(4) === 24.2, `expected 24.2s, got ${totalSeconds(4)}`);
  assert(totalFrames(4) === 726, `expected 726 frames, got ${totalFrames(4)}`);
});

test("the camera starts wide and arrives over the item at street zoom", () => {
  const wide = wideFraming(BBOX, SPREAD_POINTS);
  const target = { lng: -70.4, lat: -23.65 };
  const atStart = cameraAt(mapStart(0), wide, [target]);
  assert(
    Math.abs(atStart.zoom - wide.zoom) < 1e-9,
    `at the map scene's first frame the zoom must be the wide framing's, got ${atStart.zoom} vs ${wide.zoom}`,
  );
  const arrived = cameraAt(mapStart(0) + CAMERA_MOVE_SECONDS, wide, [target]);
  assert(
    arrived.center[0] === target.lng && arrived.center[1] === target.lat,
    `after the move the camera must sit on the item, got ${JSON.stringify(arrived.center)}`,
  );
  assert(arrived.zoom === CLOSE_ZOOM, `after the move the zoom must be CLOSE_ZOOM, got ${arrived.zoom}`);
});

console.log("\nassemble — per-card clips that tile the composition exactly");

// A small four-scene timeline (cover, two items, closing) with derived
// durations, mirroring what buildTimeline() would hand the render step.
function fourSceneTimeline(): { scenes: Scene[]; cardIds: string[] } {
  const scenes = resolveScenes([
    { kind: "cover", narrationSeconds: 1.6 },
    { kind: "item", itemIndex: 0, narrationSeconds: 6.3 },
    { kind: "item", itemIndex: 1, narrationSeconds: 4, minSeconds: 6 },
    { kind: "closing", narrationSeconds: 2.4 },
  ]);
  return { scenes, cardIds: ["cover", "item-1", "item-2", "closing"] };
}

test("clip ranges cover the whole composition with no gaps or overlaps", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  assert(ranges.length === 4, `expected 4 ranges, got ${ranges.length}`);
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  assertRangesTileComposition(ranges, totalFramesExpected);
});

test("each clip's start frame is exactly its scene's start, rounded", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  ranges.forEach((range, index) => {
    const expected = Math.round(scenes[index]!.start * FPS);
    assert(
      range.startFrame === expected,
      `card ${range.cardId}: expected start frame ${expected}, got ${range.startFrame}`,
    );
  });
});

test("the last clip reaches the final frame of the composition", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  assert(
    ranges[ranges.length - 1]!.endFrame === totalFramesExpected - 1,
    `expected the last clip to end at frame ${totalFramesExpected - 1}, got ${ranges[ranges.length - 1]!.endFrame}`,
  );
});

test("a mismatched card id / scene count is rejected before any range is computed", () => {
  const { scenes } = fourSceneTimeline();
  throws(
    () => clipRangesFor(scenes, ["cover", "item-1"]),
    /parallel lists/,
    "expected a length-mismatch error",
  );
});

test("an empty scene list is rejected rather than producing an empty video", () => {
  throws(() => clipRangesFor([], []), /no scenes/, "expected an empty-timeline error");
});

test("framesArg formats the remotion --frames range", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  assert(framesArg(ranges[0]!) === `${ranges[0]!.startFrame}-${ranges[0]!.endFrame}`, "expected start-end");
});

test("clip file names sort in scene order with a zero-padded index", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const names = ranges.map((r) => clipFileName(r, ranges.length));
  assert(
    JSON.stringify(names) === JSON.stringify(["0-cover.mp4", "1-item-1.mp4", "2-item-2.mp4", "3-closing.mp4"]),
    `unexpected file names: ${JSON.stringify(names)}`,
  );
  const sorted = [...names].sort();
  assert(JSON.stringify(sorted) === JSON.stringify(names), "file names must sort into scene order");
});

test("assertRangesTileComposition catches a gap between two clips", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const withGap = ranges.map((r, i) => (i === 2 ? { ...r, startFrame: r.startFrame + 1 } : r));
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  throws(
    () => assertRangesTileComposition(withGap, totalFramesExpected),
    /item-2 starts at frame/,
    "expected a gap to be caught",
  );
});

test("assertRangesTileComposition catches an overlap between two clips", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const withOverlap = ranges.map((r, i) => (i === 1 ? { ...r, endFrame: r.endFrame + 1 } : r));
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  throws(
    () => assertRangesTileComposition(withOverlap, totalFramesExpected),
    /item-2 starts at frame/,
    "expected an overlap to be caught",
  );
});

test("assertRangesTileComposition catches a first clip that doesn't start at frame 0", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const shifted = ranges.map((r, i) => (i === 0 ? { ...r, startFrame: 1 } : r));
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  throws(
    () => assertRangesTileComposition(shifted, totalFramesExpected),
    /first clip starts at frame 1, expected 0/,
    "expected a non-zero start to be caught",
  );
});

test("assertRangesTileComposition catches a last clip that falls short of the total", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const short = ranges.map((r, i) => (i === ranges.length - 1 ? { ...r, endFrame: r.endFrame - 1 } : r));
  const totalFramesExpected = Math.round(scenes[scenes.length - 1]!.end * FPS);
  throws(
    () => assertRangesTileComposition(short, totalFramesExpected),
    /last clip ends at frame/,
    "expected a short final clip to be caught",
  );
});

console.log("\nassemble — validating clips already on disk before concatenating");

function existingClip(cardId: string, path: string, seconds: number | undefined): ExistingClip {
  return { cardId, path, exists: seconds !== undefined, measuredSeconds: seconds };
}

test("a full, correctly-sized set of clips validates without error", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.map((r) =>
    existingClip(r.cardId, `/clips/${r.cardId}.mp4`, (r.endFrame - r.startFrame + 1) / FPS),
  );
  validateClipsForAssembly(ranges, clips); // must not throw
});

test("a missing clip fails naming its card id, not a generic message", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.map((r, i) =>
    i === 2
      ? existingClip(r.cardId, `/clips/${r.cardId}.mp4`, undefined)
      : existingClip(r.cardId, `/clips/${r.cardId}.mp4`, (r.endFrame - r.startFrame + 1) / FPS),
  );
  throws(
    () => validateClipsForAssembly(ranges, clips),
    /card "item-2"/,
    "expected the missing clip's card id to be named",
  );
});

test("a clip whose duration doesn't match the current timeline fails naming its card id", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.map((r, i) =>
    i === 1
      ? existingClip(r.cardId, `/clips/${r.cardId}.mp4`, (r.endFrame - r.startFrame + 1) / FPS + 1)
      : existingClip(r.cardId, `/clips/${r.cardId}.mp4`, (r.endFrame - r.startFrame + 1) / FPS),
  );
  throws(
    () => validateClipsForAssembly(ranges, clips),
    /card "item-1" is.*expects/s,
    "expected the mismatched clip's card id and expectation to be named",
  );
});

test("a duration within one frame of tolerance is accepted", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.map((r) =>
    existingClip(
      r.cardId,
      `/clips/${r.cardId}.mp4`,
      (r.endFrame - r.startFrame + 1) / FPS + CLIP_DURATION_TOLERANCE_SECONDS * 0.5,
    ),
  );
  validateClipsForAssembly(ranges, clips); // must not throw
});

test("clips out of scene order are rejected rather than silently concatenated wrong", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.map((r) => existingClip(r.cardId, `/clips/${r.cardId}.mp4`, (r.endFrame - r.startFrame + 1) / FPS));
  const shuffled = [clips[0]!, clips[2]!, clips[1]!, clips[3]!];
  throws(
    () => validateClipsForAssembly(ranges, shuffled),
    /expected card "item-1" at position 1, got "item-2"/,
    "expected the position and both card ids to be named",
  );
});

test("a clip-count mismatch is rejected up front", () => {
  const { scenes, cardIds } = fourSceneTimeline();
  const ranges = clipRangesFor(scenes, cardIds);
  const clips = ranges.slice(0, 2).map((r) => existingClip(r.cardId, `/clips/${r.cardId}.mp4`, 1));
  throws(
    () => validateClipsForAssembly(ranges, clips),
    /2 clip\(s\) given for 4 scene\(s\)/,
    "expected a count-mismatch error",
  );
});

test("concatListContents produces one quoted `file` line per clip, in order", () => {
  const contents = concatListContents(["/clips/0-cover.mp4", "/clips/1-item-1.mp4"]);
  assert(
    contents === "file '/clips/0-cover.mp4'\nfile '/clips/1-item-1.mp4'\n",
    `unexpected concat list contents: ${JSON.stringify(contents)}`,
  );
});

test("concatListContents rejects an empty clip list", () => {
  throws(() => concatListContents([]), /no clips/, "expected an empty-list error");
});

console.log("\nosm-cache — the network is not a dependency of every run");

await (async () => {
  const asyncTest = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      console.log(`  ok   ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  };

  // Unique per run so these never collide with a real cached response.
  const uniqueKey = (suffix: string): string => `test:${process.pid}:${suffix}`;

  await asyncTest("a second call is served from the cache, without fetching", async () => {
    let fetches = 0;
    const key = uniqueKey("hit");
    const fetcher = async (): Promise<number> => {
      fetches += 1;
      return 42;
    };
    assert((await withCache(key, "probe", fetcher)) === 42, "expected the fetched value");
    assert((await withCache(key, "probe", fetcher)) === 42, "expected the cached value");
    assert(fetches === 1, `expected exactly one fetch, got ${fetches}`);
  });

  await asyncTest("--no-cache refetches even when a fresh entry exists", async () => {
    let fetches = 0;
    const key = uniqueKey("nocache");
    const fetcher = async (): Promise<number> => {
      fetches += 1;
      return fetches;
    };
    await withCache(key, "probe", fetcher);
    await withCache(key, "probe", fetcher, { noCache: true });
    assert(fetches === 2, `expected two fetches, got ${fetches}`);
  });

  await asyncTest("an expired entry is refetched", async () => {
    let fetches = 0;
    const key = uniqueKey("expired");
    const fetcher = async (): Promise<number> => {
      fetches += 1;
      return fetches;
    };
    await withCache(key, "probe", fetcher);
    await withCache(key, "probe", fetcher, { ttlMs: -1 });
    assert(fetches === 2, `expected the expired entry to be refetched, got ${fetches}`);
  });

  await asyncTest("upstream failure falls back to an expired entry, and says so", async () => {
    // The behaviour that stops a public service's downtime from being this
    // engine's downtime. A dead cache must not mean a dead render.
    const key = uniqueKey("fallback");
    await withCache(key, "probe", async () => "stored");
    const messages: string[] = [];
    const value = await withCache(
      key,
      "probe",
      async () => {
        throw new Error("upstream is down");
      },
      { ttlMs: -1, report: (m) => messages.push(m) },
    );
    assert(value === "stored", "expected the expired entry to be served");
    assert(
      messages.some((m) => /expired cache/.test(m)),
      `expected the staleness to be announced, got: ${JSON.stringify(messages)}`,
    );
  });

  await asyncTest("with no entry at all, an upstream failure still throws", async () => {
    await withCache(uniqueKey("nofallback"), "probe", async () => {
      throw new Error("upstream is down");
    }).then(
      () => {
        throw new Error("expected the failure to propagate");
      },
      (error: unknown) => {
        assert(/upstream is down/.test(String(error)), "expected the original error");
      },
    );
  });
})();

console.log("\nverify-items — the pre-render guard");

const ITEM = {
  title: "An item",
  date: "2026-08-10",
  when: "Mon 10",
  where: "Somewhere",
  image: "https://images.example.org/a.jpg",
  category: "music",
  lat: -23.65,
  lng: -70.4,
  mapLabel: "Somewhere",
};

const PERIOD = { start: "2026-08-10", end: "2026-08-16" };

function input(overrides: Partial<ReelInput> = {}): ReelInput {
  return { city: "A city", items: [{ ...ITEM }], ...overrides };
}

test("a valid item survives", () => {
  const kept = verifyOrThrow({ input: input(), inputPath: "test.json", bbox: BBOX, period: PERIOD });
  assert(kept.length === 1, "expected the item to survive");
});

test("an item dated outside the period is dropped, not rendered", () => {
  const items = [{ ...ITEM }, { ...ITEM, title: "Last week", date: "2026-08-03" }];
  const kept = verifyOrThrow({ input: input({ items }), inputPath: "test.json", bbox: BBOX, period: PERIOD });
  assert(kept.length === 1, `expected 1 survivor, got ${kept.length}`);
});

test("0-of-N dated items throws instead of reading as 'all passed'", () => {
  // The exact state the original defect shipped in: every undated item passes
  // its own check, so nothing-verified looked identical to all-verified.
  const items = [{ ...ITEM, date: "" }, { ...ITEM, date: "" }];
  throws(
    () => verifyOrThrow({ input: input({ items }), inputPath: "test.json", bbox: BBOX, period: PERIOD }),
    /Cannot verify/,
    "an entirely undated batch should refuse to render",
  );
});

test("a date that rolls over the month is not accepted", () => {
  const items = [{ ...ITEM, date: "2026-02-31" }];
  throws(
    () => verifyOrThrow({ input: input({ items }), inputPath: "test.json", bbox: BBOX, period: PERIOD }),
    /Cannot verify/,
    "Feb 31 should not parse as March 3",
  );
});

test("an item whose pin falls outside the bbox is dropped", () => {
  const items = [{ ...ITEM }, { ...ITEM, title: "Another city", lat: -33.45, lng: -70.66 }];
  const kept = verifyOrThrow({ input: input({ items }), inputPath: "test.json", bbox: BBOX, period: PERIOD });
  assert(kept.length === 1, `expected the far item to be dropped, got ${kept.length} survivors`);
});

test("an item with no coordinate is dropped rather than defaulted to the centre", () => {
  const items = [{ ...ITEM, lat: undefined as unknown as number, lng: undefined as unknown as number }];
  throws(
    () => verifyOrThrow({ input: input({ items }), inputPath: "test.json", bbox: BBOX, period: PERIOD }),
    /No item .* survived/,
    "a coordinate-less item must not be placed at the bbox centre",
  );
});

test("an image from an undeclared host is dropped", () => {
  const items = [{ ...ITEM, image: "https://elsewhere.example.net/a.jpg" }];
  throws(
    () =>
      verifyOrThrow({
        input: input({ items, sourceImageHosts: ["images.example.org"] }),
        inputPath: "test.json",
        bbox: BBOX,
        period: PERIOD,
      }),
    /No item .* survived/,
    "an off-allowlist image should be rejected",
  );
});

test("a local image path is not held to the host allowlist", () => {
  // The allowlist draws a boundary around *fetched* URLs. A file the profile
  // owner placed in their own folder has no host and is already inside it —
  // holding it to the list would reject every profile-supplied asset.
  const items = [{ ...ITEM, image: "assets/reel/item1.jpg" }];
  const kept = verifyOrThrow({
    input: input({ items, sourceImageHosts: ["images.example.org"] }),
    inputPath: "test.json",
    bbox: BBOX,
    period: PERIOD,
  });
  assert(kept.length === 1, "a local asset should survive the host check");
});

test("a remote image is still checked when local ones are allowed", () => {
  const items = [{ ...ITEM, image: "https://elsewhere.example.net/a.jpg" }];
  throws(
    () =>
      verifyOrThrow({
        input: input({ items, sourceImageHosts: ["images.example.org"] }),
        inputPath: "test.json",
        bbox: BBOX,
        period: PERIOD,
      }),
    /No item .* survived/,
    "exempting local paths must not exempt remote URLs",
  );
});

test("an empty sourceImageHosts is an error, not 'allow nothing'", () => {
  throws(
    () =>
      verifyOrThrow({
        input: input({ sourceImageHosts: [] }),
        inputPath: "test.json",
        bbox: BBOX,
        period: PERIOD,
      }),
    /omit the key/,
    "an empty allowlist should name the way out",
  );
});

test("a wildcard host is rejected rather than read as 'anywhere'", () => {
  throws(
    () =>
      verifyOrThrow({
        input: input({ sourceImageHosts: ["*"] }),
        inputPath: "test.json",
        bbox: BBOX,
        period: PERIOD,
      }),
    /literal hosts, not wildcards/,
    "a wildcard would leave the check looking active while permitting everything",
  );
});

console.log("\nrecipe — fails at load, never silently");

function withRecipe(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reel-recipe-"));
  mkdirSync(join(dir, "recipes"), { recursive: true });
  writeFileSync(join(dir, "recipes", "reel-week.yaml"), body);
  return dir;
}

const VALID = `recipe: reel-week
version: 1
source:
  kind: http_json
  url: https://api.example.org/items
curation:
  count: 4
  guidance: |
    Prose that the engine treats as data.
map:
  bbox: [-23.72, -70.44, -23.58, -70.36]
  reference_types:
    - mall
    - hospital
render:
  script: render-reel-week
`;

test("a valid recipe parses, including the block scalar and the flow list", () => {
  const recipe = loadReelRecipe(withRecipe(VALID));
  assert(recipe.version === 1, "expected version 1");
  assert(Array.isArray(recipe.map.bbox) && recipe.map.bbox.length === 4, "expected a four-number bbox");
  assert(
    typeof recipe.curation?.guidance === "string" && recipe.curation.guidance.includes("data"),
    "expected the block scalar to be captured",
  );
});

test("a recipe with reference_types still loads — deprecated, not rejected", () => {
  // Existing profiles declare them for the retired SVG renderer. Breaking
  // every recipe over a key the engine now merely ignores would make an
  // engine upgrade a profile migration.
  const recipe = loadReelRecipe(withRecipe(VALID));
  assert(
    Array.isArray(recipe.map.reference_types) && recipe.map.reference_types.length === 2,
    "the deprecated key must still parse for compatibility",
  );
});

test("a recipe without reference_types loads — only the bbox is required", () => {
  const stripped = VALID.replace("  reference_types:\n    - mall\n    - hospital\n", "");
  const recipe = loadReelRecipe(withRecipe(stripped));
  assert(recipe.map.reference_types === undefined, "reference_types must be optional");
  assert(Array.isArray(recipe.map.bbox), "the bbox must still be read");
});

test("a missing recipe names the contract to read", () => {
  throws(
    () => loadReelRecipe(mkdtempSync(join(tmpdir(), "reel-empty-"))),
    /system\/recipes\/reel-week\.md/,
    "a missing recipe should point at the contract",
  );
});

test("an unsupported version names what the engine supports", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("version: 1", "version: 7"))),
    /this engine supports/,
    "a future version should fail clearly",
  );
});

test("an unsupported source.kind is refused — no shell, no exec, no rss", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("kind: http_json", "kind: shell"))),
    /this engine supports: http_json, local_json/,
    "a profile must not be able to declare execution",
  );
});

test("a non-https source.url is refused", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("https://api.example.org/items", "http://api.example.org/items"))),
    /must be an https/,
    "plain http should be rejected",
  );
});

test("render.script cannot be an arbitrary path", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("script: render-reel-week", "script: ../../evil.ts"))),
    /this engine supports/,
    "a profile must pick from the table, not name a path",
  );
});

test("an unknown key is an error, not silently ignored", () => {
  throws(
    () => loadReelRecipe(withRecipe(`${VALID}post_render: rm -rf /\n`)),
    /unknown key/,
    "an unknown key may be an attempt to declare behaviour",
  );
});

test("an unknown nested key is caught too", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("  script: render-reel-week", "  script: render-reel-week\n  command: whoami"))),
    /unknown key "render.command"/,
    "nested keys need the same treatment as top-level ones",
  );
});

test("curation.count outside 2..6 fails, explaining why the range exists", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("count: 4", "count: 12"))),
    /between 2 and 6/,
    "12 items would run far past a reel's attention span",
  );
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("count: 4", "count: 1"))),
    /between 2 and 6/,
    "1 item does not read as a tour",
  );
});

test("a two-item week loads — a thin source is an outcome, not an error", () => {
  // The floor was 3, and a week with two verifiable items had to be padded
  // with an unverifiable one to render at all. That is the exact failure the
  // verification stage exists to prevent, so the floor gave way instead.
  const recipe = loadReelRecipe(withRecipe(VALID.replace("count: 4", "count: 2")));
  assert(recipe.curation?.count === 2, "two items must be a legal week");
});

test("a recipe with no voice block still loads — narration is opt-in", () => {
  const recipe = loadReelRecipe(withRecipe(VALID));
  assert(recipe.voice === undefined, "a profile that never narrates declares nothing");
});

test("voice.voice_id is required once a voice block exists", () => {
  throws(
    () => loadReelRecipe(withRecipe(`${VALID}\nvoice:\n  model_id: eleven_multilingual_v2\n`)),
    /voice_id must be a non-empty string/,
    "the engine never picks a voice for a brand",
  );
  throws(
    () => loadReelRecipe(withRecipe(`${VALID}\nvoice:\n  voice_id: "   "\n`)),
    /voice_id must be a non-empty string/,
    "blank is not a voice id",
  );
});

test("a valid voice block parses", () => {
  const recipe = loadReelRecipe(
    withRecipe(`${VALID}\nvoice:\n  voice_id: abc123\n  stability: 0.4\n`),
  );
  assert(recipe.voice?.voice_id === "abc123", "the voice id reaches the engine");
  assert(recipe.voice?.stability === 0.4, "tuning is carried through");
});

test("voice tuning outside 0..1 fails at load, not mid-render", () => {
  throws(
    () => loadReelRecipe(withRecipe(`${VALID}\nvoice:\n  voice_id: abc\n  stability: 4\n`)),
    /between 0 and 1/,
    "4 is not a valid stability",
  );
});

test("an unknown key under voice is an error, like everywhere else", () => {
  throws(
    () => loadReelRecipe(withRecipe(`${VALID}\nvoice:\n  voice_id: abc\n  api_key: sk-leak\n`)),
    /unknown key/,
    "a credential in a profile file must not be read as configuration",
  );
});


console.log("\nstoryboard — validation fails naming the card");

const CARDS_OK = `storyboard: reel
version: 1
cards:
  - id: cover
    visual: cover
    narration: "The plans for this week, all in one place."
  - id: item-1
    visual: item
    item: 0
    narration: "On Tuesday, live music on the waterfront — bring a jacket, it gets windy."
  - id: item-2
    visual: item
    item: 1
    narration: |
      On Thursday the print fair takes over the square, with #1 prints
      straight from the artists.
    min_seconds: 6
  - id: closing
    visual: closing
    narration: "Save this reel and see you there."
`;

function storyboardOf(text: string, itemCount = 3): Storyboard {
  return validateStoryboard(parseYaml(text, "storyboard.yaml"), "storyboard.yaml", itemCount);
}

test("a valid storyboard parses: list of maps, quoted and block narrations", () => {
  const sb = storyboardOf(CARDS_OK);
  assert(sb.cards.length === 4, `expected 4 cards, got ${sb.cards.length}`);
  assert(sb.cards[1]!.item === 0 && sb.cards[2]!.item === 1, "item indices must be carried");
  assert(sb.cards[2]!.min_seconds === 6, "min_seconds must be carried");
  assert(sb.cards[2]!.narration.includes("#1 prints"), "a # inside a block scalar is text");
  assert(sb.cards[0]!.narration === "The plans for this week, all in one place.", "quoted narration is taken whole");
});

test("a # inside a quoted narration is text, not a comment", () => {
  const sb = storyboardOf(CARDS_OK.replace('"Save this reel and see you there."', '"Save this reel, #1 plan, see you there."'));
  assert(sb.cards[3]!.narration.includes("#1 plan"), `got ${JSON.stringify(sb.cards[3]!.narration)}`);
});

test("storyboard/version must be exact", () => {
  throws(() => storyboardOf(CARDS_OK.replace("storyboard: reel", "storyboard: carousel")), /"storyboard" must be "reel"/, "kind");
  throws(() => storyboardOf(CARDS_OK.replace("version: 1", "version: 2")), /this engine supports: 1/, "version");
});

test("duplicate ids are rejected, naming the card", () => {
  throws(() => storyboardOf(CARDS_OK.replace("id: item-2", "id: item-1")), /card item-1: duplicate id/, "dup id");
});

test("an unknown visual is rejected", () => {
  throws(() => storyboardOf(CARDS_OK.replace("visual: item\n    item: 1", "visual: map\n    item: 1")), /card item-2: "visual" must be one of cover \| item \| closing/, "visual enum");
});

test("exactly one cover first and one closing last", () => {
  const noCover = CARDS_OK.replace("  - id: cover\n    visual: cover\n    narration: \"The plans for this week, all in one place.\"\n", "");
  throws(() => storyboardOf(noCover), /card item-1: the first card must be visual=cover/, "missing cover");
  const twoClosings = CARDS_OK.replace("    min_seconds: 6\n", "    min_seconds: 6\n  - id: closing-a\n    visual: closing\n    narration: \"And that is the week, friends.\"\n");
  throws(() => storyboardOf(twoClosings), /only one closing card/, "two closings");
});

test("between 2 and 6 item cards", () => {
  const one = CARDS_OK.replace("  - id: item-2\n    visual: item\n    item: 1\n    narration: |\n      On Thursday the print fair takes over the square, with #1 prints\n      straight from the artists.\n    min_seconds: 6\n", "");
  throws(() => storyboardOf(one), /1 item card\(s\); a reel needs between 2 and 6/, "one item");
});

test("an item card must reference a valid, distinct index", () => {
  throws(() => storyboardOf(CARDS_OK.replace("item: 1", "item: 7")), /card item-2: "item" must be an integer index .*\(0\.\.2\)/, "out of range");
  throws(() => storyboardOf(CARDS_OK.replace("item: 1", "item: 0")), /card item-2: item 0 is already used by card item-1/, "duplicate item");
  throws(() => storyboardOf(CARDS_OK.replace("    item: 1\n", "")), /card item-2: "item" must be an integer index/, "missing item");
});

test("unknown keys are errors, at the root and on a card", () => {
  throws(() => storyboardOf(`${CARDS_OK}music: loud\n`), /unknown key "music"/, "root");
  throws(() => storyboardOf(CARDS_OK.replace("    min_seconds: 6\n", "    min_seconds: 6\n    camera: fly\n")), /card item-2: unknown key "camera"/, "card");
});

test("narration must exist; empty string is a mute card", () => {
  throws(() => storyboardOf(CARDS_OK.replace('    narration: "Save this reel and see you there."\n', "")), /card closing: "narration" must be a string/, "missing");
  const mute = storyboardOf(CARDS_OK.replace('"Save this reel and see you there."', '""'));
  assert(mute.cards[3]!.words === 0 && mute.cards[3]!.narration === "", "a mute card has 0 words");
});

console.log("\nstoryboard — word count and budget");

test("countWords ignores punctuation-only tokens and counts accented words", () => {
  assert(countWords("El miércoles, Iván — en Farolito.") === 5, `got ${countWords("El miércoles, Iván — en Farolito.")}`);
  assert(countWords("   ") === 0, "blank is zero");
});

test("a card over budget fails with the real count and the cap", () => {
  const long = Array.from({ length: 41 }, (_, i) => `word${i}`).join(" ");
  throws(() => storyboardOf(CARDS_OK.replace("On Tuesday, live music on the waterfront — bring a jacket, it gets windy.", long)), /card item-1: 41 words, max 30 for visual=item/, "over");
  throws(() => storyboardOf(CARDS_OK.replace("The plans for this week, all in one place.", "Hey there")), /card cover: 2 words, min 4 for visual=cover/, "under");
  assert(WORD_BUDGET.item.max === 30 && WORD_BUDGET.cover.min === 4, "budget constants are the documented ones");
});

console.log("\ntimeline — derived from the audio, or the fixed rhythm without it");

test("without a storyboard the scene list reproduces the fixed rhythm exactly", () => {
  for (const count of [2, 3, 4, 6]) {
    const scenes = resolveScenes(defaultScenes(count));
    assert(Math.abs(totalSecondsOf(scenes) - totalSeconds(count)) < 1e-9, `total for ${count} items: ${totalSecondsOf(scenes)} vs ${totalSeconds(count)}`);
    assert(totalFramesOf(scenes) === totalFrames(count), `frames for ${count}`);
    const items = scenes.filter((s) => s.kind === "item");
    items.forEach((s, i) => {
      assert(Math.abs(s.start - mapStart(i)) < 1e-9, `map start ${i}`);
      assert(Math.abs(s.start + TIMING.map - itemStart(i)) < 1e-9, `item start ${i}`);
    });
    assert(Math.abs(scenes[scenes.length - 1]!.start - closingStart(count)) < 1e-9, `closing start for ${count}`);
  }
});

test("short narration falls back to the minimums; long narration extends and starts accumulate", () => {
  const short = resolveScenes([
    { kind: "cover", narrationSeconds: 1 },
    { kind: "item", itemIndex: 0, narrationSeconds: 2 },
    { kind: "item", itemIndex: 1, narrationSeconds: 4.2 },
    { kind: "closing", narrationSeconds: 1 },
  ]);
  assert(short[0]!.duration === TIMING.cover, "a 1s cover narration keeps the 2.2s cover");
  assert(short[1]!.duration === TIMING.map + TIMING.item, "a 2s item narration keeps the 5s item scene");
  assert(short[2]!.duration === TIMING.map + TIMING.item, "4.2s + breath (4.6s) is still under the 5s floor");
  assert(short[3]!.duration === TIMING.closing, "closing at floor");

  const long = resolveScenes([
    { kind: "cover", narrationSeconds: 3 },
    { kind: "item", itemIndex: 0, narrationSeconds: 7 },
    { kind: "item", itemIndex: 1, narrationSeconds: 2, minSeconds: 6.5 },
    { kind: "closing", narrationSeconds: 2.5 },
  ]);
  assert(Math.abs(long[0]!.duration - (3 + BREATH_SECONDS)) < 1e-9, `cover grows to narration+breath, got ${long[0]!.duration}`);
  assert(Math.abs(long[1]!.duration - (7 + BREATH_SECONDS)) < 1e-9, `item grows to narration+breath, got ${long[1]!.duration}`);
  assert(long[2]!.duration === 6.5, `min_seconds raises the floor, got ${long[2]!.duration}`);
  assert(Math.abs(long[3]!.duration - (2.5 + BREATH_SECONDS)) < 1e-9, "closing grows");
  let cursor = 0;
  for (const scene of long) {
    assert(Math.abs(scene.start - cursor) < 1e-9, `scene ${scene.kind} starts at ${scene.start}, expected ${cursor}`);
    cursor += scene.duration;
  }
  assert(Math.abs(totalSecondsOf(long) - cursor) < 1e-9, "total is the last end");
});

test("the camera follows the derived scenes: it leaves for item 2 when its scene starts", () => {
  const wide = wideFraming(BBOX, SPREAD_POINTS);
  const targets = [{ lng: -70.4, lat: -23.65 }, { lng: -70.42, lat: -23.7 }];
  const scenes = resolveScenes([
    { kind: "cover", narrationSeconds: 3 },
    { kind: "item", itemIndex: 0, narrationSeconds: 8 },
    { kind: "item", itemIndex: 1 },
    { kind: "closing" },
  ]);
  const second = scenes[2]!;
  assert(activeItemIndex(second.start - 0.01, 2, scenes) === 0, "just before item 2 the camera is still on item 1");
  assert(activeItemIndex(second.start, 2, scenes) === 1, "item 2 becomes active at its start");
  const atStart = cameraAt(second.start, wide, targets, scenes);
  assert(Math.abs(atStart.zoom - wide.zoom) < 1e-9, "the flight to item 2 begins wide");
  const arrived = cameraAt(second.start + CAMERA_MOVE_SECONDS, wide, targets, scenes);
  assert(arrived.center[0] === targets[1]!.lng && arrived.zoom === CLOSE_ZOOM, "and lands on item 2 at street zoom");
  // Without scenes, the legacy signature still answers the fixed rhythm.
  assert(activeItemIndex(mapStart(1), 2) === 1, "legacy activeItemIndex unchanged");
});

test("buildTimeline maps cards to scenes, orders items by card, and folds the music intro into the cover", () => {
  const sb = storyboardOf(CARDS_OK.replace("item: 0", "item: 2").replace("item: 1", "item: 0"));
  const audio = [
    { id: "cover", seconds: 1.2, source: "synthesised" as const },
    { id: "item-1", seconds: 6.1, source: "synthesised" as const },
    { id: "item-2", seconds: 3, source: "synthesised" as const },
    { id: "closing", seconds: 0, source: "mute" as const },
  ];
  const tl = buildTimeline(sb, audio, 2.5);
  assert(tl.cards[0]!.narrationOffset === 2.5 && Math.abs(tl.cards[0]!.duration - (2.5 + 1.2 + BREATH_SECONDS)) < 1e-9, `cover holds the intro: ${tl.cards[0]!.duration}`);
  assert(Math.abs(tl.cards[1]!.duration - (6.1 + BREATH_SECONDS)) < 1e-9, "item-1 grows");
  assert(tl.cards[2]!.duration === 6, "item-2 respects min_seconds 6 over 3s of narration");
  assert(tl.cards[3]!.duration === TIMING.closing && tl.cards[3]!.narrationSeconds === 0, "mute closing at floor");
  assert(tl.scenes[1]!.itemIndex === 0 && tl.scenes[2]!.itemIndex === 1, "scene itemIndex is the position among item cards, not the input index");
  assert(tl.cards[1]!.item === 2 && tl.cards[2]!.item === 0, "timeline.json keeps the input reference");
  assert(Math.abs(tl.total - tl.scenes[3]!.end) < 1e-9, "total is the closing's end");
});

console.log("\nstoryboard — the content cache");

const VOICE = { voice_id: "v1", speed: 1.05, stability: 0.4 };

test("same text and voice hash the same; whitespace reflow does not matter", () => {
  assert(narrationCacheKey("Hola  mundo", VOICE) === narrationCacheKey("Hola\nmundo ", VOICE), "normalised text");
});

test("a changed text or a changed speed changes the key", () => {
  const base = narrationCacheKey("Hola mundo", VOICE);
  assert(narrationCacheKey("Hola mundo!", VOICE) !== base, "text");
  assert(narrationCacheKey("Hola mundo", { ...VOICE, speed: 1.1 }) !== base, "speed");
  assert(narrationCacheKey("Hola mundo", { ...VOICE, model_id: "other" }) !== base, "model");
});

test("effectiveVoice overlays only the keys the storyboard sets", () => {
  const merged = effectiveVoice({ voice_id: "v1", stability: 0.4, speed: 1 }, { speed: 0.9 });
  assert(merged.voice_id === "v1" && merged.stability === 0.4 && merged.speed === 0.9, JSON.stringify(merged));
});

console.log("\ntimeline — opacity envelope");

test("opacityBetween with default fade is a smooth envelope", () => {
  const start = 1;
  const end = 3;
  const fade = TIMING.overlap;
  // Before start, opacity is 0
  assert(opacityBetween(start - 0.1, start, end, fade) === 0, "opacity is 0 before start");
  // Just after start, fading in
  const justAfter = opacityBetween(start + fade * 0.5, start, end, fade);
  assert(justAfter > 0 && justAfter < 1, `after start + fade*0.5, opacity is ${justAfter}, should be ramping up`);
  // Far enough in that we're past the fade-in
  const midFade = opacityBetween(start + fade * 1.5, start, end, fade);
  assert(midFade === 1, "after the fade-in ramp, opacity is full");
  // Just before end, fading out
  const justBefore = opacityBetween(end - fade * 0.5, start, end, fade);
  assert(justBefore > 0 && justBefore < 1, `before end - fade*0.5, opacity is ${justBefore}, should be ramping down`);
  // After end, opacity is 0
  assert(opacityBetween(end + 0.1, start, end, fade) === 0, "opacity is 0 after end");
});

test("opacityBetween with fade 0 is a sharp step: 1 in [start, end), 0 elsewhere", () => {
  const start = 1;
  const end = 3;
  // Before start
  assert(opacityBetween(start - 0.1, start, end, 0) === 0, "opacity is 0 before start");
  // At start (inclusive)
  assert(opacityBetween(start, start, end, 0) === 1, "opacity is 1 at start");
  // In the middle
  assert(opacityBetween(1.5, start, end, 0) === 1, "opacity is 1 in the middle");
  // Just before end (exclusive boundary)
  assert(opacityBetween(end - 1e-10, start, end, 0) === 1, "opacity is 1 just before end");
  // At end (exclusive)
  assert(opacityBetween(end, start, end, 0) === 0, "opacity is 0 at end");
  // After end
  assert(opacityBetween(end + 0.1, start, end, 0) === 0, "opacity is 0 after end");
});

test("storyboard with valid transitions field accepts 'crossfade' or 'cut'", () => {
  const yaml1 = `
storyboard: reel
version: 1
transitions: crossfade
cards:
  - id: c1
    visual: cover
    narration: "Welcome to the tour here today."
  - id: c2
    visual: item
    item: 0
    narration: "This is the first item we want to show everyone."
    min_seconds: 4
  - id: c3
    visual: item
    item: 1
    narration: "This is the second item in our tour."
    min_seconds: 4
  - id: c4
    visual: closing
    narration: "Thank you and goodbye."
`;
  const result1 = validateStoryboard(parseYaml(yaml1, "test"), "test", 2);
  assert(result1.transitions === "crossfade", `expected crossfade, got ${result1.transitions}`);

  const yaml2 = yaml1.replace("crossfade", "cut");
  const result2 = validateStoryboard(parseYaml(yaml2, "test"), "test", 2);
  assert(result2.transitions === "cut", `expected cut, got ${result2.transitions}`);
});

test("storyboard with invalid transitions value rejects it", () => {
  const yaml = `
storyboard: reel
version: 1
transitions: dissolve
cards:
  - id: c1
    visual: cover
    narration: "Welcome to the tour here today."
  - id: c2
    visual: item
    item: 0
    narration: "This is the first item we want to show everyone."
    min_seconds: 4
  - id: c3
    visual: item
    item: 1
    narration: "This is the second item in our tour."
    min_seconds: 4
  - id: c4
    visual: closing
    narration: "Thank you and goodbye."
`;
  throws(
    () => validateStoryboard(parseYaml(yaml, "test"), "test", 2),
    /transitions.*must be "crossfade" or "cut"/,
    "invalid transitions value should fail",
  );
});

test("storyboard without transitions field defaults to undefined (not an error)", () => {
  const yaml = `
storyboard: reel
version: 1
cards:
  - id: c1
    visual: cover
    narration: "Welcome to the tour here today."
  - id: c2
    visual: item
    item: 0
    narration: "This is the first item we want to show everyone."
    min_seconds: 4
  - id: c3
    visual: item
    item: 1
    narration: "This is the second item in our tour."
    min_seconds: 4
  - id: c4
    visual: closing
    narration: "Thank you and goodbye."
`;
  const result = validateStoryboard(parseYaml(yaml, "test"), "test", 2);
  assert(result.transitions === undefined, `expected undefined, got ${result.transitions}`);
});

await (async () => {
  const asyncTest = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      console.log(`  ok   ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  };

  await asyncTest("synthesiseCards calls the API once per card, then serves from the sidecar; an edit re-synthesises only that card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-cards-"));
    const calls: string[] = [];
    const made = (): number => calls.length;
    const synth = async (text: string, outPath: string): Promise<void> => {
      calls.push(text);
      writeFileSync(outPath, "mp3");
    };
    const probe = (): number => 1.5;
    const sb = storyboardOf(CARDS_OK.replace('"Save this reel and see you there."', '""'));
    const first = await synthesiseCards(sb, VOICE, dir, { synth, probe });
    assert(made() === 3, `3 spoken cards → 3 calls, got ${made()}`);
    assert(first[3]!.source === "mute" && first[3]!.seconds === 0 && !first[3]!.path, "mute card: no file");
    const second = await synthesiseCards(sb, VOICE, dir, { synth, probe });
    assert(made() === 3, `nothing re-synthesised on a re-run, got ${made()}`);
    assert(second.every((c) => c.source !== "synthesised"), "all served from cache");
    const edited = storyboardOf(CARDS_OK.replace("bring a jacket", "bring a coat").replace('"Save this reel and see you there."', '""'));
    await synthesiseCards(edited, VOICE, dir, { synth, probe });
    assert(made() === 4 && /bring a coat/.test(calls[3]!), `only the edited card is re-synthesised, got ${made()}`);
    await synthesiseCards(edited, { ...VOICE, speed: 1.2 }, dir, { synth, probe });
    assert(made() === 7, `a voice change re-synthesises every spoken card, got ${made()}`);
  });
})();

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
