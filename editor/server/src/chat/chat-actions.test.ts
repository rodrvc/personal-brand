import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { loadLayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { applyAction, resolveAction, type ActionContext, type ModelAction } from "./chat-actions.js";
import { pendingProposal, type ChatRecord } from "./chat-log.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);
const ASSET = "0123456789abcdef";
const now = "2026-01-01T00:00:00.000Z";

const doc = {
  schemaVersion: 1,
  id: "chat-carousel",
  title: "Chat test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  canvas: { w: 1080, h: 1350 },
  prompt: { text: "", createdAt: now, runs: [] },
  template: { id: "explicativo" },
  slides: (["cover", "step", "step", "closing"] as const).map((kind, i) => ({
    id: `slide-${i + 1}`,
    kind,
    background: { mode: "color" as const, colorKey: "paper", pinned: i === 0, source: "manual" as const },
    objects: [
      { id: `title-${i + 1}`, kind: "text" as const, slot: "title", pinned: i === 1, locked: false, source: "ai" as const, text: `Approved ${i + 1}` },
    ],
  })),
} satisfies CarouselDocument;

const ctx: ActionContext = {
  doc,
  brand,
  template: loadLayoutTemplate(EXAMPLE, "explicativo", brand),
  library: [{ id: ASSET, name: "beach.png", kind: "background", tags: ["sky"], w: 1080, h: 1350 }],
};

const swapBackground: ModelAction = { type: "set_visual_from_library", slideId: "slide-3", slot: "background", assetId: ASSET, why: "" };

function apply(action: ModelAction): CarouselDocument {
  return applyAction(ctx, resolveAction(ctx, action)).document;
}

const tests: Array<[string, () => void]> = [
  [
    "a visual swap on one slide leaves every other slide, and the rest of that slide, identical",
    () => {
      const after = apply(swapBackground);
      const expected = structuredClone(doc) as CarouselDocument;
      expected.slides[2]!.background = { mode: "asset", assetId: ASSET, pinned: false, source: "library" };
      assert.deepEqual({ ...after, updatedAt: now }, expected);
    },
  ],
  [
    "a text edit changes that object's text and nothing else",
    () => {
      const after = apply({ type: "set_text", slideId: "slide-3", objectId: "title-3", text: "Fixed", why: "" });
      const expected = structuredClone(doc) as CarouselDocument;
      (expected.slides[2]!.objects[0] as { text: string }).text = "Fixed";
      assert.deepEqual({ ...after, updatedAt: now }, expected);
    },
  ],
  [
    "each action declares where its parts come from",
    () => {
      assert.deepEqual(resolveAction(ctx, swapBackground).provenance, [
        { source: "document", detail: "3 · background" },
        { source: "library", detail: "beach.png · sky" },
      ]);
      assert.deepEqual(
        resolveAction(ctx, { type: "generate_visual", slideId: "slide-3", slot: "background", prompt: "a beach", kind: "background", why: "" })
          .provenance.map((p) => p.source),
        ["document", "generation"],
      );
      assert.deepEqual(
        resolveAction(ctx, { type: "generate_visual", slideId: "slide-3", prompt: "a chair", kind: "decoration", why: "" }).provenance[0],
        { source: "free", detail: "3" },
      );
      assert.deepEqual(resolveAction(ctx, { type: "set_text", slideId: "slide-3", slot: "title", text: "Hi", why: "" }).provenance, [
        { source: "document", detail: "3 · title" },
        { source: "request", detail: "Hi" },
      ]);
      assert.deepEqual(
        resolveAction(ctx, { type: "add_slide", afterIndex: 1, kind: "step", why: "" }).provenance.map((p) => p.source),
        ["template", "brand"],
      );
    },
  ],
  [
    "delete_object removes only the named object, pinned or not, and refuses a locked one",
    () => {
      const after = apply({ type: "delete_object", slideId: "slide-3", objectId: "title-3", why: "" });
      const expected = structuredClone(doc) as CarouselDocument;
      expected.slides[2]!.objects = [];
      assert.deepEqual({ ...after, updatedAt: now }, expected);
      assert.deepEqual(resolveAction(ctx, { type: "delete_object", slideId: "slide-3", slot: "title", why: "" }).provenance, [
        { source: "document", detail: "3 · title · text" },
      ]);
      const pinnedGone = apply({ type: "delete_object", slideId: "slide-2", objectId: "title-2", why: "" });
      assert.deepEqual(pinnedGone.slides[1]!.objects, [], "a pinned object is deleted when the owner asks");
      const locked = { ...ctx, doc: structuredClone(doc) as CarouselDocument };
      locked.doc.slides[2]!.objects[0]!.locked = true;
      assert.throws(() => resolveAction(locked, { type: "delete_object", slideId: "slide-3", objectId: "title-3", why: "" }), /bloqueado/);
      assert.throws(() => resolveAction(ctx, { type: "delete_object", slideId: "slide-3", objectId: "nope", why: "" }), /no tiene/);
    },
  ],
  [
    "pinned pieces and assets outside the approved library are refused",
    () => {
      assert.throws(() => resolveAction(ctx, { ...swapBackground, slideId: "slide-1" }), /fijado/);
      assert.throws(() => resolveAction(ctx, { type: "set_text", slideId: "slide-2", objectId: "title-2", text: "x", why: "" }), /fijado/);
      assert.throws(() => resolveAction(ctx, { ...swapBackground, assetId: "ffffffffffffffff" }), /biblioteca/);
    },
  ],
  [
    "only the latest unresolved proposal is pending",
    () => {
      const proposal = (id: string): ChatRecord => ({ id: `m-${id}`, at: now, role: "assistant", text: "", proposal: { id, actions: [] } });
      assert.equal(pendingProposal([proposal("p1")])?.id, "p1");
      assert.equal(pendingProposal([proposal("p1"), proposal("p2")])?.id, "p2");
      const applied: ChatRecord = { id: "e", at: now, role: "event", kind: "applied", proposalId: "p2", costCents: 0, results: [] };
      assert.equal(pendingProposal([proposal("p1"), proposal("p2"), applied]), undefined);
      const discard: ChatRecord = { id: "u", at: now, role: "user", text: "", resolves: { proposalId: "p1", decision: "discard" } };
      assert.equal(pendingProposal([proposal("p1"), discard]), undefined);
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
