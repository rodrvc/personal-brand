/**
 * Pure brush-mask model (issue #85, slice 1): no DOM, testable with `tsx`
 * directly. Strokes are stored in the target image's *natural pixel space*
 * (never canvas or screen px), so a confirmed mask stays correct regardless
 * of zoom and rasterizes straight against the real image dimensions.
 *
 * Three spaces: screen px (real display pixels) -> canvas px (the slide
 * document's own space, `doc.canvas.w/h`, `screen = canvas * cssScale`,
 * Stage.tsx's `scale`) -> image px (the target `<img>`'s own grid,
 * `naturalWidth`/`naturalHeight`). `screenToImage`/`imageToScreen` convert
 * canvas<->image given an `ImageFrame`; screen<->canvas is the caller's job
 * (divide/multiply by `scale`), same as `SelectionOverlay.tsx` does.
 */

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The object's box in canvas px (rotation in degrees about the box's own centre, matching `free-layout.ts`'s CSS `transform: rotate()`) plus its `fit` and natural size. */
export interface ImageFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  fit: "cover" | "contain";
  naturalWidth: number;
  naturalHeight: number;
}

export type StrokeMode = "paint" | "erase";

/** One continuous brush stroke, in image (natural) px. */
export interface Stroke {
  mode: StrokeMode;
  /** Brush radius, in image (natural) px. */
  radius: number;
  points: Point[];
}

export interface BrushMask {
  targetObjectId: string;
  assetId?: string;
  imageWidth: number;
  imageHeight: number;
  bbox: BBox;
  bitmap: Uint8Array;
  pngDataUrl: string;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Box px per image (natural) px under `fit`: `cover` scales to the larger axis (overflow cropped), `contain` to the smaller (letterboxed). Both centre, matching `object-fit`'s default `object-position: 50% 50%`. */
export function imageDisplayScale(frame: ImageFrame): number {
  const { w, h, naturalWidth, naturalHeight, fit } = frame;
  if (naturalWidth <= 0 || naturalHeight <= 0) return 1;
  const sx = w / naturalWidth;
  const sy = h / naturalHeight;
  return fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
}

/**
 * Maps a point in slide canvas px to the target image's natural pixel
 * space. Returns `null` when the point falls outside the object's box, or —
 * for `fit: "contain"` only — inside the box but in the letterboxed margin
 * around the image (there is nothing to paint there).
 */
export function screenToImage(point: Point, frame: ImageFrame): Point | null {
  const { x, y, w, h, rotation, naturalWidth, naturalHeight } = frame;
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const dx = point.x - centerX;
  const dy = point.y - centerY;

  // Un-rotate the point into the box's own (unrotated) local space.
  const rad = degToRad(-rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const localX = w / 2 + (dx * cos - dy * sin);
  const localY = h / 2 + (dx * sin + dy * cos);

  if (localX < 0 || localX > w || localY < 0 || localY > h) return null;

  const scale = imageDisplayScale(frame);
  const displayedW = naturalWidth * scale;
  const displayedH = naturalHeight * scale;
  const offsetX = (w - displayedW) / 2;
  const offsetY = (h - displayedH) / 2;

  if (localX < offsetX || localX > offsetX + displayedW || localY < offsetY || localY > offsetY + displayedH) {
    // Only reachable under `fit: "contain"`: `cover` always overflows or
    // exactly fills the box on both axes, so offsetX/offsetY are <= 0 there.
    return null;
  }

  return { x: (localX - offsetX) / scale, y: (localY - offsetY) / scale };
}

/**
 * Inverse of `screenToImage`: maps an image-space point back to canvas px
 * given the object's *current* frame. Used to redraw stored strokes as the
 * frame changes (window resize, fit-to-stage recompute) — the strokes
 * themselves never move, only where they land on screen does.
 */
export function imageToScreen(point: Point, frame: ImageFrame): Point {
  const { x, y, w, h, rotation, naturalWidth, naturalHeight } = frame;
  const scale = imageDisplayScale(frame);
  const displayedW = naturalWidth * scale;
  const displayedH = naturalHeight * scale;
  const offsetX = (w - displayedW) / 2;
  const offsetY = (h - displayedH) / 2;

  const localX = offsetX + point.x * scale;
  const localY = offsetY + point.y * scale;
  const dx = localX - w / 2;
  const dy = localY - h / 2;

  const rad = degToRad(rotation);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedX = dx * cos - dy * sin;
  const rotatedY = dx * sin + dy * cos;

  return { x: x + w / 2 + rotatedX, y: y + h / 2 + rotatedY };
}

/**
 * Converts a brush radius chosen on screen (px) to the target image's
 * natural pixel space, given the stage's current CSS zoom (`cssScale`,
 * Stage.tsx's `scale`) and the object's frame — so the painted circle's
 * *visual* size on screen stays what the slider says regardless of zoom or
 * how large the image is actually rendered inside its box.
 */
export function screenRadiusToImageRadius(screenRadius: number, cssScale: number, frame: ImageFrame): number {
  const canvasRadius = cssScale > 0 ? screenRadius / cssScale : screenRadius;
  const scale = imageDisplayScale(frame);
  return scale > 0 ? canvasRadius / scale : canvasRadius;
}

// --- Stroke list: immutable helpers, same style as editor/mutations.ts ---

export function beginStroke(strokes: Stroke[], mode: StrokeMode, radius: number, point: Point): Stroke[] {
  return [...strokes, { mode, radius, points: [point] }];
}

export function extendStroke(strokes: Stroke[], point: Point): Stroke[] {
  if (strokes.length === 0) return strokes;
  const last = strokes[strokes.length - 1]!;
  return [...strokes.slice(0, -1), { ...last, points: [...last.points, point] }];
}

export function undoLastStroke(strokes: Stroke[]): Stroke[] {
  return strokes.slice(0, -1);
}

export function clearStrokes(): Stroke[] {
  return [];
}

// --- Rasterize ---

function stampCircle(
  bitmap: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 1,
): void {
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) bitmap[py * width + px] = value;
    }
  }
}

/** Stamps circles at samples along one segment, close enough together (half a radius apart) to leave no gaps. */
function stampSegment(
  bitmap: Uint8Array,
  width: number,
  height: number,
  from: Point,
  to: Point,
  radius: number,
  value: 0 | 1,
): void {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, radius / 2);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stampCircle(bitmap, width, height, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, value);
  }
}

export interface RasterizedMask {
  bitmap: Uint8Array;
  bbox: BBox;
}

/**
 * Stamps every stroke's circles onto a `width`x`height` bitmap, in stroke
 * order — `paint` sets pixels to 1, `erase` clears them back to 0, so an
 * erase stroke drawn after a paint stroke actually removes it, exactly like
 * the on-screen preview. Returns `null` when nothing ends up painted (no
 * strokes, or every paint stroke got erased away).
 */
export function rasterizeMask(strokes: Stroke[], width: number, height: number): RasterizedMask | null {
  const bitmap = new Uint8Array(width * height);
  for (const stroke of strokes) {
    const value: 0 | 1 = stroke.mode === "paint" ? 1 : 0;
    if (stroke.points.length === 0) continue;
    if (stroke.points.length === 1) {
      const [only] = stroke.points;
      stampCircle(bitmap, width, height, only!.x, only!.y, stroke.radius, value);
      continue;
    }
    for (let i = 1; i < stroke.points.length; i++) {
      stampSegment(bitmap, width, height, stroke.points[i - 1]!, stroke.points[i]!, stroke.radius, value);
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (bitmap[py * width + px] === 1) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }
  if (maxX < 0) return null;
  return { bitmap, bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
}

/**
 * Assembles the confirm payload. `pngDataUrl` is produced by a browser-only
 * adapter (`maskPng.ts`, `Canvas`-based) kept outside this DOM-free module —
 * this function just carries that string through.
 */
export function buildBrushMask(
  targetObjectId: string,
  imageWidth: number,
  imageHeight: number,
  rasterized: RasterizedMask,
  pngDataUrl: string,
  assetId?: string,
): BrushMask {
  return {
    targetObjectId,
    assetId,
    imageWidth,
    imageHeight,
    bbox: rasterized.bbox,
    bitmap: rasterized.bitmap,
    pngDataUrl,
  };
}
