#!/usr/bin/env node
/**
 * One-time (but safely re-runnable) migration of a single local profile —
 * its own directory plus its resolved `outputs.base_dir`, which may sit
 * entirely outside the repo — into the S3-compatible bucket configured by
 * `S3_*` env vars (issue #99).
 *
 * Never deletes anything, locally or remotely. Uploads a file that doesn't
 * exist remotely yet, skips one whose content already matches what's in the
 * bucket (compared by a `sha256` object-metadata tag this script itself
 * sets on every upload, not by ETag — ETag is a plain MD5 only for a
 * single-part upload and this script doesn't assume that), and reports —
 * without touching — any remote object whose content differs from the
 * local file of the same name, since overwriting silently could discard
 * work already done against the bucket.
 *
 * Usage:
 *   tsx editor/server/scripts/migrate-profile-to-bucket.ts --profile <slug> [--dry-run]
 *   pnpm --filter @personal-brand/editor-server migrate:profile -- --profile <slug>
 *
 * Requires `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (and
 * usually `S3_ENDPOINT` for a self-hosted bucket) in the environment —
 * exactly like running the editor itself in `s3` mode — but resolves the
 * *local* profile to migrate the ordinary `fs`-mode way, via
 * `BRAND_PROFILES_DIR`/a profile's own `config.yaml`. Run this with
 * `BRAND_OUTPUTS_ROOT` unset: that variable is the editor's own s3-mode
 * mirror redirect, and if it's set here the script would migrate the
 * mirror instead of the real local output tree.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { createObjectStore, loadStorageConfig, type S3StorageConfig } from "../src/storage/config.js";
import { ObjectNotFoundError, PreconditionFailedError, type ObjectStore } from "../src/storage/object-store.js";
import { objectKeyFor } from "../src/storage/mirror.js";
import { resolveOutputBaseDir, resolveProfileDir } from "../../../system/ig-carousel/profile.js";

interface Args {
  profile: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  let profile: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") profile = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!profile) {
    throw new Error("Usage: migrate-profile-to-bucket --profile <slug> [--dry-run]");
  }
  return { profile, dryRun };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function listFiles(root: string): string[] {
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

export interface MigrationCounts {
  uploaded: number;
  skipped: number;
  conflicts: number;
  bytes: number;
}

/** Resolves the s3 target from `env`, ignoring `STORAGE_BACKEND` — this script always talks to a bucket regardless of which backend the editor itself is currently configured for. */
export function resolveMigrationTarget(env: NodeJS.ProcessEnv): S3StorageConfig {
  const config = loadStorageConfig({ ...env, STORAGE_BACKEND: "s3" });
  if (config.backend !== "s3" || !config.s3) {
    throw new Error("Could not resolve an s3 target — check S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY.");
  }
  return config.s3;
}

/**
 * Migrates one profile. Exported (rather than only run from `main`) so
 * tests can call it directly against a `FakeObjectStore` and a temp
 * directory, without spawning a process.
 */
export async function migrateProfile(
  store: ObjectStore,
  s3Config: S3StorageConfig,
  slug: string,
  profileDir: string,
  outputsDir: string,
  options: { dryRun: boolean; log?: (line: string) => void } = { dryRun: false },
): Promise<MigrationCounts> {
  const log = options.log ?? ((line: string) => console.log(line));
  const counts: MigrationCounts = { uploaded: 0, skipped: 0, conflicts: 0, bytes: 0 };

  const areas: Array<["profile" | "outputs", string]> = [
    ["profile", profileDir],
    ["outputs", outputsDir],
  ];

  for (const [area, root] of areas) {
    for (const absPath of listFiles(root)) {
      const relPath = relative(root, absPath);
      const key = objectKeyFor(s3Config, slug, area, relPath);
      const content = readFileSync(absPath);
      const hash = sha256(content);

      let existingHash: string | undefined;
      let exists = false;
      try {
        const head = await store.head(key);
        exists = true;
        existingHash = head.metadata.sha256;
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error;
      }

      if (!exists) {
        counts.uploaded++;
        counts.bytes += content.byteLength;
        log(`upload   ${key}`);
        if (!options.dryRun) {
          try {
            await store.put(key, content, { ifNoneMatch: "*", metadata: { sha256: hash } });
          } catch (error) {
            if (error instanceof PreconditionFailedError) {
              // Someone else created it between our head and our put — treat
              // it the same as any other pre-existing-and-different object:
              // a conflict this run does not resolve, never an overwrite.
              counts.uploaded--;
              counts.bytes -= content.byteLength;
              counts.conflicts++;
              log(`conflict ${key} (created concurrently)`);
            } else {
              throw error;
            }
          }
        }
      } else if (existingHash === hash) {
        counts.skipped++;
        log(`skip     ${key} (unchanged)`);
      } else {
        counts.conflicts++;
        log(`conflict ${key} (remote content differs, not overwritten)`);
      }
    }
  }

  return counts;
}

async function main(): Promise<void> {
  const { profile: slug, dryRun } = parseArgs(process.argv.slice(2));

  const s3Config = resolveMigrationTarget(process.env);
  const store = createObjectStore({ backend: "s3", s3: s3Config, cacheDir: "" });

  const profileDir = resolveProfileDir(slug);
  const outputsDir = resolveOutputBaseDir(profileDir);

  if (!existsSync(profileDir)) {
    throw new Error(`No local profile directory found at "${profileDir}" — check BRAND_PROFILES_DIR and the slug.`);
  }

  console.log(`Migrating profile "${slug}"`);
  console.log(`  from profile dir: ${profileDir}`);
  console.log(`  from outputs dir: ${outputsDir}`);
  console.log(`  to bucket:        ${s3Config.bucket} (prefix "${s3Config.prefix}")${dryRun ? " [dry run]" : ""}`);
  console.log("");

  const counts = await migrateProfile(store, s3Config, slug, profileDir, outputsDir, { dryRun });

  console.log("");
  console.log(
    `Done: ${counts.uploaded} uploaded, ${counts.skipped} skipped, ${counts.conflicts} conflict(s), ${counts.bytes} byte(s) uploaded.`,
  );
  if (counts.conflicts > 0) {
    console.log("Conflicts were left untouched in the bucket — resolve them by hand, then re-run.");
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
