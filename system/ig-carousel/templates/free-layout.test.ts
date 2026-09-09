import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../brand-schema.js";
import type { CarouselDocument } from "../carousel-document.js";
import { validateDocument } from "../carousel-document.js";
import { loadLayoutTemplate } from "../layout-template.js";
import { renderFreeLayoutSlide, type FreeLayoutRenderContext } from "./free-layout.js";

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(ENGINE_DIR, "..", "..", "..", "profiles", "example");

const brand = loadBrand(PROFILE_DIR);
const template = loadLayoutTemplate(PROFILE_DIR, "explicativo");

const KNOWN_ASSET = "asset-hero-1";
function assetExists(assetId: string): boolean {
  return assetId === KNOWN_ASSET;
}

const ctx: FreeLayoutRenderContext = {
  assetUrl: (assetId) => `/assets/${assetId}.png`,
};

/** A valid document with a moved object (its own geometry, distinct from the template's slot). */
function buildDoc(overParams?: Record<string, unknown>): CarouselDocument {
  const raw = {
    schemaVersion: 1,
    id: "smoke-test",
    title: "Smoke test carousel",
    status: "draft",
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "Smoke test the free layout renderer", createdAt: "2026-08-17T10:00:00.000Z" },
    template: { id: "explicativo", ...(overParams ? { params: overParams } : {}) },
    slides: [
      {
        id: "slide-1",
        kind: "cover",
        background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
        objects: [
          {
            id: "obj-title",
            kind: "text",
            slot: "title",
            pinned: false,
            locked: false,
            source: "manual",
            text: "We shipped it",
            fontKey: "logo",
            fontSize: 84,
            lineHeight: 1.1,
            align: "left",
            colorKey: "ink",
          },
          // A free object with its own geometry, distinct from any slot's
          // default position — asserts an object's own px position lands
          // literally in the rendered HTML.
          {
            id: "obj-moved",
            kind: "text",
            pinned: false,
            locked: false,
            source: "manual",
            text: "Moved by hand",
            fontKey: "body",
            fontSize: 30,
            lineHeight: 1.2,
            align: "left",
            colorKey: "slate",
            geometry: { x: 321, y: 654, w: 400, rotation: 0 },
          },
        ],
      },
      {
        id: "slide-2",
        kind: "step",
        background: { mode: "asset", assetId: KNOWN_ASSET, pinned: false, source: "library" },
        objects: [
          {
            id: "obj-body",
            kind: "text",
            slot: "body",
            pinned: false,
            locked: false,
            source: "manual",
            text: "Step one",
            fontKey: "body",
            fontSize: 34,
            lineHeight: 1.4,
            align: "left",
            colorKey: "slate",
          },
        ],
      },
      {
        id: "slide-3",
        kind: "closing",
        background: { mode: "color", colorKey: "ink", pinned: false, source: "manual" },
        objects: [
          {
            id: "obj-cta",
            kind: "text",
            slot: "cta",
            pinned: false,
            locked: false,
            source: "manual",
            text: "Thanks for reading",
            fontKey: "body",
            fontSize: 36,
            lineHeight: 1.3,
            align: "left",
            colorKey: "signal",
          },
        ],
      },
    ],
  };

  const result = validateDocument(raw, { brand, assetExists });
  assert.equal(result.valid, true, "test fixture document must validate");
  if (!result.valid) throw new Error("unreachable");
  return result.document;
}

/** Every `#rrggbb`/`#rgb`/`#rrggbbaa` literal appearing in a string. */
function findHexLiterals(html: string): string[] {
  return html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
}

const BRAND_HEX_VALUES = new Set(Object.values(brand.colors).map((hex) => hex.toLowerCase()));

const tests: Array<[string, () => void]> = [
  [
    "every hex literal in rendered HTML is a brand.colors value",
    () => {
      const doc = buildDoc();
      for (let i = 0; i < doc.slides.length; i++) {
        const html = renderFreeLayoutSlide(brand, template, doc, i, ctx);
        for (const hex of findHexLiterals(html)) {
          assert.ok(
            BRAND_HEX_VALUES.has(hex.toLowerCase()),
            `slide ${i}: hex literal "${hex}" is not a brand.colors value`,
          );
        }
      }
    },
  ],

  [
    "footer zone is present on every slide with pagination on every slide (default template: pagination = 'all')",
    () => {
      const doc = buildDoc();
      const html0 = renderFreeLayoutSlide(brand, template, doc, 0, ctx);
      const html1 = renderFreeLayoutSlide(brand, template, doc, 1, ctx);
      const html2 = renderFreeLayoutSlide(brand, template, doc, 2, ctx);

      assert.match(html0, /data-zone="footer"/, "slide 0 (cover) must paint the footer zone");
      assert.match(html1, /data-zone="footer"/, "slide 1 (step) must paint the footer zone");
      assert.match(html2, /data-zone="footer"/, "slide 2 (closing) must paint the footer zone");

      // Default template's pagination = "all": every slide shows "N/total".
      assert.match(html0, /footer-pagination/, "cover slide must show pagination when pagination = 'all'");
      assert.match(html0, />1\/3</, "cover slide must show its own index over the slide count (1/3)");
      assert.match(html1, /footer-pagination/, "step slide must show pagination when pagination = 'all'");
      assert.match(html1, />2\/3</, "step slide must show its own index over the slide count (2/3)");
      assert.match(html2, /footer-pagination/, "closing slide must show pagination when pagination = 'all'");
      assert.match(html2, />3\/3</, "closing slide must show its own index over the slide count (3/3)");
    },
  ],

  [
    "pagination = 'steps' shows pagination only on step slides",
    () => {
      const doc = buildDoc({ zones: { footer: { pagination: "steps" } } });
      const stepsTemplate = loadLayoutTemplate(PROFILE_DIR, "explicativo", doc.template.params);
      const html0 = renderFreeLayoutSlide(brand, stepsTemplate, doc, 0, ctx);
      const html1 = renderFreeLayoutSlide(brand, stepsTemplate, doc, 1, ctx);
      const html2 = renderFreeLayoutSlide(brand, stepsTemplate, doc, 2, ctx);

      assert.doesNotMatch(html0, /footer-pagination/, "cover slide must not show pagination when pagination = 'steps'");
      assert.match(html1, /footer-pagination/, "step slide must show pagination when pagination = 'steps'");
      assert.doesNotMatch(html2, /footer-pagination/, "closing slide must not show pagination when pagination = 'steps'");
    },
  ],

  [
    "pagination = 'none' shows no pagination on any slide",
    () => {
      const doc = buildDoc({ zones: { footer: { pagination: "none" } } });
      const noneTemplate = loadLayoutTemplate(PROFILE_DIR, "explicativo", doc.template.params);
      const html0 = renderFreeLayoutSlide(brand, noneTemplate, doc, 0, ctx);
      const html1 = renderFreeLayoutSlide(brand, noneTemplate, doc, 1, ctx);
      const html2 = renderFreeLayoutSlide(brand, noneTemplate, doc, 2, ctx);

      assert.doesNotMatch(html0, /footer-pagination/, "cover slide must not show pagination when pagination = 'none'");
      assert.doesNotMatch(html1, /footer-pagination/, "step slide must not show pagination when pagination = 'none'");
      assert.doesNotMatch(html2, /footer-pagination/, "closing slide must not show pagination when pagination = 'none'");
    },
  ],

  [
    "document text is HTML-escaped",
    () => {
      const doc = buildDoc();
      const object = doc.slides[0]!.objects[0]!;
      assert.equal(object.kind, "text", "test fixture's first object must be a text object");
      if (object.kind === "text") {
        object.text = '<script>x</script>&"';
      }
      const html = renderFreeLayoutSlide(brand, template, doc, 0, ctx);
      assert.ok(html.includes("&lt;script&gt;"), "escaped text must contain &lt;script&gt;");
      assert.ok(!html.includes("<script>x</script>"), "raw <script> tag must not appear in the rendered HTML");
    },
  ],

  [
    "an object with its own geometry lands at its exact px position",
    () => {
      const doc = buildDoc();
      const html = renderFreeLayoutSlide(brand, template, doc, 0, ctx);
      assert.match(
        html,
        /data-object-id="obj-moved"[^>]*style="[^"]*left: 321px[^"]*top: 654px/,
        "the moved object must render at its own geometry, not a slot default",
      );
    },
  ],

  [
    "template.params.zones.footer.height changes the rendered footer height",
    () => {
      const defaultDoc = buildDoc();
      const shrunkDoc = buildDoc({ zones: { footer: { height: 40 } } });

      const shrunkTemplate = loadLayoutTemplate(PROFILE_DIR, "explicativo", shrunkDoc.template.params);
      assert.equal(shrunkTemplate.zones.footer.height, 40);

      const defaultHtml = renderFreeLayoutSlide(brand, template, defaultDoc, 0, ctx);
      const shrunkHtml = renderFreeLayoutSlide(brand, shrunkTemplate, shrunkDoc, 0, ctx);

      assert.match(defaultHtml, /height: 120px/, "default template footer height must be 120px");
      assert.match(shrunkHtml, /height: 40px/, "params-overridden footer height must be 40px");
      assert.doesNotMatch(shrunkHtml, /height: 120px/, "overridden footer must not still show the default height");
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
