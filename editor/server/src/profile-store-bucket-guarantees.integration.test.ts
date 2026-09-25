import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The same two ProfileStore-level guarantees covered by
 * `profile-store-bucket-guarantees.test.ts` against `FakeObjectStore`, run
 * here against a real S3-compatible server — see
 * `docker-compose.storage.yml`. SKIPs cleanly (exit 0) when `S3_ENDPOINT` is
 * unset or unreachable, exactly like `storage/s3-object-store.integration.test.ts`.
 */

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint) {
  console.log("SKIP - S3_ENDPOINT not set; run `docker compose -f docker-compose.storage.yml up -d` and set it to run this test");
  process.exit(0);
}

const { ProfileStore, RevisionConflictError } = await import("./profile-store.js");
const { resetStorageRuntimeForTests, initStorageRuntime, getStorageRuntime } = await import("./storage/runtime.js");

resetStorageRuntimeForTests();
const cacheDir = mkdtempSync(join(tmpdir(), "profile-store-bucket-it-cache-"));
// Mutate the real process.env (not a throwaway object): initStorageRuntime
// needs to repoint the REAL BRAND_PROFILES_DIR/BRAND_OUTPUTS_ROOT at the
// mirror for ProfileStore's plain fs calls to land there.
process.env.STORAGE_BACKEND = "s3";
process.env.S3_ENDPOINT = endpoint;
process.env.S3_BUCKET = process.env.S3_BUCKET || "brand-profiles";
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || "test";
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || "test";
process.env.S3_PREFIX = `it-${randomUUID()}/`;
process.env.PROFILE_CACHE_DIR = cacheDir;
initStorageRuntime();

try {
  await getStorageRuntime().store!.list("healthcheck/");
} catch (error) {
  console.log(`SKIP - could not reach S3 endpoint "${endpoint}": ${(error as Error).message}`);
  process.exit(0);
}

const SLUG = "acme";

const tests: Array<[string, () => Promise<void>]> = [
  [
    "writeJsonIfRevision: a stale revision is refused by the real bucket, the current one succeeds",
    async () => {
      const store = new ProfileStore(SLUG);
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 1 }, null);
      const read1 = await store.readJsonRevision<{ v: number }>("carousels/x/carousel.json");
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 2 }, read1!.revision);

      await assert.rejects(
        () => store.writeJsonIfRevision("carousels/x/carousel.json", { v: "stale" }, read1!.revision),
        RevisionConflictError,
      );

      const final = await store.readJsonRevision<{ v: number }>("carousels/x/carousel.json");
      assert.equal(final?.value.v, 2);
    },
  ],
  [
    "appendLine: concurrent appenders against the real bucket all land, none lost",
    async () => {
      const store = new ProfileStore(SLUG);
      await Promise.all([0, 1, 2, 3, 4].map((i) => store.appendLine("carousels/x/chat.jsonl", `line-${i}`)));

      const { getStorageRuntime: runtime } = await import("./storage/runtime.js");
      const { store: objectStore, config } = runtime();
      const got = await objectStore!.get(`${config.s3!.prefix}${SLUG}/carousels/x/chat.jsonl`);
      const lines = got.body.toString("utf-8").split("\n").filter(Boolean);
      assert.equal(lines.length, 5);
      for (let i = 0; i < 5; i++) assert.ok(lines.includes(`line-${i}`), `missing line-${i}`);
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

resetStorageRuntimeForTests();
rmSync(cacheDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
