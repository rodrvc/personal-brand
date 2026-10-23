import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";

import { NotFoundError, type BlobStore, type RevisionEntity, type WriteMeta } from "../contracts/index.ts";
import type { MemoryRepositories } from "../memory/index.ts";

/** The Postgres and memory repository sets are structurally identical, so the importer is typed once against the memory one. */
export type ImportRepos = MemoryRepositories;

/** One importable thing of a brand folder, with how to read it back from storage and how to write it. */
export interface Item {
  key: string;
  entityType: RevisionEntity;
  /** sha256 of the source bytes (of every source file the item is made of). */
  hash: string;
  /** What the stored row must read back as. */
  payload: unknown;
  read(brandId: string): Promise<{ id: string; version: number; value: unknown } | null>;
  write(brandId: string, expectedVersion: number | null, meta: WriteMeta): Promise<unknown>;
  /** Blob-level check for items that own bytes in the bucket: true when every blob is stored and hashes to what the row says. */
  verifyBlobs?(brandId: string): Promise<boolean>;
}

/** What a collector needs: the brand folder (`root` is its real path), storage, and where to report what it passes over. */
export interface CollectContext {
  dir: string;
  root: string;
  repos: ImportRepos;
  /** Where blobs go; without it the items that need blobs are passed over and reported. */
  blobs?: BlobStore;
  skipped: string[];
  /** Informational lines that are not left-behind data. */
  notices: string[];
  /** Top-level folder entries some collector took responsibility for; the rest are reported as not imported. */
  handled: Set<string>;
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const found = async <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));

/**
 * Reads a regular file whose real path (symlinks in any parent directory resolved) lies inside `root`, or returns
 * null. Anything else is reported in `skipped` and never read: a symlink, a non-file, or a path that escapes the
 * brand folder. A missing file is reported only when `expected`.
 */
export function readRegular(root: string, file: string, rel: string, skipped: string[], expected = false): Buffer | null {
  try {
    if (!lstatSync(file).isFile()) skipped.push(`${rel} (not a regular file)`);
    else if (!realpathSync(file).startsWith(root + sep)) skipped.push(`${rel} (outside the folder)`);
    else return readFileSync(file);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    if (expected) skipped.push(`${rel} (missing)`);
  }
  return null;
}

/** Lowercase `[a-z0-9-]` slug of free text (accents folded), or "" when nothing usable is left. */
export const slugify = (text: string, max = 60): string =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Splits a leading `---` YAML block (still unparsed, `null` when there is none) from the markdown body. */
export function splitFrontmatter(raw: string): { yaml: string | null; body: string } {
  const m = FRONTMATTER.exec(raw);
  return m ? { yaml: m[1], body: m[2] } : { yaml: null, body: raw };
}
