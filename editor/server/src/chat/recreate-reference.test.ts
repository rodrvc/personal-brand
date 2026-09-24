import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import type { Slide } from "../../../../system/ig-carousel/carousel-document.js";
import { placeFullSlideImage, recreatePrompt } from "./recreate-reference.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);
const canvas = { w: 1080, h: 1350 } as const;

{
  const prompt = recreatePrompt("like this but with this event", [{ what: "title", text: "New Show" }], true);
  assert.match(prompt, /first image exactly/);
  assert.match(prompt, /second image/);
  assert.match(prompt, /title "New Show"/);
  assert.doesNotMatch(recreatePrompt("x", [], false), /second image/, "without the content image it is described, not referenced");
}
{
  const existing: Slide = {
    id: "slide-1",
    kind: "step",
    background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
    objects: [
      { id: "old", kind: "text", text: "old", pinned: false, locked: false, source: "ai" },
      { id: "kept", kind: "text", text: "kept", pinned: true, locked: false, source: "manual" },
      { id: "locked", kind: "text", text: "locked", pinned: false, locked: true, source: "manual" },
    ],
  };
  const slide = placeFullSlideImage(existing, "0123456789abcdef", canvas, brand);
  assert.deepEqual(slide.objects.map((o) => o.id).slice(0, 2), ["kept", "locked"], "pinned and locked pieces stay, the rest goes");
  const poster = slide.objects[2]!;
  assert.equal(poster.kind === "asset" && poster.assetId, "0123456789abcdef");
  assert.deepEqual(poster.geometry, { x: 0, y: 0, w: 1080, h: 1350, rotation: 0 }, "covers the whole slide");
  assert.equal(slide.objects.length, 3, "no extra texts or objects");
  assert.equal(placeFullSlideImage(undefined, "0123456789abcdef", canvas, brand).objects.length, 1, "a new slide holds only the poster");
}
console.log("ok - recreate-reference");
