/**
 * Runtime tests for the reel engine's load-time guards.
 *
 * Plain `tsx` execution with no framework, matching the carousel's tests. What
 * is worth testing here is the same thing worth testing there: the places
 * where a wrong answer would be *silent* — a pin at the wrong coordinate, a
 * period nobody verified, an unknown key that reads as a working setting, a
 * camera that never actually arrives over the item.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInsideBBox, validateBBox, wideFraming, MAX_BBOX_SIDE_DEGREES } from "./geo.js";
import { withCache } from "./osm-cache.js";
import { loadReelRecipe } from "./recipe.js";
import {
  CAMERA_MOVE_SECONDS,
  CLOSE_ZOOM,
  cameraAt,
  mapStart,
  totalFrames,
  totalSeconds,
} from "./remotion/src/timeline.js";
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

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
