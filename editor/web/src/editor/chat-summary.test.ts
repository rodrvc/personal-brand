import assert from "node:assert/strict";

import type { CarouselDocument, ChatAction, ChatRecord } from "../api/types";
import { chatSpend, defaultReferenceRole, describeIntact, runningProposalId } from "./chat-summary";

const doc = {
  slides: ["slide-1", "slide-2", "slide-3", "slide-4"].map((id) => ({ id })),
} as unknown as CarouselDocument;

const swapBackground = {
  id: "act-1",
  type: "set_visual_from_library",
  slideId: "slide-3",
  slot: "background",
  assetId: "0123456789abcdef",
  why: "",
  provenance: [],
} as ChatAction;

const lines = describeIntact(doc, [swapBackground]);
assert.match(lines[0]!, /1, 2, 4/);
assert.equal(lines.length, 2);
assert.match(lines[1]!, /3/);
assert.match(lines[1]!, /fondo/);

const removeTitle = { id: "act-2", type: "delete_object", slideId: "slide-2", objectId: "t", why: "", provenance: [] } as ChatAction;
const withText = { slides: [{ id: "slide-1", objects: [] }, { id: "slide-2", objects: [{ id: "t", kind: "text", text: "Old" }] }] } as unknown as CarouselDocument;
const removal = describeIntact(withText, [removeTitle]);
assert.match(removal[0]!, /1\./);
assert.match(removal[1]!, /«Old»/);

const deleteAll = doc.slides.map((s, i) => ({ id: `act-${i}`, type: "delete_slide", slideId: s.id, why: "", provenance: [] }) as ChatAction);
assert.equal(describeIntact(doc, deleteAll).length, 1);

const at = "2026-01-01T00:00:00.000Z";
const spend = chatSpend([
  { id: "e1", at, role: "event", kind: "applied", proposalId: "p1", costCents: 4, results: [{ actionId: "a", slideIds: [], costCents: 4 }] },
  { id: "e2", at, role: "event", kind: "applied", proposalId: "p2", costCents: 0, results: [{ actionId: "b", slideIds: [] }] },
  { id: "m", at, role: "assistant", text: "", costCents: 1 },
]);
assert.deepEqual(spend, {
  totalCents: 5,
  items: [
    { at, costCents: 4, kind: "image" },
    { at, costCents: 1, kind: "reply" },
  ],
});

assert.equal(defaultReferenceRole({ mime: "image/png", w: 1600, h: 2000 }), "layout");
assert.equal(defaultReferenceRole({ mime: "image/jpeg", w: 1600, h: 2000 }), "content");
assert.equal(defaultReferenceRole({ mime: "image/png", w: 1125, h: 2000 }), "content");

const started: ChatRecord = { id: "s", at, role: "event", kind: "started", proposalId: "p9", costCents: 0, results: [] };
assert.equal(runningProposalId([started]), "p9");
assert.equal(runningProposalId([started, { ...started, id: "d", kind: "done" } as ChatRecord]), undefined);

console.log("ok - chat-summary");
