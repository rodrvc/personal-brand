import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadLayoutTemplate, LayoutTemplateError } from "./layout-template.js";

/** A throwaway profile dir with a `templates/<id>.json` override, cleaned up after `fn` runs. */
function withTempProfile<T>(overrides: Record<string, unknown>, fn: (profileDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "layout-template-test-"));
  try {
    const templatesDir = join(dir, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "explicativo.json"), JSON.stringify(overrides), "utf-8");
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tests: Array<[string, () => void]> = [
  [
    "C4: an override with a hex colorRole throws LayoutTemplateError naming the path",
    () => {
      withTempProfile(
        {
          slides: {
            cover: {
              slots: [
                {
                  name: "title",
                  type: "text",
                  geometry: { x: 86, y: 594, w: 908, rotation: 0 },
                  fontKey: "logo",
                  fontSize: 84,
                  lineHeight: 1.1,
                  align: "left",
                  colorRole: "#ff0000",
                },
              ],
            },
          },
        },
        (profileDir) => {
          assert.throws(
            () => loadLayoutTemplate(profileDir, "explicativo"),
            (error: unknown) => {
              assert.ok(error instanceof LayoutTemplateError, "expected a LayoutTemplateError");
              assert.match((error as Error).message, /colorRole/, "message must name the offending field");
              return true;
            },
          );
        },
      );
    },
  ],

  [
    "C4: an override with a hex zones.background.policy throws LayoutTemplateError naming the path",
    () => {
      withTempProfile({ zones: { background: { policy: "#000" } } }, (profileDir) => {
        assert.throws(
          () => loadLayoutTemplate(profileDir, "explicativo"),
          (error: unknown) => {
            assert.ok(error instanceof LayoutTemplateError);
            assert.match((error as Error).message, /zones\.background\.policy|policy/);
            return true;
          },
        );
      });
    },
  ],

  [
    "C10: a profile with templates/explicativo.json = {zones:{footer:{height:140}}} resolves height 140 and keeps everything else",
    () => {
      withTempProfile({ zones: { footer: { height: 140 } } }, (profileDir) => {
        const template = loadLayoutTemplate(profileDir, "explicativo");
        assert.equal(template.zones.footer.height, 140);
        assert.equal(template.zones.footer.logo, "auto");
        assert.equal(template.zones.footer.pagination, true);
        assert.ok(template.slides.cover, "cover slot block preserved");
        assert.ok(template.slides.step, "step slot block preserved");
        assert.ok(template.slides.closing, "closing slot block preserved");
        assert.ok(template.slides.cover!.slots.length > 0);
        assert.ok(template.slides.step!.slots.length > 0);
        assert.ok(template.slides.closing!.slots.length > 0);
      });
    },
  ],

  [
    "C10: zones.footer.logo accepts 'none' so a profile can disable the footer logo",
    () => {
      withTempProfile({ zones: { footer: { logo: "none" } } }, (profileDir) => {
        const template = loadLayoutTemplate(profileDir, "explicativo");
        assert.equal(template.zones.footer.logo, "none");
      });
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
