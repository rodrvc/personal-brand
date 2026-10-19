import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotFoundError, type CarouselRepository } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { computeUsage, computeUsageFrom, folderUsageSource, storageUsageSource } from "./usage.js";

const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const slideWith = (...ids: string[]) => ({ slides: [{ objects: ids.map((assetId) => ({ type: "image", assetId })) }] });

async function setup() {
  const repos = createMemoryRepositories();
  const brand = await repos.brands.create({ slug: "acme-coffee", displayName: "Acme" }, meta);
  const add = (slug: string, json: Record<string, unknown>) =>
    repos.carousels.create(brand.id, { slug, title: slug, document: { json, schemaVersion: 1 } }, meta);
  return { repos, brandId: brand.id, add };
}

const tests: Array<[string, () => Promise<void>]> = [
  ["storage usage counts assetId references across every carousel of the brand", async () => {
    const { repos, brandId, add } = await setup();
    await add("one", slideWith("a1", "a2"));
    await add("two", { ...slideWith("a1"), background: { assetId: "a3" } });
    const counts = await computeUsageFrom(storageUsageSource(repos.carousels, brandId));
    assert.deepEqual(counts, { a1: 2, a2: 1, a3: 1 });
  }],
  ["storage usage ignores other brands and is empty without carousels", async () => {
    const { repos, brandId, add } = await setup();
    const other = await repos.brands.create({ slug: "other-brand", displayName: "Other" }, meta);
    await repos.carousels.create(other.id, { slug: "x", title: "x", document: { json: slideWith("zz"), schemaVersion: 1 } }, meta);
    assert.deepEqual(await computeUsageFrom(storageUsageSource(repos.carousels, brandId)), {});
    await add("one", slideWith("a1"));
    assert.deepEqual(await computeUsageFrom(storageUsageSource(repos.carousels, brandId)), { a1: 1 });
  }],
  ["a carousel removed between list and get is skipped, like a missing carousel.json", async () => {
    const { repos, brandId, add } = await setup();
    await add("one", slideWith("a1"));
    await add("gone", slideWith("a2"));
    const flaky = { ...repos.carousels, get: (b: string, slug: string, v: never) => (slug === "gone" ? Promise.reject(new NotFoundError("carousel")) : repos.carousels.get(b, slug, v)) } as unknown as CarouselRepository;
    assert.deepEqual(await computeUsageFrom(storageUsageSource(flaky, brandId)), { a1: 1 });
  }],
  ["the folder source gives the same counts as the storage source for the same documents", async () => {
    const { repos, brandId, add } = await setup();
    const docs = { one: slideWith("a1", "a2"), two: slideWith("a1") };
    for (const [slug, json] of Object.entries(docs)) await add(slug, json);
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    try {
      for (const [slug, json] of Object.entries(docs)) {
        mkdirSync(join(dir, "carousels", slug), { recursive: true });
        writeFileSync(join(dir, "carousels", slug, "carousel.json"), JSON.stringify(json));
      }
      mkdirSync(join(dir, "carousels", "broken"), { recursive: true });
      writeFileSync(join(dir, "carousels", "broken", "carousel.json"), "{not json");
      assert.deepEqual(computeUsage(dir), await computeUsageFrom(storageUsageSource(repos.carousels, brandId)));
      assert.deepEqual(await computeUsageFrom(folderUsageSource(join(dir, "missing"))), {});
    } finally {
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
console.log(`usage: ${tests.length} ok`);
