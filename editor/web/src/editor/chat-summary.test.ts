import assert from "node:assert/strict";

import type { CarouselDocument, ChatAction } from "../api/types";
import { describeIntact } from "./chat-summary";

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

const deleteAll = doc.slides.map((s, i) => ({ id: `act-${i}`, type: "delete_slide", slideId: s.id, why: "", provenance: [] }) as ChatAction);
assert.equal(describeIntact(doc, deleteAll).length, 1);

console.log("ok - chat-summary");
