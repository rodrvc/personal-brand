import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { BlobStore } from "../contracts/index.ts";
import { contentRefusal, nameRefusal } from "./allowlist.ts";
import { readRegular, sha256 } from "./shared.ts";

/**
 * Top-level entries (of the brand folder only; a nested match is an ordinary file) that are never imported by design, so they are neither blobs nor left-behind data: the
 * machine-local config (`config.local.yaml` and its variants, which can hold secrets), our own cutover marker, and macOS `.DS_Store`.
 */
export const BY_DESIGN = /^(config\.local\.yaml.*|\.storage-cutover|\.DS_Store)$/;

/** A file nothing else imported, kept as a content-keyed blob. `path` is folder-relative. */
export interface LegacyFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * Everything no collector imported becomes a legacy file, but only known content (see `allowlist.ts`): the folder entries
 * left in `notImported`, the paths named by `skipped` entries (the entry stays in `skipped` with its reason; `isKept` tells
 * it apart from data that is really left behind).
 * Nothing refused is ever read into a blob, in two classes (see `Refusal`): proven secrets are listed in `refused`
 * (deliberate, like `BY_DESIGN`, so they never block a cutover); unknown types and merely suspicious names are listed in
 * `unimported`, which is left-behind data and blocks a cutover without `--partial`. Nothing is kept without a blob store. A file that cannot be read safely
 * (a symlink, a path leaving the root) is reported in `skipped` and never read. Returns the files and the lists as they remain.
 */
export function planLegacy(ctx: { root: string; blobs?: BlobStore; notImported: string[]; skipped: string[] }) {
  const { root, blobs } = ctx;
  const refused = new Set<string>();
  const unimported = new Set<string>();
  // Only the ENOENT/ENOTDIR of a path that vanished mid-walk is tolerated; any other failure is real.
  const vanished = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  if (!blobs) return { files: [] as LegacyFile[], notImported: ctx.notImported, skipped: ctx.skipped, refused: [] as string[], unimported: [] as string[] };
  const files = new Map<string, LegacyFile>();
  // Every file under `rel` (itself, when it is one), `/`-separated and sorted, minus what is refused. A link or other
  // non-file is reported in `sink` whatever its name, so it is never taken for a refusal.
  const walk = (rel: string, sink: string[]): string[] => {
    let stat;
    try {
      stat = lstatSync(join(root, rel));
    } catch (error) {
      if (vanished(error)) return [];
      throw error;
    }
    if (rel && BY_DESIGN.test(rel)) return [];
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
      sink.push(`${rel} (not a regular file)`);
      return [];
    }
    const dir = stat.isDirectory();
    const why = rel ? nameRefusal(basename(rel), dir) : null;
    if (why) {
      (why.kind === "secret" ? refused : unimported).add(`${rel}${dir ? "/" : ""} (${why.why})`);
      return [];
    }
    if (!dir) return [rel];
    try {
      return readdirSync(join(root, rel)).sort().flatMap((name) => walk(rel ? `${rel}/${name}` : name, sink));
    } catch (error) {
      if (vanished(error)) return [];
      throw error;
    }
  };
  const take = (rel: string, sink: string[]) => {
    if (files.has(rel)) return;
    const bytes = readRegular(root, join(root, rel), rel, sink);
    const why = bytes && contentRefusal(basename(rel), bytes);
    if (why) (why.kind === "secret" ? refused : unimported).add(`${rel} (${why.why})`);
    else if (bytes) files.set(rel, { path: rel, bytes, sha256: sha256(bytes) });
  };
  const notImported = ctx.notImported.filter((entry) => {
    if (BY_DESIGN.test(entry)) return true;
    walk(entry, ctx.skipped).forEach((rel) => take(rel, ctx.skipped));
    return false;
  });
  // A skipped entry keeps its reason in the report; its files are kept all the same (see `isKept`). What cannot be read
  // inside it is reported too, so a symlink in a skipped folder is never taken for kept data.
  const again: string[] = [];
  for (const entry of ctx.skipped.slice()) walk(entryPath(entry), again).forEach((f) => take(f, again));
  const skipped = [...ctx.skipped, ...again.filter((e) => !ctx.skipped.includes(e))];
  return { files: [...files.values()], notImported, skipped, refused: [...refused].sort(), unimported: [...unimported].sort() };
}

/** The path of a `<path> (<reason>)` report entry: the reason is the last balanced parenthesis, so `foto (1).png (reason)` keeps its name. */
export function entryPath(entry: string): string {
  if (!entry.endsWith(")")) return entry;
  let depth = 0;
  for (let i = entry.length - 1; i >= 0; i--) {
    if (entry[i] === ")") depth++;
    else if (entry[i] === "(" && --depth === 0) return i > 0 && entry[i - 1] === " " ? entry.slice(0, i - 1) : entry;
  }
  return entry;
}

/** Whether `path` (a skipped entry's path) is kept in the legacy manifest, itself or as a folder whose files are. */
export const isKept = (manifest: Record<string, string>, path: string): boolean => path in manifest || Object.keys(manifest).some((p) => p.startsWith(`${path}/`));
