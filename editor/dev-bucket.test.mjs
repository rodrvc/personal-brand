import assert from "node:assert/strict";

import { validateBucketEnv } from "./dev-bucket.mjs";

const tests = [
  [
    "reports every missing setting when the environment is empty",
    () => {
      const missing = validateBucketEnv({});
      assert.deepEqual(missing, ["STORAGE_BACKEND=s3", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
    },
  ],
  [
    "reports STORAGE_BACKEND=fs (or unset) as missing even with bucket vars present",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "fs",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, ["STORAGE_BACKEND=s3"]);
    },
  ],
  [
    "reports blank values as missing, not merely present keys",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "  ",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, ["S3_BUCKET"]);
    },
  ],
  [
    "passes with STORAGE_BACKEND=s3 and the three required vars set; S3_ENDPOINT stays optional",
    () => {
      const missing = validateBucketEnv({
        STORAGE_BACKEND: "s3",
        S3_BUCKET: "brand-profiles",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      assert.deepEqual(missing, []);
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
