import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFileIfPresent, validateBucketEnv } from "./dev-bucket.mjs";

const tests = [
  [
    "reports every missing setting when the environment is empty",
    () => {
      const missing = validateBucketEnv({});
      assert.deepEqual(missing, ["STORAGE_BACKEND=s3", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    },
  ],
  [
    "reports STORAGE_BACKEND=fs (or unset) as missing even with bucket vars present",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "fs",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, ["STORAGE_BACKEND=s3"]);
    },
  ],
  [
    "reports blank values as missing, not merely present keys",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "  ",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, ["S3_BUCKET"]);
    },
  ],
  [
    "passes with STORAGE_BACKEND=s3 and the three required vars set; S3_ENDPOINT stays optional",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, []);
    },
  ],
  [
    "loadEnvFileIfPresent fills bucket config from a temp .env file, so validation passes",
    () => {
      // `process.loadEnvFile` writes to the real process environment (a
      // native binding), not to a swapped-out `process.env` object, so this
      // saves and restores the exact keys it touches instead.
      const KEYS = ["STORAGE_BACKEND", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
      const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
      for (const key of KEYS) delete process.env[key];
      const dir = mkdtempSync(join(tmpdir(), "dev-bucket-test-"));
      const envPath = join(dir, ".env");
      try {
        writeFileSync(
          envPath,
          ["STORAGE_BACKEND=s3", "S3_BUCKET=brand-profiles", "S3_ACCESS_KEY_ID=id", "S3_SECRET_ACCESS_KEY=secret", ""].join("\n"),
        );
        loadEnvFileIfPresent(envPath);
        assert.deepEqual(validateBucketEnv(process.env), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        for (const key of KEYS) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    },
  ],
  [
    "loadEnvFileIfPresent never overrides a variable already set in the shell env",
    () => {
      const saved = process.env.S3_BUCKET;
      process.env.S3_BUCKET = "from-shell";
      const dir = mkdtempSync(join(tmpdir(), "dev-bucket-test-"));
      const envPath = join(dir, ".env");
      try {
        writeFileSync(envPath, "S3_BUCKET=from-dotenv\n");
        loadEnvFileIfPresent(envPath);
        assert.equal(process.env.S3_BUCKET, "from-shell");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        if (saved === undefined) delete process.env.S3_BUCKET;
        else process.env.S3_BUCKET = saved;
      }
    },
  ],
  [
    "loadEnvFileIfPresent is a no-op when the file does not exist",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "dev-bucket-test-"));
      try {
        assert.doesNotThrow(() => loadEnvFileIfPresent(join(dir, ".env")));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
