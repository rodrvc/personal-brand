import assert from "node:assert/strict";

import { FakeObjectStore } from "./fake-object-store.js";
import { ObjectNotFoundError, PreconditionFailedError } from "./object-store.js";

const tests: Array<[string, () => Promise<void> | void]> = [
  [
    "get/head throw ObjectNotFoundError for a missing key",
    async () => {
      const store = new FakeObjectStore();
      await assert.rejects(() => store.get("x/brand.json"), ObjectNotFoundError);
      await assert.rejects(() => store.head("x/brand.json"), ObjectNotFoundError);
    },
  ],
  [
    "put with no options always succeeds and returns a stable etag for the same content",
    async () => {
      const store = new FakeObjectStore();
      const a = await store.put("x/brand.json", Buffer.from("hello"));
      const b = await store.put("x/other.json", Buffer.from("hello"));
      assert.equal(a.etag, b.etag);
    },
  ],
  [
    "put ifNoneMatch:'*' fails once the key exists, succeeds for a brand-new key",
    async () => {
      const store = new FakeObjectStore();
      await store.put("x/new.json", Buffer.from("first"), { ifNoneMatch: "*" });
      await assert.rejects(
        () => store.put("x/new.json", Buffer.from("second"), { ifNoneMatch: "*" }),
        PreconditionFailedError,
      );
      const stored = await store.get("x/new.json");
      assert.equal(stored.body.toString(), "first");
    },
  ],
  [
    "put ifMatch fails on a stale etag and succeeds on the current one",
    async () => {
      const store = new FakeObjectStore();
      const first = await store.put("x/doc.json", Buffer.from("v1"));
      await assert.rejects(
        () => store.put("x/doc.json", Buffer.from("v2-stale"), { ifMatch: "not-the-real-etag" }),
        PreconditionFailedError,
      );
      const second = await store.put("x/doc.json", Buffer.from("v2"), { ifMatch: first.etag });
      assert.notEqual(second.etag, first.etag);
      const stored = await store.get("x/doc.json");
      assert.equal(stored.body.toString(), "v2");
    },
  ],
  [
    "put ifMatch against a key that does not exist yet fails",
    async () => {
      const store = new FakeObjectStore();
      await assert.rejects(
        () => store.put("x/missing.json", Buffer.from("v1"), { ifMatch: "whatever" }),
        PreconditionFailedError,
      );
    },
  ],
  [
    "list returns only keys under the given prefix",
    async () => {
      const store = new FakeObjectStore();
      await store.put("a/brand.json", Buffer.from("1"));
      await store.put("a/assets/x.png", Buffer.from("2"));
      await store.put("b/brand.json", Buffer.from("3"));

      const listed = await store.list("a/");
      assert.equal(listed.length, 2);
      assert.deepEqual(
        listed.map((o) => o.key).sort(),
        ["a/assets/x.png", "a/brand.json"],
      );
    },
  ],
  [
    "put metadata round-trips through head",
    async () => {
      const store = new FakeObjectStore();
      await store.put("x/with-meta.json", Buffer.from("v1"), { metadata: { sha256: "abc123" } });
      const head = await store.head("x/with-meta.json");
      assert.equal(head.metadata.sha256, "abc123");
    },
  ],
  [
    "two concurrent conditional writers racing on the same base: only one wins",
    async () => {
      const store = new FakeObjectStore();
      const initial = await store.put("x/counter.json", Buffer.from("0"));

      const results = await Promise.allSettled([
        store.put("x/counter.json", Buffer.from("1"), { ifMatch: initial.etag }),
        store.put("x/counter.json", Buffer.from("2"), { ifMatch: initial.etag }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
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
