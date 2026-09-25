import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exercises `ProfileStore`'s bucket-backed write guarantees
 * (`writeJsonIfRevision`, `appendLine`, `reserveOnce`) against a
 * `FakeObjectStore` injected via `setStorageRuntimeForTests` — the same
 * conditional-write semantics the real bucket enforces (proven separately
 * in `storage/s3-object-store.integration.test.ts` and, for these exact
 * ProfileStore-level scenarios, in
 * `profile-store-bucket-guarantees.integration.test.ts`), without needing a
 * bucket running for the normal `pnpm test` chain.
 */

const root = mkdtempSync(join(tmpdir(), "profile-store-bucket-test-"));
process.env.BRAND_PROFILES_DIR = root;

const { ProfileStore, RevisionConflictError } = await import("./profile-store.js");
const { FakeObjectStore } = await import("./storage/fake-object-store.js");
const { setStorageRuntimeForTests, resetStorageRuntimeForTests } = await import("./storage/runtime.js");

const SLUG = "acme";

function freshRuntime(): InstanceType<typeof FakeObjectStore> {
  const store = new FakeObjectStore();
  const bucket = "brand-profiles";
  const cacheDir = mkdtempSync(join(tmpdir(), "profile-store-bucket-cache-"));
  setStorageRuntimeForTests({
    config: {
      backend: "s3",
      cacheDir,
      s3: {
        bucket,
        region: "us-east-1",
        accessKeyId: "id",
        secretAccessKey: "secret",
        prefix: "profiles/",
        forcePathStyle: true,
      },
    },
    store,
  });
  // Mirrors what `initStorageRuntime` does for a real s3-mode server: point
  // `ProfileStore`'s own filesystem root at this run's mirror, so a
  // bucket-side fetch (fetchObjectOnDemand) and a local read
  // (ProfileStore.readFile/exists) agree on where the mirror lives.
  process.env.BRAND_PROFILES_DIR = join(cacheDir, bucket, "profiles");
  return store;
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "writeJsonIfRevision create-only (expectedRevision: null) succeeds once, fails the second time",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 1 }, null);
      await assert.rejects(
        () => store.writeJsonIfRevision("carousels/x/carousel.json", { v: 2 }, null),
        RevisionConflictError,
      );
    },
  ],
  [
    "writeJsonIfRevision with a stale revision throws RevisionConflictError (the carousel PUT route's 409 case)",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      const readBefore = await store.readJsonRevision("carousels/x/carousel.json");
      assert.equal(readBefore, undefined);
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 1 }, null);
      const read1 = await store.readJsonRevision<{ v: number }>("carousels/x/carousel.json");
      assert.equal(read1?.value.v, 1);

      // Someone else writes v2 in between.
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 2 }, read1!.revision);

      // Our stale copy (read1's revision) can no longer write.
      await assert.rejects(
        () => store.writeJsonIfRevision("carousels/x/carousel.json", { v: "stale-writer" }, read1!.revision),
        RevisionConflictError,
      );

      const finalRead = await store.readJsonRevision<{ v: number }>("carousels/x/carousel.json");
      assert.equal(finalRead?.value.v, 2);
    },
  ],
  [
    "writeJsonIfRevision writes through to the local mirror and records the manifest so syncUp doesn't re-upload it",
    async () => {
      const fake = freshRuntime();
      const store = new ProfileStore(SLUG);
      await store.writeJsonIfRevision("carousels/x/carousel.json", { v: 1 }, null);

      const { getStorageRuntime } = await import("./storage/runtime.js");
      const { syncUp } = await import("./storage/mirror.js");
      const { config } = getStorageRuntime();
      const before = await fake.get("profiles/acme/carousels/x/carousel.json");

      await syncUp(fake, config.s3!, config.cacheDir, SLUG);

      const after = await fake.get("profiles/acme/carousels/x/carousel.json");
      assert.equal(after.etag, before.etag);
      assert.equal(JSON.parse(after.body.toString("utf-8")).v, 1);
    },
  ],
  [
    "two concurrent appendLine calls on a brand-new log both land, losing nothing",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);

      await Promise.all([store.appendLine("carousels/x/chat.jsonl", "line-a"), store.appendLine("carousels/x/chat.jsonl", "line-b")]);

      const { getStorageRuntime } = await import("./storage/runtime.js");
      const { store: fake } = getStorageRuntime();
      const final = await fake!.get("profiles/acme/carousels/x/chat.jsonl");
      const lines = final.body.toString("utf-8").split("\n").filter(Boolean);
      assert.equal(lines.length, 2);
      assert.ok(lines.includes("line-a"));
      assert.ok(lines.includes("line-b"));
    },
  ],
  [
    "five concurrent appendLine calls on an existing log all land, in some order, none lost",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      await store.appendLine("carousels/x/chat.jsonl", "seed");

      await Promise.all([0, 1, 2, 3, 4].map((i) => store.appendLine("carousels/x/chat.jsonl", `line-${i}`)));

      const { getStorageRuntime } = await import("./storage/runtime.js");
      const { store: fake } = getStorageRuntime();
      const final = await fake!.get("profiles/acme/carousels/x/chat.jsonl");
      const lines = final.body.toString("utf-8").split("\n").filter(Boolean);
      assert.equal(lines.length, 6);
      for (let i = 0; i < 5; i++) assert.ok(lines.includes(`line-${i}`), `missing line-${i}`);
    },
  ],
  [
    "append A, a concurrent syncDown, then append B: the final syncUp does not lose B",
    async () => {
      const fake = freshRuntime();
      const store = new ProfileStore(SLUG);
      const { getStorageRuntime } = await import("./storage/runtime.js");
      const { syncDown, syncUp } = await import("./storage/mirror.js");
      const { config } = getStorageRuntime();

      await store.appendLine("carousels/x/chat.jsonl", "line-a");
      // An unrelated remote object syncDown will actually need to fetch —
      // gating that fetch is what interleaves append B with syncDown's own
      // in-flight run, the exact window the old implementation's stale,
      // load-once/save-once-at-the-end manifest handling was vulnerable
      // during.
      await fake.put("profiles/acme/brand.json", Buffer.from('{"v":1}\n'));

      const originalGet = fake.get.bind(fake);
      let releaseGet: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      (fake as unknown as { get: typeof fake.get }).get = async (key: string) => {
        if (key === "profiles/acme/brand.json") await gate;
        return originalGet(key);
      };

      const syncDownPromise = syncDown(fake, config.s3!, config.cacheDir, SLUG);
      await store.appendLine("carousels/x/chat.jsonl", "line-b");
      releaseGet();
      await syncDownPromise;

      await syncUp(fake, config.s3!, config.cacheDir, SLUG);

      const final = await fake.get("profiles/acme/carousels/x/chat.jsonl");
      const lines = final.body.toString("utf-8").split("\n").filter(Boolean);
      assert.ok(lines.includes("line-a"), "line-a missing");
      assert.ok(lines.includes("line-b"), "line-b missing");
    },
  ],
  [
    "readFileAsync fetches a lazily-excluded profile-area file on demand when it's absent locally",
    async () => {
      const fake = freshRuntime();
      const store = new ProfileStore(SLUG);

      // A real object in the bucket that syncDown's default lazy rules
      // would have excluded from eager hydration (reels/ is always lazy) —
      // never synced down, so it genuinely isn't on disk yet.
      await fake.put("profiles/acme/reels/2026-09-01.mp4", Buffer.from("VIDEO"));
      assert.equal(store.exists("reels/2026-09-01.mp4"), false);

      const bytes = await store.readFileAsync("reels/2026-09-01.mp4");
      assert.equal(bytes.toString("utf-8"), "VIDEO");
      assert.equal(store.exists("reels/2026-09-01.mp4"), true, "must be on disk after the on-demand fetch");
    },
  ],
  [
    "readFileAsync is a no-op fetch when the file is already on disk (the common, already-hydrated case)",
    async () => {
      const fake = freshRuntime();
      const store = new ProfileStore(SLUG);
      await store.writeJsonIfRevision("brand.json", { v: 1 }, null);

      const before = await fake.get("profiles/acme/brand.json");
      const bytes = await store.readFileAsync("brand.json");
      assert.equal(JSON.parse(bytes.toString("utf-8")).v, 1);
      const after = await fake.get("profiles/acme/brand.json");
      assert.equal(after.etag, before.etag, "no redundant fetch/overwrite happened");
    },
  ],
  [
    "writeDocumentThroughRevision (a chat proposal / export job save) is visible to a later readDocumentRevision, so an editor PUT with the pre-save revision gets a 409, same as fs mode",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      const { writeDocumentThroughRevision, readDocumentRevision } = await import("./document-store.js");

      const doc = { id: "x", title: "t", canvas: { w: 1, h: 1 }, slides: [], status: "draft", updatedAt: "now" };
      await writeDocumentThroughRevision(store, doc as unknown as Parameters<typeof writeDocumentThroughRevision>[1], { create: true });

      // The editor opened the carousel before the background write landed —
      // it holds the pre-save revision.
      const staleRead = await readDocumentRevision(store, "x");

      // A chat proposal (or an export job) saves in the background, through
      // writeDocumentThroughRevision — a real bucket-conditional write, not
      // the old local-only writeDocument.
      const updated = { ...doc, title: "updated by background write" };
      await writeDocumentThroughRevision(store, updated as unknown as Parameters<typeof writeDocumentThroughRevision>[1]);

      // The editor's PUT compares against the bucket with its stale
      // revision and must be refused, exactly like fs mode's stale-copy 409.
      await assert.rejects(
        () => store.writeJsonIfRevision("carousels/x/carousel.json", { ...doc, title: "editor's stale PUT" }, staleRead!.revision),
        RevisionConflictError,
      );
    },
  ],
  [
    "reserveOnce claims a marker exactly once; a second attempt on the same path reports false",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      const first = await store.reserveOnce("outputs/editor/x/v1/.reserved");
      const second = await store.reserveOnce("outputs/editor/x/v1/.reserved");
      assert.equal(first, true);
      assert.equal(second, false);
    },
  ],
  [
    "reserveOnce under concurrent callers: exactly one wins a given slot",
    async () => {
      freshRuntime();
      const store = new ProfileStore(SLUG);
      const results = await Promise.all([
        store.reserveOnce("outputs/editor/y/v1/.reserved"),
        store.reserveOnce("outputs/editor/y/v1/.reserved"),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
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
rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
