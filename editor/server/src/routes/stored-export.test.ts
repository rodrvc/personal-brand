import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { carouselExportKey, carouselExportPrefix } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";
import { createStorageAssetLibrary } from "../../../../system/assets/storage-library.js";

/** Export of a stored carousel (S10b2): over real HTTP, memory repositories, a fake object store and a fake renderer (no Chromium). */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-export-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { exportRouter } = await import("./export.js");
const { storedBrandGuard } = await import("../stored-read.js");

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const slide = (id: string, pending = false) => ({ id, kind: "cover", background: { mode: "color", colorKey: "ink", pinned: false, source: "manual", ...(pending ? { pending: true } : {}) }, objects: [] });
const document = (id: string, slides: object[] = [slide("s1"), slide("s2")]) => ({ schemaVersion: 1, id, title: id, createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: STAMP }, slides });

const repos = createMemoryRepositories();
const objects = new FakeObjectStore();
async function makeBrand(slug: string) {
  const brand = await repos.brands.create({ slug, displayName: slug }, meta);
  const cut = await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
  await repos.documents.put(brand.id, "tokens", "", { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 }, meta);
  return { brand, cut };
}
const add = (brandId: string, id: string, doc: Record<string, unknown>) => repos.carousels.create(brandId, { slug: id, title: id, document: { json: doc, schemaVersion: 1 } }, meta);
const { brand } = await makeBrand("export-example");
const draft = await add(brand.id, "draft-one", document("draft-one"));
const pending = await add(brand.id, "pending-one", document("pending-one", [slide("s1", true)]));

let onRender: () => Promise<void> = async () => {};
let renderCalls = 0;
let sawResolve = false;
const render = async (opts: { outputDir: string; doc: unknown; resolve?: unknown }): Promise<string[]> => {
  renderCalls += 1;
  sawResolve = typeof opts.resolve === "function";
  await onRender();
  return (opts.doc as { slides: unknown[] }).slides.map((_, i) => {
    const path = join(opts.outputDir, `${String(i + 1).padStart(2, "0")}.png`);
    writeFileSync(path, PNG);
    return path;
  });
};

const storage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, exports: repos.exports, revisions: repos.revisions, chat: repos.chat, files: objects, blobs: (brandId: string) => new BlobCache(objects, brandId, join(root, ".blobs")) };
const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(exportRouter(storage, render as never));
// A storage whose carousel reads fail: every export route answers 503, never a raw 500.
const broken = { ...storage, carousels: { ...repos.carousels, get: async () => { throw new Error("connection refused"); } } };
const brokenApp = express();
brokenApp.use(express.json());
brokenApp.use("/api/profiles/:slug", storedBrandGuard(broken));
brokenApp.use(exportRouter(broken, render as never));
const brokenServer = brokenApp.listen(0, "127.0.0.1");
const server = app.listen(0, "127.0.0.1");
await Promise.all([server, brokenServer].map((srv) => new Promise<void>((resolve) => srv.once("listening", resolve))));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles/export-example/carousels`;

const brokenBase = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}/api/profiles/export-example/carousels`;
const post = (id: string, body: object = {}) => fetch(`${base}/${id}/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function finished(res: Response): Promise<{ status: string; version?: number; error?: string }> {
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  const { jobId, carouselId } = (await res.json()) as { jobId: string; carouselId: string };
  for (let i = 0; i < 200; i++) {
    const job = (await (await fetch(`${base}/${carouselId}/export/${jobId}`)).json()) as { status: string; version?: number; error?: string };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("export never finished");
}
const outputs = async (id: string) => ((await (await fetch(`${base}/${id}/outputs`)).json()) as { versions: Array<{ version: number; slideCount?: number }> }).versions;
const row = () => repos.carousels.get(brand.id, "draft-one", (b) => b);

const tests: Array<[string, () => Promise<void>]> = [
  ["a candidate asset the export used becomes approved; one it did not use stays candidate", async () => {
    const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
    const used = await library.register(Buffer.from("used piece"), { destRelPath: "used.png" });
    const unused = await library.register(Buffer.from("unused piece"), { destRelPath: "unused.png" });
    for (const asset of [used, unused]) await repos.assets.update(brand.id, asset.id, { status: "candidate" }, { ...meta, expectedVersion: (await repos.assets.get(brand.id, asset.id)).version });
    const withAsset = { ...slide("s1"), background: { mode: "asset", assetId: used.id, pinned: false, source: "library" } };
    await add(brand.id, "asset-one", document("asset-one", [withAsset]));
    assert.equal((await finished(await post("asset-one"))).status, "done");
    assert.deepEqual([(await repos.assets.get(brand.id, used.id)).value.status, (await repos.assets.get(brand.id, unused.id)).value.status], ["approved", "candidate"]);
  }],
  ["an export lands in the bucket under the carousel's export keys, is listed, and flips draft to exported", async () => {
    const job = await finished(await post("draft-one"));
    assert.deepEqual([job.status, job.version], ["done", 1]);
    assert.ok(sawResolve, "the renderer is handed the stored asset resolver");
    const keys = (await objects.list(carouselExportPrefix(brand.id, draft.id, 1))).map((o) => o.key).sort();
    assert.deepEqual(keys, ["01.png", "02.png", "manifest.json"].map((f) => carouselExportKey(brand.id, draft.id, 1, f)));
    assert.deepEqual((await objects.get(keys[0]!)).body, PNG);
    const manifest = JSON.parse((await objects.get(carouselExportKey(brand.id, draft.id, 1, "manifest.json"))).body.toString());
    assert.deepEqual([manifest.version, manifest.slides, manifest.files], [1, ["s1", "s2"], ["01.png", "02.png"]]);
    assert.deepEqual(await outputs("draft-one"), [{ version: 1, exportedAt: (await repos.exports.list(draft.id))[0]!.finishedAt, slideCount: 2 }]);
    const after = await row();
    assert.equal(after.value.status, "exported");
    assert.equal(existsSync(join(root, "profiles")), false, "no folder appears");
  }],
  ["a second export reserves the next version and leaves an exported carousel's row alone", async () => {
    const before = (await row()).version;
    assert.equal((await finished(await post("draft-one"))).version, 2);
    assert.equal((await row()).version, before);
    assert.deepEqual((await outputs("draft-one")).map((v) => v.version), [1, 2]);
  }],
  ["two exports of the same draft queued back to back both succeed: the second finds it already exported", async () => {
    await add(brand.id, "twice-one", document("twice-one"));
    const [a, b] = await Promise.all([post("twice-one"), post("twice-one")]);
    assert.deepEqual([(await finished(a)).status, (await finished(b)).status], ["done", "done"]);
    assert.equal((await repos.carousels.get(brand.id, "twice-one", (x) => x)).value.status, "exported");
  }],
  ["pending pieces are refused with 409 and nothing is reserved, unless allowPending", async () => {
    const calls = renderCalls;
    assert.equal((await post("pending-one")).status, 409);
    assert.equal((await repos.exports.list(pending.id)).length, 0);
    assert.equal(renderCalls, calls);
    assert.equal((await finished(await post("pending-one", { allowPending: true }))).status, "done");
  }],
  ["a failed render marks the export failed, lists nothing and writes no object", async () => {
    const failing = await add(brand.id, "failing-one", document("failing-one"));
    onRender = async () => { throw new Error("render exploded"); };
    try {
      const job = await finished(await post("failing-one"));
      assert.deepEqual([job.status, job.error], ["error", "render exploded"]);
    } finally {
      onRender = async () => {};
    }
    assert.deepEqual((await repos.exports.list(failing.id)).map((e) => e.status), ["failed"]);
    assert.deepEqual(await outputs("failing-one"), []);
    assert.equal((await objects.list(carouselExportPrefix(brand.id, failing.id, 1))).length, 0);
  }],
  ["a save that lands while the export renders keeps its work: the export is complete, the status flip is refused as an error", async () => {
    const racing = await add(brand.id, "racing-one", document("racing-one"));
    const fail = repos.exports.fail;
    let failCalls = 0;
    repos.exports.fail = (async (...args: Parameters<typeof fail>) => (failCalls += 1, fail(...args))) as typeof fail;
    onRender = async () => void (await repos.carousels.save(racing.id, { title: "Edited meanwhile", document: { json: document("racing-one"), schemaVersion: 1 } }, { ...meta, expectedVersion: racing.version }));
    try {
      const job = await finished(await post("racing-one"));
      assert.deepEqual([job.status, job.version], ["error", 1], "the complete export's version is still reported");
    } finally {
      onRender = async () => {};
      repos.exports.fail = fail;
    }
    assert.equal(failCalls, 0, "a row that completed is never marked failed");
    const current = await repos.carousels.get(brand.id, "racing-one", (b) => b);
    assert.deepEqual([current.value.title, current.value.status], ["Edited meanwhile", "draft"]);
    assert.deepEqual((await repos.exports.list(racing.id)).map((e) => e.status), ["done"]);
  }],
  ["a stored export is polled by its job id: another carousel's id or an unknown id is 404", async () => {
    const res = await post("draft-one");
    const { jobId } = (await res.clone().json()) as { jobId: string };
    assert.equal((await finished(res)).status, "done");
    assert.equal((await fetch(`${base}/draft-one/export/${jobId}`)).status, 200);
    assert.equal((await fetch(`${base}/pending-one/export/${jobId}`)).status, 404);
    assert.equal((await fetch(`${base.replace("export-example", "other-example")}/draft-one/export/${jobId}`)).status, 404);
    assert.equal((await fetch(`${base}/draft-one/export/no-such-job`)).status, 404);
  }],
  ["a storage outage answers 503 on export and on outputs", async () => {
    const exported = await fetch(`${brokenBase}/draft-one/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(exported.status, 503);
    assert.match(((await exported.json()) as { error: string }).error, /almacenamiento|disponible/i);
    assert.equal((await fetch(`${brokenBase}/draft-one/outputs`)).status, 503);
  }],
  ["an approval race (the asset changed after the library was listed) is retried once and audited as a status change", async () => {
    const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
    const piece = await library.register(Buffer.from("raced piece"), { destRelPath: "raced.png" });
    await repos.assets.update(brand.id, piece.id, { status: "candidate" }, { ...meta, expectedVersion: (await repos.assets.get(brand.id, piece.id)).version });
    const withAsset = { ...slide("s1"), background: { mode: "asset", assetId: piece.id, pinned: false, source: "library" } };
    const raced = await add(brand.id, "approval-one", document("approval-one", [withAsset]));
    // The row is touched after the library was listed, so the version the export holds is stale.
    onRender = async () => void (await repos.assets.update(brand.id, piece.id, { tags: ["touched"] }, { ...meta, expectedVersion: (await repos.assets.get(brand.id, piece.id)).version }));
    try {
      assert.equal((await finished(await post("approval-one"))).status, "done");
    } finally {
      onRender = async () => {};
    }
    const after = await repos.assets.get(brand.id, piece.id);
    assert.equal(after.value.status, "approved");
    assert.deepEqual((await repos.exports.list(raced.id)).map((e) => e.status), ["done"]);
    const audit = (await repos.revisions.list("brand_asset", after.id)).at(-1)!;
    assert.deepEqual([audit.reason, audit.author], ["status", "editor:export"]);
  }],
  ["an archived brand refuses to export (403) and an unknown carousel is 404", async () => {
    const { brand: old, cut } = await makeBrand("old-export");
    const doc = await add(old.id, "week-one", document("week-one"));
    await repos.brands.archive(old.id, { ...meta, expectedVersion: cut.version });
    const res = await fetch(`${base.replace("export-example", "old-export")}/week-one/export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 403);
    assert.equal((await repos.exports.list(doc.id)).length, 0);
    assert.equal((await post("nope-one")).status, 404);
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
server.close();
brokenServer.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
