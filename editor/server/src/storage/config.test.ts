import assert from "node:assert/strict";

import { createObjectStore, loadStorageConfig } from "./config.js";
import { S3ObjectStore } from "./s3-object-store.js";

const tests: Array<[string, () => void]> = [
  [
    "defaults to the fs backend when STORAGE_BACKEND is unset",
    () => {
      const config = loadStorageConfig({});
      assert.equal(config.backend, "fs");
      assert.equal(config.s3, undefined);
      assert.ok(config.cacheDir.length > 0);
    },
  ],
  [
    "STORAGE_BACKEND=s3 without required vars throws",
    () => {
      assert.throws(() => loadStorageConfig({ STORAGE_BACKEND: "s3" }));
    },
  ],
  [
    "STORAGE_BACKEND=s3 with required vars resolves defaults for the rest",
    () => {
      const config = loadStorageConfig({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.equal(config.backend, "s3");
      assert.equal(config.s3?.bucket, "brand-profiles");
      assert.equal(config.s3?.region, "us-east-1");
      assert.equal(config.s3?.prefix, "profiles/");
      assert.equal(config.s3?.forcePathStyle, true);
      assert.equal(config.s3?.endpoint, undefined);
    },
  ],
  [
    "explicit overrides win over defaults",
    () => {
      const config = loadStorageConfig({
        STORAGE_BACKEND: "s3",
        S3_ENDPOINT: "http://localhost:9000",
        S3_BUCKET: "brand-profiles",
        S3_REGION: "eu-west-1",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_PREFIX: "custom/",
        S3_FORCE_PATH_STYLE: "false",
      });
      assert.equal(config.s3?.endpoint, "http://localhost:9000");
      assert.equal(config.s3?.region, "eu-west-1");
      assert.equal(config.s3?.prefix, "custom/");
      assert.equal(config.s3?.forcePathStyle, false);
    },
  ],
  [
    "createObjectStore builds an S3ObjectStore for an s3 config",
    () => {
      const config = loadStorageConfig({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      const store = createObjectStore(config);
      assert.ok(store instanceof S3ObjectStore);
    },
  ],
  [
    "createObjectStore throws for an fs config",
    () => {
      assert.throws(() => createObjectStore(loadStorageConfig({})));
    },
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
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
