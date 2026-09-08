import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrandStyle } from "./brand-style.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PROFILE_DIR = join(__dirname, "..", "..", "profiles", "example");

const tests: Array<[string, () => void]> = [
  [
    "profiles/example: finds the fictional sections in brand-spec.md",
    () => {
      const style = loadBrandStyle(EXAMPLE_PROFILE_DIR);
      assert.ok(style.imageDirection && style.imageDirection.length > 0, "imageDirection should be populated");
      assert.ok(style.positioning && style.positioning.length > 0, "positioning should be populated");
      assert.ok(style.logoRules && style.logoRules.length > 0, "logoRules should be populated");
      assert.ok(style.styleKeywords.length > 0, "styleKeywords should be non-empty");
      assert.ok(style.sources.includes("brand-spec.md"), "sources should include brand-spec.md");
    },
  ],

  [
    "profiles/example: reads tone.style/tone.avoid from config.yaml",
    () => {
      const style = loadBrandStyle(EXAMPLE_PROFILE_DIR);
      assert.deepEqual(style.tone.style, ["directo", "claro"]);
      assert.deepEqual(style.tone.avoid, ["frases-vacias", "humo"]);
      assert.ok(style.sources.includes("config.yaml"));
    },
  ],

  [
    "profiles/example: palette comes from brand.json, with role mapped where declared",
    () => {
      const style = loadBrandStyle(EXAMPLE_PROFILE_DIR);
      assert.ok(style.palette.length > 0, "palette should be non-empty");
      const sky = style.palette.find((p) => p.key === "sky");
      assert.equal(sky?.hex, "#4361ee");
      assert.equal(sky?.role, "flourish");
      assert.ok(style.sources.includes("brand.json"));
    },
  ],

  [
    "a profile dir with none of the style files never throws, and returns an all-empty style",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "brand-style-test-"));
      try {
        const style = loadBrandStyle(dir);
        assert.deepEqual(style.palette, []);
        assert.deepEqual(style.styleKeywords, []);
        assert.deepEqual(style.tone, { style: [], avoid: [] });
        assert.equal(style.positioning, undefined);
        assert.equal(style.imageDirection, undefined);
        assert.equal(style.logoRules, undefined);
        assert.deepEqual(style.sources, []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split("\n")[0]}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
