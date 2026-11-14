import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";
import { createStorageAssetLibrary } from "../assets/storage-library.js";

import { loadBrand } from "./brand-schema.js";
import type { CarouselDocument } from "./carousel-document.js";
import { freeLayoutTemplate } from "./layout-template.js";
import { loadWithResolver, renderCarouselDocument, RENDER_ORIGIN, type AssetResolve } from "./render-batch.js";
import { buildStoredRenderContext, storedAssetResolver } from "./stored-render-context.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "profiles", "example");
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };

/** Loads `<img>` tags for each URL and reports whether they all decoded, with no profiles folder and no mirror anywhere. */
async function loaded(urls: string[], resolve: Parameters<typeof loadWithResolver>[2]): Promise<boolean> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadWithResolver(page, urls.map((url) => `<img src="${url}">`).join(""), resolve);
    return await page.evaluate(() => [...document.images].every((img) => img.complete && img.naturalWidth > 0));
  } finally {
    await browser.close();
  }
}

async function setup() {
  const repos = createMemoryRepositories();
  const blobs = new FakeObjectStore();
  const brand = await repos.brands.create({ slug: "acme-coffee", displayName: "Acme" }, meta);
  const library = createStorageAssetLibrary({ assets: repos.assets, blobs, brandId: brand.id });
  const dir = mkdtempSync(join(tmpdir(), "stored-render-"));
  return { repos, brandId: brand.id, library, dir, cache: new BlobCache(blobs, brand.id, dir) };
}

const tests: Array<[string, () => Promise<void>]> = [
  ["a stored asset is served at its render URL, and nothing else on the origin is", async () => {
    const { repos, brandId, library, cache, dir } = await setup();
    try {
      const png = await library.register(TINY_PNG);
      const ctx = await buildStoredRenderContext(repos.assets, brandId);
      assert.equal(ctx.assetUrl(png.id), `${RENDER_ORIGIN}/assets/${png.id}`);
      const resolve = storedAssetResolver(repos.assets, cache, brandId);
      assert.equal(await loaded([ctx.assetUrl(png.id)], resolve), true);
      // Anything the resolver does not hand out fails the render instead of producing a slide without its image.
      await assert.rejects(loaded([ctx.assetUrl(png.id), `${RENDER_ORIGIN}/assets/${"0".repeat(16)}`], resolve), /no such asset/);
      await assert.rejects(loaded([`${RENDER_ORIGIN}/etc/passwd`], resolve), /not an asset URL/);
      // Routed by hostname: another port is not the origin and is refused, not fetched.
      await assert.rejects(loaded([`http://render.local:8080/assets/${png.id}`], resolve), /http:\/\/render\.local:8080\/assets\/.* \(not an asset URL\)/);
      // A cached file that cannot be served is recorded as refused (and aborted), not left to hang the page.
      await assert.rejects(loaded([ctx.assetUrl(png.id)], async () => ({ path: join(dir, "gone.png"), contentType: "image/png" })), /could not be served/);
      await assert.rejects(loaded([ctx.assetUrl(png.id)], async () => { throw new Error("bucket down"); }), /resolver failed: bucket down/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }],
  ["a request that settles after the page is idle is caught by the returned check", async () => {
    const { repos, brandId, cache, dir } = await setup();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const check = await loadWithResolver(page, "<p>nothing yet</p>", storedAssetResolver(repos.assets, cache, brandId));
      check(); // nothing refused so far
      // Added after load, as a lazily loaded font or image would be: it is awaited here, not slept for.
      await page.evaluate((url) => new Promise<void>((done) => {
        const img = new Image();
        img.onload = img.onerror = () => done();
        img.src = url;
      }), `${RENDER_ORIGIN}/assets/${"1".repeat(16)}`);
      assert.throws(check, /no such asset/);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }],
  ["a hidden asset is not served and not known to the context", async () => {
    const { repos, brandId, library, cache, dir } = await setup();
    try {
      const png = await library.register(TINY_PNG);
      await repos.assets.update(brandId, png.id, { status: "hidden" }, { ...meta, expectedVersion: 1 });
      await assert.rejects(loaded([`${RENDER_ORIGIN}/assets/${png.id}`], storedAssetResolver(repos.assets, cache, brandId)), /no such asset/);
      assert.equal((await buildStoredRenderContext(repos.assets, brandId)).assetExists(png.id), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }],
  ["the context lists fonts as font faces, and refuses an unknown asset id or a font with no family", async () => {
    const { repos, brandId, library, dir } = await setup();
    try {
      const font = await library.register(TINY_PNG, { kind: "font", family: "Example Sans" });
      const ctx = await buildStoredRenderContext(repos.assets, brandId);
      assert.deepEqual(ctx.fontFaces, [{ family: "Example Sans", url: `${RENDER_ORIGIN}/assets/${font.id}` }]);
      assert.equal(ctx.assetExists(font.id), true);
      assert.equal(ctx.assetExists("deadbeefdeadbeef"), false);
      assert.throws(() => ctx.assetUrl("deadbeefdeadbeef"), /Unknown asset id/);
      await library.register(OTHER_PNG, { kind: "font" });
      await assert.rejects(buildStoredRenderContext(repos.assets, brandId), /has no family/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }],
  ["a carousel document with an image asset and a font renders from storage; a font the resolver refuses fails the render", async () => {
    const { repos, brandId, library, cache, dir } = await setup();
    const log = console.log;
    try {
      const image = await library.register(TINY_PNG);
      await library.register(OTHER_PNG, { kind: "font", family: "Test Face" });
      const font = (await repos.assets.list(brandId)).find((row) => row.value.kind === "font")!.value.assetId;
      const base = loadBrand(EXAMPLE);
      const brand = { ...base, fonts: { ...base.fonts, body: "Test Face" } };
      const ctx = await buildStoredRenderContext(repos.assets, brandId);
      const stamp = "2026-08-17T10:00:00.000Z";
      const doc = {
        schemaVersion: 1, id: "e2e", title: "e2e", status: "draft", createdAt: stamp, updatedAt: stamp, canvas: { w: 1080, h: 1350 }, prompt: { text: "e2e", createdAt: stamp },
        slides: [{
          id: "s1", kind: "cover", background: { mode: "asset", assetId: image.id, pinned: false, source: "library" },
          objects: [{ id: "o1", kind: "text", pinned: false, locked: false, source: "manual", text: "Hello", fontKey: "body", fontSize: 30, lineHeight: 1.2, align: "left", colorKey: Object.keys(brand.colors)[0], geometry: { x: 10, y: 10, w: 400, rotation: 0 } }],
        }],
      } as unknown as CarouselDocument;
      const render = (resolve: AssetResolve, outputDir: string) =>
        renderCarouselDocument({ brand, template: freeLayoutTemplate(), doc, ctx, outputDir, assetExists: ctx.assetExists, resolve });
      const real = storedAssetResolver(repos.assets, cache, brandId);
      console.log = () => {};
      await render(real, join(dir, "ok"));
      assert.ok(existsSync(join(dir, "ok", "01.png")));
      await assert.rejects(render(async (id) => (id === font ? undefined : real(id)), join(dir, "refused")), /no such asset/);
      assert.equal(existsSync(join(dir, "refused", "01.png")), false);
    } finally {
      console.log = log;
      rmSync(dir, { recursive: true, force: true });
    }
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n`, error);
  }
}
if (failed) process.exit(1);
console.log(`stored-render-context: ${tests.length} ok`);
