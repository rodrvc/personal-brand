import assert from "node:assert/strict";

import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";

import { libraryRatio, libraryRatioRaw } from "./compose.js";

/**
 * `libraryRatioRaw` replaced `previousCarouselsLibraryRatio`'s old
 * per-carousel `readValidatedDocument` call (piece-generation spec's
 * "Library ratio with history") — on a profile with dozens of carousels
 * that reloaded brand.json and rescanned the whole asset index once per
 * OTHER carousel, ~21s total for the stats endpoint. This reads a raw,
 * unvalidated document instead, matching `listCarousels`'s existing
 * "shape-check, don't fully validate" approach in document-store.ts. These
 * tests prove it computes the same ratio a full `libraryRatio(doc)` would,
 * without needing a real brand/asset index to do it.
 */

{
  const raw = {
    slides: [
      { background: { mode: "color", source: "library" }, objects: [{ kind: "asset", source: "ai" }, { kind: "asset", source: "library" }] },
      { background: { mode: "asset", source: "manual" }, objects: [] },
    ],
  };
  // 2 of 4 pieces (background+2 objects on slide 1, background on slide 2) are "library".
  assert.equal(libraryRatioRaw(raw), 50, "counts background + object sources across all slides");
  console.log("ok  libraryRatioRaw: matches libraryRatio's percentage for a normal document");
}

{
  assert.equal(libraryRatioRaw({ slides: [] }), 0, "no slides -> 0, not NaN or a divide-by-zero throw");
  assert.equal(libraryRatioRaw({}), 0, "missing slides field -> 0");
  assert.equal(libraryRatioRaw(null), 0, "null raw document -> 0, never throws");
  assert.equal(libraryRatioRaw("not an object"), 0, "a non-object raw value -> 0, never throws");
  console.log("ok  libraryRatioRaw: degrades to 0 instead of throwing on any malformed/missing shape");
}

{
  const raw = { slides: [{ objects: [{ kind: "asset", source: "library" }, { kind: "asset", source: "library" }] }] };
  assert.equal(libraryRatioRaw(raw), 100, "a slide missing `background` entirely still counts its objects");
  console.log("ok  libraryRatioRaw: tolerates a slide with no background field");
}

{
  // A text object carries a `source` too, but it is not a visual piece:
  // `libraryRatio` ignores it, so the raw variant must as well.
  const doc = {
    slides: [
      {
        background: { mode: "color", source: "manual" },
        objects: [
          { kind: "asset", source: "library" },
          { kind: "text", source: "ai" },
          { kind: "text", source: "ai" },
        ],
      },
    ],
  };
  const validated = libraryRatio(doc as unknown as CarouselDocument);
  assert.equal(validated, 50, "1 of 2 visual pieces (background + asset object) is from the library");
  assert.equal(libraryRatioRaw(doc), validated, "the raw variant counts exactly the pieces libraryRatio counts");
  console.log("ok  libraryRatioRaw: ignores text objects, same as libraryRatio");
}
