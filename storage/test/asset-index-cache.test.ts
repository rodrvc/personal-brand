import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { verifyBrand } from "../src/import/importer.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// A clean example brand (no deliberate conflict anywhere), so exit code 0 and `conflictos 0` can discriminate.
const example = join(import.meta.dirname, "..", "..", "profiles", "example");
const work = mkdtempSync(join(tmpdir(), "asset-index-cache-"));
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const idOf = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);

async function fresh(slug: string) {
  const repos = createMemoryRepositories();
  const blobs = new FakeObjectStore();
  const dir = join(work, slug);
  cpSync(example, dir, { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  const put = (name: string, data: Buffer | string) => writeFileSync(join(dir, "assets", name), data);
  const run = async () => {
    const out = await runCli(["import", "--from", dir], { USER: "tester" }, repos, blobs);
    return { code: out.exitCode, text: out.lines.join("\n") };
  };
  const first = png("first");
  put("first.png", first);
  put("index.json", JSON.stringify({ entries: [{ id: idOf(first), w: 10, h: 10 }] }));
  const seeded = await run();
  assert.equal(seeded.code, 0, seeded.text);
  assert.match(seeded.text, /conflictos 0/);
  const brandId = (await repos.brands.getBySlug(slug)).id;
  return { repos, blobs, dir, put, run, brandId, first };
}

// 1. A malformed or wrongly-shaped index.json never crashes the import; the rest of the pass continues.
for (const [label, bad] of [["invalid JSON", "{not json"], ["entries is an object", JSON.stringify({ entries: { a: 1 } })], ["top level is an array", JSON.stringify([1])]] as const) {
  const t = await fresh(`example-badindex-${label.toLowerCase().replace(/\W+/g, "-")}`);
  const added = png(`added ${label}`);
  t.put("added.png", added);
  t.put("index.json", bad);
  const out = await t.run();
  assert.equal(out.code, 0, `${label}: ${out.text}`);
  assert.match(out.text, /assets\/index\.json \(unreadable cache: ignored\)/, label);
  assert.match(out.text, /conflictos 0/, label);
  assert.equal((await t.repos.assets.get(t.brandId, idOf(added))).value.sha256, createHash("sha256").update(added).digest("hex"), `${label}: the new asset is created`);
  assert.deepEqual(await verifyBrand(t.repos, t.dir, t.blobs), [], label);
}
// The S7b2a crash path: an entries array holding non-objects. It is still an array, so nothing is reported as ignored.
{
  const t = await fresh("example-badentries-shop");
  const added = png("added entries");
  t.put("added.png", added);
  t.put("index.json", JSON.stringify({ entries: [null, 5, { id: idOf(added), w: 4, h: 4 }] }));
  const out = await t.run();
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /conflictos 0/);
  assert.doesNotMatch(out.text, /unreadable cache/);
  assert.deepEqual(await verifyBrand(t.repos, t.dir, t.blobs), []);
}

// 2a. Index cache drift (sizes) neither conflicts nor leaves anything dirty, and settles into a no-op.
{
  const t = await fresh("example-drift-shop");
  t.put("index.json", JSON.stringify({ entries: [{ id: idOf(t.first), w: 999, h: 888 }] }));
  const drifted = await t.run();
  assert.equal(drifted.code, 0, drifted.text);
  assert.match(drifted.text, /actualizados 0,.*conflictos 0/, "sizes are outside the item hash, not just outside the conflict check");
  assert.deepEqual(await verifyBrand(t.repos, t.dir, t.blobs), []);
  const settled = await t.run();
  assert.equal(settled.code, 0, settled.text);
  assert.match(settled.text, /actualizados 0,.*conflictos 0/, "a further re-import is a no-op");
  const row = (await t.repos.assets.get(t.brandId, idOf(t.first))).value;
  assert.deepEqual([row.width, row.height], [10, 10], "a size is only borrowed at registration");
}

// 2b. A brand imported under the previous rules (item hash included width/height) updates cleanly, then settles.
{
  const t = await fresh("example-legacy-hash-shop");
  const id = idOf(t.first);
  const row = await t.repos.assets.get(t.brandId, id);
  // Replays what S7b2a stored: an import-sourced revision carrying a different source hash.
  await t.repos.assets.update(t.brandId, id, { tags: row.value.tags }, { expectedVersion: row.version, author: "cli:tester", source: "import", reason: "import", sourceHash: "legacy-hash-with-dimensions" });
  // The realistic case: the cache has drifted since that import too.
  t.put("index.json", JSON.stringify({ entries: [{ id, w: 77, h: 66 }] }));
  const healed = await t.run();
  assert.equal(healed.code, 0, healed.text);
  assert.match(healed.text, /actualizados 1,.*conflictos 0/, "the stale hash is rewritten, not reported");
  assert.deepEqual(await verifyBrand(t.repos, t.dir, t.blobs), []);
  const again = await t.run();
  assert.match(again.text, /actualizados 0,.*conflictos 0/, "the next re-import is a no-op");
  assert.equal(again.code, 0);
}
rmSync(work, { recursive: true, force: true });
console.log("asset index cache: ok");
