import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/storage/fake-object-store.js";
import type { S3StorageConfig } from "../src/storage/config.js";
import { migrateProfile, parseArgs, resolveMigrationTarget } from "./migrate-profile-to-bucket.js";

function s3Config(): S3StorageConfig {
  return {
    bucket: "brand-profiles",
    region: "us-east-1",
    accessKeyId: "id",
    secretAccessKey: "secret",
    prefix: "profiles/",
    forcePathStyle: true,
  };
}

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    "parseArgs requires --profile",
    () => {
      assert.throws(() => parseArgs([]));
      assert.deepEqual(parseArgs(["--profile", "acme"]), { profile: "acme", dryRun: false });
      assert.deepEqual(parseArgs(["--profile", "acme", "--dry-run"]), { profile: "acme", dryRun: true });
    },
  ],
  [
    "resolveMigrationTarget ignores STORAGE_BACKEND and always resolves an s3 target",
    () => {
      const config = resolveMigrationTarget({
        STORAGE_BACKEND: "fs",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.equal(config.bucket, "brand-profiles");
    },
  ],
  [
    "uploads every local file once, tagging it with a sha256 metadata hash",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
      const profileDir = join(root, "profile");
      const outputsDir = join(root, "outputs");
      mkdirSync(profileDir, { recursive: true });
      mkdirSync(join(outputsDir, "carousels/x/v1"), { recursive: true });
      writeFileSync(join(profileDir, "brand.json"), '{"name":"Acme"}');
      writeFileSync(join(outputsDir, "carousels/x/v1/01.png"), "PNGDATA");

      const store = new FakeObjectStore();
      const counts = await migrateProfile(store, s3Config(), "acme", profileDir, outputsDir, {
        dryRun: false,
        log: () => {},
      });

      assert.equal(counts.uploaded, 2);
      assert.equal(counts.skipped, 0);
      assert.equal(counts.conflicts, 0);

      const brand = await store.get("profiles/acme/brand.json");
      assert.equal(brand.body.toString(), '{"name":"Acme"}');
      const png = await store.get("profiles/acme/_outputs/carousels/x/v1/01.png");
      assert.equal(png.body.toString(), "PNGDATA");

      rmSync(root, { recursive: true, force: true });
    },
  ],
  [
    "re-running the migration is idempotent: the second run uploads nothing",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
      const profileDir = join(root, "profile");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "brand.json"), '{"name":"Acme"}');

      const store = new FakeObjectStore();
      const first = await migrateProfile(store, s3Config(), "acme", profileDir, join(root, "outputs"), {
        dryRun: false,
        log: () => {},
      });
      assert.equal(first.uploaded, 1);

      const second = await migrateProfile(store, s3Config(), "acme", profileDir, join(root, "outputs"), {
        dryRun: false,
        log: () => {},
      });
      assert.equal(second.uploaded, 0);
      assert.equal(second.skipped, 1);
      assert.equal(second.conflicts, 0);

      rmSync(root, { recursive: true, force: true });
    },
  ],
  [
    "a remote object with different content is reported as a conflict and never overwritten",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
      const profileDir = join(root, "profile");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "brand.json"), '{"name":"local version"}');

      const store = new FakeObjectStore();
      // Something else already put a different brand.json in the bucket
      // (e.g. hand-uploaded, or migrated from a different machine).
      await store.put("profiles/acme/brand.json", Buffer.from('{"name":"remote version"}'), {
        metadata: { sha256: "not-the-local-hash" },
      });

      const counts = await migrateProfile(store, s3Config(), "acme", profileDir, join(root, "outputs"), {
        dryRun: false,
        log: () => {},
      });

      assert.equal(counts.uploaded, 0);
      assert.equal(counts.conflicts, 1);
      const remote = await store.get("profiles/acme/brand.json");
      assert.equal(remote.body.toString(), '{"name":"remote version"}');

      rmSync(root, { recursive: true, force: true });
    },
  ],
  [
    "dry-run reports what it would upload but writes nothing to the store",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "migrate-test-"));
      const profileDir = join(root, "profile");
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "brand.json"), '{"name":"Acme"}');

      const store = new FakeObjectStore();
      const counts = await migrateProfile(store, s3Config(), "acme", profileDir, join(root, "outputs"), {
        dryRun: true,
        log: () => {},
      });

      assert.equal(counts.uploaded, 1);
      await assert.rejects(() => store.get("profiles/acme/brand.json"));

      rmSync(root, { recursive: true, force: true });
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
