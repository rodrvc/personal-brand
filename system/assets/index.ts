import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * The asset library: a rebuildable index over `profiles/<slug>/assets/`.
 *
 * Contract documented in `system/config/assets.schema.md` — read that first,
 * it explains *why* the shapes here look the way they do (identity by
 * content hash, sidecar-per-asset for user classification, nothing ever
 * deleted). This file is the implementation of that contract, not a second
 * source of truth for it.
 */

export const ASSET_KINDS = [
  "background",
  "character",
  "photo",
  "logo",
  "decoration",
  "font",
  "unclassified",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_ORIGINS = ["manual", "ai"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

export const ASSET_STATUSES = ["candidate", "approved", "hidden"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const assetEntrySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/, "id must be 16 hex chars (sha256 prefix)"),
  path: z.string().min(1),
  kind: z.enum(ASSET_KINDS),
  mime: z.string().min(1),
  w: z.number().int().positive().optional(),
  h: z.number().int().positive().optional(),
  bytes: z.number().int().nonnegative(),
  origin: z.enum(ASSET_ORIGINS),
  status: z.enum(ASSET_STATUSES),
  tags: z.array(z.string()),
  createdAt: z.string(),
  family: z.string().optional(),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

export const assetIndexSchema = z.object({
  entries: z.array(assetEntrySchema),
});
export type AssetIndexFile = z.infer<typeof assetIndexSchema>;

/** Generated-piece sidecar: `assets/generated/<hash>.json`. */
export const generatedSidecarSchema = z.object({
  prompt: z.string().optional(),
  model: z.string().optional(),
  costCents: z.number().optional(),
  createdAt: z.string().optional(),
  carouselId: z.string().optional(),
  slot: z.string().optional(),
});
export type GeneratedSidecar = z.infer<typeof generatedSidecarSchema>;

/** Font sidecar: `assets/fonts/<name>.meta.json`. */
export const fontSidecarSchema = z.object({
  family: z.string().optional(),
});
export type FontSidecar = z.infer<typeof fontSidecarSchema>;

/** User-classification sidecar: `assets/meta/<id>.json`. See the schema doc's
 * "Where user-set classification lives" section for why this exists
 * separately from `index.json`. */
export const userMetaSchema = z.object({
  kind: z.enum(ASSET_KINDS).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});
export type UserMeta = z.infer<typeof userMetaSchema>;

const ASSETS_DIRNAME = "assets";
const INDEX_FILENAME = "index.json";
const META_DIRNAME = "meta";
const GENERATED_DIRNAME = "generated";
const FONTS_DIRNAME = "fonts";

function assetsDir(profileDir: string): string {
  return join(profileDir, ASSETS_DIRNAME);
}

function metaDir(profileDir: string): string {
  return join(assetsDir(profileDir), META_DIRNAME);
}

/** sha256 of file content, truncated to the 16 hex chars used as asset id. */
export function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Number of leading bytes read from disk to detect mime/dimensions — every
 * format parsed below (PNG/JPEG/WEBP headers) fits comfortably within this,
 * so a multi-MB asset never gets read into memory just to be classified. */
const DETECT_PREFIX_BYTES = 64 * 1024;

/** sha256 of a file's content via a stream, so hashing never loads the
 * whole file into memory regardless of its size. */
function hashFile(absPath: string): string {
  const hash = createHash("sha256");
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let bytesRead: number;
    do {
      bytesRead = readSync(fd, buf, 0, buf.length, null);
      if (bytesRead > 0) hash.update(buf.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Reads only the first `DETECT_PREFIX_BYTES` of a file — enough to detect
 * mime + dimensions without loading the whole asset into memory. */
function readPrefix(absPath: string): Buffer {
  const fd = openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(DETECT_PREFIX_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

// --- minimal image header parsers (no new dependency) ----------------------
//
// Only what's needed to read width/height + mime from the file's own bytes,
// never from the extension — a renamed .jpg is still detected as a JPEG.

function readPngDimensions(buf: Buffer): { w: number; h: number } | undefined {
  // 8-byte signature, then an IHDR chunk: 4-byte length, "IHDR", 4-byte
  // width, 4-byte height, both big-endian.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function readJpegDimensions(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    // Start-of-frame markers (baseline/progressive/etc.) carry the
    // dimensions; other markers are skipped over by their own length.
    const isSOF =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return undefined;
    if (isSOF && offset + 9 <= buf.length) {
      const h = buf.readUInt16BE(offset + 5);
      const w = buf.readUInt16BE(offset + 7);
      return { w, h };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readWebpDimensions(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF") return undefined;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // 24-bit little-endian width-1 / height-1 at offset 24/27.
    const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
    const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
    return { w, h };
  }
  if (chunk === "VP8 " && buf.length >= 30) {
    // Lossy: 14-bit width/height at a fixed offset after the frame tag.
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { w, h };
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    // Lossless: packed into 4 bytes after a 1-byte signature.
    const b0 = buf[21]!;
    const b1 = buf[22]!;
    const b2 = buf[23]!;
    const b3 = buf[24]!;
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    return { w, h };
  }
  return undefined;
}

interface DetectedImage {
  mime: string;
  w?: number;
  h?: number;
}

/** Detects mime + dimensions from content, not extension. Non-image (e.g.
 * font) files get a mime guess from extension and no dimensions. */
export function detectImage(content: Buffer, path: string): DetectedImage {
  const png = readPngDimensions(content);
  if (png) return { mime: "image/png", ...png };
  const jpeg = readJpegDimensions(content);
  if (jpeg) return { mime: "image/jpeg", ...jpeg };
  const webp = readWebpDimensions(content);
  if (webp) return { mime: "image/webp", ...webp };

  const ext = extname(path).toLowerCase();
  const mimeByExt: Record<string, string> = {
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".svg": "image/svg+xml",
  };
  return { mime: mimeByExt[ext] ?? "application/octet-stream" };
}

/** The inverse of `detectImage`'s mime guessing, for when a Buffer with no
 * source filename needs a destination path: an extension derived from the
 * mime the content itself was detected as. */
function extensionForMime(mime: string): string | undefined {
  const extByMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "font/woff2": ".woff2",
    "font/woff": ".woff",
    "font/ttf": ".ttf",
    "font/otf": ".otf",
    "image/svg+xml": ".svg",
  };
  return extByMime[mime];
}

function kindForPath(path: string): AssetKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".woff2" || ext === ".woff" || ext === ".ttf" || ext === ".otf") return "font";
  return "unclassified";
}

function isSidecarOrIndex(relPath: string): boolean {
  const base = relPath.split(sep).pop() ?? relPath;
  return (
    base === INDEX_FILENAME ||
    base.endsWith(".meta.json") ||
    // A sidecar for a generated piece: `<hash>.json` living beside
    // `<hash>.<ext>` in generated/. Any bare .json under generated/ is a
    // sidecar, never an asset in its own right.
    (relPath.split(sep).includes(GENERATED_DIRNAME) && base.endsWith(".json")) ||
    relPath.split(sep)[0] === META_DIRNAME
  );
}

/**
 * Walks `assetsDir`, collecting file paths relative to `base`. Uses
 * `lstatSync` (never follows a symlink implicitly) and skips any symlink
 * whose resolved target falls outside `assetsDir` — a profile's asset
 * folder must never let the index reach outside itself.
 */
function walk(dir: string, base: string, assetsDirAbs: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const rel = relative(base, full);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(full);
      } catch {
        continue; // broken symlink: skip
      }
      const resolvedAssetsDir = resolve(assetsDirAbs);
      if (target !== resolvedAssetsDir && !target.startsWith(resolvedAssetsDir + sep)) {
        continue; // points outside assets/: skip rather than follow
      }
      const targetStat = lstatSync(target);
      if (targetStat.isDirectory()) {
        walk(full, base, assetsDirAbs, out);
      } else if (targetStat.isFile() && !isSidecarOrIndex(rel)) {
        out.push(rel);
      }
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, base, assetsDirAbs, out);
    } else if (stat.isFile()) {
      if (!isSidecarOrIndex(rel)) out.push(rel);
    }
  }
}

function readJsonIfExists<T>(path: string, schema: z.ZodType<T>): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return schema.parse(parsed);
  } catch {
    // A malformed sidecar is treated as absent rather than a hard failure:
    // the file it describes must still show up in the library.
    return undefined;
  }
}

/**
 * Walks `assets/`, hashes every file, merges sidecars and any prior
 * classification, dedups by content hash, and writes `index.json`.
 *
 * Safe to call with no existing index at all (full rebuild) or with an
 * index already on disk (incremental rescan — the result is the same
 * either way, since identity is the hash, not what used to be in the file).
 */
export function scanAssets(profileDir: string): AssetIndexFile {
  const dir = assetsDir(profileDir);
  const relPaths: string[] = [];
  walk(dir, profileDir, dir, relPaths);

  const byHash = new Map<string, AssetEntry>();

  for (const relPath of relPaths) {
    const absPath = join(profileDir, relPath);
    const id = hashFile(absPath);
    if (byHash.has(id)) continue; // dedup: first file wins, same bytes

    const stat = statSync(absPath);
    const detected = detectImage(readPrefix(absPath), relPath);

    let kind = kindForPath(relPath);
    let origin: AssetOrigin = "manual";
    let status: AssetStatus = "approved";
    let tags: string[] = [];
    let createdAt = stat.birthtime.toISOString();
    let family: string | undefined;

    // Generated sidecar: assets/generated/<hash>.json
    const isGenerated = relPath.split(sep).includes(GENERATED_DIRNAME);
    if (isGenerated) {
      origin = "ai";
      status = "candidate";
      const sidecarPath = join(dir, GENERATED_DIRNAME, `${id}.json`);
      const sidecar = readJsonIfExists(sidecarPath, generatedSidecarSchema);
      if (sidecar?.createdAt) createdAt = sidecar.createdAt;
    }

    // Font sidecar: assets/fonts/<name>.meta.json
    if (kind === "font") {
      const sidecarPath = absPath.replace(extname(absPath), "") + ".meta.json";
      const sidecar = readJsonIfExists(sidecarPath, fontSidecarSchema);
      family = sidecar?.family ?? inferFamilyFromFilename(relPath);
    }

    // User classification sidecar: assets/meta/<id>.json — always wins,
    // since it's the only place a deliberate user choice is recorded.
    const userMetaPath = join(metaDir(profileDir), `${id}.json`);
    const userMeta = readJsonIfExists(userMetaPath, userMetaSchema);
    if (userMeta?.kind) kind = userMeta.kind;
    if (userMeta?.tags) tags = userMeta.tags;
    if (userMeta?.status) status = userMeta.status;

    const entry: AssetEntry = {
      id,
      path: relPath.split(sep).join("/"),
      kind,
      mime: detected.mime,
      ...(detected.w ? { w: detected.w } : {}),
      ...(detected.h ? { h: detected.h } : {}),
      bytes: stat.size,
      origin,
      status,
      tags,
      createdAt,
      ...(family ? { family } : {}),
    };
    byHash.set(id, assetEntrySchema.parse(entry));
  }

  const index: AssetIndexFile = { entries: [...byHash.values()] };
  writeIndex(profileDir, index);
  return index;
}

function inferFamilyFromFilename(relPath: string): string | undefined {
  const base = relPath.split(sep).pop() ?? relPath;
  const stem = base.replace(extname(base), "");
  // "Inter-Regular" / "inter_bold" / "Inter" -> "Inter"
  const cleaned = stem.split(/[-_]/)[0];
  return cleaned || undefined;
}

function indexPath(profileDir: string): string {
  return join(assetsDir(profileDir), INDEX_FILENAME);
}

function writeIndex(profileDir: string, index: AssetIndexFile): void {
  mkdirSync(assetsDir(profileDir), { recursive: true });
  writeFileSync(indexPath(profileDir), JSON.stringify(index, null, 2) + "\n", "utf-8");
}

/**
 * True when the set of files currently on disk under `assets/` matches
 * exactly the set of paths the index claims to cover. A mismatch — a file
 * copied in by hand, or one removed outside the API — means the cached
 * index is stale and must not be trusted as-is.
 */
function indexMatchesDisk(profileDir: string, index: AssetIndexFile): boolean {
  const dir = assetsDir(profileDir);
  const relPaths: string[] = [];
  walk(dir, profileDir, dir, relPaths);
  const onDisk = new Set(relPaths.map((p) => p.split(sep).join("/")));
  const inIndex = new Set(index.entries.map((e) => e.path));
  if (onDisk.size !== inIndex.size) return false;
  for (const path of onDisk) {
    if (!inIndex.has(path)) return false;
  }
  return true;
}

/** Loads `index.json` if present, valid, and in sync with the files on
 * disk; rebuilds from disk otherwise — so a missing/corrupt/stale index is
 * never a hard failure and never silently drops a hand-copied file, per
 * the schema's "rebuildable cache" contract. */
export function loadIndex(profileDir: string): AssetIndexFile {
  const existing = readJsonIfExists(indexPath(profileDir), assetIndexSchema);
  if (existing && indexMatchesDisk(profileDir, existing)) return existing;
  return scanAssets(profileDir);
}

export interface RegisterOptions {
  kind?: AssetKind;
  origin?: AssetOrigin;
  tags?: string[];
  status?: AssetStatus;
  /** Relative destination under assets/ when registering a Buffer (ignored
   * for a source file path, which keeps its own location). */
  destRelPath?: string;
}

/**
 * Adds a file (by path or in-memory buffer) to the library. If its content
 * hash already exists, returns the existing entry untouched — no duplicate
 * write, no duplicate index entry.
 */
export function registerFile(
  profileDir: string,
  srcPathOrBuffer: string | Buffer,
  options: RegisterOptions = {},
): AssetEntry {
  const content =
    typeof srcPathOrBuffer === "string" ? readFileSync(srcPathOrBuffer) : srcPathOrBuffer;
  const id = hashContent(content);

  const index = loadIndex(profileDir);
  const existing = index.entries.find((e) => e.id === id);
  if (existing) return existing;

  let destRel = options.destRelPath;
  if (!destRel) {
    if (typeof srcPathOrBuffer === "string") {
      destRel = join(ASSETS_DIRNAME, relative(profileDir, srcPathOrBuffer).split(sep).pop()!);
    } else {
      // No destination path and no source filename to borrow an extension
      // from: derive one from the content's detected mime, so the file
      // never lands on disk with no extension at all (the hash alone).
      const detected = detectImage(content, "");
      const ext = extensionForMime(detected.mime);
      if (!ext) {
        throw new Error(
          `registerFile: could not detect a known image/font mime for this buffer ` +
            `(got "${detected.mime}") — pass "destRelPath" explicitly so the file gets a proper extension.`,
        );
      }
      destRel = join(ASSETS_DIRNAME, `${id}${ext}`);
    }
  }
  const destAbs = join(profileDir, destRel);
  mkdirSync(join(destAbs, ".."), { recursive: true });
  writeFileSync(destAbs, content);

  const stat = statSync(destAbs);
  const detected = detectImage(content, destRel);
  const entry = assetEntrySchema.parse({
    id,
    path: destRel.split(sep).join("/"),
    kind: options.kind ?? kindForPath(destRel),
    mime: detected.mime,
    ...(detected.w ? { w: detected.w } : {}),
    ...(detected.h ? { h: detected.h } : {}),
    bytes: stat.size,
    origin: options.origin ?? "manual",
    status: options.status ?? (options.origin === "ai" ? "candidate" : "approved"),
    tags: options.tags ?? [],
    createdAt: new Date().toISOString(),
  });

  index.entries.push(entry);
  writeIndex(profileDir, index);
  return entry;
}

/**
 * Updates a piece's classification (`kind`/`tags`/`status`). Writes the
 * change to `assets/meta/<id>.json` so it survives a full index rebuild
 * (see the schema doc), then updates `index.json` in place.
 */
export function updateEntry(
  profileDir: string,
  id: string,
  changes: Partial<Pick<AssetEntry, "kind" | "tags" | "status">>,
): AssetEntry {
  const index = loadIndex(profileDir);
  const entry = index.entries.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`updateEntry: no asset with id "${id}" in ${profileDir}`);
  }

  const metaPath = join(metaDir(profileDir), `${id}.json`);
  const priorMeta = readJsonIfExists(metaPath, userMetaSchema) ?? {};
  const nextMeta: UserMeta = {
    kind: changes.kind ?? priorMeta.kind ?? entry.kind,
    tags: changes.tags ?? priorMeta.tags ?? entry.tags,
    status: changes.status ?? priorMeta.status ?? entry.status,
  };
  mkdirSync(metaDir(profileDir), { recursive: true });
  writeFileSync(metaPath, JSON.stringify(nextMeta, null, 2) + "\n", "utf-8");

  Object.assign(entry, changes);
  writeIndex(profileDir, index);
  return entry;
}
