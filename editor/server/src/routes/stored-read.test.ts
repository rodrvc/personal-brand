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
// A brand storage knows but has not cut over is still a folder.
const twin = await repos.brands.create({ slug: "folder-twin", displayName: "Folder Twin" }, meta);
await repos.brands.markCutover(twin.id, { ...meta, expectedVersion: twin.version });
mkdirSync(join(root, "profiles", "folder-twin"), { recursive: true });
await repos.brands.create({ slug: "not-cut-over", displayName: "Not Cut Over" }, meta);
const tokens = JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8"));
await repos.documents.put(brand.id, "tokens", "", { json: tokens, schemaVersion: 1 }, meta);
await repos.documents.put(brand.id, "template", "extra-layout", { json: { id: "extra-layout", canvas: { w: 1080, h: 1350 }, zones: { background: { policy: "fill" }, footer: { height: 0, logo: "none", pagination: "none" }, margins: { top: 0, right: 0, bottom: 0, left: 0 } }, slides: { cover: { slots: [] }, step: { slots: [] }, closing: { slots: [] } } }, schemaVersion: 1 }, meta);
const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
const image = await library.register(TINY_PNG);
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
  blobs: (brandId: string) => new BlobCache(objects, brandId, blobDir),
};
const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(profilesRouter(storage));
app.use(assetsRouter(storage));
// The folder routers sit behind the guard exactly as in index.ts: for a stored brand none of them may be reached.
app.use(renderRouter());
app.use(chatRouter(() => new NonePieceGenerator()));
app.use(composeRouter(() => new NonePieceGenerator()));
app.use(exportRouter());
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
    assert.equal((await fetch(`${base}/${SLUG}/assets/thumbs/${image.id}.png`)).headers.get("content-type"), "image/webp");
    assert.equal((await fetch(`${base}/${SLUG}/assets/files/${hidden.id}.png`)).status, 404);
    assert.equal((await fetch(`${base}/${SLUG}/assets/files/${"0".repeat(16)}.png`)).status, 404);
  }],
  ["every route without a stored branch is gated for a stored brand: chat and outputs answer empty, the rest 501, and no folder appears", async () => {
    const chat = await json(`/${SLUG}/carousels/week-one/chat`);
    assert.deepEqual(chat.body, { records: [], pendingProposalId: null, currency: { code: "USD", rate: 1 } });
    assert.deepEqual((await json(`/${SLUG}/carousels/week-one/outputs`)).body, { versions: [] });
    for (const path of ["stats", "slides/0/html", "slides/0/png", "slides/0/contrast", "export/job-1"]) {
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
    assert.equal((await json(`/${encoded}/carousels/week-one`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 405);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
  }],
  ["writes to a stored brand are refused, and nothing is created in the profiles folder", async () => {
    const put = await json(`/${SLUG}/carousels/week-one`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document) });
    assert.equal(put.status, 405);
    assert.match(put.body.error, /almacenamiento/);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
    // A folder brand (no profile here) is untouched by the guard and answers as before.
    assert.equal((await json("/not-cut-over/brand")).status, 422);
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

server.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
