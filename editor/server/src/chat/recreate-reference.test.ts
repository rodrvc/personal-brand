import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { typeStyle } from "../../../../system/ig-carousel/typography.js";
import type { Slide } from "../../../../system/ig-carousel/carousel-document.js";
import {
  alignColumns,
  anchorLines,
  IDENTITY,
  classifyLines,
  completeTexts,
  numberedLines,
  keepTextsPrompt,
  letterbox,
  measureTexts,
  missingData,
  placePoster,
  refineTexts,
  register,
  settleTexts,
  similarity,
  toSlide,
  unregister,
  weightFor,
  withAbsentLabels,
  withWeekday,
  type PlacedText,
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
{
  // A poster: wordmark, title, a card row (caption over value), a footer, and a line inside the picture.
  const poster = [
    { text: "Example", box: { x: 0.05, y: 0.03, w: 0.2, h: 0.05 } },
    { text: "Old Show", box: { x: 0.05, y: 0.14, w: 0.3, h: 0.04 } },
    { text: "INSIDE", box: { x: 0.45, y: 0.4, w: 0.1, h: 0.02 } },
    { text: "Place", box: { x: 0.14, y: 0.76, w: 0.07, h: 0.017 } },
    { text: "Old Hall", box: { x: 0.14, y: 0.78, w: 0.3, h: 0.019 } },
    { text: "• Somewhere | more at example.org", box: { x: 0.2, y: 0.96, w: 0.6, h: 0.017 } },
  ];
  const picture = { x: 0.3, y: 0.25, w: 0.4, h: 0.4 };
  const kinds = classifyLines(poster, picture, "Example");
  assert.deepEqual(kinds, ["logo", "text", "picture", "label", "text", "text"]);
  assert.deepEqual(numberedLines(poster, kinds)!.map((l) => [l.line, l.kind]), [[0, "logo"], [1, undefined], [3, "label"], [4, undefined], [5, undefined]], "the picture's lines are not the model's to map");
  const model: PosterText[] = [
    { line: 1, zone: "title", text: "New Show", from: "content" },
    { line: 3, zone: "place", text: "New Hall", from: "content" },
    { line: 4, zone: "place", text: "Old Hall", from: "layout" },
  ];
  const completed = completeTexts(model, poster, kinds);
  assert.deepEqual(
    completed.map((t) => [t.line, t.zone, t.text, t.from]),
    [
      [1, "title", "New Show", "content"],
      [3, "label", "Place", "layout"],
      [4, "place", "New Hall", "content"],
      [5, "footer", "Somewhere | more at example.org", "layout"],
    ],
    "the caption stays, its new value goes to the value's line, the omitted footer keeps its text, the logo gets none",
  );
  // A value line the model leaves out does not keep the layout's text: it is asked for, named by what it replaces.
  const omitted = completeTexts([model[0]!], poster, kinds);
  assert.deepEqual(omitted.map((t) => [t.line, t.zone, t.text, t.from]), [
    [1, "title", "New Show", "content"],
    [3, "label", "Place", "layout"],
    [4, "body", "", "missing"],
    [5, "footer", "Somewhere | more at example.org", "layout"],
  ]);
  assert.deepEqual(missingData(omitted), [{ zone: "body", replaces: "Old Hall" }]);
}
{
  const texts = measureTexts([{ line: 0, zone: "chip", text: "NEW", from: "content" }], [{ text: "OLD", box: { x: 0.1, y: 0.1, w: 0.1, h: 0.015 } }]);
  const picture = { assetId: "fedcba9876543210", box: { x: 0.3, y: 0.25, w: 0.4, h: 0.4 } };
  const surface = brand.colors[brand.roles.surface]!.slice(1);
  const slide = placePoster(undefined, "0123456789abcdef", texts, canvas, brand, { picture, behind: () => surface });
  const [, framed, chip] = slide.objects;
  assert.equal(framed!.kind === "asset" && framed.assetId, "fedcba9876543210", "the event's picture goes in the frame");
  assert.deepEqual(framed!.geometry, { x: 324, y: 338, w: 432, h: 540, rotation: 0 });
  assert.equal(framed!.pinned, false, "the picture can be moved");
  assert.notEqual(chip!.kind === "text" && chip.colorKey, brand.roles.surface, "a chip's surface-coloured ink does not vanish on the surface");
}
{
  assert.equal(withWeekday("THU 26 SEP", "2026-09-26", "en-US"), "SAT 26 SEP", "the weekday comes from the date, in the text's case");
  assert.equal(withWeekday("Thu 26 Sep", "2026-09-26", "en-US"), "Sat 26 Sep");
  assert.equal(withWeekday("26 SEP", "2026-09-26", "en-US"), "26 SEP", "no leading word: nothing to rewrite");
  assert.equal(withWeekday("THU 27 SEP", "2026-09-26", "en-US"), "THU 27 SEP", "a text for another day is left alone");
  assert.equal(withWeekday("VIE 25 SEP", "2026-09-26", "es-CL"), "VIE 25 SEP");
  assert.match(withWeekday("VIE 26 SEP", "2026-09-26", "es-CL"), /^S\u00c1B 26 SEP$/, "in the profile's locale");


  assert.deepEqual([0.1, 0.15, 0.2].map(weightFor), [400, 600, 700]);

  const row = (x: number, y: number, text: string): PlacedText => ({ zone: "body", text, from: "layout", box: { x, y, w: 0.3, h: 0.02 } });
  const card = alignColumns([row(0.138, 0.76, "Place"), row(0.151, 0.78, "Hall"), row(0.147, 0.82, "Time"), { ...row(0.75, 0.1, "Date"), box: { x: 0.75, y: 0.1, w: 0.13, h: 0.02 } }]);
  assert.deepEqual(card.slice(0, 3).map((t) => t.box.x), [0.147, 0.147, 0.147], "one column, one start: its median");
  assert.ok(Math.abs(card[0]!.box.x + card[0]!.box.w - 0.438) < 1e-9, "the right edge stays");
  assert.equal(card[3]!.box.x, 0.75, "a right-aligned text keeps its box");

  const refined = refineTexts(
    [
      { line: 0, zone: "chip", text: "LIVE MUSIC", original: "ARTS", from: "layout", box: { x: 0.07, y: 0.1, w: 0.1, h: 0.015 } },
      { line: 1, zone: "date", text: "THU 26 SEP", date: "2026-09-26", from: "content", box: { x: 0.75, y: 0.1, w: 0.13, h: 0.016 } },
      row(0.138, 0.76, "Place"),
    ].map((t) => ({ line: 2, ...t })) as PlacedText[],
    { locale: "en-US" },
    { stroke: (box) => (box.y < 0.5 ? 0.2 : 0.1), left: (box) => box.x + 0.01, colour: () => "#123456" },
  );
  assert.deepEqual(refined.map((t) => [t.text, t.weight]), [["LIVE MUSIC", 700], ["SAT 26 SEP", 700], ["Place", 400]], "a chip is a text like any other");
  assert.equal(refined[0]!.box.x, 0.07, "a chip's box is not moved to its ink: it is centred on its pill");
  assert.ok(Math.abs(refined[2]!.box.x - 0.148) < 1e-9, "a text starts where its ink starts");
}
{
  const line = [{ text: "Old", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.03 } }];
  const [text] = measureTexts([{ line: 0, zone: "subtitle", text: "New", from: "content" }], line);
  const colourOf = (color: string | undefined, behind = "ffffff") => {
    const [object] = placePoster(undefined, "0123456789abcdef", [{ ...text!, color }], canvas, brand, { behind: () => behind }).objects.slice(1);
    return object!.kind === "text" ? { colorKey: object.colorKey, color: object.color } : {};
  };
  const [brandKey, brandHex] = Object.entries(brand.colors).find(([, hex]) => hex.toLowerCase() !== "#ffffff")!;
  assert.deepEqual(colourOf("#7b3a9e"), { colorKey: undefined, color: "#7b3a9e" }, "the reference's colour, as it is, when the brand has none like it");
  assert.equal(colourOf(brandHex).colorKey, brandKey, "a brand colour when the measured one is it");
  assert.equal(colourOf(undefined, "000000").colorKey, brand.roles[typeStyle(brand, "subtitle").color as keyof typeof brand.roles], "the role's colour when nothing was measured");
  assert.equal(colourOf("#f0f0f0").color, undefined, "a colour that would not read on what is behind falls back to the best-contrast brand colour");
}
{
  const line = [{ text: "Old", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.03 } }];
  const [title] = measureTexts([{ line: 0, zone: "title", text: "New", from: "content", weight: 400, color: "#222222" }], line);
  const plain = placePoster(undefined, "0123456789abcdef", [title!], canvas, brand, { behind: () => "ffffff" }).objects[1]!;
  const asked = placePoster(undefined, "0123456789abcdef", [{ ...title!, restyle: { scale: 1.5, color: "#ffd400", weight: 700 } }], canvas, brand, {
    behind: () => "ffffff",
  }).objects[1]!;
  assert.ok(plain.kind === "text" && asked.kind === "text");
  if (plain.kind === "text" && asked.kind === "text") {
    assert.equal(asked.fontSize, Math.round(plain.fontSize! * 1.5), "the size the owner asked for, off the scale");
    assert.equal(asked.fontWeight, 700);
    assert.equal(asked.color, "#ffd400", "the owner's colour stands, even where the contrast check would replace it");
  }
}
{
  // A bigger size never pushes a long text past the layout's margins, nor below the size it had.
  const line = [{ text: "Old", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.03 } }];
  const [title] = measureTexts([{ line: 0, zone: "title", text: "A tribute night", from: "content" }], line);
  const plain = placePoster(undefined, "0123456789abcdef", [title!], canvas, brand).objects[1]!;
  const asked = placePoster(undefined, "0123456789abcdef", [{ ...title!, restyle: { scale: 3 } }], canvas, brand).objects[1]!;
  assert.ok(plain.kind === "text" && asked.kind === "text");
  if (plain.kind === "text" && asked.kind === "text") {
    assert.ok(asked.fontSize! < Math.round(plain.fontSize! * 3), "capped by the margins");
    assert.ok(asked.fontSize! >= plain.fontSize!, "never smaller than asked-for bigger");
    assert.ok(asked.geometry!.x >= Math.floor(0.1 * canvas.w) - 1, "keeps the left margin");
  }
  // A font that sets narrower than the estimate, as measured on the old line, leaves room to grow.
  const narrow = { ...title!, original: "Old line text" };
  const plainNarrow = placePoster(undefined, "0123456789abcdef", [narrow], canvas, brand).objects[1]!;
  const grown = placePoster(undefined, "0123456789abcdef", [{ ...narrow, restyle: { scale: 1.3 } }], canvas, brand).objects[1]!;
  if (plainNarrow.kind === "text" && grown.kind === "text") assert.equal(grown.fontSize, Math.round(plainNarrow.fontSize! * 1.3));
}
{
  // A left text whose estimated width runs past the canvas keeps its start rather than sliding to the edge.
  const line = [{ text: "Old", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.03 } }];
  const [title] = measureTexts([{ line: 0, zone: "title", text: "A VERY LONG EVENT NAME WRITTEN IN CAPITALS", from: "content" }], line);
  const placed = placePoster(undefined, "0123456789abcdef", [title!], canvas, brand).objects[1]!;
  assert.equal(placed.geometry!.x, Math.round(0.1 * canvas.w));
  assert.ok(placed.geometry!.x + placed.geometry!.w <= canvas.w);
}
{
  // No event datum is inherited from the layout: marked missing, taken from the layout or left empty, it is asked for.
  const texts: PosterText[] = [
    { line: 0, zone: "title", text: "New Show", from: "content" },
    { line: 1, zone: "time", text: "", from: "missing" },
    { line: 2, zone: "place", text: "Old Hall", from: "layout" },
    { line: 3, zone: "label", text: "Place", from: "layout" },
    { line: 4, zone: "price", text: "", from: "content" },
    { line: 5, zone: "date", text: "", from: "absent" },
    { line: 6, zone: "time", text: "", from: "missing" },
    { line: 7, zone: "entry", text: "Free", from: "owner" },
    { line: 8, zone: "footer", text: "site", from: "layout" },
  ];
  assert.deepEqual(missingData(texts).map((m) => m.zone), ["time", "place", "price"], "every missing datum, once, in order; labels, the footer and what does not exist are not asked for");
  assert.deepEqual(missingData([texts[0]!, texts[5]!, texts[7]!, texts[8]!]), [], "given by the content or the owner, or not there at all");
  const lines = [
    { text: "Place", box: { x: 0.1, y: 0.5, w: 0.1, h: 0.02 } },
    { text: "Old Hall", box: { x: 0.1, y: 0.525, w: 0.3, h: 0.03 } },
  ];
  const labelled = withAbsentLabels([{ line: 0, zone: "label", text: "Place", from: "layout" }, { line: 1, zone: "place", text: "", from: "absent" }], lines);
  assert.deepEqual(labelled.map((t) => t.from), ["absent", "absent"], "the label of a datum the event does not have goes with it");
  const measured = measureTexts(labelled, lines);
  assert.equal(measured.length, 2, "absent texts are kept to be erased, though empty");
  assert.equal(placePoster(undefined, "0123456789abcdef", measured, canvas, brand).objects.length, 1, "but never placed as texts");
}
console.log("ok - recreate-reference");
