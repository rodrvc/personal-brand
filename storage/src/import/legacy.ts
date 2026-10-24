import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import type { BlobStore } from "../contracts/index.ts";
import { contentRefusal, nameRefusal } from "./allowlist.ts";
import { OUTPUTS_LABEL, type OutputsRoot } from "./outputs.ts";
import { readRegular, sha256 } from "./shared.ts";

/**
 * Top-level entries (of the brand folder only; a nested match is an ordinary file) that are never imported by design, so they are neither blobs nor left-behind data: the
 * machine-local config (`config.local.yaml` and its variants, which can hold secrets), our own cutover marker, and macOS `.DS_Store`.
 */
export const BY_DESIGN = /^(config\.local\.yaml.*|\.storage-cutover|\.DS_Store)$/;

/**
 * A file nothing else imported, kept as a content-keyed blob. `path` is folder-relative, or `@outputs/<path>` under the second
 * root. Only its hash is held: the bytes are read again from `file` (confined to `base`) when it is uploaded, one file at a time.
 */
export interface LegacyFile {
  path: string;
  sha256: string;
  base: string;
  file: string;
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null; // a dangling link: reported as a link by the caller
  }
};

/**
 * Everything no collector imported becomes a legacy file, but only known content (see `allowlist.ts`): the folder entries
 * left in `notImported`, the paths named by `skipped` entries (the entry stays in `skipped` with its reason; `isKept` tells
 * it apart from data that is really left behind), and every file of the second outputs root that no collector used, through
 * the same allowlist and refusal policy.
 * Nothing refused is ever read into a blob, in two classes (see `Refusal`): proven secrets are listed in `refused`
 * (deliberate, like `BY_DESIGN`, so they never block a cutover); unknown types and merely suspicious names are listed in
 * `unimported`, which is left-behind data and blocks a cutover without `--partial`. Nothing is kept without a blob store. A file that cannot be read safely
 * (a symlink, a path leaving the root) is reported in `skipped` and never read. Returns the files and the lists as they remain.
 */
export function planLegacy(ctx: { root: string; outputs: OutputsRoot | null; used: Set<string>; blobs?: BlobStore; notImported: string[]; skipped: string[] }) {
  const { root, outputs, used, blobs } = ctx;
  const refused = new Set<string>();
  const unimported = new Set<string>();
  // Only the ENOENT/ENOTDIR of a path that vanished mid-walk is tolerated; any other failure is real.
  const vanished = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
  if (!blobs) {
    // Nothing can be kept, so a second root outside the folder is left behind whole and must block a cutover.
    if (outputs && !outputs.inside) ctx.skipped.push(`${OUTPUTS_LABEL} (no blob store)`);
    return { files: [] as LegacyFile[], notImported: ctx.notImported, skipped: ctx.skipped, refused: [] as string[], unimported: [] as string[] };
  }
  const files = new Map<string, LegacyFile>();
  const origin = new Map<string, string>(); // label -> base it was read from
  // Every file under `rel` of `base` (itself, when it is one), `/`-separated and sorted, minus what a collector used or is
  // refused (labelled with `prefix`). A link or other non-file is reported in `sink` whatever its name, so it is never taken for a refusal.
  const walk = (base: string, rel: string, prefix: string, sink: string[]): string[] => {
    let stat;
    try {
      stat = lstatSync(join(base, rel));
    } catch (error) {
      if (vanished(error)) return [];
      throw error;
    }
    if (rel && (used.has(join(base, rel)) || (base === root && BY_DESIGN.test(rel)))) return [];
    // A link to the outputs root is that root, which is read as the second root: not a link to report.
    if (base === root && outputs && !outputs.inside && stat.isSymbolicLink() && realOrNull(join(base, rel)) === outputs.real) return [];
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
      sink.push(`${prefix}${rel} (not a regular file)`);
      return [];
    }
    const dir = stat.isDirectory();
    if (base === root && rel.startsWith("@")) {
      unimported.add(`${rel}${dir ? "/" : ""} (name starts with @: could be mistaken for the outputs root)`);
      return [];
    }
    const why = rel ? nameRefusal(basename(rel), dir) : null;
    if (why) {
      (why.kind === "secret" ? refused : unimported).add(`${prefix}${rel}${dir ? "/" : ""} (${why.why})`);
      return [];
    }
    if (!dir) return [rel];
    try {
      return readdirSync(join(base, rel)).sort().flatMap((name) => walk(base, rel ? `${rel}/${name}` : name, prefix, sink));
    } catch (error) {
      if (vanished(error)) return [];
      // A folder that exists but cannot be listed (EACCES...) is reported, never a crash and never taken for empty.
      const note = `${prefix}${rel} (not a readable directory)`;
      if (!sink.includes(note)) sink.push(note);
      return [];
    }
  };
  const take = (base: string, rel: string, label: string, sink: string[]) => {
    if (files.has(label)) {
      if (origin.get(label) !== base) sink.push(`${label} (same label in two roots: not imported)`);
      return;
    }
    const bytes = readRegular(base, join(base, rel), label, sink);
    const why = bytes && contentRefusal(basename(rel), bytes);
    if (why) (why.kind === "secret" ? refused : unimported).add(`${label} (${why.why})`);
    else if (bytes) {
      files.set(label, { path: label, sha256: sha256(bytes), base, file: join(base, rel) });
      origin.set(label, base);
    }
  };
  const notImported = ctx.notImported.filter((entry) => {
    if (BY_DESIGN.test(entry)) return true;
    walk(root, entry, "", ctx.skipped).forEach((rel) => take(root, rel, rel, ctx.skipped));
    return false;
  });
  // A skipped entry keeps its reason in the report; its files are kept all the same (see `isKept`). What cannot be read
  // inside it is reported too, so a symlink in a skipped folder is never taken for kept data.
  const again: string[] = [];
  for (const entry of ctx.skipped.filter((e) => !e.startsWith(OUTPUTS_LABEL))) walk(root, entryPath(entry), "", again).forEach((f) => take(root, f, f, again));
  const skipped = [...ctx.skipped, ...again.filter((e) => !ctx.skipped.includes(e))];
  // The second root is walked whole: what a collector used is left out, the rest goes through the same policy as the folder.
  if (outputs && !outputs.inside) walk(outputs.real, "", OUTPUTS_LABEL, skipped).forEach((rel) => take(outputs.real, rel, `${OUTPUTS_LABEL}${rel}`, skipped));
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
