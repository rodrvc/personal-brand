import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "./fake-object-store.js";
import {
  bucketHasBrand,
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
      await store.put("profiles/acme/_outputs/carousels/x/v1/01.png", Buffer.from("PNGDATA"));

      await syncDown(store, config(), cacheDir, "acme");

      const roots = resolveMirrorRoots(config(), cacheDir, "acme");
      assert.ok(existsSync(join(roots.outputsDir, "carousels/x/v1/01.png")));
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
