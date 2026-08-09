import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CarouselInput, Slide } from "./types.js";
import { readSourceImageHosts, verifyOrThrow, verifySlides } from "./verify-slides.js";

const WEEK = {
  start: new Date(2026, 7, 17), // Mon 17 Aug 2026
  end: new Date(2026, 7, 23), // Sun 23 Aug
};
const HOSTS = ["api.example.com"];

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
/** Inside `system/`, like the fixture `render.ts` renders. Need not exist — only the path is read. */
const ENGINE_INPUT = join(ENGINE_DIR, "example-input.json");
/**
 * Outside `system/`, like a profile's generated input. Pointed at a profile dir
 * that has no `recipes/` folder on purpose: that is the state `render.ts` is in
 * (no recipe to answer to), so these cases isolate the path rule from the
 * separate question of what a recipe declared.
 */
const PROFILE_DIR = join(ENGINE_DIR, "..", "..", "profiles", "does-not-exist");
const PROFILE_INPUT = join(PROFILE_DIR, "carousels", "week-input.json");

/** A carousel input carrying its own host declaration, as the engine fixture does. */
function input(over: Partial<CarouselInput> = {}): CarouselInput {
  return { sourceImageHosts: HOSTS, slides: [], ...over };
}

function slide(over: Partial<Slide> = {}): Slide {
  return {
    title: "Evento",
    subtitle: "Detalle",
    meta: "Sáb 22 Ago · Lugar",
    date: "2026-08-22",
    image: "https://api.example.com/media/x/photo.jpg",
    ...over,
  };
}

const tests: Array<[string, () => void]> = [
  [
    "keeps a slide inside the week, from an allowed host",
    () => {
      const { kept, rejected } = verifySlides([slide()], { period: WEEK, allowedImageHosts: HOSTS });
      assert.equal(kept.length, 1);
      assert.deepEqual(rejected, []);
    },
  ],
  [
    "keeps both boundary days — the period is inclusive",
    () => {
      const items = [slide({ date: "2026-08-17" }), slide({ date: "2026-08-23" })];
      const { kept } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 2);
    },
  ],
  [
    "drops the day before and the day after",
    () => {
      const items = [slide({ date: "2026-08-16" }), slide({ date: "2026-08-24" })];
      const { kept, rejected } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 0);
      assert.equal(rejected.length, 2);
      assert.match(rejected[0]!.reason, /outside 2026-08-17\.\.2026-08-23/);
    },
  ],
  [
    "reproduces the original defect: events from another week are dropped, not rendered",
    () => {
      // The shipped bug: events dated 9 Aug under a "17–23 Aug" header.
      const items = [slide({ date: "2026-08-09" }), slide({ date: "2026-08-22" })];
      const { kept, rejected } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 1);
      assert.equal(kept[0]!.date, "2026-08-22");
      assert.equal(rejected.length, 1);
    },
  ],
  [
    "keeps the surviving slides in order, so the carousel refills from the curated list",
    () => {
      const items = [
        slide({ title: "A", date: "2026-08-01" }), // out
        slide({ title: "B", date: "2026-08-18" }),
        slide({ title: "C", date: "2026-08-19" }),
      ];
      const { kept } = verifySlides(items, { period: WEEK });
      assert.deepEqual(
        kept.map((s) => s.title),
        ["B", "C"],
      );
    },
  ],
  [
    "a slide with no date passes: not all content is date-bound",
    () => {
      const items = [slide({ date: undefined }), slide({ date: "2026-08-18" })];
      const { kept } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 2);
    },
  ],
  [
    "a malformed date is rejected — present but wrong is a mistake, not an omission",
    () => {
      const { rejected } = verifySlides([slide({ date: "22-08-2026" })], { period: WEEK });
      assert.equal(rejected.length, 1);
      assert.match(rejected[0]!.reason, /not a valid YYYY-MM-DD/);
    },
  ],
  [
    "an impossible date is rejected instead of rolling over into the next month",
    () => {
      // new Date(2026, 1, 31) silently becomes 3 March.
      const { rejected } = verifySlides([slide({ date: "2026-02-31" })], { period: WEEK });
      assert.equal(rejected.length, 1);
    },
  ],
  [
    "reproduces the second defect: an image from another host is dropped",
    () => {
      const items = [slide({ image: "https://instagram.com/invented.jpg" })];
      const { kept, rejected } = verifySlides(items, { period: WEEK, allowedImageHosts: HOSTS });
      assert.equal(kept.length, 0);
      assert.match(rejected[0]!.reason, /image host "instagram\.com" is not one of the source hosts/);
    },
  ],
  [
    "a slide with no image passes: images are optional",
    () => {
      const { kept } = verifySlides([slide({ image: undefined })], {
        period: WEEK,
        allowedImageHosts: HOSTS,
      });
      assert.equal(kept.length, 1);
    },
  ],
  [
    "a non-URL image is rejected",
    () => {
      const { rejected } = verifySlides([slide({ image: "photo.jpg" })], {
        allowedImageHosts: HOSTS,
      });
      assert.match(rejected[0]!.reason, /not a valid URL/);
    },
  ],
  [
    "with no options nothing is checked — the engine stays opt-in",
    () => {
      const items = [slide({ date: "1999-01-01", image: "https://elsewhere.example/x.jpg" })];
      const { kept, rejected } = verifySlides(items);
      assert.equal(kept.length, 1);
      assert.deepEqual(rejected, []);
    },
  ],
  [
    "omitting allowedImageHosts skips the host check even when a period is set",
    () => {
      const items = [slide({ image: "https://elsewhere.example/x.jpg" })];
      const { kept } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 1);
    },
  ],

  // --- the hole the per-slide date tolerance composed into ---
  [
    "the defect's actual state: 0 of N slides dated is reported, not passed in silence",
    () => {
      // Every slide passes the period check individually, so `rejected` is empty
      // and `kept` is full — indistinguishable from a verified batch until now.
      const items = [slide({ date: undefined }), slide({ date: undefined })];
      const { kept, rejected, unverified } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 2);
      assert.deepEqual(rejected, []);
      assert.equal(unverified.length, 1);
      assert.match(unverified[0]!, /none of the 2 slide\(s\) carries a "date"/);
    },
  ],
  [
    "the finding names the period that went unchecked, so the message is actionable",
    () => {
      const { unverified } = verifySlides([slide({ date: undefined })], { period: WEEK });
      assert.match(unverified[0]!, /2026-08-17\.\.2026-08-23/);
    },
  ],
  [
    "one dated slide is enough: the period was actually checked against something",
    () => {
      const items = [slide({ date: undefined }), slide({ date: undefined }), slide()];
      const { unverified } = verifySlides(items, { period: WEEK });
      assert.deepEqual(unverified, []);
    },
  ],
  [
    "a batch whose only dated slides were dropped still counts as verified",
    () => {
      // Counted over the input, not `kept`: these dates were compared and lost.
      const items = [slide({ date: "2026-08-09" }), slide({ date: "2026-08-01" })];
      const { kept, rejected, unverified } = verifySlides(items, { period: WEEK });
      assert.equal(kept.length, 0);
      assert.equal(rejected.length, 2);
      assert.deepEqual(unverified, []);
    },
  ],
  [
    "requireDates: false is the written-down opt-out for non-dated content",
    () => {
      const { unverified } = verifySlides([slide({ date: undefined })], {
        period: WEEK,
        requireDates: false,
      });
      assert.deepEqual(unverified, []);
    },
  ],
  [
    "no period means nothing to verify — an undated batch is not a finding",
    () => {
      const { unverified } = verifySlides([slide({ date: undefined })]);
      assert.deepEqual(unverified, []);
    },
  ],
  [
    "an empty batch reports no date finding — emptiness is the caller's own check",
    () => {
      const { unverified } = verifySlides([], { period: WEEK });
      assert.deepEqual(unverified, []);
    },
  ],

  // --- sourceImageHosts, read off the carousel input rather than brand.json ---
  [
    "a well-formed sourceImageHosts is returned for use as allowedImageHosts",
    () => {
      const input = { sourceImageHosts: ["api.example.com"], slides: [] } as CarouselInput;
      assert.deepEqual(readSourceImageHosts(input, "in.json"), ["api.example.com"]);
    },
  ],
  [
    "omitting sourceImageHosts is valid: imagery may legitimately live anywhere",
    () => {
      assert.equal(readSourceImageHosts({ slides: [] }, "in.json"), undefined);
    },
  ],
  [
    "the singular sourceImageHost is rejected, not ignored — misspelt it disarms the check",
    () => {
      const input = { sourceImageHost: ["api.example.com"], slides: [] } as unknown as CarouselInput;
      assert.throws(() => readSourceImageHosts(input, "in.json"), /did you mean "sourceImageHosts"/);
    },
  ],
  [
    "a bare string instead of an array is rejected — it would char-index the host list",
    () => {
      const input = { sourceImageHosts: "api.example.com", slides: [] } as unknown as CarouselInput;
      assert.throws(() => readSourceImageHosts(input, "in.json"), /non-empty array/);
    },
  ],
  [
    "an empty array is rejected: it reads as a check that is on but permits nothing",
    () => {
      const input = { sourceImageHosts: [], slides: [] } as CarouselInput;
      assert.throws(() => readSourceImageHosts(input, "in.json"), /non-empty array/);
    },
  ],
  [
    "a non-string entry is rejected, naming its index",
    () => {
      const input = { sourceImageHosts: ["api.example.com", 7], slides: [] } as unknown as CarouselInput;
      assert.throws(() => readSourceImageHosts(input, "in.json"), /sourceImageHosts\[1\]/);
    },
  ],
  [
    "the error names the input file, since that is the file to go and fix",
    () => {
      const input = { sourceImageHosts: [], slides: [] } as CarouselInput;
      assert.throws(() => readSourceImageHosts(input, "profiles/x/carousels/week-input.json"), {
        message: /Invalid profiles\/x\/carousels\/week-input\.json:/,
      });
    },
  ],

  // --- selfDeclaredProvenance: the one branch whose job is to WEAKEN a check ---
  // It shipped with zero cases, and a reviewer demonstrated the cost: widening
  // the fixture's sourceImageHosts to include an invented host, then pointing a
  // slide at it, produced 8 PNGs at exit 0 with no warning.
  [
    "an engine fixture declaring its own hosts skips the recipe check",
    () => {
      // No recipe exists at PROFILE_DIR, so without the bypass this is the
      // "checked against nothing" finding — that it renders is the whole point.
      const kept = verifyOrThrow({
        slides: [slide({ date: undefined })],
        input: input(),
        inputPath: ENGINE_INPUT,
        profileDir: PROFILE_DIR,
        recipe: "layout-comparison",
        selfDeclaredProvenance: true,
      });
      assert.equal(kept.length, 1);
    },
  ],
  [
    "an engine fixture with NO declaration is still checked — the flag alone exempts nothing",
    () => {
      // The bypass is `flag && hosts`, not `flag`. A fixture that forgot its
      // hosts has stated nothing, so there is nothing to honour.
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input({ sourceImageHosts: undefined }),
            inputPath: ENGINE_INPUT,
            profileDir: PROFILE_DIR,
            recipe: "layout-comparison",
            selfDeclaredProvenance: true,
          }),
        /checked against nothing/,
      );
    },
  ],
  [
    "the flag is refused for an input outside system/ — the premise is enforced, not trusted",
    () => {
      // The exemption's argument is that the file is tracked under `system/` and
      // reviewed in a diff. Nothing checked that, so any caller could claim a
      // profile's agent-written input carried a fixture's authority.
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: PROFILE_INPUT,
            profileDir: PROFILE_DIR,
            recipe: "weekly-roundup",
            selfDeclaredProvenance: true,
          }),
        /Refusing selfDeclaredProvenance/,
      );
    },
  ],
  [
    "the refusal explains why, naming the recipe as the place to declare hosts",
    () => {
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: PROFILE_INPUT,
            profileDir: PROFILE_DIR,
            recipe: "weekly-roundup",
            selfDeclaredProvenance: true,
          }),
        /Declare source\.image_hosts in the profile's recipe/,
      );
    },
  ],
  [
    "a path that escapes system/ via .. is refused — resolve() runs before the prefix test",
    () => {
      // Left unresolved, this string starts with the engine dir and would pass a
      // naive startsWith while actually naming a file outside it.
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: join(ENGINE_DIR, "..", "..", "profiles", "x", "in.json"),
            profileDir: PROFILE_DIR,
            recipe: "weekly-roundup",
            selfDeclaredProvenance: true,
          }),
        /Refusing selfDeclaredProvenance/,
      );
    },
  ],
  [
    "a sibling dir whose name merely starts with 'system' is not inside it",
    () => {
      // `system-scratch/` shares the prefix but not the containment — the
      // separator in the comparison is what keeps these apart.
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: join(ENGINE_DIR, "..", "..", "system-scratch", "in.json"),
            profileDir: PROFILE_DIR,
            recipe: "weekly-roundup",
            selfDeclaredProvenance: true,
          }),
        /Refusing selfDeclaredProvenance/,
      );
    },
  ],
  [
    "without the flag, an input declaring its own hosts with no recipe is still a finding",
    () => {
      // The case a reviewer blocked twice: an input naming its own allowlist is
      // the floor writing itself a ceiling. Absent flag must not soften it.
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: PROFILE_INPUT,
            profileDir: PROFILE_DIR,
            recipe: "weekly-roundup",
          }),
        /cannot be its own source of truth/,
      );
    },
  ],
  [
    "selfDeclaredProvenance: false is not a back door — it behaves as absent",
    () => {
      assert.throws(
        () =>
          verifyOrThrow({
            slides: [slide({ date: undefined })],
            input: input(),
            inputPath: ENGINE_INPUT,
            profileDir: PROFILE_DIR,
            recipe: "layout-comparison",
            selfDeclaredProvenance: false,
          }),
        /cannot be its own source of truth/,
      );
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
