import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "./brand-schema.js";
import { changeSlideKind, changeTemplate, resetObjectToSlot, resolveSlide } from "./carousel-document-resolve.js";
import type { CarouselDocument } from "./carousel-document.js";
import { validateDocument } from "./carousel-document.js";
import { freeLayoutTemplate, loadLayoutTemplate } from "./layout-template.js";

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(ENGINE_DIR, "..", "..", "profiles", "example");

const brand = loadBrand(PROFILE_DIR);
const template = loadLayoutTemplate(PROFILE_DIR, "explicativo");

const KNOWN_ASSET = "asset-hero-1";
function assetExists(assetId: string): boolean {
  return assetId === KNOWN_ASSET;
}

/** A minimal, valid document built against `profiles/example`. */
function validDoc(over: Partial<CarouselDocument> = {}): CarouselDocument {
  return {
    schemaVersion: 1,
    id: "week-34-launch",
    title: "Launch week",
    status: "draft",
    createdAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:00:00.000Z",
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "Explain the launch in 3 steps", createdAt: "2026-08-17T10:00:00.000Z" },
    template: { id: "explicativo" },
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
    ],
    ...over,
  };
}

const tests: Array<[string, () => void]> = [
  [
    "accepts a valid document built against profiles/example",
    () => {
      const result = validateDocument(validDoc(), { brand, assetExists });
      assert.equal(result.valid, true);
    },
  ],
  [
    "rejects an unknown colorKey, naming the exact field path",
    () => {
      const doc = validDoc();
      doc.slides[0]!.objects[0] = { ...(doc.slides[0]!.objects[0] as any), colorKey: "coral" };
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(
        result.errors.some((error) => error.path === "slides[0].objects[0].colorKey"),
        `expected an error at slides[0].objects[0].colorKey, got: ${JSON.stringify(result.errors)}`,
      );
    },
  ],
  [
    "rejects a background colorKey that doesn't exist in brand.colors",
    () => {
      const doc = validDoc();
      doc.slides[0]!.background = { mode: "color", colorKey: "coral", pinned: false, source: "manual" };
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(result.errors.some((error) => error.path === "slides[0].background.colorKey"));
    },
  ],
  [
    "rejects a missing assetId, naming the exact field path",
    () => {
      const doc = validDoc();
      doc.slides[1]!.background = { mode: "asset", assetId: "does-not-exist", pinned: false, source: "library" };
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(
        result.errors.some((error) => error.path === "slides[1].background.assetId"),
        `expected an error at slides[1].background.assetId, got: ${JSON.stringify(result.errors)}`,
      );
    },
  ],
  [
    "rejects a missing assetId on an asset object",
    () => {
      const doc = validDoc({
        slides: [
          {
            id: "slide-1",
            kind: "step",
            background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
            objects: [
              {
                id: "obj-media",
                kind: "asset",
                slot: "media",
                pinned: false,
                locked: false,
                source: "library",
                assetId: "ghost-asset",
                fit: "cover",
              },
            ],
          },
        ],
      });
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(result.errors.some((error) => error.path === "slides[0].objects[0].assetId"));
    },
  ],
  [
    "rejects an unknown fontKey",
    () => {
      const doc = validDoc();
      doc.slides[0]!.objects[0] = { ...(doc.slides[0]!.objects[0] as any), fontKey: "display" };
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(result.errors.some((error) => error.path === "slides[0].objects[0].fontKey"));
    },
  ],
  [
    "rejects a hex literal slipped into any string field, not just a color field",
    () => {
      const doc = validDoc();
      doc.title = "Launch #ff0000 week";
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
      if (result.valid) return;
      assert.ok(result.errors.some((error) => error.path === "title"));
    },
  ],
  [
    "rejects a non-slug id",
    () => {
      const doc = validDoc({ id: "Week 34!" });
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
    },
  ],
  [
    "a document with no template key validates: absence means no template",
    () => {
      const raw = validDoc() as any;
      delete raw.template;
      const result = validateDocument(raw, { brand, assetExists });
      assert.equal(result.valid, true);
      if (!result.valid) return;
      assert.equal(result.document.template, undefined);
    },
  ],
  [
    "rejects template: null — absence, not null, is what means no template",
    () => {
      const doc = validDoc({ template: null as any });
      const result = validateDocument(doc, { brand, assetExists });
      assert.equal(result.valid, false);
    },
  ],
  [
    "a document with a template key still validates",
    () => {
      const result = validateDocument(validDoc(), { brand, assetExists });
      assert.equal(result.valid, true);
      if (!result.valid) return;
      assert.deepEqual(result.document.template, { id: "explicativo" });
    },
  ],

  // --- resolveSlide / resetObjectToSlot / changeSlideKind ---

  [
    "resolveSlide: an object with slot and no own geometry inherits the slot's geometry",
    () => {
      const doc = validDoc();
      const resolved = resolveSlide(doc, doc.slides[0]!, template);
      const titleSlot = template.slides.cover!.slots.find((slot) => slot.name === "title")!;
      assert.deepEqual(resolved.objects[0]!.geometry, titleSlot.geometry);
    },
  ],
  [
    "resolveSlide: an object's own geometry overrides the slot's",
    () => {
      const doc = validDoc();
      (doc.slides[0]!.objects[0] as any).geometry = { x: 10, y: 20, w: 300, rotation: 0 };
      const resolved = resolveSlide(doc, doc.slides[0]!, template);
      assert.deepEqual(resolved.objects[0]!.geometry, { x: 10, y: 20, w: 300, rotation: 0 });
    },
  ],
  [
    "margin change moves untouched slides and not the overridden one (D4 cover behaviour)",
    () => {
      const doc = validDoc();
      // Slide 1's title object has no own geometry -> inherits the slot, i.e. moves with the template.
      // Slide 2's body object gets an explicit override -> must stay put across a template change.
      const overriddenGeometry = { x: 500, y: 500, w: 200, rotation: 0 };
      (doc.slides[1]!.objects[0] as any).geometry = overriddenGeometry;

      const before = resolveSlide(doc, doc.slides[0]!, template);

      const movedTemplate: typeof template = {
        ...template,
        zones: { ...template.zones, margins: { ...template.zones.margins, left: 200 } },
        slides: {
          ...template.slides,
          cover: {
            slots: template.slides.cover!.slots.map((slot) =>
              slot.name === "title" ? { ...slot, geometry: { ...slot.geometry, x: 200 } } : slot,
            ),
          },
        },
      };

      const after = resolveSlide(doc, doc.slides[0]!, movedTemplate);
      assert.notEqual(after.objects[0]!.geometry.x, before.objects[0]!.geometry.x);
      assert.equal(after.objects[0]!.geometry.x, 200);

      const overriddenAfter = resolveSlide(doc, doc.slides[1]!, movedTemplate);
      assert.deepEqual(overriddenAfter.objects[0]!.geometry, overriddenGeometry);
    },
  ],
  [
    "C3: changing a slot's fontSize in the template moves untouched objects and not one with its own fontSize",
    () => {
      const doc = validDoc();
      // Slide 1's title drops its own fontSize -> must inherit the slot's.
      // Slide 2's body keeps its own fontSize (34, from validDoc) -> must stay put.
      delete (doc.slides[0]!.objects[0] as any).fontSize;

      const before = resolveSlide(doc, doc.slides[0]!, template);
      assert.equal(before.objects[0]!.content.kind === "text" ? before.objects[0]!.content.fontSize : undefined, 84);

      const resizedTemplate: typeof template = {
        ...template,
        slides: {
          ...template.slides,
          cover: {
            slots: template.slides.cover!.slots.map((slot) =>
              slot.name === "title" ? { ...slot, fontSize: 120 } : slot,
            ),
          },
        },
      };

      const after = resolveSlide(doc, doc.slides[0]!, resizedTemplate);
      const afterContent = after.objects[0]!.content;
      assert.equal(afterContent.kind === "text" ? afterContent.fontSize : undefined, 120);

      const stillOwnSize = resolveSlide(doc, doc.slides[1]!, resizedTemplate);
      const bodyContent = stillOwnSize.objects[0]!.content;
      assert.equal(bodyContent.kind === "text" ? bodyContent.fontSize : undefined, 34, "object with its own fontSize is unaffected by the template resize");
    },
  ],
  [
    "resetObjectToSlot: drops the own geometry override, restoring slot inheritance",
    () => {
      const doc = validDoc();
      (doc.slides[0]!.objects[0] as any).geometry = { x: 10, y: 20, w: 300, rotation: 0 };
      const reset = resetObjectToSlot(doc.slides[0]!.objects[0]!);
      assert.equal((reset as any).geometry, undefined);
      assert.equal(reset.slot, "title");
    },
  ],
  [
    "resetObjectToSlot: refuses to reset a free object with no slot",
    () => {
      const doc = validDoc();
      const free = { ...doc.slides[0]!.objects[0]!, slot: undefined };
      assert.throws(() => resetObjectToSlot(free), /has no slot/);
    },
  ],
  [
    "changeSlideKind: a slot present in both kinds keeps its text and takes the new kind's geometry",
    () => {
      const doc = validDoc();
      const stepSlide = doc.slides[1]!; // has slot "body", present under step only in this layout
      // "step" and "closing" both lack a shared slot in the fixture layout except free text —
      // use cover -> step instead, which share no slot name either; assert via a slot both kinds share.
      // The fixture layout's cover/step/closing share no slot names, so simulate a shared-slot case directly.
      const sharedTemplate = {
        ...template,
        slides: {
          ...template.slides,
          closing: {
            slots: [...template.slides.closing!.slots, template.slides.step!.slots.find((s) => s.name === "body")!],
          },
        },
      };
      const changed = changeSlideKind(stepSlide, "closing", sharedTemplate as any);
      assert.equal(changed.kind, "closing");
      const bodyObject = changed.objects.find((object) => object.slot === "body");
      assert.ok(bodyObject, "expected the body-slotted object to survive the kind change");
      assert.equal((bodyObject as any).text, "Step one");
      assert.equal((bodyObject as any).geometry, undefined); // dropped, so it takes the new kind's slot geometry
    },
  ],
  [
    "changeSlideKind: a slot absent from the new kind becomes a free object with frozen geometry",
    () => {
      const doc = validDoc();
      const stepSlide = doc.slides[1]!; // slot "body" does not exist under "closing" in the default layout
      const changed = changeSlideKind(stepSlide, "closing", template);
      const freed = changed.objects.find((object) => object.id === "obj-body")!;
      assert.equal(freed.slot, undefined);
      assert.ok((freed as any).geometry, "expected the freed object to carry a frozen geometry");
    },
  ],
  [
    "changeSlideKind: same kind is a no-op",
    () => {
      const doc = validDoc();
      const unchanged = changeSlideKind(doc.slides[0]!, "cover", template);
      assert.equal(unchanged, doc.slides[0]);
    },
  ],

  // --- changeTemplate ---

  [
    "changeTemplate: a shared slot keeps its content and its slot, but loses its own geometry",
    () => {
      // "title" exists under kind "cover" in both templates — a shared slot.
      const doc = validDoc();
      const retargeted = {
        ...template,
        id: "retargeted",
        slides: {
          ...template.slides,
          cover: {
            slots: template.slides.cover!.slots.map((slot) =>
              slot.name === "title" ? { ...slot, geometry: { ...slot.geometry, x: 12 } } : slot,
            ),
          },
        },
      };
      const changed = changeTemplate(doc, template, retargeted as any);
      const title = changed.slides[0]!.objects.find((object) => object.id === "obj-title")!;
      assert.equal(title.slot, "title");
      assert.equal((title as any).text, "We shipped it");
      assert.equal((title as any).geometry, undefined);
    },
  ],
  [
    "changeTemplate: a slot absent from the target loses its slot and gains the frozen old geometry",
    () => {
      // "body" exists under "step" in the default template, not in target.
      const doc = validDoc();
      const target = { ...template, id: "no-body", slides: { ...template.slides, step: { slots: [] } } };
      const changed = changeTemplate(doc, template, target as any);
      const body = changed.slides[1]!.objects.find((object) => object.id === "obj-body")!;
      assert.equal(body.slot, undefined);
      const originalSlot = template.slides.step!.slots.find((slot) => slot.name === "body")!;
      assert.deepEqual((body as any).geometry, originalSlot.geometry);
    },
  ],
  [
    "changeTemplate: a free object (no slot) is untouched",
    () => {
      const doc = validDoc();
      const freeGeometry = { x: 321, y: 654, w: 400, rotation: 0 };
      (doc.slides[0]!.objects as any[]).push({
        id: "obj-free", kind: "text", pinned: false, locked: false, source: "manual",
        text: "Free", fontKey: "body", fontSize: 20, lineHeight: 1.2, align: "left",
        colorKey: "slate", geometry: freeGeometry,
      });
      const target = { ...template, id: "other", slides: { cover: { slots: [] }, step: { slots: [] }, closing: { slots: [] } } };
      const changed = changeTemplate(doc, template, target as any);
      const free = changed.slides[0]!.objects.find((object) => object.id === "obj-free")!;
      assert.deepEqual((free as any).geometry, freeGeometry);
      assert.equal(free.slot, undefined);
    },
  ],
  [
    "changeTemplate: swapping to freeLayoutTemplate() demotes everything, freezing each origin slot's geometry",
    () => {
      const doc = validDoc();
      const free = freeLayoutTemplate();
      const changed = changeTemplate(doc, template, free);
      assert.equal(changed.template, undefined, "swapping to the free template clears doc.template");
      changed.slides.forEach((slide, slideIndex) => {
        const originSlide = doc.slides[slideIndex]!;
        slide.objects.forEach((object, objectIndex) => {
          assert.equal(object.slot, undefined, `object "${object.id}" must be demoted to a free object`);
          const originObject = originSlide.objects[objectIndex]!;
          const originSlot = originObject.slot
            ? template.slides[originSlide.kind]!.slots.find((slot) => slot.name === originObject.slot)
            : undefined;
          if (originSlot) {
            assert.deepEqual((object as any).geometry, originSlot.geometry, `object "${object.id}" must freeze the origin slot's geometry`);
          }
        });
        assert.doesNotThrow(() => resolveSlide(changed, slide, free));
      });
    },
  ],
  [
    "changeTemplate: swapping FROM freeLayoutTemplate() leaves objects unchanged (nothing was ever slotted)",
    () => {
      const doc = validDoc();
      const free = freeLayoutTemplate();
      const freed = changeTemplate(doc, template, free);
      const backToTemplate = changeTemplate(freed, free, template);
      for (const slide of backToTemplate.slides) {
        for (const object of slide.objects) {
          assert.equal(object.slot, undefined, `object "${object.id}" has no slot in the free document and cannot regain one`);
        }
      }
    },
  ],
  [
    "changeTemplate: drops template.params on swap and bumps updatedAt",
    () => {
      const doc = validDoc({ template: { id: "explicativo", params: { zones: { footer: { height: 40 } } } } });
      const otherTemplate = { ...template, id: "other" };
      const changed = changeTemplate(doc, template, otherTemplate as any);
      assert.deepEqual(changed.template, { id: "other" });
      assert.notEqual(changed.updatedAt, doc.updatedAt);
    },
  ],
  [
    "changeTemplate then changeSlideKind compose exactly like remapObjects's rule applied twice by hand",
    () => {
      const doc = validDoc();
      const coverSlide = doc.slides[0]!; // kind "cover", obj-title slotted to "title"

      // "target" keeps "title" under "cover" (retargeted geometry) but not
      // under "closing" — whichever step lands on "closing" under "target"
      // must demote the object there.
      const target = {
        ...template,
        id: "target",
        slides: {
          ...template.slides,
          cover: {
            slots: template.slides.cover!.slots.map((slot) =>
              slot.name === "title" ? { ...slot, geometry: { ...slot.geometry, x: 500 } } : slot,
            ),
          },
          closing: { slots: template.slides.closing!.slots.filter((slot) => slot.name !== "title") },
        },
      };
      const targetCoverSlot = target.slides.cover.slots.find((s) => s.name === "title")!;
      const templateClosingSlot = template.slides.closing!.slots.find((s) => s.name === "title")!;

      // Order A: changeTemplate (cover -> cover, slot kept) then
      // changeSlideKind (cover -> closing under target, slot dropped) —
      // demotes at step 2, freezing target's own cover geometry.
      const afterTemplateA = changeTemplate(doc, template, target as any);
      const slideA = changeSlideKind(afterTemplateA.slides[0]!, "closing", target as any);
      const objA = slideA.objects.find((o) => o.id === "obj-title")!;
      assert.equal(objA.slot, undefined);
      assert.deepEqual((objA as any).geometry, targetCoverSlot.geometry);

      // Order B: changeSlideKind (cover -> closing under the ORIGINAL
      // template, which still declares "title" for both kinds — slot
      // survives) then changeTemplate (closing -> closing under target,
      // slot dropped) — demotes at step 2 instead, freezing the ORIGINAL
      // template's closing geometry. Same rule, different step, different
      // frozen value — by construction, not a bug: "which template is in
      // force when the slot disappears" differs between the two orders.
      const slideB0 = changeSlideKind(coverSlide, "closing", template);
      assert.equal(slideB0.objects[0]!.slot, "title");
      const afterKindB = { ...doc, slides: [slideB0, ...doc.slides.slice(1)] };
      const afterTemplateB = changeTemplate(afterKindB, template, target as any);
      const objB = afterTemplateB.slides[0]!.objects.find((o) => o.id === "obj-title")!;
      assert.equal(objB.slot, undefined);
      assert.deepEqual((objB as any).geometry, templateClosingSlot.geometry, "frozen from the ORIGINAL template's closing slot, the last one it resolved against");
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
