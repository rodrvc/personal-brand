import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { detectImage } from "../../../system/assets/index.js";
import { colourReader, cropToSize, inkReader, recolourPill, edgeColor, encodePng, eraseBoxes, findPicture, findPill, padToSize, remap, toRgba, widenPill } from "./image-tools.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

if (existsSync("/usr/bin/sips")) {
  const padded = detectImage(padToSize(TINY_PNG, 64, 96), "out.png");
  assert.deepEqual([padded.mime, padded.w, padded.h], ["image/png", 64, 96], "letterboxed to exactly the requested size");
  const cropped = detectImage(cropToSize(padToSize(TINY_PNG, 64, 96), 40, 50), "out.png");
  assert.deepEqual([cropped.w, cropped.h], [40, 50], "cropped to the exact size");
  const white = padToSize(TINY_PNG, 20, 40, "FFFFFF");
  assert.equal(edgeColor(white), "FFFFFF", "the colour of the band above the picture");
  const blackSquare = padToSize(TINY_PNG, 20, 40, "FFFFFF");
  const erased = eraseBoxes(blackSquare, [{ x: 0, y: 0.25, w: 1, h: 0.5 }]);
  assert.equal(edgeColor(cropToSize(erased, 20, 4)), "FFFFFF", "the square is painted with the colour around it");
  assert.equal(edgeColor(cropToSize(blackSquare, 20, 4)), "000000");
  console.log("ok - image-tools");
} else {
  console.log("skip - no sips on this system");
}
{
  // A horizontal gradient with a black bar across its middle rows.
  const w = 40;
  const h = 20;
  const gradient = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bar = y >= 8 && y < 12 && x >= 10 && x < 30;
      gradient.set(bar ? [0, 0, 0, 255] : [100 + x, 100 + x, 100 + x, 255], (y * w + x) * 4);
    }
  }
  const png = encodePng(w, h, gradient);
  const erased = toRgba(eraseBoxes(png, [{ x: 10 / w, y: 8 / h, w: 20 / w, h: 4 / h }])).pixels;
  for (const x of [12, 20, 28]) {
    assert.ok(Math.abs(erased[(10 * w + x) * 4]! - (100 + x)) <= 3, `the gradient continues through the erased bar at x=${x}`);
  }
  const shifted = toRgba(remap(png, { sx: 1, ox: 0.25, sy: 1, oy: 0 })).pixels;
  assert.equal(shifted[(2 * w + 5) * 4], 100 + 15, "each point reads the image a quarter further right");
  assert.equal(shifted[(2 * w + 39) * 4], 100 + 39, "past the edge, the edge repeats");
  const same = toRgba(remap(png, { sx: 1, ox: 0, sy: 1, oy: 0 })).pixels;
  assert.deepEqual(same, toRgba(png).pixels, "the identity leaves the image as it is");
  const filled = toRgba(remap(png, { sx: 1, ox: 0.5, sy: 1, oy: 0 }, undefined, undefined, "FF0000")).pixels;
  assert.deepEqual([...filled.slice((2 * w + 39) * 4, (2 * w + 39) * 4 + 4)], [255, 0, 0, 255], "past the edge, the fill colour");
  const small = toRgba(remap(png, { sx: 1, ox: 0, sy: 1, oy: 0 }, 20, 10));
  assert.deepEqual([small.width, small.height], [20, 10], "resampled into the requested size");
  // A dark icon touching the bar's left edge must not streak into the fill.
  const withIcon = new Uint8Array(gradient);
  for (let y = 8; y < 12; y++) for (let x = 5; x < 10; x++) withIcon.set([0, 0, 0, 255], (y * w + x) * 4);
  const clean = toRgba(eraseBoxes(encodePng(w, h, withIcon), [{ x: 10 / w, y: 8 / h, w: 20 / w, h: 4 / h }])).pixels;
  assert.ok(clean[(10 * w + 14) * 4]! > 100, "the icon's pixels count as the surface, not as black");
  console.log("ok - image-tools pixels");
}
if (existsSync("/usr/bin/sips")) {
  // A pale page with a thin dark line of "text" and a framed, noisy picture below it.
  const [w, h] = [432, 540];
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const text = y >= 40 && y < 56 && x >= 30 && x < 300 && x % 6 < 3;
      const picture = x >= 130 && x < 300 && y >= 140 && y < 360;
      const noise = (x * 7 + y * 13) % 90;
      page.set(text ? [20, 20, 20, 255] : picture ? [120 + noise, 60, 150 - noise, 255] : [246, 243, 248, 255], (y * w + x) * 4);
    }
  }
  const found = findPicture(encodePng(w, h, page))!;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
  assert.ok(near(found.x, 130 / w) && near(found.y, 140 / h), `the picture's corner, not the text above it: ${JSON.stringify(found)}`);
  assert.ok(near(found.w, 170 / w) && near(found.h, 220 / h));
  assert.equal(findPicture(encodePng(w, h, new Uint8Array(w * h * 4).fill(250))), undefined, "a blank page has no picture");
  console.log("ok - image-tools picture");
}
{
  // A pale page with a purple pill holding (erased) text.
  const [w, h] = [200, 100];
  const page = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) page.set(x >= 20 && x < 80 && y >= 40 && y < 60 ? [120, 60, 170, 255] : [246, 243, 248, 255], (y * w + x) * 4);
  }
  const png = encodePng(w, h, page);
  const text = { x: 30 / w, y: 45 / h, w: 40 / w, h: 10 / h };
  assert.deepEqual(findPill(png, text), { x0: 20, x1: 79, y0: 40, y1: 59 }, "the pill around the text");
  assert.equal(findPill(png, { x: 120 / w, y: 45 / h, w: 20 / w, h: 10 / h }), undefined, "no pill on the bare page");
  const wider = findPill(widenPill(png, findPill(png, text)!, 30), text);
  assert.deepEqual(wider, { x0: 20, x1: 109, y0: 40, y1: 59 }, "30 px wider, same height");
  const read = colourReader(png);
  assert.equal(read(text), "783CAA", "what is behind the text: the pill");
  assert.equal(read({ x: 0, y: 0, w: 0.05, h: 0.1 }), "F6F3F8");
  const red = toRgba(recolourPill(png, findPill(png, text)!, "#E63946")).pixels;
  assert.deepEqual([...red.subarray((50 * w + 50) * 4, (50 * w + 50) * 4 + 3)], [230, 57, 70], "the pill takes the new colour");
  assert.deepEqual([...red.subarray((50 * w + 150) * 4, (50 * w + 150) * 4 + 3)], [246, 243, 248], "the page around it does not");
  console.log("ok - image-tools pill");
}
{
  // Dark vertical stems on a pale page: thin ones from x 20, thick ones from x 60.
  const [w, h] = [120, 40];
  const page = new Uint8Array(w * h * 4).fill(250);
  for (let y = 10; y < 30; y++) {
    for (let x = 0; x < w; x++) {
      const thin = x >= 12 && x < 50 && x % 10 < 2;
      const thick = x >= 60 && x < 110 && x % 10 < 5;
      if (thin || thick) page.set([20, 20, 20, 255], (y * w + x) * 4);
    }
  }
  const ink = inkReader(encodePng(w, h, page));
  const thin = { x: 5 / w, y: 10 / h, w: 45 / w, h: 20 / h };
  const thick = { x: 60 / w, y: 10 / h, w: 50 / w, h: 20 / h };
  assert.ok(Math.abs(ink.stroke(thin) - 0.1) < 1e-9 && Math.abs(ink.stroke(thick) - 0.25) < 1e-9, "stroke width over line height");
  assert.equal(ink.left(thin), 20 / w, "the first column with ink, past the box's padding");
  assert.equal(ink.colour(thick), "#141414", "the ink's own colour, not the page's");
  console.log("ok - image-tools ink");
}
