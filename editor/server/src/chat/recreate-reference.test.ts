import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import type { Slide } from "../../../../system/ig-carousel/carousel-document.js";
import {
  anchorLines,
  IDENTITY,
  keepPictureLines,
  keepTextsPrompt,
  letterbox,
  measureTexts,
  placePoster,
  register,
  settleTexts,
  similarity,
  toSlide,
  unregister,
  type PosterText,
} from "./recreate-reference.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);
const canvas = { w: 1080, h: 1350 } as const;
const lines = [
  { text: "Old Show", box: { x: 0.1, y: 0.2, w: 0.4, h: 0.06 } },
  { text: "SAT 1 JAN", box: { x: 0.75, y: 0.1, w: 0.15, h: 0.02 } },
];

{
  const texts: PosterText[] = [
    { line: 0, zone: "title", text: "New Show", from: "content" },
    { zone: "place", text: "Hall", from: "content", box: { x: 0.1, y: 0.8, w: 0.3, h: 0.02 } },
    { line: 7, zone: "date", text: "lost", from: "content" },
    { line: 1, zone: "logo", text: "", from: "layout" },
    { line: 1, zone: "picture", text: "SAT 1 JAN", from: "layout" },
  ];
  const measured = measureTexts(texts, lines);
  assert.deepEqual(measured.map((t) => t.text), ["New Show", "Hall"], "no line and no box, logo and picture lines are all dropped");
  assert.deepEqual(anchorLines(texts, lines), [lines[0]], "a picture line is no anchor: the generator redraws the picture");
  const picture = { x: 0.7, y: 0.05, w: 0.25, h: 0.1 };
  const classified = keepPictureLines([{ line: 1, zone: "date", text: "SUN 2 FEB", from: "content" }, { line: 0, zone: "title", text: "New", from: "content" }], lines, picture);
  assert.deepEqual(classified.map((t) => t.zone), ["picture", "title"], "a line inside the framed picture is the picture's, whatever the model said");
  assert.deepEqual(anchorLines([], lines, picture), [lines[0]]);
  assert.deepEqual(measured[0]!.box, lines[0]!.box, "the box comes from the measured line, not the model");
  assert.equal(measured[0]!.original, "Old Show");
  const clock = { text: "• 20:00 HRS", box: { x: 0.3, y: 0.68, w: 0.11, h: 0.015 } };
  const [time] = measureTexts([{ line: 0, zone: "time", text: "• 21:30 HRS", from: "content" }], [clock]);
  assert.equal(time!.text, "21:30 HRS", "the icon OCR read as a bullet is not text");
  assert.equal(time!.original, "20:00 HRS");
  assert.ok(time!.box.x > 0.3 && Math.abs(time!.box.x + time!.box.w - 0.41) < 1e-9, "the box starts past the icon, which stays in the background");
}
{
  const prompt = keepTextsPrompt(true);
  assert.match(prompt, /every text exactly as it is written/);
  assert.match(prompt, /second image/);
  assert.doesNotMatch(keepTextsPrompt(false), /second image/);
}
{
  assert.ok(similarity("Teatro Ejemplo Álamo", "Teatro Ejemplo Alamo.") > 0.9, "accents and punctuation do not count");
  assert.ok(similarity("Horario", "Liberada") < 0.3);
  const anchors = [
    { text: "Brand", box: { x: 0.1, y: 0.05, w: 0.2, h: 0.04 } },
    { text: "Place", box: { x: 0.2, y: 0.7, w: 0.1, h: 0.02 } },
    { text: "Find more events online", box: { x: 0.2, y: 0.95, w: 0.6, h: 0.02 } },
  ];
  // The generator stretched the layout 10% taller and moved it up by 0.08.
  const drawn = anchors.map(({ text, box }) => ({ text, box: { x: box.x, y: 1.1 * box.y - 0.08, w: box.w, h: 1.1 * box.h } }));
  const r = register(anchors, drawn);
  assert.ok(Math.abs(r.sy - 1.1) < 1e-6 && Math.abs(r.oy + 0.08) < 1e-6, "scale and offset read from the kept texts");
  assert.ok(Math.abs(r.sx - 1) < 1e-6 && Math.abs(r.ox) < 1e-6);
  assert.deepEqual(register(anchors.slice(0, 2), drawn), IDENTITY, "too few anchors: the image is taken as it is");
  assert.deepEqual(letterbox(1024 / 1536, 0.8), { sx: 1, ox: 0, sy: 1024 / 1536 / 0.8, oy: (1 - 1024 / 1536 / 0.8) / 2 }, "a taller image holds the slide in its middle band");
  assert.deepEqual(register([], drawn, letterbox(1, 0.8)).sx, 0.8, "the fallback when nothing can be read");
  const back = unregister(drawn[1]!.box, r);
  assert.ok(Math.abs(back.y - 0.7) < 1e-6 && Math.abs(back.h - 0.02) < 1e-6, "a generated box lands on the reference's");
  const title = { zone: "title" as const, text: "New", from: "content" as const, original: "Old Show", box: { x: 0.1, y: 0.2, w: 0.4, h: 0.06 } };
  const pill = { zone: "time" as const, text: "21:30 HRS", from: "content" as const, original: "20:00 HRS", box: { x: 0.3, y: 0.68, w: 0.1, h: 0.015 } };
  const settled = settleTexts(
    [title, pill],
    [
      { text: "Old Shovv!", box: { x: 0.1, y: 1.1 * 0.21 - 0.08, w: 0.5, h: 0.066 } },
      { text: "• 20.00 HRS", box: { x: 0.28, y: 1.1 * 0.7 - 0.08, w: 0.12, h: 0.0165 } },
      drawn[2]!,
    ],
    r,
  );
  assert.ok(Math.abs(settled.texts[1]!.box.y - 0.7) < 1e-6, "the pill's text goes where the generator moved the pill");
  assert.ok(settled.texts[1]!.box.x > 0.28, "past the pill's icon");
  const footer = unregister(drawn[2]!.box, r);
  assert.ok(settled.erase.length >= 4, "both texts, where they were and where they went");
  assert.ok(!settled.erase.some((b) => Math.abs(b.y - footer.y) < 1e-6), "the footer, over no replaced text, stays");
}
{
  assert.deepEqual(toSlide({ x: 0.1, y: 0.2, w: 0.4, h: 0.1 }, 0.8, canvas), { x: 0.1, y: 0.2, w: 0.4, h: 0.1 }, "same proportion: same box");
  const wide = toSlide({ x: 0, y: 0, w: 1, h: 1 }, 1, canvas);
  assert.equal(Math.round(wide.h * 1000) / 1000, 0.8, "a square reference is letterboxed into the portrait slide");
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
  const texts = measureTexts([{ line: 0, zone: "title", text: "New Show", from: "content" }], lines);
  const slide = placePoster(existing, "0123456789abcdef", texts, canvas, brand);
  const [kept, locked, poster, title] = slide.objects;
  assert.deepEqual([kept!.id, locked!.id], ["kept", "locked"], "pinned and locked pieces stay, the rest goes");
  assert.equal(poster!.kind === "asset" && poster.assetId, "0123456789abcdef");
  assert.deepEqual(poster!.geometry, { x: 0, y: 0, w: 1080, h: 1350, rotation: 0 });
  assert.equal(poster!.pinned, true, "the text-free poster is pinned");
  assert.equal(title!.kind, "text");
  if (title!.kind === "text") {
    assert.equal(title.text, "New Show");
    assert.equal(title.pinned, false, "texts stay editable");
    assert.equal(title.fontKey, "handwritten", "the brand's title font");
    assert.equal(title.colorKey, brand.roles.onSurface);
    assert.ok(brand.typeScale!.includes(title.fontSize!), "snapped to the brand's scale");
    assert.equal(title.geometry!.x, 108, "placed where it was measured");
    assert.equal(title.fontSize, 88, "a 81 px box without descenders is about a 92 px font, snapped to the scale");
  }
}
{
  const chipLine = [{ text: "CULTURA", box: { x: 0.07, y: 0.1, w: 0.1, h: 0.015 } }];
  const texts = measureTexts([{ line: 0, zone: "chip", text: "MÚSICA EN VIVO", from: "content" }], chipLine);
  const [, chip] = placePoster(undefined, "0123456789abcdef", texts, canvas, brand).objects;
  assert.ok(chip!.kind === "text" && chip.fontSize! < 24, "a longer chip text steps down the scale to stay in its pill");
}
console.log("ok - recreate-reference");
