import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOutputBaseDir, resolveProfileDir, resolveProfilesRoot } from "./profile.js";

const root = mkdtempSync(join(tmpdir(), "profile-ts-test-"));
const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, "config.yaml"), `outputs:\n  base_dir: "outputs"\n`);

const tests: Array<[string, () => void]> = [
  [
    "with no BRAND_OUTPUTS_ROOT, resolves base_dir under the profile dir as before",
    () => {
      delete process.env.BRAND_OUTPUTS_ROOT;
      assert.equal(resolveOutputBaseDir(profileDir), join(profileDir, "outputs"));
    },
  ],
  [
    "BRAND_OUTPUTS_ROOT overrides config.yaml's base_dir entirely",
    () => {
      const mirrorOutputs = mkdtempSync(join(tmpdir(), "mirror-outputs-"));
      process.env.BRAND_OUTPUTS_ROOT = mirrorOutputs;
      try {
        assert.equal(resolveOutputBaseDir(profileDir), join(mirrorOutputs, SLUG));
      } finally {
        delete process.env.BRAND_OUTPUTS_ROOT;
        rmSync(mirrorOutputs, { recursive: true, force: true });
      }
    },
  ],
  [
    "BRAND_PROFILES_DIR still governs resolveProfilesRoot/resolveProfileDir unchanged",
    () => {
      process.env.BRAND_PROFILES_DIR = root;
      try {
        assert.equal(resolveProfilesRoot(), root);
        assert.equal(resolveProfileDir(SLUG), profileDir);
      } finally {
        delete process.env.BRAND_PROFILES_DIR;
      }
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

rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
