import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectImage } from "../../../system/assets/index.js";

import { messages } from "./messages.js";

export class ImageToolUnavailableError extends Error {}

/** Image conversion runs through macOS `sips`; elsewhere it fails with this error instead of a spawn ENOENT. */
export function requireImageTool(): void {
  if (process.platform !== "darwin") {
    throw new ImageToolUnavailableError(messages.imageToolUnavailable);
  }
}

export function withSips(bytes: Buffer, steps: Array<(input: string, output: string) => string[]>, inputExtension = ""): Buffer {
  requireImageTool();
  const dir = mkdtempSync(join(tmpdir(), "image-tools-"));
  try {
    let current = join(dir, `in${inputExtension}`);
    writeFileSync(current, bytes);
    steps.forEach((step, i) => {
      const next = join(dir, `step-${i}.png`);
      execFileSync("sips", step(current, next), { stdio: "ignore" });
      current = next;
    });
    return readFileSync(current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Letterboxes the image into exactly `w`x`h`, keeping its proportions, as a PNG. */
export function padToSize(bytes: Buffer, w: number, h: number, padColor = "FFFFFF"): Buffer {
  const source = detectImage(bytes, "image");
  const widthBound = !source.w || !source.h || source.w / source.h >= w / h;
  return withSips(bytes, [
    (input, output) => ["-s", "format", "png", widthBound ? "--resampleWidth" : "--resampleHeight", String(widthBound ? w : h), input, "--out", output],
    (input, output) => ["-p", String(h), String(w), "--padColor", padColor, input, "--out", output],
  ]);
}

/** Centre-crops the image to the proportion of `w`x`h` and scales it to exactly that size, as a PNG. */
export function cropToSize(bytes: Buffer, w: number, h: number): Buffer {
  const source = detectImage(bytes, "image");
  if (!source.w || !source.h) throw new Error("Cannot read the image size to crop it.");
  const wider = source.w / source.h > w / h;
  const cropW = wider ? Math.round((source.h * w) / h) : source.w;
  const cropH = wider ? source.h : Math.round((source.w * h) / w);
  return withSips(bytes, [
    (input, output) => ["-s", "format", "png", "-c", String(cropH), String(cropW), input, "--out", output],
    (input, output) => ["-z", String(h), String(w), input, "--out", output],
  ]);
}

/** The average colour of the image's top edge, as a hex without `#`, for padding that blends in. */
export function edgeColor(bytes: Buffer): string {
  const small = withSips(bytes, [(input, output) => ["-s", "format", "png", "-z", "50", "40", input, "--out", output]]);
  const { width, channels, rows } = decodePng(small);
  const sums = [0, 0, 0];
  const gray = channels < 3;
  for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) sums[c]! += rows[0]![x * channels + (gray ? 0 : c)]!;
  return sums.map((sum) => Math.round(sum / width).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Minimal decoder for the 8-bit, non-interlaced PNGs `sips` writes: unfilters each scanline. */
function decodePng(png: Buffer): { width: number; channels: number; rows: Uint8Array[] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[png[25]!] ?? 3;
  const chunks: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IEND") break;
    if (type === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      const predictor =
        filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? (left + up) >> 1
        : filter === 4 ? paeth(left, up, upLeft)
        : 0;
      row[i] = (row[i]! + predictor) & 0xff;
    }
    rows.push(row);
    previous = row;
  }
  return { width, channels, rows };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far an edge pixel may be from the box's surrounding colour and still count as that surface. */
const EDGE_TOLERANCE = 32;
const EDGE_BLUR = 8;

/**
 * The most common colour among the pixels, averaged within its bin of 16 levels per channel. A per-channel median
 * would mix two surfaces into a colour that is neither (lavender and yellow into pink).
 */
function dominantColour(colours: number[][]): number[] {
  const bins = new Map<number, number[][]>();
  for (const colour of colours) {
    const key = (colour[0]! >> 4) * 256 + (colour[1]! >> 4) * 16 + (colour[2]! >> 4);
    bins.set(key, [...(bins.get(key) ?? []), colour]);
  }
  const top = [...bins.values()].sort((a, b) => b.length - a.length)[0];
  if (!top) return [255, 255, 255];
  return [0, 1, 2].map((c) => top.reduce((sum, colour) => sum + colour[c]!, 0) / top.length);
}

/** Moving average over `radius` values on each side. */
function blur(values: number[], radius: number): number[] {
  const sums = [0];
  for (const v of values) sums.push(sums[sums.length - 1]! + v);
  return values.map((_, i) => {
    const [from, to] = [Math.max(0, i - radius), Math.min(values.length, i + radius + 1)];
    return (sums[to]! - sums[from]!) / (to - from);
  });
}

/**
 * Fills each box (fractions of the image), grown by an eighth of its height to take the anti-aliased edge, with the
 * surface around it: every pixel blends the colours just outside the box on its row and on its column, weighted by
 * distance, so a gradient continues through the box instead of leaving a flat patch. Returns a PNG.
 */
export function eraseBoxes(png: Buffer, boxes: PixelBox[]): Buffer {
  const { width, height, pixels } = toRgba(png);
  for (const box of boxes) {
    const pad = Math.max(2, Math.round(0.12 * box.h * height));
    // A side that reaches the image's edge has no surface beyond it: the fill leans on the opposite side alone.
    const x0 = Math.max(0, Math.floor(box.x * width) - pad);
    const y0 = Math.max(0, Math.floor(box.y * height) - pad);
    const x1 = Math.min(width, Math.ceil((box.x + box.w) * width) + pad);
    const y1 = Math.min(height, Math.ceil((box.y + box.h) * height) + pad);
    if (x1 <= x0 || y1 <= y0) continue;
    const sides = { left: x0 > 0, right: x1 < width, top: y0 > 0, bottom: y1 < height };
    const raw = (x: number, y: number, c: number) => pixels[(y * width + x) * 4 + c]!;
    const ring: Array<[number, number]> = [];
    for (let x = x0; x < x1; x++) {
      if (sides.top) ring.push([x, y0 - 1]);
      if (sides.bottom) ring.push([x, y1]);
    }
    for (let y = y0; y < y1; y++) {
      if (sides.left) ring.push([x0 - 1, y]);
      if (sides.right) ring.push([x1, y]);
    }
    const surface = dominantColour(ring.map(([x, y]) => [raw(x, y, 0), raw(x, y, 1), raw(x, y, 2)]));
    // An edge pixel far from the surrounding colour belongs to something touching the box (an icon, a frame, a
    // letter): interpolating from it would drag streaks across the box, so it counts as that colour instead.
    const at = (x: number, y: number, c: number) =>
      [0, 1, 2].some((k) => Math.abs(raw(x, y, k) - surface[k]!) > EDGE_TOLERANCE) ? surface[c]! : raw(x, y, c);
    // Averaged along each side, so a faint remnant on an edge fades out instead of drawing a line across the box.
    const edge = (length: number, read: (i: number, c: number) => number) =>
      [0, 1, 2].map((c) => blur(Array.from({ length }, (_, i) => read(i, c)), EDGE_BLUR));
    const edges = {
      top: sides.top ? edge(x1 - x0, (i, c) => at(x0 + i, y0 - 1, c)) : undefined,
      bottom: sides.bottom ? edge(x1 - x0, (i, c) => at(x0 + i, y1, c)) : undefined,
      left: sides.left ? edge(y1 - y0, (i, c) => at(x0 - 1, y0 + i, c)) : undefined,
      right: sides.right ? edge(y1 - y0, (i, c) => at(x1, y0 + i, c)) : undefined,
    };
    const between = (a: number | undefined, b: number | undefined, da: number, db: number) =>
      a !== undefined && b !== undefined ? (a * db + b * da) / (da + db) : (a ?? b);
    const fill = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dl = x - x0 + 1;
        const dr = x1 - x;
        const dt = y - y0 + 1;
        const db = y1 - y;
        for (let c = 0; c < 3; c++) {
          const across = between(edges.left?.[c]![y - y0], edges.right?.[c]![y - y0], dl, dr);
          const down = between(edges.top?.[c]![x - x0], edges.bottom?.[c]![x - x0], dt, db);
          // The nearer pair of edges knows the surface better: a wide box leans on top and bottom.
          const wAcross = across === undefined ? 0 : 1 / Math.min(sides.left ? dl : Infinity, sides.right ? dr : Infinity);
          const wDown = down === undefined ? 0 : 1 / Math.min(sides.top ? dt : Infinity, sides.bottom ? db : Infinity);
          const total = wAcross + wDown;
          fill[((y - y0) * (x1 - x0) + (x - x0)) * 3 + c] = total > 0 ? Math.round(((across ?? 0) * wAcross + (down ?? 0) * wDown) / total) : 255;
        }
      }
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const f = ((y - y0) * (x1 - x0) + (x - x0)) * 3;
        pixels[i] = fill[f]!;
        pixels[i + 1] = fill[f + 1]!;
        pixels[i + 2] = fill[f + 2]!;
        pixels[i + 3] = 255;
      }
    }
  }
  return encodePng(width, height, pixels);
}

/**
 * Resamples the image into `outW`x`outH` so that each point of the result reads the image at `scale * point + offset`
 * per axis (fractions of each), bilinearly. Points that fall outside repeat the nearest edge, or take `fill` (a hex
 * without `#`) when given: repeating a cut edge that crosses a text draws streaks. Returns a PNG.
 */
export function remap(png: Buffer, r: { sx: number; ox: number; sy: number; oy: number }, outW?: number, outH?: number, fill?: string): Buffer {
  const { width, height, pixels } = toRgba(png);
  const w = outW ?? width;
  const h = outH ?? height;
  const out = new Uint8Array(w * h * 4);
  const fillRgba = fill ? [0, 2, 4].map((i) => parseInt(fill.slice(i, i + 2), 16)).concat(255) : undefined;
  const outside = (at: number, size: number) => at < -1 || at > size;
  for (let y = 0; y < h; y++) {
    const rawY = (r.sy * (y + 0.5) / h + r.oy) * height - 0.5;
    const sy = Math.min(height - 1, Math.max(0, rawY));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const rawX = (r.sx * (x + 0.5) / w + r.ox) * width - 0.5;
      if (fillRgba && (outside(rawX, width) || outside(rawY, height))) {
        out.set(fillRgba, (y * w + x) * 4);
        continue;
      }
      const sx = Math.min(width - 1, Math.max(0, rawX));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const p = (xx: number, yy: number) => pixels[(yy * width + xx) * 4 + c]!;
        const top = p(x0, y0) * (1 - fx) + p(x1, y0) * fx;
        const bottom = p(x0, y1) * (1 - fx) + p(x1, y1) * fx;
        out[(y * w + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return encodePng(w, h, out);
}

export function toRgba(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const { width, channels, rows } = decodePng(png);
  const pixels = new Uint8Array(width * rows.length * 4);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const gray = channels < 3;
      for (let c = 0; c < 3; c++) pixels[at + c] = row[x * channels + (gray ? 0 : c)]!;
      pixels[at + 3] = channels === 4 ? row[x * 4 + 3]! : channels === 2 ? row[x * 2 + 1]! : 255;
    }
  });
  return { width, height: rows.length, pixels };
}

export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PICTURE_SCAN_WIDTH = 216;

/**
 * The box (fractions) of the largest picture on a poster: the region that is neither the page's colour (read at its
 * border) nor flat. Texts, chips and icons are also "busy" but thin, so an opening wider than a line of text
 * removes them and leaves the picture, whose bounding box is returned; undefined when nothing that large is left.
 */
export function findPicture(bytes: Buffer): PixelBox | undefined {
  const source = detectImage(bytes, "image");
  if (!source.w || !source.h) return undefined;
  const h = Math.round((PICTURE_SCAN_WIDTH * source.h) / source.w);
  const { width, height, pixels } = toRgba(withSips(bytes, [(input, output) => ["-s", "format", "png", "-z", String(h), String(PICTURE_SCAN_WIDTH), input, "--out", output]]));
  const color = (i: number) => [pixels[i * 4]!, pixels[i * 4 + 1]!, pixels[i * 4 + 2]!];
  const border = Array.from({ length: width }, (_, x) => x).flatMap((x) => [x, (height - 1) * width + x]);
  const page = [0, 1, 2].map((c) => border.map((i) => color(i)[c]!).sort((a, b) => a - b)[border.length >> 1]!);
  const luma = Float32Array.from({ length: width * height }, (_, i) => 0.3 * pixels[i * 4]! + 0.59 * pixels[i * 4 + 1]! + 0.11 * pixels[i * 4 + 2]!);
  const busy = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const offPage = color(i).some((v, c) => Math.abs(v - page[c]!) > 30);
      const edge = x + 1 < width && y + 1 < height && Math.abs(luma[i]! - luma[i + 1]!) + Math.abs(luma[i]! - luma[i + width]!) > 24;
      busy[i] = offPage || edge ? 1 : 0;
    }
  }
  const radius = Math.round(0.05 * width);
  const opened = dilate(erode(busy, width, height, radius), width, height, radius);
  let best: PixelBox | undefined;
  let bestArea = 0;
  const seen = new Uint8Array(width * height);
  for (let start = 0; start < opened.length; start++) {
    if (!opened[start] || seen[start]) continue;
    let [minX, minY, maxX, maxY, area] = [width, height, 0, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      [minX, minY, maxX, maxY, area] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y), area + 1];
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
        if (j >= 0 && j < opened.length && opened[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (area > bestArea) {
      bestArea = area;
      best = { x: minX / width, y: minY / height, w: (maxX + 1 - minX) / width, h: (maxY + 1 - minY) / height };
    }
  }
  return best && bestArea >= 0.02 * width * height ? best : undefined;
}

/** Counts of set cells in every (2r+1)-square window, from a summed-area table. */
function windowSums(mask: Uint8Array, width: number, height: number, r: number): (x: number, y: number) => number {
  const table = new Int32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      table[(y + 1) * (width + 1) + x + 1] = mask[y * width + x]! + table[y * (width + 1) + x + 1]! + table[(y + 1) * (width + 1) + x]! - table[y * (width + 1) + x]!;
    }
  }
  return (x, y) => {
    const [x0, y0, x1, y1] = [Math.max(0, x - r), Math.max(0, y - r), Math.min(width, x + r + 1), Math.min(height, y + r + 1)];
    return table[y1 * (width + 1) + x1]! - table[y0 * (width + 1) + x1]! - table[y1 * (width + 1) + x0]! + table[y0 * (width + 1) + x0]!;
  };
}

function erode(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const sum = windowSums(mask, width, height, r);
  const full = (x: number, y: number) => (Math.min(width, x + r + 1) - Math.max(0, x - r)) * (Math.min(height, y + r + 1) - Math.max(0, y - r));
  return Uint8Array.from(mask, (_, i) => (sum(i % width, Math.floor(i / width)) === full(i % width, Math.floor(i / width)) ? 1 : 0));
}

function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const sum = windowSums(mask, width, height, r);
  return Uint8Array.from(mask, (_, i) => (sum(i % width, Math.floor(i / width)) > 0 ? 1 : 0));
}
