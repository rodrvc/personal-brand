import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FakeObjectStore } from "../src/blob/fake-object-store.ts";
import { putBlob } from "../src/blob/put-blob.ts";
import { ObjectNotFoundError, PreconditionFailedError } from "../src/contracts/errors.ts";
import { blobKey } from "../src/contracts/keys.ts";

const brand = "11111111-1111-4111-8111-111111111111";
const bytes = Buffer.from("hello blob");
const sha = createHash("sha256").update(bytes).digest("hex");

const store = new FakeObjectStore();
const first = await putBlob(store, brand, bytes, "text/plain");
assert.deepEqual(first, { sha256: sha, key: `brands/${brand}/blobs/sha256/${sha.slice(0, 2)}/${sha}` });
assert.equal(first.key, blobKey(brand, sha));
assert.equal((await store.head(first.key)).metadata.sha256, sha);

const second = await putBlob(store, brand, Buffer.from(bytes), "text/plain");
assert.deepEqual(second, first, "same bytes: same result");
assert.equal(store.size(), 1, "second write is a no-op");

const concurrent = await Promise.all([1, 2, 3].map(() => putBlob(store, brand, Buffer.from("other"))));
assert.equal(new Set(concurrent.map((r) => r.key)).size, 1);
assert.equal(store.size(), 2);

// Different bytes already stored under the hash-derived key is an error, not silent success.
const tampered = new FakeObjectStore();
await tampered.put(blobKey(brand, sha), Buffer.from("tampered"), { metadata: { sha256: "0".repeat(64) } });
await assert.rejects(() => putBlob(tampered, brand, bytes), /different content/);
await assert.rejects(() => putBlob(new FakeObjectStore(), "not-a-uuid", bytes), /Invalid brandId/);
// A conditional put rejected while the winner is not yet visible is retried.
const lagging = new FakeObjectStore();
const realPut = lagging.put.bind(lagging);
let calls = 0;
lagging.put = async (key, body, options) => {
  if (++calls === 1) {
    await realPut(key, body, options);
    throw new PreconditionFailedError(key);
  }
  return realPut(key, body, options);
};
const realHead = lagging.head.bind(lagging);
let heads = 0;
lagging.head = async (key) => {
  if (++heads === 1) throw new ObjectNotFoundError(key);
  return realHead(key);
};
assert.equal((await putBlob(lagging, brand, bytes)).sha256, sha);
assert.equal(heads, 2, "head was retried after a not-found");
console.log("put-blob ok");
