import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
