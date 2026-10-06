import assert from "node:assert/strict";

import {
  beginStroke,
  buildBrushMask,
  clearStrokes,
  extendStroke,
  imageToScreen,
  rasterizeMask,
  screenRadiusToImageRadius,
  screenToImage,
  undoLastStroke,
} from "./mask";
import type { ImageFrame } from "./mask";

/**
 * `screenToImage`/`imageToScreen`/`rasterizeMask` back slice 1 of #85
 * (odd/tasks/brush-mask.md): a wrong mapping here would mean a mask that
 * paints in the wrong place on the real image, so this exercises `cover`,
 * `contain` (incl. its letterbox), and a rotated box, plus the stroke list
 * and rasterize/confirm shape — no DOM needed, run directly with `tsx`.
 */

function approxEqual(a: number, b: number, tolerance = 1e-6, label = "") {
  assert.ok(Math.abs(a - b) <= tolerance, `${label} expected ${b}, got ${a}`);
}

// --- cover: box narrower than the image's aspect ratio, image overflows vertically ---
{
  // 100x100 box, 200x400 natural image. cover scale = max(100/200, 100/400) = 0.5.
  // Displayed image is 100x200, centered: offsetX = 0, offsetY = (100-200)/2 = -50.
  const frame: ImageFrame = { x: 10, y: 20, w: 100, h: 100, rotation: 0, fit: "cover", naturalWidth: 200, naturalHeight: 400 };

  // Box centre (canvas px: x=10+50=60, y=20+50=70) maps to the image's own centre.
  const center = screenToImage({ x: 60, y: 70 }, frame);
  assert.ok(center, "box centre is inside the visible image");
  approxEqual(center!.x, 100, undefined, "cover centre x");
  approxEqual(center!.y, 200, undefined, "cover centre y");

  // Top-left corner of the box: still inside the image under cover (only over/under-flow is cropped).
  const corner = screenToImage({ x: 10, y: 20 }, frame);
  assert.ok(corner, "box corner stays inside the image under cover");
  approxEqual(corner!.x, 0, undefined, "cover corner x");
  approxEqual(corner!.y, 100, undefined, "cover corner y (cropped 100px off the top)");

  // Outside the box entirely.
  assert.equal(screenToImage({ x: 200, y: 200 }, frame), null);

  // Round trip through imageToScreen.
  const back = imageToScreen(center!, frame);
  approxEqual(back.x, 60, undefined, "cover round-trip x");
  approxEqual(back.y, 70, undefined, "cover round-trip y");
}

// --- contain: box wider than the image's aspect ratio, image letterboxes horizontally ---
{
  // 200x100 box, 100x100 natural (square) image. contain scale = min(200/100, 100/100) = 1.
  // Displayed image is 100x100, centered: offsetX = (200-100)/2 = 50, offsetY = 0.
  const frame: ImageFrame = { x: 0, y: 0, w: 200, h: 100, rotation: 0, fit: "contain", naturalWidth: 100, naturalHeight: 100 };

  // A point in the letterbox margin (x=10, well left of offsetX=50) is outside the visible image.
  assert.equal(screenToImage({ x: 10, y: 50 }, frame), null, "letterbox margin has no image under it");

  // Just inside the visible image's left edge.
  const insideLeftEdge = screenToImage({ x: 50, y: 50 }, frame);
  assert.ok(insideLeftEdge);
  approxEqual(insideLeftEdge!.x, 0, undefined, "contain left edge x");
  approxEqual(insideLeftEdge!.y, 50, undefined, "contain left edge y");

  const center = screenToImage({ x: 100, y: 50 }, frame);
  assert.ok(center);
  approxEqual(center!.x, 50, undefined, "contain centre x");
  approxEqual(center!.y, 50, undefined, "contain centre y");
}

// --- rotated box: rotation is in degrees, about the box centre ---
{
  // 100x100 box centred at (150,150) (x=100,y=100), rotated 90deg, cover with a same-size (100x100) image (scale=1, no crop).
  const frame: ImageFrame = { x: 100, y: 100, w: 100, h: 100, rotation: 90, fit: "cover", naturalWidth: 100, naturalHeight: 100 };

  // The centre always maps to the image centre regardless of rotation.
  const center = screenToImage({ x: 150, y: 150 }, frame);
  assert.ok(center);
  approxEqual(center!.x, 50, 1e-6, "rotated centre x");
  approxEqual(center!.y, 50, 1e-6, "rotated centre y");

  // A point straight "right" of centre on screen (canvas px), rotated -90deg
  // back into box-local space, lands "up" in the unrotated box — i.e. at
  // the image's top edge, not its right edge.
  const rightOfCenter = screenToImage({ x: 190, y: 150 }, frame);
  assert.ok(rightOfCenter);
  approxEqual(rightOfCenter!.x, 50, 1e-6, "rotated right-of-centre x");
  approxEqual(rightOfCenter!.y, 10, 1e-6, "rotated right-of-centre y");

  // Round trip.
  const back = imageToScreen(rightOfCenter!, frame);
  approxEqual(back.x, 190, 1e-6, "rotated round-trip x");
  approxEqual(back.y, 150, 1e-6, "rotated round-trip y");
}

// --- screenRadiusToImageRadius: screen px -> image px through both the CSS zoom and the fit scale ---
{
  // cssScale halves screen->canvas; cover with naturalWidth=200 over a 100px box halves canvas->image again.
  const frame: ImageFrame = { x: 0, y: 0, w: 100, h: 100, rotation: 0, fit: "cover", naturalWidth: 200, naturalHeight: 200 };
  const imageRadius = screenRadiusToImageRadius(20, 0.5, frame);
  approxEqual(imageRadius, 80, undefined, "screen radius through cssScale and fit scale");
}

// --- stroke list: add, extend, undo, clear ---
{
  let strokes = clearStrokes();
  strokes = beginStroke(strokes, "paint", 5, { x: 0, y: 0 });
  strokes = extendStroke(strokes, { x: 10, y: 0 });
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0]!.points.length, 2);

  strokes = beginStroke(strokes, "erase", 3, { x: 5, y: 5 });
  assert.equal(strokes.length, 2);

  strokes = undoLastStroke(strokes);
  assert.equal(strokes.length, 1, "undo removes only the last stroke");
  assert.equal(strokes[0]!.mode, "paint");

  strokes = clearStrokes();
  assert.equal(strokes.length, 0);
}

// --- rasterizeMask: paint, then erase, produces the expected bbox; empty input returns null ---
{
  let strokes = clearStrokes();
  strokes = beginStroke(strokes, "paint", 4, { x: 10, y: 10 });
  strokes = extendStroke(strokes, { x: 20, y: 10 });

  const painted = rasterizeMask(strokes, 40, 40);
  assert.ok(painted, "painted strokes produce a mask");
  assert.ok(painted!.bitmap[10 * 40 + 15] === 1, "midpoint of the painted segment is set");
  assert.ok(painted!.bbox.w > 0 && painted!.bbox.h > 0);

  // Erase over the same area clears every bit that was set.
  strokes = beginStroke(strokes, "erase", 20, { x: 15, y: 10 });
  const erased = rasterizeMask(strokes, 40, 40);
  assert.equal(erased, null, "erasing everything that was painted leaves nothing to rasterize");

  // No strokes at all.
  assert.equal(rasterizeMask(clearStrokes(), 40, 40), null);
}

// --- buildBrushMask: assembles the confirm payload shape ---
{
  let strokes = clearStrokes();
  strokes = beginStroke(strokes, "paint", 4, { x: 10, y: 10 });
  const rasterized = rasterizeMask(strokes, 40, 40);
  assert.ok(rasterized);
  const mask = buildBrushMask("obj-1", 40, 40, rasterized!, "data:image/png;base64,AAAA", "asset-1");
  assert.equal(mask.targetObjectId, "obj-1");
  assert.equal(mask.assetId, "asset-1");
  assert.equal(mask.imageWidth, 40);
  assert.equal(mask.imageHeight, 40);
  assert.deepEqual(mask.bbox, rasterized!.bbox);
  assert.equal(mask.bitmap, rasterized!.bitmap);
  assert.equal(mask.pngDataUrl, "data:image/png;base64,AAAA");
}

console.log("mask.test.ts: ok");
