import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { detectImage } from "../../../../system/assets/index.js";
import { colourReader, encodePng, findPill, toRgba } from "../image-tools.js";
import type { PlacedText } from "./recreate-reference.js";
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
  {
    // An info card: a purple left border, purple dividers between rows, and each row an icon column beside a label
    // over its value. The event has no entry: the first row goes, icon included; the second row stays.
    const { w: cw, h: ch } = canvas;
    const [PURPLE, WHITE, DARK] = [[120, 60, 170], [255, 255, 255], [30, 30, 30]];
    const layout = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let colour = [246, 243, 248];
        if (x >= 60 && x < 900 && y >= 700 && y < 1000) {
          colour = WHITE;
          if (x < 64 || y === 740 || y === 741 || y === 860 || y === 861) colour = PURPLE;
          if (x >= 90 && x < 130 && ((y >= 762 && y < 798) || (y >= 882 && y < 918)) && !(x >= 106 && x < 114 && y % 120 < 5)) colour = DARK; // icons
          if (x >= 170 && x < 260 && ((y >= 755 && y < 772) || (y >= 875 && y < 892)) && x % 4 < 2) colour = DARK; // labels
          if (x >= 170 && x < 420 && ((y >= 780 && y < 805) || (y >= 900 && y < 925)) && x % 4 < 2) colour = DARK; // values
        }
        layout.set([...colour, 255], (y * cw + x) * 4);
      }
    }
    const box = (x0: number, y0: number, x1: number, y1: number) => ({ x: x0 / cw, y: y0 / ch, w: (x1 - x0) / cw, h: (y1 - y0) / ch });
    const label: PlacedText = { line: 0, zone: "label", text: "", from: "absent", box: box(170, 755, 260, 772) };
    const value: PlacedText = { line: 1, zone: "entry", text: "", from: "absent", box: box(170, 780, 420, 805) };
    const other: PlacedText = { line: 2, zone: "place", text: "Hall", from: "content", box: box(170, 900, 420, 925) };
    const row = toRgba(referenceBackground(encodePng(cw, ch, layout), [label, value, other], 0.8, canvas, brand).image);
    const at = (x: number, y: number) => [...row.pixels.subarray((y * cw + x) * 4, (y * cw + x) * 4 + 3)];
    const near = (a: number[], b: number[]) => a.every((v, c) => Math.abs(v - b[c]!) <= 6);
    let stray: string | undefined;
    for (let y = 745; y < 855 && !stray; y++) for (let x = 80; x < 440 && !stray; x++) if (!near(at(x, y), WHITE)) stray = `${x},${y}: ${at(x, y)}`;
    assert.equal(stray, undefined, "the absent row is gone: label, value and its icon");
    assert.ok(near(at(61, 780), PURPLE) && near(at(300, 740), PURPLE) && near(at(300, 860), PURPLE), "the border and dividers stay");
    assert.ok(near(at(100, 900), DARK), "the other row keeps its icon");
  }
  console.log("ok - reference-background");
} else {
  console.log("skip - no sips on this system");
}
