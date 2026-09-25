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
let generations = 0;
const fakeGenerator = {
  async completeJson(request: { images?: unknown[] }) {
    seenImages = request.images?.length ?? 0;
    return { json: nextReply, model: "fake", costCents: 0 };
  },
  async generateImage(spec: { referenceAssetIds?: string[]; mode?: string; prompt?: string }) {
    if (holdGeneration) await holdGeneration;
    if (failGeneration) throw new Error("provider down");
    generations++;
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

/** Runs `fn` with the environment variables set, restoring them after. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const editable = { EDITOR_POSTER_ROUTE: "editable" };

async function uploadPair(): Promise<{ layout: any; content: any }> {
  const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
  const content = (await post("/references", { name: "event.png", mime: "image/png", dataBase64: Buffer.from(TINY_PNG.toString("hex") + "04", "hex").toString("base64") })).body.reference;
  return { layout, content };
}

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
    "with the editable route on, compose_from_reference builds the poster from the layout itself, at no cost, with editable texts on top",
    async () => {
      const { action, event, onDisk, layout } = await withEnv(editable, composePoster);
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
    "with the editable route on, a poster missing event data asks one question for all of it, and the answer composes with the earlier references",
    () => withEnv(editable, async () => {
      reset();
      const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
      const content = (await post("/references", { name: "event.png", mime: "image/png", dataBase64: Buffer.from(TINY_PNG.toString("hex") + "03", "hex").toString("base64") })).body.reference;
      const box = (y: number) => ({ x: 0.1, y, w: 0.4, h: 0.04 });
      nextReply = {
        text: "Listo",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "title", text: "New event", from: "content", box: box(0.1) },
              { zone: "time", text: "20:00", from: "layout", original: "20:00", box: box(0.3) },
              { zone: "label", text: "Place", from: "layout", box: box(0.4) },
              { zone: "place", text: "", from: "missing", box: box(0.5) },
              { zone: "price", text: "", from: "missing", box: box(0.6) },
            ],
          },
        ],
      };
      const asked = await post("/messages", { text: "this poster with this event", references: [{ ...layout, role: "layout" }, { ...content, role: "content" }] });
      const question = asked.body.records[1];
      assert.equal(question.proposal, undefined, "nothing is composed yet");
      assert.deepEqual(question.asksFor, ["time", "place", "price"], "a time kept from the layout counts as missing");
      assert.equal(question.text.match(/\?/g)?.length, 1, "one question");
      for (const name of ["la hora", "el lugar", "el precio"]) assert.ok(question.text.includes(name), `it names ${name}`);

      seenImages = 0;
      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "title", text: "New event", from: "content", box: box(0.1) },
              { zone: "time", text: "", from: "absent", box: box(0.3) },
              { zone: "label", text: "Place", from: "layout", box: box(0.4) },
              { zone: "place", text: "The hall", from: "owner", box: box(0.5) },
              { zone: "price", text: "Free", from: "owner", box: box(0.6) },
            ],
          },
        ],
      };
      const answered = await post("/messages", { text: "The hall, free, and it has no time", references: [] });
      const [user, assistant] = answered.body.records;
      assert.equal(seenImages, 2, "the model sees the earlier references again");
      assert.deepEqual(user.references.map((r: any) => r.id), [layout.id, content.id], "the answer carries them, for apply");
      const action = assistant.proposal.actions[0];
      assert.deepEqual(action.referenceIds, [layout.id, content.id]);
      // The provider repaints the background, so the question flow is checked without macOS image tools.
      process.env.EDITOR_POSTER_BACKGROUND = "provider";
      const { event, onDisk } = await applyAndWait(assistant.proposal.id).finally(() => delete process.env.EDITOR_POSTER_BACKGROUND);
      assert.equal(event.kind, "done", event.error);
      const texts = onDisk.slides[0].objects.filter((o: any) => o.kind === "text").map((o: any) => o.text);
      assert.deepEqual(texts, ["New event", "Place", "The hall", "Free"], "the time the event does not have is removed, not placed");

      nextReply = { text: "Ok", actions: [] };
      const later = await post("/messages", { text: "thanks", references: [] });
      assert.equal(later.body.records[0].references, undefined, "only the answer to a question inherits the references");
    }),
  ],
  [
    "by default a poster is one generated image over the whole slide, with no text objects",
    async () => {
      reset();
      generations = 0;
      const { layout, content } = await uploadPair();
      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "chip", text: "LIVE MUSIC", from: "content", original: "ARTS" },
              { zone: "title", text: "New event", from: "content", original: "Old event" },
              { zone: "date", text: "MON 26 SEP", from: "content", original: "SAT 20 SEP", date: "2026-09-26" },
              { zone: "time", text: "21:00", from: "content", original: "20:00" },
              { zone: "place", text: "The hall", from: "owner", original: "Old venue" },
              { zone: "price", text: "", from: "absent", original: "$10" },
            ],
          },
        ],
      };
      const { body } = await post("/messages", {
        text: "this poster with this event at The hall, title in red; it has no price",
        activeSlideId: "slide-2",
        references: [{ ...layout, role: "layout" }, { ...content, role: "content" }],
      });
      const action = body.records[1].proposal.actions[0];
      assert.equal(action.posterRoute, "image");
      assert.equal(action.anchors, undefined, "no OCR");
      assert.equal(action.picture, undefined, "no frame detection");
      assert.equal(action.texts.find((t: any) => t.zone === "date").text, "SAT 26 SEP", "the weekday comes from the date, not the model");
      const { event, onDisk } = await applyAndWait(body.records[1].proposal.id);
      assert.equal(event.kind, "done", event.error);
      assert.equal(generations, 1, "one image");
      assert.equal(seenMode, "reproduce");
      assert.deepEqual(seenReferenceIds, [layout.id, content.id], "the layout goes first, then the event");
      assert.equal(event.costCents, 4);
      const objects = onDisk.slides[1].objects;
      assert.equal(objects.length, 1, "one asset and nothing else");
      assert.equal(objects[0].kind, "asset");
      assert.equal(objects[0].assetId, event.results[0].assetIds[0]);
      assert.deepEqual(objects[0].geometry, { x: 0, y: 0, w: 1080, h: 1350, rotation: 0 }, "over the whole slide");
      for (const datum of ['"LIVE MUSIC"', '"New event"', '"SAT 26 SEP"', "Saturday, September 26, 2026", '"21:00"', '"The hall"']) {
        assert.ok(seenPrompt.includes(datum), `the provider is told ${datum}`);
      }
      assert.match(seenPrompt, /has no price: remove/, "an absent datum is removed");
      assert.match(seenPrompt, /Nothing of the first image's event may remain/);
      assert.match(seenPrompt, /title in red/, "the owner's request reaches the provider");
      assert.ok(!seenPrompt.includes('"Old event"') || seenPrompt.includes('in place of "Old event"'), "the old event is only named as what is replaced");
    },
  ],
  [
    "a merged block is asked for, invented copy is dropped, and the answer with formatted data composes",
    async () => {
      reset();
      generations = 0;
      const { layout, content } = await uploadPair();
      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "title", text: "Echo! A Tribute Night", from: "content" },
              { zone: "subtitle", text: "North presenta el mejor tributo a The Sample Band", from: "owner" },
              { zone: "body", text: "Ubicación\nNorth Bar\n\nHorario\nApertura desde las 21:00 hrs\n\nEntrada General\n$5.000 CLP", from: "owner" },
            ],
          },
        ],
      };
      const asked = await post("/messages", { text: "genera este afiche pero con este evento", references: [{ ...layout, role: "layout" }, { ...content, role: "content" }] });
      const question = asked.body.records[1];
      assert.equal(question.proposal, undefined, "nothing is proposed");
      assert.deepEqual(question.asksFor, ["price", "time"], "data only: the invented subtitle is dropped, not asked for");
      assert.equal(generations, 0);

      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "title", text: "Echo! A Tribute Night", from: "content" },
              { zone: "subtitle", text: "North presenta el mejor tributo a The Sample Band", from: "owner" },
              { zone: "time", text: "Apertura desde las 21:00 hrs", from: "owner" },
              { zone: "price", text: "$5.000 CLP", from: "owner" },
            ],
          },
        ],
      };
      const answered = await post("/messages", { text: "abre a las 21:00 y la entrada general cuesta $5.000", references: [] });
      const reply = answered.body.records[1];
      assert.equal(reply.asksFor, undefined, "not asked again");
      assert.ok(reply.proposal, "the poster is proposed");
      assert.equal(reply.proposal.actions[0].texts.find((t: any) => t.zone === "subtitle").from, "absent");
    },
  ],
  [
    "a model that calls data absent on its own is not believed: the owner is asked first",
    async () => {
      reset();
      generations = 0;
      const { layout, content } = await uploadPair();
      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "date", text: "SÁB 26 SEP", from: "content", original: "JUEVES 24 SEP", date: "2026-09-26" },
              { zone: "title", text: "Echo! A Tribute Night", from: "content", original: "Thursday Club Night" },
              { zone: "subtitle", text: "North presenta Echo! A Tribute Night", from: "content", original: "A tribute and a stand-up set" },
              { zone: "body", text: "", from: "absent", original: "Ubicación" },
              { zone: "body", text: "", from: "absent", original: "Horario" },
              { zone: "body", text: "", from: "absent", original: "Entrada General" },
            ],
          },
        ],
      };
      const asked = await post("/messages", { text: "genera este afiche pero con este evento", references: [{ ...layout, role: "layout" }, { ...content, role: "content" }] });
      const question = asked.body.records[1];
      assert.equal(question.proposal, undefined, "nothing is generated from the first message");
      assert.deepEqual(question.asksFor, ["place", "time", "entry"]);
      assert.equal(generations, 0);
    },
  ],
  [
    "by default a poster missing an event datum asks before generating, and the answer generates with both messages",
    async () => {
      reset();
      generations = 0;
      const { layout, content } = await uploadPair();
      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "chip", text: "", from: "missing" },
              { zone: "title", text: "New event", from: "content" },
              { zone: "place", text: "", from: "missing", original: "Old venue" },
              { zone: "price", text: "$10", from: "layout", original: "$10" },
            ],
          },
        ],
      };
      const asked = await post("/messages", { text: "this poster with this event, bigger title", references: [{ ...layout, role: "layout" }, { ...content, role: "content" }] });
      const question = asked.body.records[1];
      assert.equal(question.proposal, undefined, "nothing is generated yet");
      assert.deepEqual(question.asksFor, ["place", "price"], "the chip is never asked for; a price kept from the layout is");
      assert.equal(question.text.match(/\?/g)?.length, 1, "one question");
      assert.equal(generations, 0);

      nextReply = {
        text: "",
        actions: [
          {
            type: "compose_from_reference",
            texts: [
              { zone: "title", text: "New event", from: "content" },
              { zone: "place", text: "The hall", from: "owner" },
              { zone: "price", text: "", from: "absent" },
            ],
          },
        ],
      };
      const answered = await post("/messages", { text: "The hall, and it is free of charge", references: [] });
      const proposal = answered.body.records[1].proposal;
      assert.deepEqual(proposal.actions[0].referenceIds, [layout.id, content.id], "the answer reuses the earlier references");
      const { event } = await applyAndWait(proposal.id);
      assert.equal(event.kind, "done", event.error);
      assert.equal(generations, 1);
      assert.match(seenPrompt, /bigger title/, "the first message's request still reaches the provider");
      assert.match(seenPrompt, /"The hall"/);
      assert.match(seenPrompt, /short tag naming the kind of event/, "a chip nobody wrote is inferred by the provider");
    },
  ],
  [
    "with the editable route on, compose_from_reference can still repaint the poster with the image provider",
    async () => {
      process.env.EDITOR_POSTER_BACKGROUND = "provider";
      process.env.EDITOR_POSTER_ROUTE = "editable";
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
        delete process.env.EDITOR_POSTER_ROUTE;
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
      for (const route of ["editable", "image"]) {
        reset();
        const layout = (await post("/references", { name: "layout.png", mime: "image/png", dataBase64: TINY_PNG.toString("base64") })).body.reference;
        await withoutImageTool(() =>
          withEnv({ EDITOR_POSTER_ROUTE: route, EDITOR_POSTER_BACKGROUND: "provider" }, async () => {
            nextReply = { text: "", actions: [{ type: "compose_from_reference", texts: [{ zone: "title", text: "New event", from: "content", box: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } }] }] };
            const { status, body } = await post("/messages", { text: "this poster", references: [{ ...layout, role: "layout" }] });
            assert.equal(status, 200, `the message does not fail (${route} route)`);
            assert.ok(body.records[1].proposal, `the poster is still proposed (${route} route)`);
            const { event } = await applyAndWait(body.records[1].proposal.id);
            assert.equal(event.kind, "done", event.error);
          }),
        );
      }
    },
  ],
  [
    "a generated poster is cut back to the slide's proportion, never stretched",
    async () => {
      const { fitToSlide } = await import("./chat.js");
      const { encodePng, toRgba } = await import("../image-tools.js");
      const { detectImage } = await import("../../../../system/assets/index.js");
      const canvas = { w: 1080, h: 1350 } as const;
      // A 2:3 image whose 4:5 middle is red and whose letterbox bands are blue.
      const [w, h] = [64, 96];
      const band = (h - (w * 5) / 4) / 2;
      const pixels = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.set(y < band || y >= h - band ? [0, 0, 255, 255] : [255, 0, 0, 255], (y * w + x) * 4);
      const fitted = fitToSlide(encodePng(w, h, pixels), canvas);
      const size = detectImage(fitted, "fitted.png");
      assert.deepEqual([size.w, size.h], [1080, 1350], "the canvas size and proportion");
      const out = toRgba(fitted);
      for (const y of [30, 675, 1320]) assert.deepEqual([...out.pixels.slice(y * 1080 * 4, y * 1080 * 4 + 3)], [255, 0, 0], `row ${y} is the slide, not a band`);
      const exact = encodePng(80, 100, new Uint8Array(80 * 100 * 4));
      assert.equal(fitToSlide(exact, canvas), exact, "an image already at the slide's proportion is kept as it is");
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
