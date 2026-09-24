import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { detectImage } from "../../../../system/assets/index.js";
import { colourReader, encodePng, findPill } from "../image-tools.js";
import { referenceBackground } from "./reference-background.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);
const canvas = { w: 1080, h: 1350 } as const;

if (existsSync("/usr/bin/sips")) {
  // A 4:5 layout: a pale page, a purple pill with white "text", and a dark line of "text" below it.
  const [w, h] = [432, 540];
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pill = x >= 20 && x < 80 && y >= 40 && y < 60;
      const pillText = pill && x >= 30 && x < 70 && y >= 46 && y < 54 && x % 3 === 0;
      const line = x >= 20 && x < 200 && y >= 80 && y < 92 && x % 4 < 2;
      page.set(pillText ? [255, 255, 255, 255] : pill ? [120, 60, 170, 255] : line ? [30, 30, 30, 255] : [246, 243, 248, 255], (y * w + x) * 4);
    }
  }
  const chip = { line: 0, zone: "chip" as const, text: "A MUCH LONGER CATEGORY", original: "OLD", from: "content" as const, box: { x: 30 / w, y: 46 / h, w: 40 / w, h: 8 / h } };
  const title = { line: 1, zone: "title" as const, text: "New", from: "content" as const, box: { x: 20 / w, y: 80 / h, w: 180 / w, h: 12 / h } };
  const built = referenceBackground(encodePng(w, h, page), [chip, title], 0.8, canvas, brand);
  const size = detectImage(built.image, "out");
  assert.deepEqual([size.w, size.h], [1080, 1350], "the slide's exact size");
  const read = colourReader(built.image);
  assert.equal(read(title.box), "F6F3F8", "the old text is erased into the page");
  const pill = findPill(built.image, built.texts[0]!.box)!;
  assert.ok(pill.x1 - pill.x0 > 150, "the pill grew to hold the longer text");
  const [placedChip] = built.texts;
  const centre = (placedChip!.box.x + placedChip!.box.w / 2) * canvas.w;
  assert.ok(Math.abs(centre - (pill.x0 + pill.x1) / 2) < 2, "the chip's text is centred on the grown pill");
  assert.deepEqual(built.texts[1], title, "other texts keep their boxes");
  console.log("ok - reference-background");
} else {
  console.log("skip - no sips on this system");
}
