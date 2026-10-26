import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/**
 * The editor's read endpoints for a brand served from storage (S10a), over real HTTP against the routers and the memory
 * repositories: no database, no bucket, no `profiles/` folder for the brand. `BRAND_PROFILES_DIR` points at an empty
 * directory and the last test checks nothing was created in it.
 */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-read-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");
process.env.EDITOR_THUMB_CACHE_DIR = join(root, "thumbs");

const { default: express } = await import("express");
const { createStorageAssetLibrary } = await import("../../../../system/assets/storage-library.js");
const { profilesRouter } = await import("./profiles.js");
const { assetsRouter } = await import("./assets.js");
const { renderRouter } = await import("./render.js");
const { storedBrandGuard } = await import("../stored-read.js");
const { chatRouter } = await import("./chat.js");
const { composeRouter } = await import("./compose.js");
const { exportRouter } = await import("./export.js");
const { closeSharedBrowser } = await import("../browser.js");
const { NonePieceGenerator } = await import("../ai/none.js");

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SLUG = "stored-example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";

const repos = createMemoryRepositories();
const objects = new FakeObjectStore();
const brand = await repos.brands.create({ slug: SLUG, displayName: "Stored Example" }, meta);
await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
// A cut-over brand whose folder is still on disk is served from storage only.
const twin = await repos.brands.create({ slug: "folder-twin", displayName: "Folder Twin" }, meta);
await repos.brands.markCutover(twin.id, { ...meta, expectedVersion: twin.version });
mkdirSync(join(root, "profiles", "folder-twin"), { recursive: true });
// A brand storage knows but has not cut over is still a folder.
await repos.brands.create({ slug: "not-cut-over", displayName: "Not Cut Over" }, meta);
// An archived brand that was cut over is still served from storage, and listed.
const old = await repos.brands.create({ slug: "archived-cut", displayName: "Archived Cut" }, meta);
const oldCut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
await repos.brands.archive(old.id, { ...meta, expectedVersion: oldCut.version });
const tokens = JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8"));
await repos.documents.put(brand.id, "tokens", "", { json: tokens, schemaVersion: 1 }, meta);
await repos.documents.put(brand.id, "template", "extra-layout", { json: { id: "extra-layout", canvas: { w: 1080, h: 1350 }, zones: { background: { policy: "fill" }, footer: { height: 0, logo: "none", pagination: "none" }, margins: { top: 0, right: 0, bottom: 0, left: 0 } }, slides: { cover: { slots: [] }, step: { slots: [] }, closing: { slots: [] } } }, schemaVersion: 1 }, meta);
const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
const image = await library.register(TINY_PNG);
const font = await library.register(Buffer.from("wOF2 not a real font"), { destRelPath: "face.woff2", family: "Test Family" });
const hidden = await library.register(Buffer.concat([TINY_PNG, Buffer.from("x")]));
await repos.assets.update(brand.id, hidden.id, { status: "hidden" }, { ...meta, expectedVersion: 1 });

const document = {
  schemaVersion: 1, id: SLUG, title: "Stored carousel", createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: STAMP },
  slides: [{ id: "s1", kind: "cover", background: { mode: "asset", assetId: image.id, pinned: false, source: "library" }, objects: [] }],
};
const carousel = await repos.carousels.create(brand.id, { slug: "week-one", title: "Stored carousel", document: { json: document, schemaVersion: 1 } }, meta);

// A dot folder, like the real `~/.cache` the cache lives in.
const blobDir = join(root, ".blobs");
const storage = {
  brands: repos.brands,
  documents: repos.documents,
  assets: repos.assets,
  carousels: repos.carousels,
  exports: repos.exports,
  files: objects,
  blobs: (brandId: string) => new BlobCache(objects, brandId, blobDir),
};
// A storage whose reads fail, and one whose carousel listing names a head that is gone by the time it is read.
const failing = { ...storage, brands: { getBySlug: async () => { throw new Error("connection refused"); }, list: async () => { throw new Error("connection refused"); } } };
const racing = { ...storage, carousels: { get: repos.carousels.get.bind(repos.carousels), save: repos.carousels.save.bind(repos.carousels), setStatus: repos.carousels.setStatus.bind(repos.carousels), list: async (id: string) => { const heads = await repos.carousels.list(id); return [...heads, ...heads.map((h) => ({ ...h, value: { ...h.value, slug: "vanished" } }))]; } } };
const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(profilesRouter(storage));
app.use(assetsRouter(storage));
// The folder routers sit behind the guard exactly as in index.ts: for a stored brand none of them may be reached.
app.use(renderRouter(storage));
app.use(chatRouter(() => new NonePieceGenerator()));
app.use(composeRouter(() => new NonePieceGenerator()));
app.use(exportRouter(storage));
const failingApp = express();
failingApp.use("/api/profiles/:slug", storedBrandGuard(failing));
failingApp.use(profilesRouter(failing));
const racingApp = express();
racingApp.use(profilesRouter(racing));
const failingServer = failingApp.listen(0);
const racingServer = racingApp.listen(0);
await Promise.all([failingServer, racingServer].map((srv) => new Promise<void>((resolve) => srv.once("listening", resolve))));
const urlOf = (srv: typeof failingServer) => `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/profiles`;
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles`;

const json = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, etag: res.headers.get("etag"), body: res.headers.get("content-type")?.includes("json") ? await res.json() : undefined, res };
};

const tests: Array<[string, () => Promise<void>]> = [
  ["the brand, its style and its templates come from the stored documents", async () => {
    assert.equal((await json(`/${SLUG}/brand`)).body.copy.wordmark, tokens.copy.wordmark);
    assert.ok(Array.isArray((await json(`/${SLUG}/style`)).body.sources));
    const { body } = await json(`/${SLUG}/templates`);
    assert.deepEqual(body.templates.map((t: { id: string; origin: string }) => [t.id, t.origin]), [["explicativo", "engine-default"], ["extra-layout", "brand-override"]]);
    assert.equal((await json(`/${SLUG}/template/extra-layout`)).body.id, "extra-layout");
    assert.equal((await json(`/${SLUG}/template/__free__`)).body.id, "__free__");
    assert.equal((await json(`/${SLUG}/template/missing`)).status, 400);
  }],
  ["a stored brand is listed, a brand storage has not cut over is not, and a cut-over slug replaces its folder entry", async () => {
    const slugs = (await json("/")).body.profiles.map((p: { slug: string }) => p.slug);
    assert.ok(slugs.includes(SLUG));
    assert.ok(!slugs.includes("not-cut-over"));
    // The folder of a cut-over brand is still on disk: it is listed once, as stored data, with no folder card.
    const twin = (await json("/")).body.profiles.filter((p: { slug: string }) => p.slug === "folder-twin");
    assert.deepEqual(twin, [{ slug: "folder-twin", hasBrand: true }]);
  }],
  ["an archived cut-over brand is not in the picker (nor is its folder twin), but the guard still serves it as stored", async () => {
    mkdirSync(join(root, "profiles", "archived-cut"), { recursive: true });
    assert.ok(!(await json("/")).body.profiles.some((p: { slug: string }) => p.slug === "archived-cut"));
    assert.equal((await json("/archived-cut/carousels/x/stats")).status, 501);
  }],
  ["a storage outage while the page loads fails the PNG with a 503 and is not cached", async () => {
    const real = storage.blobs;
    let broken = true;
    const flaky = { ...storage, blobs: (brandId: string) => ({ read: async (sha: string) => { if (broken) throw new Error("blob store down"); return real(brandId).read(sha); } }) };
    const flakyApp = express();
    flakyApp.use(renderRouter(flaky));
    const flakyServer = flakyApp.listen(0);
    await new Promise<void>((resolve) => flakyServer.once("listening", resolve));
    const log = console.error;
    console.error = () => {};
    try {
      const url = `${urlOf(flakyServer)}/${SLUG}/carousels/week-one/slides/0/png`;
      const failed = await fetch(url);
      assert.equal(failed.status, 503);
      assert.doesNotMatch(JSON.stringify(await failed.json()), /blob store down/);
      broken = false;
      const ok = await fetch(url);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "image/png");
    } finally {
      console.error = log;
      flakyServer.close();
    }
  }],
  ["a carousel removed between the list and the get is skipped, not a 404 for the whole listing", async () => {
    const res = await fetch(`${urlOf(racingServer)}/${SLUG}/carousels`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { carousels: Array<{ id: string }> }).carousels.map((c) => c.id), ["week-one"]);
  }],
  ["a storage failure is a logged 503 with a clear message, for a folder brand and for the listing, never a folder fallback", async () => {
    const log = console.error;
    console.error = () => {};
    try {
      for (const path of ["/some-folder-brand/brand", "/"]) {
        const res = await fetch(`${urlOf(failingServer)}${path}`);
        assert.equal(res.status, 503, path);
        assert.match(((await res.json()) as { error: string }).error, /almacenamiento/);
      }
    } finally {
      console.error = log;
    }
  }],
  ["the carousel listing and the document come from the repository, and the document carries its version as an ETag", async () => {
    const list = (await json(`/${SLUG}/carousels`)).body.carousels;
    assert.deepEqual(list, [{ id: "week-one", title: "Stored carousel", status: "draft", updatedAt: STAMP, slideCount: 1 }]);
    const one = await json(`/${SLUG}/carousels/week-one`);
    assert.equal(one.status, 200);
    assert.equal(one.etag, `"${carousel.version}"`);
    assert.equal(one.body.id, "week-one");
    assert.equal(one.body.slides[0].background.assetId, image.id);
    // The same version is "not modified"; a save moves the tag.
    assert.equal((await fetch(`${base}/${SLUG}/carousels/week-one`, { cache: "no-cache", headers: { "If-None-Match": one.etag! } })).status, 304);
    await repos.carousels.save(carousel.id, { document: { json: { ...document, updatedAt: "2026-08-18T10:00:00.000Z" }, schemaVersion: 1 } }, { ...meta, expectedVersion: carousel.version });
    assert.equal((await json(`/${SLUG}/carousels/week-one`)).etag, `"${carousel.version + 1}"`);
  }],
  ["a scheduled carousel reads as exported, an unknown one is 404 and a bad id is 400", async () => {
    await repos.carousels.setStatus(carousel.id, { status: "scheduled", scheduledFor: STAMP }, { ...meta, expectedVersion: carousel.version + 1 });
    assert.equal((await json(`/${SLUG}/carousels/week-one`)).body.status, "exported");
    assert.equal((await json(`/${SLUG}/carousels/nope`)).status, 404);
    assert.equal((await json(`/${SLUG}/carousels/Bad_Id`)).status, 400);
  }],
  ["the asset library lists virtual paths and usage; files and thumbnails are served by id, a hidden asset is not", async () => {
    const { entries } = (await json(`/${SLUG}/assets`)).body;
    const entry = entries.find((e: { id: string }) => e.id === image.id);
    assert.equal(entry.path, `assets/${image.id}.png`);
    assert.equal(entry.usageCount, 1);
    const file = await fetch(`${base}/${SLUG}/assets/files/${image.id}.png`);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), TINY_PNG);
    const thumb = await fetch(`${base}/${SLUG}/assets/thumbs/${image.id}.png`);
    assert.equal(thumb.headers.get("content-type"), "image/webp");
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    assert.ok(thumbBytes.length > 12);
    assert.equal(`${thumbBytes.subarray(0, 4)}${thumbBytes.subarray(8, 12)}`, "RIFFWEBP");
    assert.equal((await fetch(`${base}/${SLUG}/assets/thumbs/${hidden.id}.png`)).status, 404);
    assert.equal((await fetch(`${base}/${SLUG}/assets/thumbs/${"0".repeat(16)}.png`)).status, 404);
    assert.equal((await fetch(`${base}/${SLUG}/assets/files/${hidden.id}.png`)).status, 404);
    assert.equal((await fetch(`${base}/${SLUG}/assets/files/${"0".repeat(16)}.png`)).status, 404);
  }],
  ["every route without a stored branch is gated for a stored brand: chat and outputs answer empty, the rest 501, and no folder appears", async () => {
    const chat = await json(`/${SLUG}/carousels/week-one/chat`);
    assert.deepEqual(chat.body, { records: [], pendingProposalId: null, currency: { code: "USD", rate: 1 } });
    assert.deepEqual((await json(`/${SLUG}/carousels/week-one/outputs`)).body, { versions: [] });
    for (const path of ["stats"]) {
      const res = await json(`/${SLUG}/carousels/week-one/${path}`);
      assert.equal(res.status, 501, path);
    }
    assert.equal((await json(`/${SLUG}/assets/0123456789abcdef/generation`)).status, 501);
    assert.match((await json(`/${SLUG}/carousels/week-one/stats`)).body.error, /próximo cambio/);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
  }],
  ["the gate sees the decoded slug, so an encoded one cannot dodge it", async () => {
    const encoded = SLUG.replace("-", "%2D");
    assert.equal((await json(`/${encoded}/carousels/week-one/stats`)).status, 501);
    assert.equal((await json(`/${encoded}/carousels/week-one`, { method: "DELETE" })).status, 405);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
  }],
  ["an invalid template params JSON is a 400, and the free template does not need it", async () => {
    assert.equal((await json(`/${SLUG}/template/extra-layout?params=%7Bnope`)).status, 400);
    assert.equal((await json(`/${SLUG}/template/__free__?params=%7Bnope`)).status, 200);
  }],
  ["a slide renders from storage: the preview HTML points at this server, the PNG is drawn from the blob cache", async () => {
    const html = await (await fetch(`${base}/${SLUG}/carousels/week-one/slides/0/html`)).text();
    assert.ok(html.includes(`/api/profiles/${SLUG}/assets/files/${image.id}`));
    assert.ok(!html.includes("render.local"));
    assert.ok(html.includes(`font-family: "Test Family";\n    src: url("/api/profiles/${SLUG}/assets/files/${font.id}") format("woff2");`));
    const contrast = await json(`/${SLUG}/carousels/week-one/slides/0/contrast`);
    assert.equal(contrast.status, 200);
    assert.ok(Array.isArray(contrast.body.measurements));
    const png = await fetch(`${base}/${SLUG}/carousels/week-one/slides/0/png`);
    assert.equal(png.status, 200);
    assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), "PNG");
    assert.equal((await fetch(`${base}/${SLUG}/carousels/week-one/slides/9/png`)).status, 404);
  }],
  ["writes other than the carousel save are refused for a stored brand (the save itself is in stored-write.test.ts), and nothing is created in the profiles folder", async () => {
    const del = await json(`/${SLUG}/carousels/week-one`, { method: "DELETE" });
    assert.equal(del.status, 405);
    assert.match(del.body.error, /almacenamiento/);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
    // A folder brand (no profile here) is untouched by the guard and answers as before.
    assert.equal((await json("/not-cut-over/brand")).status, 422);
  }],
  ["a render error on a slide (an asset hidden after it was placed) is a 500, not a storage outage", async () => {
    await repos.carousels.create(brand.id, { slug: "uses-hidden", title: "Uses hidden", document: { json: { ...document, id: "uses-hidden", slides: [{ id: "s1", kind: "cover", background: { mode: "asset", assetId: hidden.id, pinned: false, source: "library" }, objects: [] }] }, schemaVersion: 1 } }, meta);
    for (const path of ["png", "contrast"]) {
      const res = await fetch(`${base}/${SLUG}/carousels/uses-hidden/slides/0/${path}`);
      assert.equal(res.status, 500, path);
      assert.doesNotMatch(JSON.stringify(await res.json()), /almacenamiento/);
    }
  }],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split("\n").slice(0, 8).join(" | ")}`);
  }
}

await closeSharedBrowser();
server.close();
failingServer.close();
racingServer.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
