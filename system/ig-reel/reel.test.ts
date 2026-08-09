/**
 * Runtime tests for the reel engine's load-time guards.
 *
 * Plain `tsx` execution with no framework, matching the carousel's tests. What
 * is worth testing here is the same thing worth testing there: the places
 * where a wrong answer would be *silent* — a pin at the wrong coordinate, a
 * period nobody verified, an unknown key that reads as a working setting.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isInsideBBox, isPlaceable, placeItem, project, validateBBox, MAX_BBOX_SIDE_DEGREES } from "./geo.js";
import { loadBrand } from "../ig-carousel/brand-schema.js";
import { buildMapSvg, chainSegments } from "./map-svg.js";
import { withCache } from "./osm-cache.js";
import { validateReferenceTypes } from "./osm.js";
import { loadReelRecipe } from "./recipe.js";
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

test("an oversized bbox fails at load, not at Overpass timeout", () => {
  const side = MAX_BBOX_SIDE_DEGREES + 0.1;
  throws(() => validateBBox([0, 0, side, side]), /longest side/, "an oversized box should fail");
});

console.log("\ngeo — placement");

test("the map covers the canvas for a coordinate at the centre", () => {
  const place = placeItem(BBOX, -23.65, -70.4, "centre");
  assert(place.left <= 0 && place.top <= 0, "the layer should start off-canvas");
});

test("the map covers the canvas anywhere isPlaceable allows", () => {
  // This is the check that caught a pale band showing through on items near
  // the edge, back when the layer was scaled at 0.55. `isPlaceable` is the
  // predicate the guard filters on, so anything it accepts must place without
  // throwing — otherwise a verified item could still crash the render.
  const [latMin, lonMin, latMax, lonMax] = BBOX;
  for (let i = 0; i <= 20; i += 1) {
    for (let j = 0; j <= 20; j += 1) {
      const lat = latMin + ((latMax - latMin) * i) / 20;
      const lng = lonMin + ((lonMax - lonMin) * j) / 20;
      if (isPlaceable(BBOX, lat, lng)) {
        placeItem(BBOX, lat, lng, `${lat},${lng}`);
      }
    }
  }
});

test("a coordinate on the bbox edge is refused placement rather than crashing", () => {
  // Geometry, not a bug: centring an edge point puts half the canvas beyond
  // where the map exists, and no MAP_SCALE fixes it. The guard drops such an
  // item with a reason; placeItem still asserts, as the last line of defence.
  assert(!isPlaceable(BBOX, -23.7199, -70.4399), "a corner point must not be placeable");
  throws(
    () => placeItem(BBOX, -23.7199, -70.4399, "corner"),
    /does not cover the canvas/,
    "placing an edge point should assert rather than emit a gap",
  );
});

test("isInsideBBox rejects a coordinate outside the declared box", () => {
  assert(isInsideBBox(BBOX, -23.65, -70.4), "a point inside should be inside");
  assert(!isInsideBBox(BBOX, -33.45, -70.66), "a point in another city should be outside");
});

console.log("\nosm — reference types are a closed enum");

test("supported types pass through", () => {
  assert(validateReferenceTypes(["mall", "hospital"]).length === 2, "expected two types");
});

test("an unsupported type fails naming what exists", () => {
  throws(
    () => validateReferenceTypes(["nightclub"]),
    /this engine supports/,
    "an unknown type should fail",
  );
});

test("a profile cannot smuggle Overpass QL through reference_types", () => {
  throws(
    () => validateReferenceTypes(['node["amenity"](0,0,1,1);out;']),
    /this engine supports/,
    "raw query text should be rejected like any other unknown value",
  );
});

console.log("\nmap-svg — coastline chaining");

test("ways that share endpoints join into one chain, whatever order they arrive in", () => {
  // Out of order and with the middle piece reversed — the shape OSM actually
  // returns. Sorting by latitude instead of chaining tore this into a zigzag.
  const chains = chainSegments([
    [{ x: 20, y: 20 }, { x: 30, y: 30 }],
    [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    [{ x: 20, y: 20 }, { x: 10, y: 10 }],
  ]);
  assert(chains.length === 1, `expected one chain, got ${chains.length}`);
  assert(chains[0]!.length === 4, `expected 4 points, got ${chains[0]!.length}`);
});

test("genuinely disconnected shores stay separate chains", () => {
  // An island and the mainland must not be bridged by a false edge.
  const chains = chainSegments([
    [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    [{ x: 500, y: 500 }, { x: 510, y: 510 }],
  ]);
  assert(chains.length === 2, `expected two chains, got ${chains.length}`);
});

test("the longest chain is drawn first so fragments cannot paint over the shore", () => {
  const chains = chainSegments([
    [{ x: 900, y: 900 }, { x: 905, y: 905 }],
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }],
  ]);
  assert(chains[0]!.length > chains[1]!.length, "the longest chain should come first");
});

console.log("\nmap-svg — the sea lands on the water, not the town");

test("a concave bay fills the sea on the correct side of the shore", () => {
  // The regression that cost the most to find. Two polygon approaches passed
  // a straight north-south coast and painted sea across the middle of a
  // bay-shaped harbour, which only showed up once a second profile existed.
  // The fixture is that harbour's real coastline, cached so this needs no
  // network; the probes are points whose nature is not in dispute.
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/bay-coastline.json", import.meta.url), "utf-8"),
  ) as { elements: { geometry: { lat: number; lon: number }[] }[] };

  const bayBBox = validateBBox([-33.06, -71.65, -33.02, -71.59]);
  const brand = loadBrand("profiles/example", ["reel", "categories"]);
  const { svg } = buildMapSvg(bayBBox, fixture.elements, [], [], brand);

  // Sea is painted as merged rects; a point is water if a rect covers it.
  const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/>/g)].map(
    (m) => m.slice(1).map(Number) as [number, number, number, number],
  );
  assert(rects.length > 0, "expected the sea to be painted at all");

  const isSea = (lat: number, lng: number): boolean => {
    const { x, y } = project(bayBBox, lat, lng);
    return rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh);
  };

  const probes: [string, number, number, boolean][] = [
    ["a hillside inland", -33.048, -71.6, false],
    ["the town centre", -33.043, -71.615, false],
    ["a square inland", -33.0448, -71.6222, false],
    ["a street inland", -33.0472, -71.6118, false],
    ["open water in the bay", -33.025, -71.62, true],
  ];
  for (const [name, lat, lng, wantSea] of probes) {
    const got = isSea(lat, lng);
    assert(got === wantSea, `${name} came out as ${got ? "sea" : "land"}, expected ${wantSea ? "sea" : "land"}`);
  }
});

test("two landmark labels never print on top of each other", () => {
  // Collision is measured against the box each label is drawn in, not its
  // anchor point: the text is offset from its dot and anchored to one side,
  // so an anchor-centred box is not the box on screen.
  //
  // Note what this does NOT cover, because chasing it here wasted a render:
  // the overlap visible on the finished video was between a landmark label
  // and the *item's own map label*, which the composition draws in a separate
  // layer this function never sees. No amount of spacing inside the SVG could
  // have fixed it; the composition gives that label a solid plate instead.
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/bay-coastline.json", import.meta.url), "utf-8"),
  ) as { elements: { geometry: { lat: number; lon: number }[] }[] };
  const bayBBox = validateBBox([-33.06, -71.65, -33.02, -71.59]);
  const brand = loadBrand("profiles/example", ["reel", "categories"]);

  // Deliberately adversarial: same spot, names of very different lengths.
  const crowded = [
    { name: "Puerto", lat: -33.0369, lng: -71.6255 },
    { name: "Plaza Sotomayor", lat: -33.037, lng: -71.6256 },
    { name: "Muelle Prat", lat: -33.0371, lng: -71.6257 },
  ].map((l) => ({ name: l.name, lat: l.lat, lon: l.lng }));

  const { svg } = buildMapSvg(bayBBox, fixture.elements, [], crowded, brand);

  const labels = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)"[^>]*>([^<]+)<\/text>/g)].map(
    (m) => {
      const x = Number(m[1]);
      const width = m[4]!.length * 34 * 0.58;
      return {
        left: m[3] === "end" ? x - width : x,
        right: m[3] === "end" ? x : x + width,
        y: Number(m[2]),
        name: m[4]!,
      };
    },
  );

  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i]!;
      const b = labels[j]!;
      const overlapping = a.left < b.right && a.right > b.left && Math.abs(a.y - b.y) < 40;
      assert(!overlapping, `"${a.name}" and "${b.name}" overlap on the map`);
    }
  }
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
    Array.isArray(recipe.map.reference_types) && recipe.map.reference_types.length === 2,
    "expected two reference types",
  );
  assert(
    typeof recipe.curation?.guidance === "string" && recipe.curation.guidance.includes("data"),
    "expected the block scalar to be captured",
  );
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

test("curation.count outside 3..6 fails, explaining why the range exists", () => {
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("count: 4", "count: 12"))),
    /between 3 and 6/,
    "12 items would run far past a reel's attention span",
  );
  throws(
    () => loadReelRecipe(withRecipe(VALID.replace("count: 4", "count: 1"))),
    /between 3 and 6/,
    "1 item does not read as a tour",
  );
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
