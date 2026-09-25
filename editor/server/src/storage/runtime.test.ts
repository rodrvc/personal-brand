import assert from "node:assert/strict";
import { join } from "node:path";

import { S3ObjectStore } from "./s3-object-store.js";
import {
  getStorageRuntime,
  initStorageRuntime,
  resetStorageRuntimeForTests,
  slugFromRequestPath,
} from "./runtime.js";

const tests: Array<[string, () => void]> = [
  [
    "slugFromRequestPath extracts the slug from /api/profiles/:slug/... paths",
    () => {
      assert.equal(slugFromRequestPath("/api/profiles/acme/brand"), "acme");
      assert.equal(slugFromRequestPath("/api/profiles/acme"), "acme");
      assert.equal(slugFromRequestPath("/api/profiles/acme/carousels/x/chat/messages"), "acme");
    },
  ],
  [
    "slugFromRequestPath returns undefined for unrelated paths",
    () => {
      assert.equal(slugFromRequestPath("/api/health"), undefined);
      assert.equal(slugFromRequestPath("/api/profiles"), undefined);
    },
  ],
  [
    "initStorageRuntime defaults to fs and leaves BRAND_PROFILES_DIR untouched",
    () => {
      resetStorageRuntimeForTests();
      const env: NodeJS.ProcessEnv = {};
      const runtime = initStorageRuntime(env);
      assert.equal(runtime.config.backend, "fs");
      assert.equal(runtime.store, undefined);
      assert.equal(env.BRAND_PROFILES_DIR, undefined);
    },
  ],
  [
    "initStorageRuntime in s3 mode points BRAND_PROFILES_DIR/BRAND_OUTPUTS_ROOT at the mirror",
    () => {
      resetStorageRuntimeForTests();
      const env: NodeJS.ProcessEnv = {
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
        PROFILE_CACHE_DIR: "/tmp/cache-root",
      };
      const runtime = initStorageRuntime(env);
      assert.equal(runtime.config.backend, "s3");
      assert.ok(runtime.store instanceof S3ObjectStore);
      assert.equal(env.BRAND_PROFILES_DIR, join("/tmp/cache-root", "brand-profiles", "profiles"));
      assert.equal(env.BRAND_OUTPUTS_ROOT, join("/tmp/cache-root", "brand-profiles", "outputs"));
    },
  ],
  [
    "getStorageRuntime auto-initializes from process.env if never called explicitly",
    () => {
      resetStorageRuntimeForTests();
      const runtime = getStorageRuntime();
      assert.equal(runtime.config.backend, "fs");
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

resetStorageRuntimeForTests();

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
