import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { NotFoundError, ObjectNotFoundError, PreconditionFailedError } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/** The planner for a stored brand (S10b5): plan preview, plan/apply (resume, races), generating regenerate and the stats history, over real HTTP, the memory repositories and a fake generator (no network). */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-compose-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { createStorageAssetLibrary } = await import("../../../../system/assets/storage-library.js");
const { composeRouter } = await import("./compose.js");
const { storedBrandGuard } = await import("../stored-read.js");
const { approveCandidates } = await import("../stored-assets.js");
const { storedPlannerSource } = await import("../stored-compose.js");
const { setPlanClock } = await import("./compose.js");
const { guardStorage, resolveStored } = await import("../stored-read.js");
const { putBlob } = await import("@personal-brand/storage/blob");
type EditorStorage = import("../stored-read.js").EditorStorage;

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EXAMPLE = join(REPO, "profiles", "example");
const SLUG = "compose-example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const tokens = { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 };

const repos = createMemoryRepositories();
const brand = await repos.brands.create({ slug: SLUG, displayName: "Compose Example" }, meta);
await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
await repos.documents.put(brand.id, "tokens", "", tokens, meta);
const objects = new FakeObjectStore();
const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
const storage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, exports: repos.exports, revisions: repos.revisions, chat: repos.chat, files: objects, blobs: (brandId: string) => new BlobCache(new FakeObjectStore(), brandId, join(root, ".blobs")) };

/** A generator that never leaves the process: copy per slide, a 1x1 PNG per image, and optional failure on the n-th image. */
const calls = { prompts: [] as string[], languages: [] as Array<string | undefined>, images: 0, failOnImage: 0, hold: undefined as Promise<void> | undefined, onImage: undefined as ((n: number) => Promise<void>) | undefined };
const generator = {
  draftCopy: async (plan: { slides: Array<{ slideId: string }>; brand?: { language?: string } }) => (calls.languages.push(plan.brand?.language), { slides: plan.slides.map((s) => ({ slideId: s.slideId, headline: `Headline ${s.slideId}`, body: "Body" })), model: "fake", costCents: 0 }),
  generateImage: async (spec: { prompt: string }) => {
    calls.prompts.push(spec.prompt);
    const n = ++calls.images;
    await calls.onImage?.(n);
    await calls.hold;
    if (n === calls.failOnImage) throw new Error("provider down");
    return { buffer: PNG, mime: "image/png", model: "fake-image", costCents: 4, usedReferenceIds: [] };
  },
  completeJson: async () => ({ json: {}, model: "fake", costCents: 0 }),
  acceptsReference: () => false,
};

async function serve(extra: Partial<EditorStorage>): Promise<{ base: string; close(): void }> {
  const app = express();
  app.use(express.json());
  app.use("/api/profiles/:slug", storedBrandGuard({ ...storage, ...extra }));
  app.use(composeRouter(() => generator, { ...storage, ...extra }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles`, close: () => void server.close() };
}
const main = await serve({});
const post = async (path: string, body: unknown, base = main.base) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any, etag: res.headers.get("etag") };
};
const row = (id: string) => repos.carousels.get(brand.id, id, (b) => b);
const slide = (id: string, objects: object[] = []) => ({ id, kind: "step", background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" }, objects });
const base = { schemaVersion: 1, createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "weekly tips", createdAt: STAMP } };

const tests: Array<[string, () => Promise<void>]> = [
  ["a plan preview for a stored brand plans from the stored library, writes nothing and refuses what the folder refuses", async () => {
    const photo = await library.register(Buffer.concat([PNG, Buffer.from("library")]), { kind: "photo", origin: "manual", status: "approved", tags: ["tips"] });
    const preview = await post(`/${SLUG}/carousels?mode=plan`, { id: "planned", prompt: "weekly tips, 2 steps" });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.plan.slideKinds, ["cover", "step", "step", "closing"]);
    assert.equal(preview.body.plan.visualSlots.some((v: { assetId?: string }) => v.assetId === photo.id), true, "the approved stored piece is used before generating");
    assert.equal(preview.body.generatedPieces > 0 && preview.body.estimatedCostCents > 0, true);
    await assert.rejects(row("planned"), NotFoundError);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
    for (const [bad, status] of [[{ id: "planned2" }, 400], [{ id: "planned2", prompt: "x", templateId: null }, 400], [{ id: "planned2", prompt: "x", assetIds: "a" }, 400], [{ id: 7, prompt: "x" }, 400]] as const) assert.equal((await post(`/${SLUG}/carousels?mode=plan`, bad)).status, status, JSON.stringify(bad));
    await repos.carousels.create(brand.id, { slug: "taken", title: "T", document: { json: { ...base, id: "taken", title: "T", slides: [] }, schemaVersion: 1 } }, meta);
    assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "taken", prompt: "x" })).status, 409);
  }],
  ["plan/apply stores the composed carousel, with each generated image a candidate asset in the bucket carrying its generation metadata", async () => {
    assert.equal((await post(`/${SLUG}/carousels/never-planned/plan/apply`, {})).status, 404);
    const applied = await post(`/${SLUG}/carousels/planned/plan/apply`, {});
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const stored = await row("planned");
    assert.equal(stored.value.title, applied.body.title);
    const generated = (await repos.assets.list(brand.id)).filter((a) => a.value.origin === "ai");
    assert.equal(generated.length > 0 && generated.every((a) => a.value.status === "candidate"), true);
    assert.deepEqual(generated[0]!.value.generation, { prompt: generated[0]!.value.generation!.prompt, model: "fake-image", costCents: 4, createdAt: generated[0]!.value.generation!.createdAt, carouselId: "planned", slot: generated[0]!.value.generation!.slot });
    assert.equal((await objects.get(generated[0]!.value.blobKey)).body.equals(PNG), true);
    assert.equal((await post(`/${SLUG}/carousels/planned/plan/apply`, {})).status, 404, "the plan is spent");
  }],
  ["a generation failing mid-apply answers 202 with the slots done so far already stored, and a retry resumes from them without paying again", async () => {
    const preview = await post(`/${SLUG}/carousels?mode=plan`, { id: "flaky", prompt: "weekly tips" });
    assert.equal(preview.status, 201);
    const total = preview.body.generatedPieces as number;
    assert.equal(total >= 2, true, "the plan has slots to resume");
    const start = calls.images;
    try {
      calls.failOnImage = start + 2;
      const partial = await post(`/${SLUG}/carousels/flaky/plan/apply`, {});
      assert.equal(partial.status, 202);
      assert.equal(partial.body.planDropped, false, "a provider failure keeps the plan for a retry");
      assert.match(partial.body.error, /provider down/);
      assert.equal(JSON.stringify((await row("flaky")).value.document).includes('"source":"ai"'), true, "the first generated slot was persisted");
      const afterFirst = (await row("flaky")).version;
      assert.equal(afterFirst, 2, "the first write created the row (v1) and the first slot was saved at the version it named (v2)");
      assert.equal((await post(`/${SLUG}/carousels/flaky/plan/apply`, {})).status, 201);
      assert.equal(calls.images - start, total + 1, "the retry generated only the slots still missing: one failed attempt, then total - 1");
      assert.equal((await row("flaky")).version > afterFirst, true, "the retry saved on top of the first run's version");
    } finally {
      calls.failOnImage = 0;
    }
  }],
  ["a save landing mid-apply keeps the user's version (202, plan dropped, nothing regenerated or overwritten); two applies at once are refused (409)", async () => {
    assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "raced", prompt: "weekly tips" })).status, 201);
    const start = calls.images;
    try {
      calls.onImage = async (n) => {
        if (n !== start + 1) return;
        const current = await row("raced");
        await repos.carousels.save(current.id, { title: "Edited by the user", document: { json: { ...(current.value.document as object), title: "Edited by the user" }, schemaVersion: 1 } }, { ...meta, expectedVersion: current.version });
      };
      const raced = await post(`/${SLUG}/carousels/raced/plan/apply`, {});
      assert.equal(raced.status, 202, JSON.stringify(raced.body));
      assert.equal(raced.body.planDropped, true);
      assert.equal((await row("raced")).value.title, "Edited by the user", "the user's save is what the row holds");
      assert.equal((await row("raced")).version, 2, "v1 was the apply's first write, v2 the user's save; the apply's own later write was refused");
      assert.equal(calls.images - start, 1, "the apply stopped at the conflict");
      assert.equal((await post(`/${SLUG}/carousels/raced/plan/apply`, {})).status, 404, "a stale plan is spent, not retried over the user's version");
    } finally {
      calls.onImage = undefined;
    }
    assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "twice", prompt: "weekly tips" })).status, 201);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    calls.hold = new Promise<void>((resolve) => (release = resolve));
    calls.onImage = async () => started();
    try {
      const first = post(`/${SLUG}/carousels/twice/plan/apply`, {});
      await running;
      assert.equal((await post(`/${SLUG}/carousels/twice/plan/apply`, {})).status, 409, "the second apply would pay for the same slots");
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "twice", prompt: "other" })).status, 409, "a re-plan would replace the plan being paid for");
      release();
      assert.equal((await first).status, 201);
    } finally {
      release();
      calls.hold = undefined;
      calls.onImage = undefined;
    }
  }],
  ["the first write of a stored apply only creates: a carousel that appeared since the preview is a 409, left as it is, and the plan is dropped", async () => {
    assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "appeared", prompt: "weekly tips" })).status, 201);
    await repos.carousels.create(brand.id, { slug: "appeared", title: "Mine", document: { json: { ...base, id: "appeared", title: "Mine", slides: [] }, schemaVersion: 1 } }, meta);
    const images = calls.images;
    const applied = await post(`/${SLUG}/carousels/appeared/plan/apply`, {});
    assert.equal(applied.status, 409, JSON.stringify(applied.body));
    assert.equal(applied.body.planDropped, true);
    assert.equal((await row("appeared")).value.title, "Mine");
    assert.equal((await row("appeared")).version, 1, "not overwritten");
    assert.equal(calls.images, images, "nothing was generated");
    assert.equal((await post(`/${SLUG}/carousels/appeared/plan/apply`, {})).status, 404);
  }],
  ["a pending plan is forgotten after an hour, but never while its apply is running", async () => {
    let now = Date.parse(STAMP);
    setPlanClock(() => now);
    try {
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "stale", prompt: "weekly tips" })).status, 201);
      now += 61 * 60 * 1000;
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "fresh", prompt: "weekly tips" })).status, 201, "any new plan sweeps the old ones");
      assert.equal((await post(`/${SLUG}/carousels/stale/plan/apply`, {})).status, 404);
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => (started = resolve));
      calls.hold = new Promise<void>((resolve) => (release = resolve));
      calls.onImage = async () => started();
      try {
        const first = post(`/${SLUG}/carousels/fresh/plan/apply`, {});
        await running;
        now += 61 * 60 * 1000;
        assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "other", prompt: "weekly tips" })).status, 201);
        release();
        assert.equal((await first).status, 201, "the running apply survived the sweep");
      } finally {
        release();
        calls.hold = undefined;
        calls.onImage = undefined;
      }
    } finally {
      setPlanClock(() => Date.now());
    }
  }],
  ["the TTL runs from the last apply activity, so a partial apply keeps its resume, and an expired plan is a 404 at apply time even if nothing swept it", async () => {
    const min = 60 * 1000;
    let now = Date.parse(STAMP);
    setPlanClock(() => now);
    try {
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "partial", prompt: "weekly tips" })).status, 201);
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "lapsed", prompt: "weekly tips" })).status, 201);
      now += 40 * min;
      calls.failOnImage = calls.images + 1;
      const failed = await post(`/${SLUG}/carousels/partial/plan/apply`, {});
      calls.failOnImage = 0;
      assert.equal(failed.status, 202, JSON.stringify(failed.body));
      assert.equal(failed.body.planDropped, false);
      now += 40 * min; // 80 minutes after the preview, 40 after the last apply
      assert.equal((await post(`/${SLUG}/carousels/lapsed/plan/apply`, {})).status, 404, "never applied: expired at apply time, though nothing swept it");
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "sweeper", prompt: "weekly tips" })).status, 201, "a new plan sweeps by last activity, not creation");
      assert.equal((await post(`/${SLUG}/carousels/partial/plan/apply`, {})).status, 201, "the partial apply resumed");
    } finally {
      setPlanClock(() => Date.now());
    }
  }],
  ["the copy is drafted in the stored config's primary_language (none without one)", async () => {
    const draftIn = async (id: string) => {
      assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id, prompt: "weekly tips" })).status, 201);
      assert.equal((await post(`/${SLUG}/carousels/${id}/plan/apply`, {})).status, 201);
      return calls.languages.at(-1);
    };
    assert.equal(await draftIn("no-config"), undefined);
    await repos.documents.put(brand.id, "config", "", { json: { profile: { primary_language: " fr-FR " } }, schemaVersion: 1 }, meta);
    assert.equal(await draftIn("with-config"), "fr-FR");
  }],
  ["a vanished asset costs 0 (like the folder); any other lookup failure propagates", async () => {
    const source = (get: () => Promise<never>) => storedPlannerSource({ storage: { ...storage, assets: { ...storage.assets, get } } as EditorStorage, brandId: brand.id, slug: SLUG });
    assert.equal(await source(async () => { throw new NotFoundError("gone"); }).costCents("0000000000000000"), 0);
    await assert.rejects(source(async () => { throw new Error("pool exhausted"); }).costCents("0000000000000000"), /pool exhausted/);
  }],
  ["plan/apply on an archived brand is 403", async () => {
    const old = await repos.brands.create({ slug: "old-compose", displayName: "Old" }, meta);
    const cut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
    await repos.documents.put(old.id, "tokens", "", tokens, meta);
    assert.equal((await post(`/old-compose/carousels?mode=plan`, { id: "late", prompt: "x" })).status, 201);
    await repos.brands.archive(old.id, { ...meta, expectedVersion: cut.version });
    assert.equal((await post(`/old-compose/carousels/late/plan/apply`, {})).status, 403);
  }],
  ["a generating regenerate stores a candidate, snapshots the save and moves the ETag; pinned pieces and non-string prompts are refused; a save landing meanwhile is a 409", async () => {
    const piece = (id: string, pinned: boolean) => ({ id, kind: "asset", slot: "media", pinned, locked: false, source: "library", assetId: undefined, awaitingImage: true, fit: "cover" });
    const document = { ...base, id: "regen", title: "Regen", slides: [slide("s1", [piece("img", false), piece("fixed", true), { id: "t", kind: "text", slot: "title", pinned: false, locked: false, source: "manual", text: "old" }])] };
    const created = await repos.carousels.create(brand.id, { slug: "regen", title: "Regen", document: { json: document, schemaVersion: 1 } }, meta);
    const regen = (target: object, extra: object = {}) => post(`/${SLUG}/carousels/regen/regenerate`, { target: { slideId: "s1", ...target }, ...extra });
    const before = (await repos.assets.list(brand.id)).length;
    assert.equal((await regen({ objectId: "fixed" })).status, 400);
    assert.equal((await regen({ objectId: "img" }, { prompt: 7 })).status, 400);
    assert.equal((await regen({})).status, 400);
    assert.equal((await regen({ objectId: 5 })).status, 400, "a non-string objectId is refused before anything is generated");
    assert.equal((await repos.assets.list(brand.id)).length, before, "nothing was generated for a refused request");
    assert.equal((await regen({ objectId: "img" }, { prompt: "fine", preview: true })).status, 200, "the preview still serves");
    const done = await regen({ objectId: "img" }, { prompt: " my words " });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.costCents, 4);
    assert.equal(calls.prompts.at(-1)!.startsWith("my words"), true);
    const asset = done.body.document.slides[0].objects[0].assetId;
    assert.equal((await repos.assets.get(brand.id, asset)).value.status, "candidate");
    assert.equal(done.etag, `"${(await row("regen")).version}"`);
    assert.equal((await repos.revisions.list("carousel", created.id)).at(-1)!.reason, "snapshot");
    assert.equal((await regen({ objectId: "background" })).status, 200);
    assert.equal((await regen({ scope: "unpinned" })).body.document.slides[0].objects[2].text, "Headline s1");
    try {
      calls.onImage = async () => { const current = await row("regen"); await repos.carousels.save(current.id, { title: "Mine", document: { json: current.value.document as Record<string, unknown>, schemaVersion: 1 } }, { ...meta, expectedVersion: current.version }); };
      const conflicted = await regen({ objectId: "img" });
      assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body) + " the regenerate does not overwrite the save that landed during generation");
      assert.equal((await row("regen")).value.title, "Mine");
    } finally {
      calls.onImage = undefined;
    }
  }],
  ["a generating regenerate on an archived brand is 403 and generates nothing", async () => {
    const old = await repos.brands.create({ slug: "old-regen", displayName: "Old" }, meta);
    const cut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
    await repos.documents.put(old.id, "tokens", "", tokens, meta);
    await repos.carousels.create(old.id, { slug: "c", title: "C", document: { json: { ...base, id: "c", title: "C", slides: [slide("s1")] }, schemaVersion: 1 } }, meta);
    await repos.brands.archive(old.id, { ...meta, expectedVersion: cut.version });
    const images = calls.images;
    assert.equal((await post(`/old-regen/carousels/c/regenerate`, { target: { slideId: "s1", objectId: "background" } })).status, 403);
    assert.equal(calls.images, images);
  }],
  ["the stats history skips a sibling that vanished, falls back to the row's updatedAt, and fails whole on any other sibling error", async () => {
    await repos.carousels.create(brand.id, { slug: "no-stamp", title: "N", document: { json: { ...base, id: "no-stamp", title: "N", updatedAt: undefined, slides: [] }, schemaVersion: 1 } }, meta);
    const history = async (carousels: EditorStorage["carousels"]) => { const s = await serve({ carousels }); try { const res = await fetch(`${s.base}/${SLUG}/carousels/regen/stats`); return { status: res.status, body: (await res.json()) as any }; } finally { s.close(); } };
    const failing = (fail: (slug: string) => unknown): EditorStorage["carousels"] => ({ ...storage.carousels, list: storage.carousels.list.bind(storage.carousels), save: storage.carousels.save.bind(storage.carousels), setStatus: storage.carousels.setStatus.bind(storage.carousels), create: storage.carousels.create.bind(storage.carousels), get: (async (brandId: string, slug: string, validate: never) => { if (slug !== "regen" && fail(slug)) throw fail(slug); return storage.carousels.get(brandId, slug, validate); }) as never });
    const ok = await history(failing((slug) => (slug === "flaky" ? new NotFoundError(slug) : undefined)));
    assert.equal(ok.status, 200);
    const ids = ok.body.history.map((h: { carouselId: string }) => h.carouselId);
    assert.equal(ids.includes("flaky"), false, "the vanished sibling is skipped");
    assert.equal(ok.body.history.find((h: { carouselId: string }) => h.carouselId === "no-stamp").updatedAt, (await row("no-stamp")).updatedAt, "no string updatedAt in the document: the row's");
    assert.equal((await history(failing((slug) => (slug === "flaky" ? new Error("pool exhausted") : undefined)))).status, 503, "a storage failure on one sibling is an outage, not a smaller history");
  }],
  ["an outage while applying is the route's error (503, plan kept pending), not a 202; an archived-style refusal is the same", async () => {
    assert.equal((await post(`/${SLUG}/carousels?mode=plan`, { id: "outage", prompt: "weekly tips" })).status, 201);
    const down = await serve({ assets: { ...storage.assets, register: async () => { throw new Error("pool exhausted"); } } });
    try {
      assert.equal((await post(`/${SLUG}/carousels/outage/plan/apply`, {}, down.base)).status, 503);
    } finally {
      down.close();
    }
    assert.equal((await post(`/${SLUG}/carousels/outage/plan/apply`, {})).status, 201, "the plan was still pending");
  }],
  ["the bucket guard lets write-once answers through only from the method that gives them: put refusing an existing key, head not seeing it yet", async () => {
    let heads = 0;
    const files = { ...objects, put: async () => { throw new PreconditionFailedError("k"); }, head: async () => { if (heads++ === 0) throw new ObjectNotFoundError("k"); return { etag: "e", size: PNG.byteLength, metadata: { sha256: (await import("node:crypto")).createHash("sha256").update(PNG).digest("hex") } }; } } as unknown as EditorStorage["files"];
    await putBlob(guardStorage({ ...storage, files }).files, brand.id, PNG);
    assert.equal(heads, 2, "head's not-found was retried, not turned into an outage");
    const wrong = guardStorage({ ...storage, files: { ...files, get: async () => { throw new ObjectNotFoundError("k"); } } as unknown as EditorStorage["files"] });
    await assert.rejects(wrong.files.get("k"), /storage failure/, "only put and head are exempt");
  }],
  ["approving assets reports a non-Error throw by its text", async () => {
    const assets = { ...storage.assets, get: async () => { throw "bucket exploded"; } } as unknown as EditorStorage["assets"];
    await assert.rejects(approveCandidates({ storage: { ...storage, assets }, slug: SLUG, brandId: brand.id }, new Set(["0000000000000000"]), "editor"), /bucket exploded/);
  }],
  ["a folder brand plans and applies through the same planner: sidecar for the candidate, document on disk, plan spent", async () => {
    cpSync(EXAMPLE, join(root, "profiles", "folder-compose"), { recursive: true });
    assert.equal((await post(`/folder-compose/carousels?mode=plan`, { id: "on-disk", prompt: "weekly tips" })).status, 201);
    const applied = await post(`/folder-compose/carousels/on-disk/plan/apply`, {});
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    assert.equal(existsSync(join(root, "profiles", "folder-compose", "carousels", "on-disk", "carousel.json")), true);
    // The example library covers every slot, so the folder's generation path (candidate plus sidecar) is reached by a regenerate.
    const regenerated = await post(`/folder-compose/carousels/on-disk/regenerate`, { target: { slideId: "slide-1", objectId: "background" } });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.body));
    assert.equal(JSON.parse(readFileSync(join(root, "profiles", "folder-compose", "assets", "generated", `${regenerated.body.document.slides[0].background.assetId}.json`), "utf-8")).costCents, 4);
    assert.equal(regenerated.body.costCents, 4);
    assert.equal((await post(`/folder-compose/carousels/on-disk/plan/apply`, {})).status, 404);
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
main.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
