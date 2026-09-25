import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { detectImage } from "../../../../system/assets/index.js";
import { encodePng, toRgba, type Raster } from "../image-tools.js";
import type { TextRun } from "../text-raster.js";
import type { PlacedText } from "./recreate-reference.js";
import { referenceBackground } from "./reference-background.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);
const canvas = { w: 1080, h: 1350 } as const;

const PAGE = [246, 243, 248];
const PURPLE = [120, 60, 170];
const RED = [200, 40, 40];
const GREEN = [40, 150, 90];
const WHITE = [255, 255, 255];
const DARK = [30, 30, 30];

/** A stand-in for Chromium: each run is a solid block in its colour, as wide as its text roughly sets. */
const runs: TextRun[] = [];
async function rasterise(asked: TextRun[]): Promise<Buffer[]> {
  runs.push(...asked);
  return asked.map((run) => {
    const [w, h] = [Math.round(0.6 * run.size * run.text.length) + 10, Math.round(run.size * 1.4)];
    const pixels = new Uint8Array(w * h * 4);
    const rgb = [1, 3, 5].map((i) => parseInt(run.color.slice(i, i + 2), 16));
    for (let y = Math.round(0.2 * h); y < Math.round(0.8 * h); y++) for (let x = 5; x < w - 5; x++) pixels.set([...rgb, 255], (y * w + x) * 4);
    return encodePng(w, h, pixels);
  });
}

if (existsSync("/usr/bin/sips")) {
  // A layout at the slide's size: a time pill with a clock icon, a centred chip, a plain title, a place line with a
  // pin icon and a pill the event turns out not to have.
  const { w, h } = canvas;
  const page = new Uint8Array(w * h * 4);
  const capsule = (x: number, y: number, x0: number, x1: number, y0: number, y1: number) => {
    const r = (y1 - y0) / 2;
    const dx = Math.max(0, Math.abs(x + 0.5 - (x0 + x1) / 2) - ((x1 - x0) / 2 - r));
    return Math.hypot(dx, y + 0.5 - (y0 + y1) / 2) <= r;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let colour = PAGE;
      if (capsule(x, y, 100, 400, 200, 260)) {
        colour = PURPLE;
        if (x >= 125 && x < 156 && y >= 215 && y < 246) colour = WHITE; // clock
        if (x >= 175 && x < 300 && y >= 218 && y < 242 && x % 6 < 3) colour = WHITE; // old time
      }
      if (capsule(x, y, 440, 640, 60, 110)) colour = x >= 460 && x < 620 && y >= 75 && y < 95 && x % 5 < 2 ? WHITE : RED;
      if (x >= 100 && x < 600 && y >= 400 && y < 430 && x % 4 < 2) colour = DARK; // title
      if (x >= 100 && x < 119 && y >= 500 && y < 521) colour = DARK; // pin
      if (x >= 130 && x < 400 && y >= 500 && y < 520 && x % 4 < 2) colour = DARK; // place
      if (capsule(x, y, 100, 300, 600, 640)) colour = x >= 130 && x < 270 && y >= 612 && y < 628 && x % 4 < 2 ? WHITE : GREEN;
      page.set([...colour, 255], (y * w + x) * 4);
    }
  }
  const box = (x0: number, y0: number, x1: number, y1: number) => ({ x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h });
  const time: PlacedText = { line: 0, zone: "time", text: "21:30 HRS", original: "20:00", from: "content", color: "#ffffff", box: box(175, 218, 300, 242) };
  const chip: PlacedText = { line: 1, zone: "chip", text: "NEW", original: "OLD CATEGORY", from: "content", color: "#ffffff", box: box(460, 75, 620, 95) };
  const title: PlacedText = { line: 2, zone: "title", text: "New", from: "content", box: box(100, 400, 600, 430) };
  const place: PlacedText = { line: 3, zone: "place", text: "", from: "absent", box: box(130, 500, 400, 520) };
  const gone: PlacedText = { line: 4, zone: "entry", text: "", from: "absent", box: box(130, 612, 270, 628) };

  const built = await referenceBackground(encodePng(w, h, page), [time, chip, title, place, gone], 0.8, canvas, brand, rasterise);
  const size = detectImage(built.image, "out");
  assert.deepEqual([size.w, size.h], [1080, 1350], "the slide's exact size");
  assert.deepEqual(built.texts, [title], "only the plain text is left to place as an editable text");
  assert.deepEqual(runs.map((r) => [r.text, r.color]), [["21:30 HRS", "#ffffff"], ["NEW", "#ffffff"]], "pill texts are rasterised in their measured ink");

  const out = toRgba(built.image);
  const at = (r: Raster, x: number, y: number) => [...r.pixels.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];
  const near = (a: number[], b: number[], tolerance = 6) => a.every((v, c) => Math.abs(v - b[c]!) <= tolerance);
  /** Every pixel of the rows and columns is one of the colours. */
  const only = (x0: number, x1: number, y0: number, y1: number, colours: number[][], r = out) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!colours.some((c) => near(at(r, x, y), c))) return `${x},${y}: ${at(r, x, y)}`;
    return undefined;
  };

  // The time pill: icon kept, text after it where the old one started, pill longer, nothing else in it.
  const [textW] = [Math.round(0.6 * runs[0]!.size * 9)];
  assert.ok(near(at(out, 140, 230), WHITE) && near(at(out, 126, 216), WHITE), "the clock is kept");
  assert.ok(near(at(out, 165, 230), PURPLE), "the gap after the icon is the pill's colour");
  assert.ok(near(at(out, 177, 230), WHITE), "the new text starts where the old one did, after the icon");
  const end = 175 + textW;
  assert.ok(near(at(out, end + 50, 230), PURPLE), "the pill grew to hold the longer text");
  assert.ok(near(at(out, end + 101 + 3, 230), PAGE, 10), "and ends with the padding it had");
  assert.equal(only(160, 172, 205, 255, [PURPLE]), undefined, "no old glyph between the icon and the text");
  assert.equal(only(end + 2, end + 80, 205, 255, [PURPLE]), undefined, "no old glyph after the text");

  // The chip: centred, narrower for its shorter text, and nothing of the old pill or its text left around it.
  const chipW = Math.round(0.6 * runs[1]!.size * 3) + 40;
  const chipLeft = Math.round(540 - chipW / 2);
  assert.ok(near(at(out, 540, 64), RED), "the chip's pill is still there, centred");
  assert.ok(near(at(out, chipLeft + 12, 85), RED), "its left end");
  assert.equal(only(440, chipLeft - 3, 55, 115, [PAGE]), undefined, "the old pill and glyphs left of the new one are gone");
  assert.equal(only(chipLeft + chipW + 3, 645, 55, 115, [PAGE]), undefined, "and right of it");
  assert.equal(only(chipLeft + 12, chipLeft + 19, 70, 100, [RED]), undefined, "no old glyph inside, before the new text");

  // What the event does not have is erased: the place line with its pin, and the pill with its text.
  assert.equal(only(95, 405, 495, 525, [PAGE]), undefined, "the place and its pin are gone");
  assert.equal(only(95, 305, 595, 645, [PAGE]), undefined, "the absent pill is gone, whole");

  {
    // A time pill inside a white card with a purple border, close to the border's left and bottom edges, with a
    // clock drawn as a ring; the OCR box starts on the clock.
    const CARD = WHITE;
    const layout = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let colour = PAGE;
        const inCard = x >= 60 && x < 900 && y >= 700 && y < 900;
        if (inCard) colour = x < 64 || y >= 896 ? PURPLE : CARD;
        if (capsule(x, y, 90, 330, 820, 870)) {
          colour = PURPLE;
          const ring = Math.hypot(x + 0.5 - 122, y + 0.5 - 845);
          if (ring <= 14 && ring >= 10) colour = WHITE;
          if (x >= 150 && x < 270 && y >= 833 && y < 857 && x % 6 < 3) colour = WHITE;
        }
        layout.set([...colour, 255], (y * w + x) * 4);
      }
    }
    runs.length = 0;
    const clock: PlacedText = { line: 0, zone: "time", text: "22:30 HRS", original: "20:00 HRS", from: "content", color: "#ffffff", box: box(106, 831, 270, 859) };
    const again = await referenceBackground(encodePng(w, h, layout), [clock], 0.8, canvas, brand, rasterise);
    const card = toRgba(again.image);
    const px = (x: number, y: number) => at(card, x, y);
    const textW = Math.round(0.6 * runs[0]!.size * 9);
    assert.deepEqual(again.texts, [], "the time is drawn into the pill, not placed");
    assert.ok(near(px(61, 845), PURPLE) && near(px(400, 897), PURPLE), "the card's border is untouched");
    assert.ok(near(px(75, 845), CARD) && near(px(91, 822), CARD), "so is the card around the pill");
    assert.ok(near(px(122, 833), WHITE) && near(px(122, 845), PURPLE), "the clock ring is kept, in place");
    assert.ok(near(px(92, 845), PURPLE), "the pill keeps its left end");
    assert.ok(near(px(146, 845), PURPLE) && near(px(152, 845), WHITE), "the text starts after the clock, where the old one did");
    const right = Math.max(330, 150 + textW + 61);
    assert.ok(near(px(right - 3, 822), CARD), "the right end is rounded");
    assert.ok(near(px(right - 25, 845), PURPLE), "with the padding it had after the text");
    assert.equal(only(right + 2, 890, 815, 875, [CARD], card), undefined, "nothing erased or left past the pill");
  }

  {
    // An info card: a purple left border, purple dividers between rows, and each row an icon column beside a label
    // over its value. The event has no entry: the first row goes, icon included; the second row stays.
    const layout = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let colour = PAGE;
        if (x >= 60 && x < 900 && y >= 700 && y < 1000) {
          colour = WHITE;
          if (x < 64 || y === 740 || y === 741 || y === 860 || y === 861) colour = PURPLE;
          if (x >= 90 && x < 130 && ((y >= 762 && y < 798) || (y >= 882 && y < 918)) && !(x >= 106 && x < 114 && y % 120 < 5)) colour = DARK; // icons
          if (x >= 170 && x < 260 && ((y >= 755 && y < 772) || (y >= 875 && y < 892)) && x % 4 < 2) colour = DARK; // labels
          if (x >= 170 && x < 420 && ((y >= 780 && y < 805) || (y >= 900 && y < 925)) && x % 4 < 2) colour = DARK; // values
        }
        layout.set([...colour, 255], (y * w + x) * 4);
      }
    }
    const label: PlacedText = { line: 0, zone: "label", text: "", from: "absent", box: box(170, 755, 260, 772) };
    const value: PlacedText = { line: 1, zone: "entry", text: "", from: "absent", box: box(170, 780, 420, 805) };
    const other: PlacedText = { line: 2, zone: "place", text: "Hall", from: "content", box: box(170, 900, 420, 925) };
    const row = toRgba((await referenceBackground(encodePng(w, h, layout), [label, value, other], 0.8, canvas, brand, rasterise)).image);
    assert.equal(only(80, 440, 745, 855, [WHITE], row), undefined, "the absent row is gone: label, value and its icon");
    assert.ok(near(at(row, 61, 780), PURPLE) && near(at(row, 300, 740), PURPLE) && near(at(row, 300, 860), PURPLE), "the border and dividers stay");
    assert.ok(near(at(row, 100, 900), DARK), "the other row keeps its icon");
  }
  console.log("ok - reference-background");
} else {
  console.log("skip - no sips on this system");
}
