#!/usr/bin/env node
/**
 * Lets a terminal workflow (a skill, a recipe, a plain shell script) share
 * the same bucket-backed profile data as the editor (issue #115), without
 * running the editor's Express process. It calls the same mirror engine
 * (`syncDown`/`syncUp`/`fetchObjectOnDemand` in `storage/mirror.ts`) the
 * editor's `storageSyncMiddleware` uses, so conditional writes, no-clobber of
 * newer bucket data, and the lazy-media rule all come for free.
 *
 * Usage:
 *   tsx editor/server/scripts/profile-sync.ts pull   --profile <slug>
 *   tsx editor/server/scripts/profile-sync.ts push   --profile <slug>
 *   tsx editor/server/scripts/profile-sync.ts status --profile <slug> [--remote]
 *   tsx editor/server/scripts/profile-sync.ts fetch  --profile <slug> --path <relPath> [--area profile|outputs]
 *   tsx editor/server/scripts/profile-sync.ts env
 *   pnpm --filter @personal-brand/editor-server run sync:profile -- pull --profile <slug>
 *
 * `pull` (`syncDown`) materializes eager objects and deliberately leaves lazy
 * media (a profile's own `outputs/`/`reels/` tree, a resolved export's
 * rendered PNGs/MP4s) alone, same rule and reason as the editor: a profile
 * can carry hundreds of MB of rendered history nothing needs on every pull.
 * A skill that needs one specific lazy file uses `fetch` instead of a bulk
 * `--all` flag, so "lazy stays lazy by default" has no second way to defeat it.
 *
 * `push` (`syncUp`) uploads every changed mirror file with a conditional
 * write. A file the bucket already moved past is left alone and counted as a
 * conflict; `push` then exits non-zero and tells the caller to `pull` first.
 *
 * `status` is a cheap, local-only report by default: unsynced local edits
 * (hash no longer matches the manifest) and untracked local files (never in
 * the manifest). `--remote` adds one `head` per manifest entry to also
 * report objects the bucket moved past locally — opt-in, one request per
 * tracked file.
 *
 * `env` prints the mirror roots (`resolveMirrorRoots`, profile-independent)
 * as `export BRAND_PROFILES_DIR=...` / `export BRAND_OUTPUTS_ROOT=...` — the
 * same variables `initStorageRuntime` sets for the editor process, so
 * `eval "$(tsx .../profile-sync.ts env)"` points existing engine scripts
 * (`system/ig-carousel/profile.ts`) at the same mirror unmodified.
 *
 * When `STORAGE_BACKEND` is not `s3`, every subcommand is a no-op that exits
 * 0 and says so, so a skill can call this unconditionally on any clone.
 *
 * Cache dir: `PROFILE_CACHE_DIR` if set, else `loadStorageConfig`'s own
 * default (a fixed OS-temp path, the same one the editor server falls back
 * to). Sharing that default with a live server is NOT recommended:
 * `syncDown`/`syncUp` only dedupe concurrent callers in-process, and the
 * manifest file is a plain synchronous read-then-write with no cross-process
 * lock, so two processes patching it around the same time can race and lose
 * an entry (the object store's own conditional writes still protect the
 * actual profile/output files). Use a `PROFILE_CACHE_DIR` distinct from the
 * server's when running this alongside a live editor.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { createObjectStore, loadStorageConfig, type S3StorageConfig, type StorageConfig } from "../src/storage/config.js";
import { ObjectNotFoundError, type ObjectStore } from "../src/storage/object-store.js";
import { fetchObjectOnDemand, objectKeyFor, resolveMirrorRoots, syncDown, syncUp, type Manifest } from "../src/storage/mirror.js";

export interface CliResult {
  lines: string[];
  exitCode: number;
}

export interface PullCommand {
  kind: "pull";
  profile: string;
}
export interface PushCommand {
  kind: "push";
  profile: string;
}
export interface StatusCommand {
  kind: "status";
  profile: string;
  remote: boolean;
}
export interface FetchCommand {
  kind: "fetch";
  profile: string;
  area: "profile" | "outputs";
  path: string;
}
export interface EnvCommand {
  kind: "env";
}
export type Command = PullCommand | PushCommand | StatusCommand | FetchCommand | EnvCommand;

const USAGE = "Usage: profile-sync <pull|push|status|fetch|env> --profile <slug> [--remote] [--path <relPath>] [--area profile|outputs]";

export function parseArgs(argv: string[]): Command {
  const [kind, ...rest] = argv;
  if (kind === "env") return { kind: "env" };

  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--remote") {
      flags.set("remote", true);
      continue;
    }
    if (token.startsWith("--")) {
      flags.set(token.slice(2), rest[++i]);
    }
  }

  const profile = flags.get("profile");
  if (typeof profile !== "string" || !profile) {
    throw new Error(USAGE);
  }

  if (kind === "pull") return { kind: "pull", profile };
  if (kind === "push") return { kind: "push", profile };
  if (kind === "status") return { kind: "status", profile, remote: flags.get("remote") === true };
  if (kind === "fetch") {
    const path = flags.get("path");
    if (typeof path !== "string" || !path) {
      throw new Error("Usage: profile-sync fetch --profile <slug> --path <relPath> [--area profile|outputs]");
    }
    const area = flags.get("area");
    if (area !== undefined && area !== "profile" && area !== "outputs") {
      throw new Error('--area must be "profile" or "outputs"');
    }
    return { kind: "fetch", profile, area: (area as "profile" | "outputs" | undefined) ?? "profile", path };
  }

  throw new Error(kind ? `Unknown command "${kind}". ${USAGE}` : USAGE);
}

function fsNoop(action: string): CliResult {
  return {
    lines: [`storage backend is "fs" — ${action} is a no-op; bucket sync only applies when STORAGE_BACKEND=s3.`],
    exitCode: 0,
  };
}

export async function runPull(store: ObjectStore, s3Config: S3StorageConfig, cacheDir: string, profile: string): Promise<CliResult> {
  const result = await syncDown(store, s3Config, cacheDir, profile);
  const lines = [
    `pull "${profile}": ${result.downloaded} downloaded, ${result.skippedLazy} lazy (left for "fetch"), ${result.conflicts} unsynced local edit(s) kept.`,
  ];
  return { lines, exitCode: 0 };
}

export async function runPush(store: ObjectStore, s3Config: S3StorageConfig, cacheDir: string, profile: string): Promise<CliResult> {
  const result = await syncUp(store, s3Config, cacheDir, profile);
  const lines = [`push "${profile}": ${result.uploaded} uploaded, ${result.conflicts} conflict(s).`];
  if (result.conflicts > 0) {
    lines.push(`${result.conflicts} local file(s) were not uploaded — the bucket changed since the last sync. Run "pull" first, then "push" again.`);
    return { lines, exitCode: 1 };
  }
  return { lines, exitCode: 0 };
}

export async function runFetch(
  store: ObjectStore,
  s3Config: S3StorageConfig,
  cacheDir: string,
  profile: string,
  area: "profile" | "outputs",
  relPath: string,
): Promise<CliResult> {
  const localPath = await fetchObjectOnDemand(store, s3Config, cacheDir, profile, area, relPath);
  return { lines: [`fetched "${relPath}" (${area}) -> ${localPath}`], exitCode: 0 };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Small local duplicate of `mirror.ts`'s own (unexported) file walker — the same shape `migrate-profile-to-bucket.ts` already keeps its own copy of, rather than exporting an internal helper only for this. */
function listLocalFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) results.push(abs);
    }
  };
  walk(root);
  return results;
}

function loadManifestSnapshot(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

export interface StatusReport {
  /** "<area>:<relPath>" for a local file whose content no longer matches the manifest's last-synced hash. */
  unsynced: string[];
  /** "<area>:<relPath>" for a local file that has never been recorded in the manifest (never pushed, or pulled outside this mirror). */
  untracked: string[];
  /** Object keys whose bucket etag no longer matches the manifest's last-seen etag — only populated when `checkRemote` is true. */
  remoteNewer: string[];
}

export async function computeStatus(
  store: ObjectStore,
  s3Config: S3StorageConfig,
  cacheDir: string,
  profile: string,
  checkRemote: boolean,
): Promise<StatusReport> {
  const roots = resolveMirrorRoots(s3Config, cacheDir, profile);
  const manifest = loadManifestSnapshot(roots.manifestPath);

  const unsynced: string[] = [];
  const untracked: string[] = [];

  const areas: Array<["profile" | "outputs", string]> = [
    ["profile", roots.profileDir],
    ["outputs", roots.outputsDir],
  ];
  for (const [area, root] of areas) {
    for (const absPath of listLocalFiles(root)) {
      const relPath = relative(root, absPath);
      const key = objectKeyFor(s3Config, profile, area, relPath);
      const entry = manifest[key];
      const label = `${area}:${relPath}`;
      if (!entry) {
        untracked.push(label);
        continue;
      }
      if (sha256(readFileSync(absPath)) !== entry.hash) {
        unsynced.push(label);
      }
    }
  }

  const remoteNewer: string[] = [];
  if (checkRemote) {
    for (const [key, entry] of Object.entries(manifest)) {
      try {
        const head = await store.head(key);
        if (head.etag !== entry.etag) remoteNewer.push(key);
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error;
      }
    }
  }

  return { unsynced, untracked, remoteNewer };
}

export async function runStatus(
  store: ObjectStore,
  s3Config: S3StorageConfig,
  cacheDir: string,
  profile: string,
  checkRemote: boolean,
): Promise<CliResult> {
  const report = await computeStatus(store, s3Config, cacheDir, profile, checkRemote);
  const lines = [`status "${profile}": ${report.unsynced.length} unsynced edit(s), ${report.untracked.length} untracked file(s)${checkRemote ? `, ${report.remoteNewer.length} remote-newer` : ""}.`];
  for (const item of report.unsynced) lines.push(`  unsynced   ${item}`);
  for (const item of report.untracked) lines.push(`  untracked  ${item}`);
  for (const item of report.remoteNewer) lines.push(`  remote>local ${item}`);
  return { lines, exitCode: 0 };
}

export function runEnv(config: StorageConfig): CliResult {
  if (config.backend !== "s3" || !config.s3) {
    // A leading "#" keeps `eval "$(profile-sync env)"` a no-op shell comment
    // instead of a "command not found" on the fs backend — a skill can call
    // this unconditionally without branching on STORAGE_BACKEND itself.
    return {
      lines: ['# storage backend is "fs" — no mirror env vars to export; BRAND_PROFILES_DIR/BRAND_OUTPUTS_ROOT keep their existing defaults.'],
      exitCode: 0,
    };
  }
  // Any slug works here: `profileMirrorRoot`/`outputsMirrorRoot` are the
  // roots shared by every profile, computed the exact same way
  // `initStorageRuntime` does for the editor process.
  const roots = resolveMirrorRoots(config.s3, config.cacheDir, "_");
  return {
    lines: [`export BRAND_PROFILES_DIR=${roots.profileMirrorRoot}`, `export BRAND_OUTPUTS_ROOT=${roots.outputsMirrorRoot}`],
    exitCode: 0,
  };
}

/** Full dispatch used by both `main()` and the fs-backend/`env` tests — s3-backend command tests call `runPull`/`runPush`/`runStatus`/`runFetch` directly against a `FakeObjectStore` instead, the same way `migrate-profile-to-bucket.test.ts` exercises `migrateProfile` without going through this function. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const command = parseArgs(argv);
  const config = loadStorageConfig(env);

  if (command.kind === "env") return runEnv(config);
  if (config.backend !== "s3" || !config.s3) return fsNoop(command.kind);

  const store = createObjectStore(config);
  const { s3, cacheDir } = config;
  switch (command.kind) {
    case "pull":
      return runPull(store, s3, cacheDir, command.profile);
    case "push":
      return runPush(store, s3, cacheDir, command.profile);
    case "status":
      return runStatus(store, s3, cacheDir, command.profile, command.remote);
    case "fetch":
      return runFetch(store, s3, cacheDir, command.profile, command.area, command.path);
  }
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), process.env);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
