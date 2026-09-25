import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FakeObjectStore } from "./fake-object-store.js";
import {
  bucketHasBrand,
  fetchObjectOnDemand,
  hydrateIfStale,
  listProfileSlugsFromBucket,
  resetHydrationCache,
  resolveMirrorRoots,
  syncDown,
  syncUp,
} from "./mirror.js";
import type { S3StorageConfig } from "./config.js";

function config(): S3StorageConfig {
  return {
    bucket: "brand-profiles",
    region: "us-east-1",
    accessKeyId: "id",
    secretAccessKey: "secret",
    prefix: "profiles/",
    forcePathStyle: true,
  };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "syncDown pulls a new remote object into the local mirror and records it in the manifest",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from('{"name":"Acme"}'));

      await syncDown(store, config(), cacheDir, "acme");

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const localPath = join(roots.profileDir, "brand.json");
      assert.ok(existsSync(localPath));
      assert.equal(readFileSync(localPath, "utf-8"), '{"name":"Acme"}');
      const manifest = JSON.parse(readFileSync(roots.manifestPath, "utf-8"));
      assert.ok(manifest["profiles/acme/brand.json"]);

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown routes _outputs/ keys into the outputs mirror, not the profile mirror",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      // `.json` rather than `.png` on purpose: this test is about mirror
      // routing, not the lazy-media exclusion (covered separately below) —
      // a rendered image is excluded from eager syncDown by default.
      await store.put("profiles/acme/_outputs/carousels/x/v1/manifest.json", Buffer.from("{}"));

      await syncDown(store, config(), cacheDir, "acme");

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      assert.ok(existsSync(join(roots.outputsDir, "carousels/x/v1/manifest.json")));
      assert.ok(!existsSync(join(roots.profileDir, "_outputs")));

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown a second time with no remote changes touches nothing (etag unchanged skips download)",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("v1"));
      await syncDown(store, config(), cacheDir, "acme");

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const localPath = join(roots.profileDir, "brand.json");
      // Simulate a local edit that syncDown must NOT clobber when the remote etag is unchanged.
      writeFileSync(localPath, "locally-edited");

      await syncDown(store, config(), cacheDir, "acme");
      assert.equal(readFileSync(localPath, "utf-8"), "locally-edited");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncUp uploads a locally-written mirror file that was never in the manifest",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(roots.profileDir, { recursive: true });
      writeFileSync(join(roots.profileDir, "config.yaml"), "profile:\n  name: Acme\n");

      await syncUp(store, config(), cacheDir, "acme");

      const got = await store.get("profiles/acme/config.yaml");
      assert.equal(got.body.toString(), "profile:\n  name: Acme\n");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncUp skips a file whose content hash is unchanged since the last sync",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(roots.outputsDir, { recursive: true });
      const filePath = join(roots.outputsDir, "carousels/x/v1/01.png");
      mkdirSync(join(roots.outputsDir, "carousels/x/v1"), { recursive: true });
      writeFileSync(filePath, "PNGDATA");

      await syncUp(store, config(), cacheDir, "acme");
      const firstPut = await store.get("profiles/acme/_outputs/carousels/x/v1/01.png");
      assert.equal(firstPut.body.toString(), "PNGDATA");

      // A second syncUp with unchanged content must not re-upload (asserted indirectly:
      // etag/hash bookkeeping stays consistent and the object is unchanged).
      await syncUp(store, config(), cacheDir, "acme");
      const secondGet = await store.get("profiles/acme/_outputs/carousels/x/v1/01.png");
      assert.equal(secondGet.etag, firstPut.etag);

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "hydrateIfStale only calls syncDown once within the TTL window",
    async () => {
      resetHydrationCache();
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("v1"));

      await hydrateIfStale(store, config(), cacheDir, "acme", 10_000);
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const localPath = join(roots.profileDir, "brand.json");
      writeFileSync(localPath, "locally-edited-after-first-hydrate");

      // Remote changes, but within the TTL window a second call must be a no-op.
      await store.put("profiles/acme/brand.json", Buffer.from("v2-remote"));
      await hydrateIfStale(store, config(), cacheDir, "acme", 10_000);
      assert.equal(readFileSync(localPath, "utf-8"), "locally-edited-after-first-hydrate");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "listProfileSlugsFromBucket returns the distinct top-level slugs under the prefix",
    async () => {
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("1"));
      await store.put("profiles/acme/config.yaml", Buffer.from("2"));
      await store.put("profiles/other-brand/brand.json", Buffer.from("3"));

      const slugs = await listProfileSlugsFromBucket(store, config());
      assert.deepEqual(slugs, ["acme", "other-brand"]);
    },
  ],
  [
    "bucketHasBrand reflects whether brand.json exists for a slug",
    async () => {
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("1"));

      assert.equal(await bucketHasBrand(store, config(), "acme"), true);
      assert.equal(await bucketHasBrand(store, config(), "no-brand-yet"), false);
    },
  ],
  [
    "syncUp does not overwrite a concurrent newer remote write with a stale local edit",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");

      await store.put("profiles/acme/brand.json", Buffer.from("v1"));
      await syncDown(store, config(), cacheDir, "acme"); // baseline: manifest now knows etag(v1)/hash(v1)

      // A bypass writer edits the local mirror directly, without going
      // through a bucket-aware write path.
      writeFileSync(join(roots.profileDir, "brand.json"), "v2-local");

      // Meanwhile a different writer updates the same object in the bucket —
      // the manifest's recorded etag is now stale on both sides.
      await store.put("profiles/acme/brand.json", Buffer.from("v2-remote"));

      await syncUp(store, config(), cacheDir, "acme");

      const remote = await store.get("profiles/acme/brand.json");
      assert.equal(remote.body.toString(), "v2-remote", "the newer remote write must survive");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown never performs a stale wholesale manifest save: a concurrent manifest write for another key survives a syncDown in flight",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("v1"));
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");

      const originalList = store.list.bind(store);
      let releaseList: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      (store as unknown as { list: typeof store.list }).list = async (prefix: string) => {
        const result = await originalList(prefix);
        await gate;
        return result;
      };

      const syncDownPromise = syncDown(store, config(), cacheDir, "acme");

      // Simulate a concurrent writer patching an unrelated manifest key
      // directly on disk while syncDown is in flight.
      mkdirSync(dirname(roots.manifestPath), { recursive: true });
      writeFileSync(
        roots.manifestPath,
        JSON.stringify({ "profiles/acme/other-key.json": { etag: "e", hash: "h" } }, null, 2) + "\n",
        "utf-8",
      );

      releaseList();
      await syncDownPromise;

      const manifest = JSON.parse(readFileSync(roots.manifestPath, "utf-8"));
      assert.ok(manifest["profiles/acme/other-key.json"], "the concurrent manifest write must survive");
      assert.ok(manifest["profiles/acme/brand.json"], "syncDown's own entry must also be present");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown keeps a local file with an unsynced edit rather than overwriting it from the bucket",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("v1"));
      await syncDown(store, config(), cacheDir, "acme");

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const localPath = join(roots.profileDir, "brand.json");
      writeFileSync(localPath, "locally-edited-not-yet-uploaded");

      await store.put("profiles/acme/brand.json", Buffer.from("v2-remote"));
      const result = await syncDown(store, config(), cacheDir, "acme");

      assert.equal(readFileSync(localPath, "utf-8"), "locally-edited-not-yet-uploaded");
      assert.equal(result.conflicts, 1);
      assert.equal(result.downloaded, 0);

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown refuses a remote key with a `..` segment or an absolute path instead of writing outside the mirror root",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/../../etc/evil.json", Buffer.from("pwned"));
      await store.put("profiles/acme//etc/absolute-ish.json", Buffer.from("also-pwned"));

      const result = await syncDown(store, config(), cacheDir, "acme");

      assert.equal(result.downloaded, 0);
      assert.ok(result.conflicts >= 1);
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      assert.ok(!existsSync(join(roots.profileMirrorRoot, "..", "..", "etc", "evil.json")));

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown excludes lazy output media by default, and fetchObjectOnDemand pulls it in on request",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/_outputs/carousels/x/v1/01.png", Buffer.from("PNGDATA"));
      await store.put("profiles/acme/_outputs/carousels/x/v1/manifest.json", Buffer.from("{}"));

      const result = await syncDown(store, config(), cacheDir, "acme");
      assert.equal(result.skippedLazy, 1);

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      assert.ok(!existsSync(join(roots.outputsDir, "carousels/x/v1/01.png")), "the PNG must not be eagerly hydrated");
      assert.ok(existsSync(join(roots.outputsDir, "carousels/x/v1/manifest.json")), "the small manifest must still be hydrated eagerly");

      const localPath = await fetchObjectOnDemand(store, config(), cacheDir, "acme", "outputs", "carousels/x/v1/01.png");
      assert.equal(readFileSync(localPath, "utf-8"), "PNGDATA");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "two concurrent syncDown calls for the same slug share one in-flight run instead of listing twice",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/brand.json", Buffer.from("v1"));

      let listCalls = 0;
      const originalList = store.list.bind(store);
      (store as unknown as { list: typeof store.list }).list = async (prefix: string) => {
        listCalls++;
        return originalList(prefix);
      };

      const [a, b] = await Promise.all([
        syncDown(store, config(), cacheDir, "acme"),
        syncDown(store, config(), cacheDir, "acme"),
      ]);

      assert.equal(listCalls, 1);
      assert.equal(a, b, "both callers must get the exact same result object from the shared in-flight run");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "syncDown does not clobber a local write that lands on the SAME key while its `get` is in flight",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const key = "profiles/acme/chat.jsonl";
      const localPath = join(roots.profileDir, "chat.jsonl");

      await store.put(key, Buffer.from("A"));
      await syncDown(store, config(), cacheDir, "acme"); // baseline: manifest now knows etag(A)/hash(A)

      // Another instance appends directly to the bucket.
      const afterX = await store.put(key, Buffer.from("A+X"));

      // Gate this store's `get` so syncDown's download of "A+X" stays in
      // flight while a concurrent local writer (this instance's own
      // ProfileStore write guarantees, simulated directly here) races ahead
      // of it and lands a newer write on the exact same key.
      const originalGet = store.get.bind(store);
      let releaseGet: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGet = resolve;
      });
      (store as unknown as { get: typeof store.get }).get = async (k: string) => {
        const result = await originalGet(k);
        await gate;
        return result;
      };

      const syncDownPromise = syncDown(store, config(), cacheDir, "acme");

      // The concurrent local write: uploads a newer version, then writes the
      // local mirror and records the manifest entry it produced — all
      // before syncDown's `get` (issued against the older "A+X" content)
      // resolves.
      const afterB = await store.put(key, Buffer.from("A+X+B"), { ifMatch: afterX.etag });
      mkdirSync(roots.profileDir, { recursive: true });
      writeFileSync(localPath, "A+X+B");
      // Simulates `ProfileStore`'s bucket-backed write guarantees patching
      // the manifest entry synchronously right after the local write above
      // (`updateManifestEntry`, not yet exported from this module on this
      // link — patched directly here the same way this file's other tests
      // simulate a concurrent manifest writer).
      const { createHash } = await import("node:crypto");
      mkdirSync(dirname(roots.manifestPath), { recursive: true });
      const manifestBefore = existsSync(roots.manifestPath) ? JSON.parse(readFileSync(roots.manifestPath, "utf-8")) : {};
      manifestBefore[key] = { etag: afterB.etag, hash: createHash("sha256").update("A+X+B").digest("hex") };
      writeFileSync(roots.manifestPath, JSON.stringify(manifestBefore, null, 2) + "\n", "utf-8");

      releaseGet();
      const result = await syncDownPromise;

      assert.equal(readFileSync(localPath, "utf-8"), "A+X+B", "the local write that landed during the `get` must survive");
      assert.equal(result.conflicts, 1);
      assert.equal(result.downloaded, 0);

      const manifest = JSON.parse(readFileSync(roots.manifestPath, "utf-8"));
      assert.equal(manifest[key].hash, createHash("sha256").update("A+X+B").digest("hex"), "the manifest must still describe the surviving local content");

      rmSync(cacheDir, { recursive: true, force: true });
    },
  ],
  [
    "fetchObjectOnDemand never leaves a truncated file when the download stream errors partway through",
    async () => {
      const cacheDir = mkdtempSync(join(tmpdir(), "mirror-test-"));
      const store = new FakeObjectStore();
      await store.put("profiles/acme/_outputs/carousels/x/v1/01.png", Buffer.from("GOODDATA"));
      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      const localPath = join(roots.outputsDir, "carousels/x/v1/01.png");

      const originalGetStream = store.getStream.bind(store);
      (store as unknown as { getStream: typeof store.getStream }).getStream = async (key: string) => {
        const real = await originalGetStream(key);
        return {
          etag: real.etag,
          stream: (async function* () {
            yield Buffer.from("PARTIAL");
            throw new Error("connection dropped mid-stream");
          })(),
        };
      };

      await assert.rejects(
        () => fetchObjectOnDemand(store, config(), cacheDir, "acme", "outputs", "carousels/x/v1/01.png"),
        /connection dropped mid-stream/,
      );

      assert.ok(!existsSync(localPath), "a failed download must never leave a file at the real destination path");

      // A retry with a healthy stream must still succeed afterwards.
      (store as unknown as { getStream: typeof store.getStream }).getStream = originalGetStream;
      const finalPath = await fetchObjectOnDemand(store, config(), cacheDir, "acme", "outputs", "carousels/x/v1/01.png");
      assert.equal(readFileSync(finalPath, "utf-8"), "GOODDATA");

      rmSync(cacheDir, { recursive: true, force: true });
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
