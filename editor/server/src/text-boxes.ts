import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TextLine {
  text: string;
  /** Fractions of the image, from its top-left corner. */
  box: { x: number; y: number; w: number; h: number };
}

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "text-boxes.swift");

/** The OCR binary is compiled once per source version into the temp dir; undefined where Vision is unavailable. */
function binary(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const source = readFileSync(SOURCE);
  const path = join(tmpdir(), "editor-text-boxes", createHash("sha256").update(source).digest("hex").slice(0, 16));
  if (existsSync(path)) return path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("swiftc", ["-O", SOURCE, "-o", path], { stdio: "ignore" });
    return path;
  } catch {
    return undefined;
  }
}

/** Every line of text in the image with its measured box, or undefined when local OCR is not available. */
export function readTextLines(bytes: Buffer): TextLine[] | undefined {
  const ocr = binary();
  if (!ocr) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "text-boxes-"));
  try {
    const input = join(dir, "image");
    writeFileSync(input, bytes);
    const { lines } = JSON.parse(execFileSync(ocr, [input], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8")) as {
      lines: Array<{ text: string; x: number; y: number; w: number; h: number }>;
    };
    return lines.map(({ text, x, y, w, h }) => ({ text, box: { x, y, w, h } }));
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
