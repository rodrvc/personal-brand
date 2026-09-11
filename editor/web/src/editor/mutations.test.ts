import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSlide } from "../../../../system/ig-carousel/carousel-document-resolve.js";
import { validateDocument, type CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { loadLayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { addTextObject, clampGeometryToCanvas, resetObjectToSlot, setObjectGeometry } from "./mutations.js";

/**
 * `addTextObject` is the only path in the editor that can put text on a
 * slide (ACU-238) — a silent failure here (bad geometry, an unresolvable
 * slot, a hex literal slipping into colorKey) would mean text that looks
 * fine in the mutation but the renderer/validator rejects or mispositions.
 * Runs against `profiles/example` and the engine's own `explicativo`
 * template, the same fixtures `carousel-document.test.ts` uses, so this
 * stays a real integration check against the engine, not a mock of it.
 */

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(ENGINE_DIR, "..", "..", "..", "..", "profiles", "example");

const brand = loadBrand(PROFILE_DIR);
const template = loadLayoutTemplate(PROFILE_DIR, "explicativo");

function baseDoc(): CarouselDocument {
  return {
    schemaVersion: 1,
    id: "week-1",
    title: "Test carousel",
    status: "draft",
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T10:00:00.000Z",
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "", createdAt: "2026-09-09T10:00:00.000Z" },
    template: { id: "explicativo" },
    slides: [
      {
        id: "slide-cover",
        kind: "cover",
        background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
        objects: [],
      },
    ],
  };
}

// A text object added to an empty slide takes a free template slot: no
// geometry/style of its own, resolves fully from the slot.
{
  const doc = baseDoc();
  const next = addTextObject(doc, "slide-cover", "obj-1", template, brand);
  const result = validateDocument(next, { brand, assetExists: () => true });
  assert.ok(result.valid, `document should validate: ${JSON.stringify("errors" in result ? result.errors : [])}`);

  const object = next.slides[0]!.objects[0];
  assert.ok(object, "object was appended");
  assert.equal(object!.kind, "text");
  assert.ok(object!.slot, "seeded from a template slot");
  assert.equal(object!.geometry, undefined, "no own geometry — inherits the slot's");
  // Template text slots never declare an `h` (explicativo.json), so the
  // renderer leaves `height` off the style and lets it come from content.
  // With `text: ""` that lays out at zero height — invisible and
  // unclickable in the editor. A non-empty placeholder is what keeps a
  // freshly added object visible and selectable the moment it appears.
  assert.ok(
    object!.kind === "text" && object!.text.length > 0,
    "seeded with non-empty placeholder text so it isn't zero-height",
  );

  const resolved = resolveSlide(next, next.slides[0]!, template);
  const resolvedObject = resolved.objects[0]!;
  assert.ok(resolvedObject.geometry.w > 0 && (resolvedObject.geometry.h ?? 0) >= 0, "resolves to real geometry");
  assert.equal(resolvedObject.content.kind, "text");
  if (resolvedObject.content.kind === "text") {
    assert.ok(resolvedObject.content.fontKey, "inherits fontKey from the slot");
    assert.ok(resolvedObject.content.fontSize, "inherits fontSize from the slot");
    assert.ok(resolvedObject.content.colorRole, "inherits colorRole from the slot");
    assert.ok(resolvedObject.content.text.length > 0, "resolved content keeps the placeholder text");
  }
}

// Once every text slot on the slide kind is taken, a further add falls back
// to a free (unslotted) object with an explicit, in-bounds geometry and a
// brand.colors-backed colorKey — never a hex literal.
{
  let doc = baseDoc();
  const coverTextSlots = template.slides.cover!.slots.filter((s) => s.type === "text").map((s) => s.name);
  assert.ok(coverTextSlots.length > 0, "fixture assumption: cover has text slots");
  for (const slotName of coverTextSlots) {
    doc = addTextObject(doc, "slide-cover", `obj-${slotName}`, template, brand);
    // Force this occupant's slot to stick even though addTextObject seeds
    // it plainly — set its slot explicitly so the next call sees it used.
    doc = {
      ...doc,
      slides: doc.slides.map((s) =>
        s.id === "slide-cover"
          ? { ...s, objects: s.objects.map((o) => (o.id === `obj-${slotName}` ? { ...o, slot: slotName } : o)) }
          : s,
      ),
    };
  }

  const next = addTextObject(doc, "slide-cover", "obj-overflow", template, brand);
  const result = validateDocument(next, { brand, assetExists: () => true });
  assert.ok(result.valid, `document should validate: ${JSON.stringify("errors" in result ? result.errors : [])}`);

  const overflow = next.slides[0]!.objects.find((o) => o.id === "obj-overflow")!;
  assert.equal(overflow.slot, undefined, "no free slot left — falls back to a free object");
  assert.ok(overflow.geometry, "free object carries its own geometry");
  assert.ok(overflow.kind === "text" && overflow.colorKey, "free object carries an explicit colorKey");
  assert.ok(overflow.kind === "text" && overflow.colorKey! in brand.colors, "colorKey resolves in brand.colors");

  const g = overflow.geometry!;
  assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= template.canvas.w, "fallback geometry sits inside the canvas");

  const resolved = resolveSlide(next, next.slides[0]!, template);
  const resolvedOverflow = resolved.objects.find((o) => o.id === "obj-overflow")!;
  assert.equal(resolvedOverflow.content.kind, "text");
}

// clampGeometryToCanvas keeps an object's whole box inside the canvas
// (QA: a text object was dragged to geometry.y: -203 with no clamp).
{
  const canvas = { w: 1080, h: 1350 };

  const inside = { x: 100, y: 100, w: 200, h: 100, rotation: 0 };
  assert.deepEqual(clampGeometryToCanvas(inside, canvas), inside, "already inside the canvas is untouched");

  const negative = clampGeometryToCanvas({ x: -50, y: -203, w: 200, h: 100, rotation: 0 }, canvas);
  assert.deepEqual(negative, { x: 0, y: 0, w: 200, h: 100, rotation: 0 }, "negative origin clamps to 0, size untouched");

  const overflow = clampGeometryToCanvas({ x: 1000, y: 1300, w: 200, h: 100, rotation: 0 }, canvas);
  assert.equal(overflow.x + overflow.w, canvas.w, "far edge (x) touches the canvas edge");
  assert.equal((overflow.y ?? 0) + (overflow.h ?? 0), canvas.h, "far edge (y) touches the canvas edge");

  const bigger = clampGeometryToCanvas({ x: 500, y: 500, w: 1500, h: 2000, rotation: 0 }, canvas);
  assert.deepEqual(bigger, { x: 0, y: 0, w: 1500, h: 2000, rotation: 0 }, "larger than canvas pinned at 0, size never shrunk");
}

function docWithObject(object: CarouselDocument["slides"][number]["objects"][number]): CarouselDocument {
  const doc = baseDoc();
  return { ...doc, slides: doc.slides.map((s) => (s.id === "slide-cover" ? { ...s, objects: [object] } : s)) };
}

// setObjectGeometry runs every geometry write through the clamp, not just
// the overlay's drag handler.
{
  const doc = docWithObject({ id: "obj-1", pinned: false, locked: false, source: "manual", kind: "text", text: "hi", geometry: { x: 0, y: 0, w: 100, h: 50, rotation: 0 } });
  const next = setObjectGeometry(doc, "slide-cover", "obj-1", { x: -50, y: -50, w: 100, h: 50, rotation: 0 });
  const object = next.slides[0]!.objects[0]!;
  assert.equal(object.geometry?.x, 0, "setObjectGeometry clamps too");
  assert.equal(object.geometry?.y, 0, "setObjectGeometry clamps too");
}

// resetObjectToSlot (the editor wrapper) delegates to the engine's
// resetObjectToSlot: drops geometry and typographic overrides, keeps text
// and the document-level colorKey pin. The fuller field-dropping rule
// itself is tested once in carousel-document.test.ts.
{
  const doc = docWithObject({
    id: "obj-1", pinned: false, locked: false, source: "manual", kind: "text",
    text: "El texto que escribió el dueño", slot: "headline",
    geometry: { x: 10, y: 20, w: 300, h: 60, rotation: 0 },
    fontSize: 48, colorKey: "onSurface", fontKey: "body", lineHeight: 1.4, align: "center",
  });

  const object = resetObjectToSlot(doc, "slide-cover", "obj-1").slides[0]!.objects[0]!;
  assert.ok(object.kind === "text" && object.text === "El texto que escribió el dueño", "keeps the text");
  assert.equal(object.geometry, undefined, "loses geometry");
  for (const field of ["fontSize", "fontKey", "lineHeight", "align"]) {
    assert.ok(!(field in object), `${field} dropped`);
  }
  assert.ok(object.kind === "text" && object.colorKey === "onSurface", "colorKey is a document-level pin, kept");
  assert.equal(object.slot, "headline", "keeps the slot reference");
}

console.log("mutations: addTextObject seeds from a template slot, then falls back to a free object");
console.log("mutations: clampGeometryToCanvas + setObjectGeometry keep objects on-canvas");
console.log("mutations: resetObjectToSlot drops style overrides but keeps text");
