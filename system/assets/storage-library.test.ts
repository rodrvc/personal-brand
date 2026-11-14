import assert from "node:assert/strict";

import { FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { fetchFontsIntoLibrary } from "./fetch-fonts.js";
import { hashContent } from "./index.js";
import { createStorageAssetLibrary } from "./storage-library.js";

// No profile dir anywhere in this file: the library runs on memory storage only.
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const OTHER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function setup() {
  const repos = createMemoryRepositories();
  const blobs = new FakeObjectStore();
  const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
  const brand = await repos.brands.create({ slug: "acme-coffee", displayName: "Acme" }, meta);
  return { repos, blobs, brandId: brand.id, library: createStorageAssetLibrary({ assets: repos.assets, blobs, brandId: brand.id }) };
}

const tests: Array<[string, () => Promise<void>]> = [
  ["register stores the bytes in the bucket and a row, with the folder library's id", async () => {
    const { library, blobs, repos, brandId } = await setup();
    const entry = await library.register(TINY_PNG, { tags: ["ink:light"] });
    assert.equal(entry.id, hashContent(TINY_PNG));
    assert.ok("blobKey" in entry && !("path" in entry));
    assert.deepEqual([entry.mime, entry.w, entry.h, entry.bytes, entry.origin, entry.status, entry.kind], ["image/png", 1, 1, TINY_PNG.byteLength, "manual", "approved", "unclassified"]);
    assert.deepEqual(await library.read(entry.id), TINY_PNG);
    assert.equal((await blobs.head(entry.blobKey!)).size, TINY_PNG.byteLength);
    assert.equal((await repos.assets.list(brandId)).length, 1);
  }],
  ["same bytes registered twice produce exactly one entry", async () => {
    const { library, blobs } = await setup();
    const first = await library.register(TINY_PNG);
    const second = await library.register(TINY_PNG, { kind: "logo", tags: ["other"] });
    assert.deepEqual(second, first, "the existing entry wins, untouched");
    assert.equal((await library.list()).length, 1);
    assert.equal((await blobs.list("")).length, 1);
  }],
  ["update changes classification only and bumps the row version", async () => {
    const { library, repos, brandId } = await setup();
    const entry = await library.register(TINY_PNG);
    const updated = await library.update(entry.id, { kind: "character", tags: ["ink:light"] });
    assert.deepEqual([updated.kind, updated.tags, updated.status], ["character", ["ink:light"], "approved"]);
    assert.equal((await repos.assets.get(brandId, entry.id)).version, 2);
    await assert.rejects(() => library.update("0123456789abcdef", { kind: "photo" }), /Not found/);
  }],
  ["fonts upload as assets with their family, nothing on disk", async () => {
    const { library } = await setup();
    const css = "@font-face { font-family: 'Example Serif'; src: url(https://fonts.test/a.woff2); }";
    const saved = await fetchFontsIntoLibrary("https://fonts.test/css", library, { fetchText: async () => css, fetchBuffer: async () => Buffer.from("not-a-real-font") });
    assert.deepEqual(saved, ["ExampleSerif-a.woff2"]);
    const [font] = await library.list();
    assert.deepEqual([font!.kind, font!.mime, font!.family], ["font", "font/woff2", "Example Serif"]);
    await fetchFontsIntoLibrary("https://fonts.test/css", library, { fetchText: async () => css, fetchBuffer: async () => Buffer.from("not-a-real-font") });
    assert.equal((await library.list()).length, 1, "running it twice adds nothing");
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
console.log(`storage-library: ${tests.length} ok`);
