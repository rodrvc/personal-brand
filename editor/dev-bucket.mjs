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

import { startEditor } from "./dev.mjs";

const REQUIRED_VARS = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

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
