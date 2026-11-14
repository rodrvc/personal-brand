import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { BlobCache, defaultBlobCacheDir } from "../src/blob/blob-cache.ts";
import { FakeObjectStore } from "../src/blob/fake-object-store.ts";
import { putBlob } from "../src/blob/put-blob.ts";
import { ObjectNotFoundError } from "../src/contracts/errors.ts";
import { blobKey } from "../src/contracts/keys.ts";

const brand = "11111111-1111-4111-8111-111111111111";
const dir = await mkdtemp(join(tmpdir(), "blob-cache-test-"));
try {
  const store = new FakeObjectStore();
  let gets = 0;
  const original = store.getStream.bind(store);
  store.getStream = async (key) => (gets++, original(key));

  const bytes = Buffer.from("cached bytes");
  const { sha256 } = await putBlob(store, brand, bytes);
  const cache = new BlobCache(store, brand, dir);

  const path = await cache.read(sha256);
  assert.equal(path, join(dir, "sha256", sha256.slice(0, 2), sha256));
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(gets, 1, "miss fetches");

  assert.equal(await cache.read(sha256), path);
  assert.equal(gets, 1, "hit does not fetch");

  await chmod(path, 0o644);
  await writeFile(path, "corrupted");
  assert.equal(await cache.read(sha256), path);
  assert.equal(gets, 1, "a hit only stats the file");
  assert.equal(await cache.verify(sha256), path);
  assert.deepEqual(await readFile(path), bytes, "verify replaces a corrupt file");
  assert.equal(gets, 2, "corruption refetches");
  assert.equal(await cache.verify(sha256), path);
  assert.equal(gets, 2, "verify of a good file does not refetch");

  const wrongSha = createHash("sha256").update("nope").digest("hex");
  await assert.rejects(() => cache.read(wrongSha), ObjectNotFoundError);
  await store.put(blobKey(brand, wrongSha), Buffer.from("not nope"));
  await assert.rejects(() => cache.read(wrongSha), /hash mismatch/);
  await assert.rejects(() => readFile(cache.pathFor(wrongSha)), "bad content never lands in the cache");

  await rm(dir, { recursive: true, force: true });
  assert.deepEqual(await readFile(await cache.read(sha256)), bytes, "cache is disposable");

  const fresh = new BlobCache(store, brand, join(dir, "concurrent"));
  const paths = await Promise.all(Array.from({ length: 8 }, () => fresh.read(sha256)));
  assert.equal(new Set(paths).size, 1);
  assert.deepEqual(await readFile(paths[0]!), bytes);

  const failing = new FakeObjectStore();
  const broken = await putBlob(failing, brand, Buffer.from("never fully read"));
  failing.getStream = async (key) => ({
    ...(await failing.head(key)),
    stream: Readable.from((async function* () {
      yield Buffer.from("first chunk");
      throw new Error("source failed mid-stream");
    })()),
  });
  const failingDir = join(dir, "failing");
  await assert.rejects(() => new BlobCache(failing, brand, failingDir).read(broken.sha256), /mid-stream/);
  const shard = join(failingDir, "sha256", broken.sha256.slice(0, 2));
  assert.deepEqual(await readdir(shard), [], "a failed fill leaves no temp file");

  assert.equal(defaultBlobCacheDir({ BLOB_CACHE_DIR: "/x" }), "/x");
  assert.match(defaultBlobCacheDir({}), /\.cache[\\/]personal-brand[\\/]blobs$/);
  console.log("blob-cache ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
