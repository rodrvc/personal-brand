import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { PreconditionFailedError } from "./object-store.js";
import { S3ObjectStore } from "./s3-object-store.js";

/**
 * Exercises `S3ObjectStore` against a real S3-compatible server — bring one
 * up with `docker compose -f docker-compose.storage.yml up -d` (see that
 * file's header for why it runs `adobe/s3mock` rather than MinIO's own
 * image today) and set `S3_ENDPOINT` before running this file. Prints a
 * clear SKIP and exits 0 when no endpoint is configured or it is
 * unreachable, so `pnpm test` never fails in an environment with no bucket
 * running.
 *
 * What this specifically proves that the fake store's tests cannot: the
 * real server enforces `If-Match`/`If-None-Match` on PutObject — the exact
 * guarantee the carousel stale-revision check and chat-log append rely on.
 */

const endpoint = process.env.S3_ENDPOINT;

if (!endpoint) {
  console.log("SKIP - S3_ENDPOINT not set; run `docker compose -f docker-compose.storage.yml up -d` and set it to run this test");
  process.exit(0);
}

const store = new S3ObjectStore({
  bucket: process.env.S3_BUCKET || "brand-profiles",
  endpoint,
  region: process.env.S3_REGION || "us-east-1",
  accessKeyId: process.env.S3_ACCESS_KEY_ID || "test",
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "test",
  forcePathStyle: true,
});

try {
  await store.list("healthcheck/");
} catch (error) {
  console.log(`SKIP - could not reach S3 endpoint "${endpoint}": ${(error as Error).message}`);
  process.exit(0);
}

const prefix = `integration-test/${randomUUID()}/`;

const tests: Array<[string, () => Promise<void>]> = [
  [
    "put then get round-trips content and etag",
    async () => {
      const key = `${prefix}doc.json`;
      const put = await store.put(key, Buffer.from(JSON.stringify({ hello: "world" })));
      const got = await store.get(key);
      assert.equal(got.body.toString(), JSON.stringify({ hello: "world" }));
      assert.equal(got.etag, put.etag);
    },
  ],
  [
    "head reports the same etag as get, and errors for a missing key",
    async () => {
      const key = `${prefix}head-me.json`;
      const put = await store.put(key, Buffer.from("x"));
      const head = await store.head(key);
      assert.equal(head.etag, put.etag);
      await assert.rejects(() => store.head(`${prefix}missing.json`));
    },
  ],
  [
    "ifNoneMatch:'*' really is enforced server-side: second create of the same key fails",
    async () => {
      const key = `${prefix}create-once.json`;
      await store.put(key, Buffer.from("v1"), { ifNoneMatch: "*" });
      await assert.rejects(
        () => store.put(key, Buffer.from("v2"), { ifNoneMatch: "*" }),
        PreconditionFailedError,
      );
    },
  ],
  [
    "ifMatch really is enforced server-side: a stale etag is refused, the current one succeeds",
    async () => {
      const key = `${prefix}revisioned.json`;
      const first = await store.put(key, Buffer.from("v1"));
      await assert.rejects(
        () => store.put(key, Buffer.from("v2-stale"), { ifMatch: "not-the-real-etag" }),
        PreconditionFailedError,
      );
      const second = await store.put(key, Buffer.from("v2"), { ifMatch: first.etag });
      const got = await store.get(key);
      assert.equal(got.body.toString(), "v2");
      assert.notEqual(second.etag, first.etag);
    },
  ],
  [
    "put metadata round-trips through head on a real server",
    async () => {
      const key = `${prefix}with-meta.json`;
      await store.put(key, Buffer.from("v1"), { metadata: { sha256: "deadbeef" } });
      const head = await store.head(key);
      assert.equal(head.metadata.sha256, "deadbeef");
    },
  ],
  [
    "list finds every object under a prefix",
    async () => {
      await store.put(`${prefix}list/a.txt`, Buffer.from("a"));
      await store.put(`${prefix}list/b.txt`, Buffer.from("b"));
      const listed = await store.list(`${prefix}list/`);
      assert.deepEqual(
        listed.map((o) => o.key).sort(),
        [`${prefix}list/a.txt`, `${prefix}list/b.txt`],
      );
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
