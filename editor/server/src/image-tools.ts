import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
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
