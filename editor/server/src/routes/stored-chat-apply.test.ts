import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/** The chat's writes for a stored brand (S10b7b): a message (model turn), a reference upload and applying a proposal, over real HTTP, the memory repositories and a fake model/image provider. */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-chat-apply-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { createStorageAssetLibrary } = await import("../../../../system/assets/storage-library.js");
const { chatRouter } = await import("./chat.js");
const { assetResolverFor } = await import("../chat/chat-references.js");
const { messages } = await import("../messages.js");
const { storedChatWorkspace } = await import("../chat/chat-workspace.js");
const { guardStorage, resolveStored, storedBrandGuard } = await import("../stored-read.js");
type EditorStorage = import("../stored-read.js").EditorStorage;

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const SLUG = "apply-example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const repos = createMemoryRepositories();
const brand = await repos.brands.create({ slug: SLUG, displayName: "Apply Example" }, meta);
await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
const tokens = { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 };
await repos.documents.put(brand.id, "tokens", "", tokens, meta);
const objects = new FakeObjectStore();
const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
const storage: EditorStorage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, exports: repos.exports, revisions: repos.revisions, chat: repos.chat, files: objects, blobs: (brandId: string) => new BlobCache(objects, brandId, join(root, ".blobs")) };
const approved = await library.register(Buffer.concat([PNG, Buffer.from("a")]), { kind: "photo", origin: "manual", status: "approved", tags: ["sea"] });

const seen = { inputs: [] as any[], images: 0, completions: 0, reply: {} as unknown, onImage: undefined as (() => Promise<void>) | undefined };
const generator = {
  completeJson: async (request: { input: string; images?: unknown[] }) => (seen.completions++, seen.inputs.push(JSON.parse(request.input)), seen.images = request.images?.length ?? 0, { json: seen.reply, model: "fake", costCents: 1 }),
  generateImage: async () => (await seen.onImage?.(), { buffer: Buffer.concat([PNG, Buffer.from("g")]), mime: "image/png", model: "fake-image", costCents: 4, usedReferenceIds: [] }),
  acceptsReference: () => true,
};

const closers: Array<() => void> = [];
async function serve(extra: Partial<EditorStorage>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/profiles/:slug", storedBrandGuard({ ...storage, ...extra }));
  app.use(chatRouter(() => generator as never, { storage: { ...storage, ...extra } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closers.push(() => void server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles`;
}
let raceOnce = false;
let raceSlug = "";
let failNextGet = false;
// A user's save landing right before the proposal's own write.
const racing = { carousels: { ...storage.carousels, save: async (...args: Parameters<EditorStorage["carousels"]["save"]>) => {
  const current = raceOnce ? await repos.carousels.get(brand.id, raceSlug, (b) => b) : undefined;
  if (current) await repos.carousels.save(current.id, { title: "Mine", document: { json: current.value.document as Record<string, unknown>, schemaVersion: 1 } }, { ...meta, expectedVersion: current.version, reason: "save" });
  raceOnce = false;
  return storage.carousels.save(...args);
} } };
// An outage on the first read after a save: the apply's re-check of its own committed write.
const flaky = { carousels: { ...storage.carousels,
  save: async (...args: Parameters<EditorStorage["carousels"]["save"]>) => { const saved = await storage.carousels.save(...args); failNextGet = true; return saved; },
  get: (async (...args: Parameters<EditorStorage["carousels"]["get"]>) => { if (failNextGet) { failNextGet = false; throw new Error("connection refused"); } return storage.carousels.get(...args); }) as EditorStorage["carousels"]["get"],
} };
const main = await serve({});
const racingBase = await serve(racing);
const flakyBase = await serve(flaky);
const post = async (path: string, body: unknown, base = main) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const doc = (id: string) => ({ json: { schemaVersion: 1, id, title: id, createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: STAMP }, slides: [{ id: "s1", kind: "step", background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" }, objects: [{ id: "t1", kind: "text", slot: "title", pinned: false, locked: false, source: "ai", text: "Old" }] }] }, schemaVersion: 1 });
const row = async (id: string) => repos.carousels.get(brand.id, id, (b) => b as any);
// Each test seeds its own carousel (and chat), so none depends on another having run.
const seed = (slug: string, document = doc(slug)) => repos.carousels.create(brand.id, { slug, title: slug, document }, meta);
const finished = async (id: string, proposalId: string, base = main) => {
  for (let i = 0; i < 200; i++) {
    const { records } = (await (await fetch(`${base}/${SLUG}/carousels/${id}/chat`)).json()) as { records: any[] };
    const event = records.find((r) => r.role === "event" && r.proposalId === proposalId && (r.kind === "done" || r.kind === "failed"));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the proposal never finished");
};
const propose = async (id: string, actions: unknown[], base = main) => {
  seen.reply = { text: "Here you go", actions };
  const sent = await post(`/${SLUG}/carousels/${id}/chat/messages`, { text: "change it" }, base);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body.records[1].proposal.id as string;
};
const setText = { type: "set_text", slideId: "s1", objectId: "t1", text: "New", why: "asked" };
const archived = await repos.brands.create({ slug: "old-apply", displayName: "Old" }, meta);
const archivedCut = await repos.brands.markCutover(archived.id, { ...meta, expectedVersion: archived.version });
await repos.documents.put(archived.id, "tokens", "", tokens, meta);
const late = await repos.carousels.create(archived.id, { slug: "late", title: "Late", document: doc("late") }, meta);
await repos.chat.append(late.id, { id: "m1", at: STAMP, role: "assistant", text: "p", proposal: { id: "p1", actions: [{ id: "a1", ...setText, provenance: [] }] } });
await repos.brands.archive(archived.id, { ...meta, expectedVersion: archivedCut.version });

const tests: Array<[string, () => Promise<void>]> = [
  ["a message goes through the model with the stored library (approved images only, named like the asset routes) and logs both turns", async () => {
    const created = await seed("week-one");
    const reference = (await post(`/${SLUG}/carousels/week-one/chat/references`, { name: "ref.png", mime: "image/png", dataBase64: PNG.toString("base64") })).body.reference;
    seen.reply = { text: "Done", actions: [setText] };
    const sent = await post(`/${SLUG}/carousels/week-one/chat/messages`, { text: "make it new", references: [reference] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.records.map((r: any) => r.role), ["user", "assistant"]);
    assert.equal(sent.body.records[1].proposal.actions[0].type, "set_text");
    assert.equal(seen.images, 1, "the reference reached the provider");
    const input = seen.inputs.at(-1);
    assert.deepEqual(input.library.map((l: any) => [l.id, l.name, l.kind]), [[approved.id, `${approved.id}.png`, "photo"]], "the reference and any candidate are not in the library");
    assert.equal(input.document.slides[0].objects[0].text, "Old");
    assert.deepEqual((await repos.chat.list(created.id)).map((m) => (m.body as any).role), ["user", "assistant"]);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false, "no folder appears");
  }],
  ["a reference is a candidate asset of origin reference, stored once; an unsupported type or a malformed body is a 400", async () => {
    await seed("refs-one");
    const send = (mime: string) => post(`/${SLUG}/carousels/refs-one/chat/references`, { name: "r.png", mime, dataBase64: PNG.toString("base64") });
    const first = (await send("image/png")).body.reference;
    assert.equal(first.mime, "image/png");
    assert.deepEqual([first.w, first.h], [1, 1]);
    const asset = (await repos.assets.get(brand.id, first.id)).value;
    assert.deepEqual([asset.origin, asset.status, asset.kind], ["reference", "candidate", "unclassified"]);
    assert.equal((await send("image/png")).body.reference.id, first.id, "the same bytes are the same asset");
    assert.equal((await send("application/pdf")).status, 400);
    assert.equal((await post(`/${SLUG}/carousels/week-one/chat/references`, { name: 1 })).status, 400);
    assert.equal((await post(`/${SLUG}/carousels/missing/chat/references`, { name: "r", mime: "image/png", dataBase64: "" })).status, 404);
  }],
  ["applying a proposal writes the document at its row version, stores the generated image as an ai candidate and records the cost", async () => {
    const created = await seed("apply-one");
    const id = await propose("apply-one", [setText, { type: "generate_visual", slideId: "s1", slot: "background", prompt: "a calm sea", kind: "background", why: "asked" }]);
    const before = await row("apply-one");
    const applied = await post(`/${SLUG}/carousels/apply-one/chat/proposals/${id}/apply`, {});
    assert.equal(applied.status, 202, JSON.stringify(applied.body));
    assert.equal(applied.body.records[0].kind, "started");
    const event = await finished("apply-one", id);
    assert.equal(event.kind, "done", event.error);
    assert.equal(event.costCents, 4);
    const after = await row("apply-one");
    assert.equal(after.version, before.version + 1);
    const slide = (after.value.document as any).slides[0];
    assert.equal(slide.objects[0].text, "New");
    assert.equal(slide.background.mode, "asset");
    const generated = (await repos.assets.get(brand.id, slide.background.assetId)).value;
    assert.deepEqual([generated.origin, generated.status], ["ai", "candidate"]);
    assert.deepEqual([generated.generation?.prompt, generated.generation?.costCents, generated.generation?.carouselId], ["a calm sea", 4, "apply-one"]);
    assert.equal((await repos.revisions.listHeads("carousel", created.id, ["snapshot"])).length, 1, "a multi-piece change is a snapshot");
    assert.equal((await post(`/${SLUG}/carousels/apply-one/chat/proposals/${id}/apply`, {})).status, 409, "it is no longer pending");
  }],
  ["a save that lands between the read and the write fails the proposal and keeps the user's version", async () => {
    await seed("race-one");
    const id = await propose("race-one", [{ ...setText, text: "Lost" }], racingBase);
    raceSlug = "race-one";
    raceOnce = true;
    assert.equal((await post(`/${SLUG}/carousels/race-one/chat/proposals/${id}/apply`, {}, racingBase)).status, 202);
    const event = await finished("race-one", id, racingBase);
    assert.deepEqual([event.kind, event.error], ["failed", messages.saveConflict]);
    const current = await row("race-one");
    assert.equal(current.value.title, "Mine");
    assert.equal((current.value.document as any).slides[0].objects[0].text, "Old", "nothing of the proposal was written");
  }],
  ["a provider failure is a failed event with the cost so far, and the document is untouched", async () => {
    await seed("fail-one");
    const id = await propose("fail-one", [{ type: "generate_visual", slideId: "s1", slot: "background", prompt: "x", kind: "background", why: "" }]);
    const before = (await row("fail-one")).version;
    seen.onImage = async () => { throw new Error("provider down"); };
    try {
      await post(`/${SLUG}/carousels/fail-one/chat/proposals/${id}/apply`, {});
      const event = await finished("fail-one", id);
      assert.deepEqual([event.kind, event.error, event.costCents], ["failed", "provider down", 0]);
    } finally {
      seen.onImage = undefined;
    }
    assert.equal((await row("fail-one")).version, before);
  }],
  ["an archived brand refuses a message, a reference and an apply (403) before any model call, and writes nothing", async () => {
    const calls = seen.completions;
    for (const [path, body] of [["messages", { text: "hi" }], ["references", { name: "r", mime: "image/png", dataBase64: PNG.toString("base64") }], ["proposals/p1/apply", {}]] as const) {
      { const r = await post(`/old-apply/carousels/late/chat/${path}`, body); assert.equal(r.status, 403, path + JSON.stringify(r.body)); }
    }
    assert.equal(seen.completions, calls);
    assert.equal((await repos.assets.list(archived.id)).length, 0);
  }],
  ["a corrupt chat body is a 503 (never served, never skipped); a storage failure on a message or an apply is a 503", async () => {
    const bad = await repos.carousels.create(brand.id, { slug: "corrupt", title: "Corrupt", document: doc("corrupt") }, meta);
    await repos.chat.append(bad.id, { role: "assistant" } as never);
    assert.equal((await fetch(`${main}/${SLUG}/carousels/corrupt/chat`)).status, 503);
    assert.equal((await post(`/${SLUG}/carousels/corrupt/chat/messages`, { text: "hi" })).status, 503);
    const down = await serve({ chat: { ...storage.chat, append: async () => { throw new Error("connection refused"); } } });
    const good = await repos.carousels.create(brand.id, { slug: "outage", title: "Outage", document: doc("outage") }, meta);
    await repos.chat.append(good.id, { id: "m1", at: STAMP, role: "assistant", text: "p", proposal: { id: "prop-x", actions: [{ id: "a1", ...setText, provenance: [] }] } });
    assert.equal((await post(`/${SLUG}/carousels/outage/chat/proposals/prop-x/apply`, {}, down)).status, 503);
    seen.reply = { text: "ok", actions: [] };
    assert.equal((await post(`/${SLUG}/carousels/outage/chat/messages`, { text: "hi" }, down)).status, 503);
  }],
  ["two concurrent applies of the same pending proposal run it once: the second is a 409 and the provider is paid once", async () => {
    await seed("conc-one");
    const id = await propose("conc-one", [{ type: "generate_visual", slideId: "s1", slot: "background", prompt: "a calm sea", kind: "background", why: "" }]);
    let paid = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    seen.onImage = async () => { paid++; await gate; };
    try {
      // The first run is held inside the provider until both responses are in, so the second request meets a running apply.
      const [a, b] = await Promise.all([1, 2].map(() => post(`/${SLUG}/carousels/conc-one/chat/proposals/${id}/apply`, {})));
      release();
      assert.deepEqual([a!.status, b!.status].sort(), [202, 409]);
      assert.equal([a!, b!].find((r) => r.status === 409)!.body.error, messages.proposal.applyInFlight);
      assert.equal((await finished("conc-one", id)).kind, "done");
    } finally {
      release();
      seen.onImage = undefined;
    }
    assert.equal(paid, 1);
    assert.equal((await repos.chat.list((await row("conc-one")).id)).filter((m) => (m.body as any).kind === "started").length, 1);
  }],
  ["a save that lands during generation is built upon, not lost", async () => {
    await seed("built-one");
    const id = await propose("built-one", [setText, { type: "generate_visual", slideId: "s1", slot: "background", prompt: "x", kind: "background", why: "" }]);
    seen.onImage = async () => {
      const current = await row("built-one");
      const json = structuredClone(current.value.document) as any;
      json.slides[0].objects.push({ id: "t2", kind: "text", slot: "body", pinned: false, locked: false, source: "manual", text: "Mine" });
      await repos.carousels.save(current.id, { title: "Mine", document: { json, schemaVersion: 1 } }, { ...meta, expectedVersion: current.version, reason: "save" });
    };
    try {
      await post(`/${SLUG}/carousels/built-one/chat/proposals/${id}/apply`, {});
      assert.equal((await finished("built-one", id)).kind, "done");
    } finally {
      seen.onImage = undefined;
    }
    const objects = ((await row("built-one")).value.document as any).slides[0].objects;
    assert.deepEqual(objects.map((o: any) => [o.id, o.text]), [["t1", "New"], ["t2", "Mine"]]);
  }],
  ["a failure re-checking a committed apply does not turn it into a failed event", async () => {
    await seed("flaky-one");
    const id = await propose("flaky-one", [setText], flakyBase);
    failNextGet = false;
    assert.equal((await post(`/${SLUG}/carousels/flaky-one/chat/proposals/${id}/apply`, {}, flakyBase)).status, 202);
    const event = await finished("flaky-one", id, flakyBase);
    assert.equal(event.kind, "done", event.error);
    assert.equal(((await row("flaky-one")).value.document as any).slides[0].objects[0].text, "New");
  }],
  ["a stored row whose document is invalid is a 400 on a message and on an apply", async () => {
    const bad = await seed("invalid-one", { json: { ...doc("invalid-one").json, slides: "nope" }, schemaVersion: 1 } as never);
    await repos.chat.append(bad.id, { id: "m1", at: STAMP, role: "assistant", text: "p", proposal: { id: "prop-i", actions: [{ id: "a1", ...setText, provenance: [] }] } });
    const calls = seen.completions;
    assert.equal((await post(`/${SLUG}/carousels/invalid-one/chat/messages`, { text: "hi" })).status, 400);
    assert.equal((await post(`/${SLUG}/carousels/invalid-one/chat/proposals/prop-i/apply`, {})).status, 400);
    assert.equal(seen.completions, calls, "no model call");
    assert.equal((await repos.chat.list(bad.id)).length, 1, "nothing was appended");
  }],
  ["the image provider's resolver reads a stored brand's assets from storage, and nothing for an unknown id", async () => {
    const read = await assetResolverFor(storage, SLUG)(approved.id);
    assert.equal(read?.mime, "image/png");
    assert.ok(read!.bytes.equals(Buffer.concat([PNG, Buffer.from("a")])));
    assert.equal(await assetResolverFor(storage, SLUG)("0123456789abcdef"), undefined);
    // Without storage, or for a brand storage does not hold, the folder is read (an example profile copy: never the real profiles).
    cpSync(EXAMPLE, join(root, "profiles", "folder-brand"), { recursive: true });
    for (const s of [undefined, storage]) assert.equal(await assetResolverFor(s, "folder-brand")("0123456789abcdef"), undefined);
    assert.equal(existsSync(join(root, "profiles", "missing-brand")), false);
  }],
  ["the raster fonts of a stored brand are its font assets, served through the resolver", async () => {
    const font = await library.register(Buffer.from("not really a font"), { kind: "font", family: "Fixture Face", destRelPath: "face.woff2" });
    const guarded = guardStorage(storage);
    await seed("fonts-one");
    const ws = await storedChatWorkspace((await resolveStored(guarded, SLUG))!, "fonts-one");
    const fonts = await ws!.fonts({} as never)();
    assert.deepEqual(fonts.fontFaces, [{ family: "Fixture Face", url: `http://render.local/assets/${font.id}` }]);
    assert.equal(typeof (await fonts.resolve!(font.id))?.path, "string");
    assert.equal(await fonts.resolve!("0123456789abcdef"), undefined);
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(error as Error).message.split("\n").slice(0, 8).join(" | ")}`);
  }
}
closers.forEach((close) => close());
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
