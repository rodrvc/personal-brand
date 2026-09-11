import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "./brand-schema.js";
import { FREE_TEMPLATE_ID, freeLayoutTemplate, listLayoutTemplates, loadLayoutTemplate, LayoutTemplateError } from "./layout-template.js";

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PROFILE_DIR = join(ENGINE_DIR, "..", "..", "profiles", "example");
const exampleBrand = loadBrand(EXAMPLE_PROFILE_DIR);

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

/**
 * A throwaway profile dir carrying templates under arbitrary ids, so a test
 * can declare an id the engine has NO default for — which is what
 * `listLayoutTemplates` already lists and `loadLayoutTemplate` has to be
 * able to load.
 */
function withTempProfileTemplates<T>(templates: Record<string, unknown>, fn: (profileDir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "layout-template-test-standalone-"));
  try {
    const templatesDir = join(dir, "templates");
    mkdirSync(templatesDir, { recursive: true });
    for (const [id, body] of Object.entries(templates)) {
      writeFileSync(join(templatesDir, `${id}.json`), JSON.stringify(body), "utf-8");
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The engine's own `explicativo` as a plain object, restamped with `id` —
 * a known-valid full template to reuse as the body of a brand-only id. A
 * template declares its own `id` in the file (the loader reads it from the
 * body, not from the filename), so a fixture that forgets to restamp it
 * would be testing the wrong id.
 */
function engineDefaultBody(id: string): Record<string, unknown> {
  const body = JSON.parse(readFileSync(join(ENGINE_DIR, "layouts", "explicativo.json"), "utf-8")) as Record<string, unknown>;
  return { ...body, id };
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
            () => loadLayoutTemplate(profileDir, "explicativo", exampleBrand),
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
          () => loadLayoutTemplate(profileDir, "explicativo", exampleBrand),
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
        const template = loadLayoutTemplate(profileDir, "explicativo", exampleBrand);
        assert.equal(template.zones.footer.height, 140);
        assert.equal(template.zones.footer.logo, "auto");
        assert.equal(template.zones.footer.pagination, "all");
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
        const template = loadLayoutTemplate(profileDir, "explicativo", exampleBrand);
        assert.equal(template.zones.footer.logo, "none");
      });
    },
  ],

  [
    "listLayoutTemplates: a brand override with the same id as an engine default replaces it, not adds a second entry",
    () => {
      withTempProfile({ zones: { footer: { height: 140 } } }, (profileDir) => {
        const templates = listLayoutTemplates(profileDir);
        const explicativoEntries = templates.filter((t) => t.id === "explicativo");
        assert.equal(explicativoEntries.length, 1, "override must replace the default, not duplicate it");
        assert.equal(explicativoEntries[0]!.origin, "brand-override");
        assert.equal(explicativoEntries[0]!.displayName, "Explicativo");
      });
    },
  ],

  [
    "freeLayoutTemplate() parses against the layout template schema",
    () => {
      // No schema is exported directly: round-trip the shape through
      // loadLayoutTemplate's own validation by writing it as a full
      // override of "explicativo" — it supplies every top-level key, so the
      // deep merge replaces the default wholesale and the validated result
      // equals the free template itself; a schema violation would throw.
      const free = freeLayoutTemplate();
      withTempProfile(free, (profileDir) => {
        const resolved = loadLayoutTemplate(profileDir, "explicativo", exampleBrand);
        assert.equal(resolved.id, free.id);
        assert.deepEqual(resolved.zones, free.zones);
        assert.deepEqual(resolved.slides, free.slides);
      });
    },
  ],
  [
    "listLayoutTemplates: with no override, the engine default is listed with origin engine-default",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "layout-template-test-no-override-"));
      try {
        const templates = listLayoutTemplates(dir);
        const explicativo = templates.find((t) => t.id === "explicativo");
        assert.ok(explicativo, "engine default must be listed even with no profile override");
        assert.equal(explicativo!.origin, "engine-default");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ],

  [
    "3.2: a signature with a copyKey the brand does not define fails naming the path",
    () => {
      withTempProfile(
        {
          zones: {
            footer: {
              signature: { copyKey: "notACopyKey", fontKey: "body", colorRole: "onSurfaceMuted", align: "right" },
            },
          },
        },
        (profileDir) => {
          assert.throws(
            () => loadLayoutTemplate(profileDir, "explicativo", exampleBrand),
            (error: unknown) => {
              assert.ok(error instanceof LayoutTemplateError, "expected a LayoutTemplateError");
              assert.match(
                (error as Error).message,
                /zones\.footer\.signature\.copyKey → brand\.copy\.notACopyKey/,
                "message must name the missing key's path",
              );
              return true;
            },
          );
        },
      );
    },
  ],

  [
    "3.2: a signature with a fontKey the brand does not define fails naming the path",
    () => {
      withTempProfile(
        {
          zones: {
            footer: {
              signature: { copyKey: "wordmark", fontKey: "notAFontKey", colorRole: "onSurfaceMuted", align: "right" },
            },
          },
        },
        (profileDir) => {
          assert.throws(
            () => loadLayoutTemplate(profileDir, "explicativo", exampleBrand),
            (error: unknown) => {
              assert.ok(error instanceof LayoutTemplateError, "expected a LayoutTemplateError");
              assert.match(
                (error as Error).message,
                /zones\.footer\.signature\.fontKey → brand\.fonts\.notAFontKey/,
                "message must name the missing key's path",
              );
              return true;
            },
          );
        },
      );
    },
  ],

  [
    "3.2: a signature with a colorRole the brand does not define fails naming the path",
    () => {
      withTempProfile(
        {
          zones: {
            footer: {
              signature: { copyKey: "wordmark", fontKey: "body", colorRole: "notARole", align: "right" },
            },
          },
        },
        (profileDir) => {
          assert.throws(
            () => loadLayoutTemplate(profileDir, "explicativo", exampleBrand),
            (error: unknown) => {
              assert.ok(error instanceof LayoutTemplateError, "expected a LayoutTemplateError");
              assert.match(
                (error as Error).message,
                /zones\.footer\.signature\.colorRole → brand\.roles\.notARole/,
                "message must name the missing key's path",
              );
              return true;
            },
          );
        },
      );
    },
  ],

  [
    "3.2: a signature whose keys the brand DOES define resolves without throwing",
    () => {
      withTempProfile(
        {
          zones: {
            footer: {
              signature: { copyKey: "wordmark", fontKey: "body", colorRole: "onSurfaceMuted", align: "right" },
            },
          },
        },
        (profileDir) => {
          const template = loadLayoutTemplate(profileDir, "explicativo", exampleBrand);
          assert.equal(template.zones.footer.signature?.copyKey, "wordmark");
        },
      );
    },
  ],

  [
    "listLayoutTemplates: never returns the free template's sentinel id, with or without a profile override",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "layout-template-test-no-free-"));
      try {
        const withoutOverride = listLayoutTemplates(dir);
        assert.ok(
          withoutOverride.every((t) => t.id !== FREE_TEMPLATE_ID),
          "listLayoutTemplates must never list the free template's sentinel id",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      withTempProfile({ zones: { footer: { height: 140 } } }, (profileDir) => {
        const withOverride = listLayoutTemplates(profileDir);
        assert.ok(
          withOverride.every((t) => t.id !== FREE_TEMPLATE_ID),
          "listLayoutTemplates must never list the free template's sentinel id, even with a profile override present",
        );
      });
    },
  ],
  [
    "a brand-only template (no engine default for the id) loads standalone",
    () => {
      // `listLayoutTemplates` lists ids a brand declares on its own, so
      // refusing to load them made every one of them a dead entry in the
      // picker: listed, then a raw error the moment it was selected.
      withTempProfileTemplates({ "brand-only": engineDefaultBody("brand-only") }, (profileDir) => {
        const template = loadLayoutTemplate(profileDir, "brand-only", exampleBrand);
        assert.equal(template.id, "brand-only", "the standalone override is the whole template");
        assert.ok(template.slides.cover.slots.length > 0, "its slots come through, with nothing to merge onto");
      });
    },
  ],

  [
    "a brand-only template is still schema-checked and brand-cross-checked, not waved through",
    () => {
      // Standing alone must buy no leniency: the same schema and the same
      // brand cross-validation apply as to a merged template.
      withTempProfileTemplates({ "brand-only-broken": { ...engineDefaultBody("brand-only-broken"), canvas: { w: "wide" } } }, (profileDir) => {
        assert.throws(
          () => loadLayoutTemplate(profileDir, "brand-only-broken", exampleBrand),
          (error: unknown) => error instanceof LayoutTemplateError && /canvas/.test((error as Error).message),
          "a malformed standalone override fails naming the offending path",
        );
      });

      const withBadSignature = engineDefaultBody("brand-only-signature");
      (withBadSignature.zones as Record<string, any>).footer.signature = {
        copyKey: "no-such-copy-key",
        fontKey: "body",
        colorRole: "onSurface",
      };
      withTempProfileTemplates({ "brand-only-signature": withBadSignature }, (profileDir) => {
        assert.throws(
          () => loadLayoutTemplate(profileDir, "brand-only-signature", exampleBrand),
          LayoutTemplateError,
          "a standalone override is cross-validated against the brand like any other",
        );
      });
    },
  ],

  [
    "an id backed by neither an engine default nor a profile override still fails, naming it",
    () => {
      withTempProfileTemplates({ "brand-only": engineDefaultBody("brand-only") }, (profileDir) => {
        assert.throws(
          () => loadLayoutTemplate(profileDir, "no-such-template", exampleBrand),
          (error: unknown) =>
            error instanceof LayoutTemplateError && /no-such-template/.test((error as Error).message),
          "a genuinely missing id is still an error, and says which id",
        );
      });
    },
  ],

  [
    "listing and loading agree: every id listLayoutTemplates returns is loadable",
    () => {
      // The invariant the blocker broke. Asserted over the whole listing
      // rather than over a hardcoded id, so a future template of either
      // origin is covered without editing this test.
      withTempProfileTemplates(
        { "brand-only": engineDefaultBody("brand-only"), "brand-only-two": engineDefaultBody("brand-only-two") },
        (profileDir) => {
          const listed = listLayoutTemplates(profileDir);
          assert.ok(listed.length >= 3, "engine default plus both brand-only ids are listed");
          for (const entry of listed) {
            const template = loadLayoutTemplate(profileDir, entry.id, exampleBrand);
            assert.equal(template.id, entry.id, `listed template "${entry.id}" must load`);
          }
        },
      );
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