import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let seenReferenceIds: string[] = [];
const fakeGenerator = {
  async completeJson(request: { images?: unknown[] }) {
    seenImages = request.images?.length ?? 0;
    return { json: nextReply, model: "fake", costCents: 0 };
  },
  async generateImage(spec: { referenceAssetIds?: string[] }) {
    if (failGeneration) throw new Error("provider down");
    seenReferenceIds = spec.referenceAssetIds ?? [];
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

const swapBackground = { type: "set_visual_from_library", slideId: "slide-3", slot: "background", assetId: asset.id, why: "" };

const tests: Array<[string, () => Promise<void>]> = [
  [
    "apply snapshots the document before writing and logs the version path",
    async () => {
      reset();
      const assistant = await propose({ text: "Done", actions: [swapBackground] });
      const { status, body } = await post(`/proposals/${assistant.proposal.id}/apply`);
      assert.equal(status, 200);
      assert.equal(body.document.slides[2].background.assetId, asset.id);

      const event = body.records[0];
      assert.equal(event.kind, "applied");
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

      const { status, body } = await post(`/proposals/${assistant.proposal.id}/apply`);
      assert.equal(status, 200);
      const onDisk = JSON.parse(readFileSync(join(carouselDir, "carousel.json"), "utf-8"));
      assert.equal(onDisk.slides[2].background.assetId, body.records[0].results[0].assetIds[0]);
      assert.equal(onDisk.slides[2].background.source, "ai");
      assert.equal(body.records[0].costCents, 4);
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
      const { status, body } = await post(`/proposals/${assistant.proposal.id}/apply`);
      assert.equal(status, 200);
      const onDisk = JSON.parse(readFileSync(join(carouselDir, "carousel.json"), "utf-8"));
      const added = onDisk.slides[1].objects.find((o: { assetId?: string }) => o.assetId === body.records[0].results[0].assetIds[0]);
      assert.ok(added, "the generated asset must be on the named slide in the persisted document");
      assert.equal(added.slot, undefined);
      assert.equal(added.source, "ai");
      assert.ok(added.geometry && added.assetId);
      assert.deepEqual(body.document.slides[1].background, document.slides[1]!.background);
    },
  ],
  [
    "a proposal that fails midway is logged as failed and stops being pending",
    async () => {
      reset();
      failGeneration = true;
      const generate = { type: "generate_visual", slideId: "slide-2", slot: "background", prompt: "a beach", kind: "background" };
      const assistant = await propose({ text: "", actions: [swapBackground, generate] });
      const { status } = await post(`/proposals/${assistant.proposal.id}/apply`);
      failGeneration = false;
      assert.equal(status, 500);
      const { records } = await (await fetch(base)).json();
      assert.equal(records.at(-1).kind, "failed");
      assert.equal((await post(`/proposals/${assistant.proposal.id}/apply`)).status, 409);
      assert.equal((await post("/messages", { text: "x", references: [null] })).status, 400);
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
      assert.equal((await post(`/proposals/${second.proposal.id}/apply`)).status, 200);
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
for (const [name, fn] of tests) {
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
