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

/** The language part of a BCP 47 tag, lower-cased: "es-XX" and "es_419" both give "es". */
function languagePart(tag: string): string {
  return tag.split(/[-_]/)[0]!.toLowerCase();
}

/**
 * Maps requested tags (normally the brand's locale) onto the recognition languages the OCR supports, by language part
 * (a bare or regional tag such as "es-XX" gives a supported "es-ES"), brand languages first and English after them as
 * a fallback, since posters mix it in. Nothing matched gives [] and the OCR relies on language detection alone.
 */
export function matchRecognitionLanguages(requested: string[], supported: string[]): string[] {
  const pick = (tag: string): string | undefined => {
    const exact = supported.find((s) => s.toLowerCase() === tag.toLowerCase().replace("_", "-"));
    return exact ?? supported.find((s) => languagePart(s) === languagePart(tag));
  };
  const matched = [...requested.filter(Boolean), "en"].map(pick).filter((s): s is string => s !== undefined);
  return [...new Set(matched)];
}

let supportedLanguages: string[] | undefined;

function supported(ocr: string): string[] {
  if (supportedLanguages) return supportedLanguages;
  try {
    supportedLanguages = JSON.parse(execFileSync(ocr, ["--supported"], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8")) as string[];
  } catch {
    supportedLanguages = [];
  }
  return supportedLanguages;
}

/**
 * Every line of text in the image with its measured box, or undefined when local OCR is not available.
 * `languages` are BCP 47 tags, normally the brand's locale; see matchRecognitionLanguages. With none matched the OCR
 * detects the language itself.
 */
export function readTextLines(bytes: Buffer, languages: string[] = []): TextLine[] | undefined {
  const ocr = binary();
  if (!ocr) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "text-boxes-"));
  try {
    const input = join(dir, "image");
    writeFileSync(input, bytes);
    const recognition = matchRecognitionLanguages(languages, supported(ocr)).join(",");
    const { lines } = JSON.parse(execFileSync(ocr, recognition ? [input, recognition] : [input], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8")) as {
      lines: Array<{ text: string; x: number; y: number; w: number; h: number }>;
    };
    return lines.map(({ text, x, y, w, h }) => ({ text, box: { x, y, w, h } }));
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
