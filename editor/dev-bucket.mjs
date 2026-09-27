#!/usr/bin/env node
// Runs the editor (API + web) in bucket mode (issue #115): fails fast with a
// clear message when the required S3_* configuration is missing, instead of
// letting editor/server's own loadStorageConfig throw deep inside its first
// request. Once validated, reuses editor/dev.mjs's process wiring unchanged
// — same two child processes, same tagged output, same shutdown handling.
//
// Port overrides reuse the names editor/server and editor/web already read
// (EDITOR_PORT for the API, EDITOR_WEB_PORT for Vite's dev server — see
// editor/web/vite.config.ts), so this can run beside a default fs-mode
// instance without a port clash. Neither variable changes `pnpm dev:editor`.
//
// Usage: pnpm run editor:bucket
//   STORAGE_BACKEND=s3 S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
//   [S3_ENDPOINT=...] [EDITOR_PORT=4330] [EDITOR_WEB_PORT=5191] pnpm run editor:bucket

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startEditor } from "./dev.mjs";

const REQUIRED_VARS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

/**
 * Loads `envPath` into `process.env` if it exists, shell env wins (same
 * semantics as `editor/server/src/env.ts`'s `loadRepoRootEnv`, used by the
 * Express process and the `profile-sync` CLI). This file is `.mjs`, not
 * `.ts`, so it can't import that module directly without `tsx`;
 * `process.loadEnvFile` (stable since Node 20.6) already does not override a
 * variable already set in the environment, so it needs no extra parsing.
 * Exported so a test can point it at a temp file instead of the real
 * repo-root `.env`.
 */
export function loadEnvFileIfPresent(envPath) {
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/**
 * Loads the repo-root `.env` before validation. Without this, bucket config
 * that lives only in `.env` (not the shell) was invisible here and this
 * launcher's fail-fast check rejected startup even though the Express
 * process would have read it fine.
 */
function loadRepoRootEnv() {
  loadEnvFileIfPresent(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
}

/** Pure so it can be unit-tested without spawning anything. Returns the list of missing/invalid settings, empty when bucket mode is ready to start. */
export function validateBucketEnv(env) {
  const missing = [];
  if (env.STORAGE_BACKEND !== "s3") missing.push("STORAGE_BACKEND=s3");
  for (const key of REQUIRED_VARS) {
    if (!env[key] || !env[key].trim()) missing.push(key);
  }
  return missing;
}

function main() {
  loadRepoRootEnv();
  const missing = validateBucketEnv(process.env);
  if (missing.length > 0) {
    console.error(
      `editor:bucket requires bucket configuration; missing or unset: ${missing.join(", ")}.\n` +
        "Set these (repo-root .env or the shell environment) and try again:\n" +
        "  STORAGE_BACKEND=s3\n" +
        "  S3_BUCKET=<bucket-name>\n" +
        "  S3_ACCESS_KEY_ID=<key-id>\n" +
        "  S3_SECRET_ACCESS_KEY=<secret>\n" +
        "  S3_ENDPOINT=<url>       # omit only when targeting AWS S3 itself\n" +
        'See docs/SETUP.md, "Starting the editor in bucket mode".',
    );
    process.exit(1);
  }
  startEditor();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
