import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "editor-server-chat-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
cpSync(join(REPO_ROOT, "profiles", "example"), profileDir, { recursive: true });

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const { registerFile } = await import("../../../../system/assets/index.js");
const asset = registerFile(profileDir, TINY_PNG, { destRelPath: "assets/bg.png", origin: "manual", status: "approved" });

const ID = "chat-carousel";
const carouselDir = join(profileDir, "carousels", ID);
const now = new Date().toISOString();
const textObject = (id: string, text: string) => ({
  id,
  kind: "text",
  slot: "title",
  pinned: false,
  locked: false,
  source: "ai",
  text,
});
const colorBackground = { mode: "color", colorKey: "paper", pinned: false, source: "manual" };
const document = {
  schemaVersion: 1,
  id: ID,
  title: "Chat test",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  canvas: { w: 1080, h: 1350 },
  prompt: { text: "", createdAt: now, runs: [] },
  template: { id: "explicativo" },
  slides: ["cover", "step", "step", "closing"].map((kind, i) => ({
    id: `slide-${i + 1}`,
    kind,
    background: colorBackground,
    objects: [textObject(`title-${i + 1}`, `Approved ${i + 1}`)],
  })),
};

function reset(): void {
  rmSync(carouselDir, { recursive: true, force: true });
  mkdirSync(carouselDir, { recursive: true });
  writeFileSync(join(carouselDir, "carousel.json"), JSON.stringify(document));
}

let nextReply: unknown;
let seenImages = 0;
let failGeneration = false;
let holdGeneration: Promise<void> | undefined;
let seenReferenceIds: string[] = [];
let seenMode: string | undefined;
let seenPrompt = "";
const fakeGenerator = {
  async completeJson(request: { images?: unknown[] }) {
    seenImages = request.images?.length ?? 0;
    return { json: nextReply, model: "fake", costCents: 0 };
  },
  async generateImage(spec: { referenceAssetIds?: string[]; mode?: string; prompt?: string }) {
    if (holdGeneration) await holdGeneration;
    if (failGeneration) throw new Error("provider down");
    seenReferenceIds = spec.referenceAssetIds ?? [];
    seenMode = spec.mode;
    seenPrompt = spec.prompt ?? "";
    const buffer = Buffer.from(TINY_PNG.toString("hex") + "00", "hex");
    return { buffer, mime: "image/png", model: "fake", costCents: 4, usedReferenceIds: seenReferenceIds };
  },
  acceptsReference: () => true,
};

const { default: express } = await import("express");
const { chatRouter } = await import("./chat.js");
const app = express();
app.use(express.json());
app.use(chatRouter(() => fakeGenerator as never));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles/${SLUG}/carousels/${ID}/chat`;

async function post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function propose(reply: unknown, references: unknown[] = []): Promise<any> {
  nextReply = reply;
  const { status, body } = await post("/messages", { text: "the third one, please", references });
  assert.equal(status, 200);
  return body.records[1];
}

/** Applies, then waits for the terminal event the background run appends. */
async function applyAndWait(proposalId: string): Promise<{ status: number; event: any; onDisk: any }> {
  const { status } = await post(`/proposals/${proposalId}/apply`);
  for (let i = 0; i < 100 && status === 202; i++) {
    const { records } = await (await fetch(base)).json();
    const event = records.find((r: any) => r.proposalId === proposalId && (r.kind === "done" || r.kind === "failed"));
    if (event) return { status, event, onDisk: JSON.parse(readFileSync(join(carouselDir, "carousel.json"), "utf-8")) };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { status, event: undefined, onDisk: undefined };
}

const swapBackground = { type: "set_visual_from_library", slideId: "slide-3", slot: "background", assetId: asset.id, why: "" };

/** Proposes and applies a poster from a layout and a content reference, on the second slide. */
async function composePoster(): Promise<{ action: any; event: any; onDisk: any; layout: any; content: any }> {
  reset();
  seenMode = undefined;
  const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
  const content = (await post("/references", { name: "event.png", mime: "image/png", dataBase64: Buffer.from(TINY_PNG.toString("hex") + "01", "hex").toString("base64") })).body.reference;
  nextReply = {
    text: "",
    actions: [
      {
        type: "compose_from_reference",
        texts: [
          { zone: "title", text: "New event", from: "content", original: "Old event", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } },
          { zone: "label", text: "Place", from: "layout", original: "Place", box: { x: 0.1, y: 0.8, w: 0.2, h: 0.02 } },
          { zone: "media", text: "event.png", box: { x: 0.2, y: 0.3, w: 0.6, h: 0.4 } },
        ],
      },
    ],
  };
  const { body } = await post("/messages", {
    text: "this poster with this event",
    activeSlideId: "slide-2",
    references: [{ ...layout, role: "layout" }, { ...content, role: "content" }],
  });
  const action = body.records[1].proposal.actions[0];
  assert.deepEqual(action.referenceIds, [layout.id, content.id], "the layout goes first, as the base image");
  assert.deepEqual(action.provenance.map((p: any) => p.source), ["layout_reference", "content_reference", "content_reference", "reference_kept"]);
  assert.deepEqual(action.texts.map((t: any) => t.text), ["New event", "Place"], "a picture is not a text zone");
  const { event, onDisk } = await applyAndWait(body.records[1].proposal.id);
  assert.equal(event.kind, "done", event.error);
  return { action, event, onDisk, layout, content };
}

/** Marks a test that runs macOS `sips` for real; it is skipped elsewhere, as image-tools.test.ts does. */
const NEEDS_IMAGE_TOOL = { needsImageTool: true };

/** Runs `fn` as if on a system without `sips`, so the fallback is exercised on macOS too. */
async function withoutImageTool(fn: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

const tests: Array<[string, () => Promise<void>, { needsImageTool?: boolean }?]> = [
  [
    "apply snapshots the document before writing and logs the version path",
    async () => {
      reset();
      const assistant = await propose({ text: "Done", actions: [swapBackground] });
      const { status, event, onDisk } = await applyAndWait(assistant.proposal.id);
      assert.equal(status, 202);
      assert.equal(onDisk.slides[2].background.assetId, asset.id);
      assert.equal(event.kind, "done");
      assert.deepEqual(JSON.parse(readFileSync(join(profileDir, event.documentVersion), "utf-8")), document);
    },
  ],
  [
    "generate_visual generates on apply, attaches the image and logs what it cost",
    async () => {
      reset();
      const upload = await post("/references", { name: "sunset.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") });
      assert.equal(upload.status, 200);
      const generate = { type: "generate_visual", slideId: "slide-3", slot: "background", prompt: "a beach", kind: "background" };
      const assistant = await propose({ text: "", actions: [generate] }, [upload.body.reference]);
      assert.equal(seenImages, 1);
      assert.equal(assistant.proposal.actions[0].referenceIds[0], upload.body.reference.id);
      assert.deepEqual(assistant.proposal.actions[0].provenance.at(-1), { source: "reference", detail: "sunset.png" });

      const { event, onDisk } = await applyAndWait(assistant.proposal.id);
      assert.equal(onDisk.slides[2].background.assetId, event.results[0].assetIds[0]);
      assert.equal(onDisk.slides[2].background.source, "ai");
      assert.equal(event.costCents, 4);
      assert.deepEqual(seenReferenceIds, [upload.body.reference.id], "the reference reaches the image generator by asset id");
      assert.deepEqual((await (await fetch(base)).json()).currency, { code: "USD", rate: 1 });
      appendFileSync(join(profileDir, "config.yaml"), "\ncurrency:\n  code: eur\n  rate: 0.9\n");
      assert.deepEqual((await (await fetch(base)).json()).currency, { code: "EUR", rate: 0.9 });
    },
  ],
  [
    "a generated object with no slot is added loose, with its own geometry",
    async () => {
      reset();
      const chair = { type: "generate_visual", slideId: "slide-2", prompt: "a chair", kind: "decoration" };
      const assistant = await propose({ text: "", actions: [chair] });
      const { event, onDisk } = await applyAndWait(assistant.proposal.id);
      assert.equal(event.kind, "done");
      const added = onDisk.slides[1].objects.find((o: { assetId?: string }) => o.assetId === event.results[0].assetIds[0]);
      assert.ok(added, "the generated asset must be on the named slide in the persisted document");
      assert.equal(added.slot, undefined);
      assert.equal(added.source, "ai");
      assert.ok(added.geometry && added.assetId);
      assert.deepEqual(onDisk.slides[1].background, document.slides[1]!.background);
    },
  ],
  [
    "a proposal that fails midway is logged as failed and stops being pending",
    async () => {
      reset();
      failGeneration = true;
      const generate = { type: "generate_visual", slideId: "slide-2", slot: "background", prompt: "a beach", kind: "background" };
      const assistant = await propose({ text: "", actions: [swapBackground, generate] });
      const { event } = await applyAndWait(assistant.proposal.id);
      failGeneration = false;
      assert.equal(event.kind, "failed");
      assert.equal((await post(`/proposals/${assistant.proposal.id}/apply`)).status, 409);
      assert.equal((await post("/messages", { text: "x", references: [null] })).status, 400);
    },
  ],
  [
    "compose_from_reference builds the poster from the layout itself, at no cost, with editable texts on top",
    async () => {
      const { action, event, onDisk, layout } = await composePoster();
      assert.equal(event.costCents, 0, "no image provider involved");
      assert.equal(seenMode, undefined);
      const [poster, ...texts] = onDisk.slides[1].objects;
      assert.equal(poster.assetId, event.results[0].assetIds[0]);
      assert.notEqual(poster.assetId, layout.id, "a new background: the layout with its texts erased");
      assert.deepEqual(poster.geometry, { x: 0, y: 0, w: 1080, h: 1350, rotation: 0 });
      assert.equal(poster.pinned, true);
      assert.deepEqual(texts.map((t: any) => [t.kind, t.text, t.pinned]), [["text", "New event", false], ["text", "Place", false]], "editable texts on top");
      assert.deepEqual(onDisk.slides[0], document.slides[0], "other slides are untouched");
      assert.equal(action.slideId, "slide-2");
    },
    NEEDS_IMAGE_TOOL,
  ],
  [
    "compose_from_reference can still repaint the poster with the image provider",
    async () => {
      process.env.EDITOR_POSTER_BACKGROUND = "provider";
      try {
        const { event, onDisk, layout, content } = await composePoster();
        assert.equal(event.costCents, 4);
        assert.equal(seenMode, "reproduce");
        assert.deepEqual(seenReferenceIds, [layout.id, content.id]);
        const [poster, ...texts] = onDisk.slides[1].objects;
        assert.equal(poster.pinned, true);
        assert.deepEqual(texts.map((t: any) => [t.text, t.pinned]), [["New event", false], ["Place", false]]);
        assert.match(seenPrompt, /every text exactly as it is written/, "the provider keeps the texts; they are erased after measuring");
      } finally {
        delete process.env.EDITOR_POSTER_BACKGROUND;
      }
    },
    NEEDS_IMAGE_TOOL,
  ],
  [
    "a content reference placed with set_visual_from_library is still placeable when the proposal is applied",
    async () => {
      reset();
      const photo = (await post("/references", { name: "photo.png", mime: "image/png", dataBase64: Buffer.from(TINY_PNG.toString("hex") + "02", "hex").toString("base64") })).body.reference;
      const place = { type: "set_visual_from_library", slideId: "slide-3", slot: "background", assetId: photo.id, why: "" };
      const assistant = await propose({ text: "", actions: [place] }, [{ ...photo, role: "content" }]);
      assert.ok(assistant.proposal, "proposed");
      const { status, event, onDisk } = await applyAndWait(assistant.proposal.id);
      assert.equal(status, 202, "not refused at apply");
      assert.equal(event.kind, "done");
      assert.equal(onDisk.slides[2].background.assetId, photo.id);
    },
  ],
  [
    "an apply that cannot write its outcome is logged, and the server keeps running",
    async () => {
      reset();
      let release!: () => void;
      holdGeneration = new Promise((resolve) => (release = resolve));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const errors: unknown[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        const generate = { type: "generate_visual", slideId: "slide-2", slot: "background", prompt: "a beach", kind: "background" };
        const assistant = await propose({ text: "", actions: [generate] });
        assert.equal((await post(`/proposals/${assistant.proposal.id}/apply`)).status, 202);
        chmodSync(join(carouselDir, "chat.jsonl"), 0o444);
        failGeneration = true;
        release();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        holdGeneration = undefined;
        failGeneration = false;
        chmodSync(join(carouselDir, "chat.jsonl"), 0o644);
        console.error = consoleError;
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(unhandled, [], "no unhandled rejection");
      assert.equal(errors.length, 1, "the lost outcome is reported");
      assert.equal((await fetch(base)).status, 200, "the server still answers");
    },
  ],
  [
    "compose_from_reference targets the active slide, else the first one, else a new one on an empty carousel",
    async () => {
      const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
      const target = async (activeSlideId?: string) => {
        nextReply = { text: "", actions: [{ type: "compose_from_reference", replacements: [] }] };
        const { body } = await post("/messages", { text: "this poster", references: [{ ...layout, role: "layout" }], ...(activeSlideId ? { activeSlideId } : {}) });
        return body.records[1].proposal;
      };
      reset();
      assert.equal((await target("slide-3")).actions[0].slideId, "slide-3", "the active slide");
      assert.equal((await target()).actions[0].slideId, "slide-1", "the first slide when none is active");
      assert.equal((await target("gone")).actions[0].slideId, "slide-1", "the first slide when the active one no longer exists");

      writeFileSync(join(carouselDir, "carousel.json"), JSON.stringify({ ...document, slides: [] }));
      const proposal = await target();
      assert.equal(proposal.actions[0].slideId, undefined, "no slide yet");
      const { event, onDisk } = await applyAndWait(proposal.id);
      assert.equal(event.kind, "done");
      assert.equal(onDisk.slides.length, 1, "a new slide holds the poster");
      assert.deepEqual(event.results[0].slideIds, [onDisk.slides[0].id]);
    },
    NEEDS_IMAGE_TOOL,
  ],
  [
    "without image tools, a message with a layout reference still proposes and applies the poster",
    async () => {
      reset();
      const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
      await withoutImageTool(async () => {
        nextReply = { text: "", actions: [{ type: "compose_from_reference", texts: [{ zone: "title", text: "New event", from: "content", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } }] }] };
        const { status, body } = await post("/messages", { text: "this poster", references: [{ ...layout, role: "layout" }] });
        assert.equal(status, 200, "the message does not fail");
        assert.ok(body.records[1].proposal, "the poster is still proposed");
        process.env.EDITOR_POSTER_BACKGROUND = "provider";
        try {
          const { event } = await applyAndWait(body.records[1].proposal.id);
          assert.equal(event.kind, "done", event.error);
        } finally {
          delete process.env.EDITOR_POSTER_BACKGROUND;
        }
      });
    },
  ],
  [
    "an action outside the closed set is refused with a message naming it",
    async () => {
      reset();
      const assistant = await propose({ text: "", actions: [{ type: "move_piece", slideId: "slide-1" }] });
      assert.equal(assistant.proposal, undefined);
      assert.match(assistant.text, /move_piece/);
    },
  ],
  [
    "only the latest unresolved proposal can be applied, and only once",
    async () => {
      reset();
      const first = await propose({ text: "", actions: [swapBackground] });
      const second = await propose({ text: "", actions: [{ type: "delete_slide", slideId: "slide-4", why: "" }] });
      assert.equal((await post(`/proposals/${first.proposal.id}/apply`)).status, 409);
      assert.equal((await applyAndWait(second.proposal.id)).event.kind, "done");
      assert.equal((await post(`/proposals/${second.proposal.id}/apply`)).status, 409);
    },
  ],
  [
    "the log is only ever appended to",
    async () => {
      reset();
      const first = await propose({ text: "", actions: [swapBackground] });
      const logPath = join(carouselDir, "chat.jsonl");
      const before = readFileSync(logPath, "utf-8");
      await post(`/proposals/${first.proposal.id}/discard`);
      const after = readFileSync(logPath, "utf-8");
      assert.ok(after.startsWith(before));
      assert.equal(after.trim().split("\n").length, 3);
      assert.equal((await post(`/proposals/${first.proposal.id}/apply`)).status, 409);
    },
  ],
];

let failed = 0;
for (const [name, fn, options] of tests) {
  if (options?.needsImageTool && process.platform !== "darwin") {
    console.log(`skip - ${name} (no sips on this system)`);
    continue;
  }
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

server.close();
rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
