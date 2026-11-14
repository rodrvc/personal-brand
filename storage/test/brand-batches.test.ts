import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { importBrand, verifyBrand } from "../src/import/importer.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// Batch folders (`carousels/<id>/` with a `batch.json` and no `carousel.json`): their finished renders become hidden assets.
// Fictional brand, temp folders and memory storage only.
const work = mkdtempSync(join(tmpdir(), "brand-batches-"));
const dir = join(work, "example-posters");
const put = (rel: string, body: string | Buffer) => (mkdirSync(join(dir, rel, ".."), { recursive: true }), writeFileSync(join(dir, rel), body));
const png = (label: string) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`pixels-${label}`)]);
const idOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const [A, B, C, D] = [png("a"), png("b"), png("c"), png("d")];

put("profile.md", "# Profile\n");
put("assets/shared.png", D); // the same bytes as a render of the second batch
const B1 = "carousels/daily-2026-01-10";
put(`${B1}/batch.json`, "{ not json at all"); // presence decides: it is never parsed
put(`${B1}/cover.json`, '{"title":"Cover"}');
put(`${B1}/caption.txt`, "A caption\n");
put(`${B1}/source/photo.png`, png("source"));
put(`${B1}/final/01.png`, A);
put(`${B1}/final/02.png`, B);
put(`${B1}/final-v2/01.png`, A); // unchanged copy of an updated batch
put(`${B1}/final-v2/02.png`, C);
put(`${B1}/final-v2/notes.txt`, "not an image\n");
put(`${B1}/final-v2/fake.png`, "this is text, not a png");
put(`${B1}/final-v2/nested/03.png`, png("nested")); // only files directly inside a final folder count
put(`${B1}/finals/04.png`, png("not-final")); // not `final` or `final-*`
put(`${B1}/bundle.zip`, Buffer.from("504b0304", "hex"));
const B2 = "carousels/daily-2026-01-11";
put(`${B2}/batch.json`, "{}");
put(`${B2}/final/01.png`, A);
put(`${B2}/final/02.png`, D);
const LONG = `carousels/${"x".repeat(60)}`;
put(`${LONG}/batch.json`, "{}");
put(`${LONG}/final/01.png`, png("long"));
put("carousels/plain/carousel.json", '{"title":"A carousel","status":"draft"}');
put("carousels/plain/batch.json", "{}"); // a carousel.json wins: still a carousel
put("carousels/plain/final/01.png", png("plain"));

const repos = createMemoryRepositories();
const blobs = new FakeObjectStore();
const env = { USER: "tester", HOME: work };
const opts = { from: dir, dryRun: false, author: "cli:tester", blobs, env };
const first = await importBrand(repos, opts);
const brand = await repos.brands.getBySlug("example-posters");
const assets = await repos.assets.list(brand.id);
const byId = new Map(assets.map((a) => [a.value.assetId, a.value]));

assert.ok(first.items.some((i) => i.key === "carousel:plain" && i.outcome === "created"), "a folder with carousel.json is still a carousel");
assert.ok(!first.skipped.some((s) => s.includes("daily-2026") && s.includes("carousel.json")), "a batch folder is not reported as a carousel without carousel.json");
assert.deepEqual(first.items.filter((i) => i.key.startsWith("asset:")).length, 4, "A, B, C and D (shared with assets/); a real carousel's final/ is not a batch");
assert.equal(byId.size, 4);

// One asset per distinct content, tags are the union of every placement, and a batch render is hidden and unclassified.
const tagsOf = (b: Buffer) => [...byId.get(idOf(b))!.tags].sort();
assert.deepEqual(tagsOf(A), ["batch:daily-2026-01-10", "batch:daily-2026-01-10/final", "batch:daily-2026-01-10/final-v2", "batch:daily-2026-01-11", "batch:daily-2026-01-11/final"], "same bytes in two final folders and two batches: one asset, union of tags");
assert.deepEqual(tagsOf(B), ["batch:daily-2026-01-10", "batch:daily-2026-01-10/final"]);
assert.deepEqual(tagsOf(C), ["batch:daily-2026-01-10", "batch:daily-2026-01-10/final-v2"]);
for (const b of [A, B, C]) assert.deepEqual(
  { kind: byId.get(idOf(b))!.kind, origin: byId.get(idOf(b))!.origin, status: byId.get(idOf(b))!.status },
  { kind: "unclassified", origin: "manual", status: "hidden" },
);
// Same bytes already in assets/**: the assets/ item wins (kind, origin, status); the batch tag is only added.
const shared = byId.get(idOf(D))!;
assert.deepEqual({ status: shared.status, origin: shared.origin, kind: shared.kind }, { status: "approved", origin: "manual", kind: "unclassified" });
assert.deepEqual(shared.tags, ["batch:daily-2026-01-11", "batch:daily-2026-01-11/final"]);
assert.equal(assets.filter((a) => a.value.sha256 === shared.sha256).length, 1);

// What was not claimed keeps today's behavior.
assert.ok(!byId.has(idOf(png("nested"))) && !byId.has(idOf(png("not-final"))) && !byId.has(idOf(png("source"))), "nested, non-final and source images are not batch assets");
const manifest = first.legacy.manifest;
assert.equal(manifest[`${B1}/final/01.png`], undefined, "a claimed render is not also a legacy blob");
assert.equal(manifest[`${B2}/final/02.png`], undefined);
assert.ok(manifest[`${B1}/caption.txt`], "caption.txt stays legacy");
assert.ok(manifest[`${B1}/source/photo.png`], "source images stay legacy");
assert.ok(manifest[`${B1}/final-v2/nested/03.png`], "a nested image stays legacy");
assert.ok(first.skipped.some((s) => s.startsWith(`${B1}/final-v2/fake.png`) && s.includes("not an image by content")), "an image by extension only is reported");
assert.equal(manifest[`${B1}/bundle.zip`], undefined, "the zip is still not imported");

// A tag over 50 characters is never truncated: the file is reported and falls back to the legacy pass.
assert.ok(first.skipped.some((s) => s.startsWith(`${LONG}/final/01.png`) && s.includes("batch tag longer than 50")));
assert.ok(!byId.has(idOf(png("long"))));
assert.ok(manifest[`${LONG}/final/01.png`], "the unclaimed render is kept as a legacy blob instead");

// Hidden: `brand workspace` (which skips hidden assets) never materializes the renders; `asset list --tag` finds them.
assert.equal((await repos.assets.list(brand.id)).filter((a) => a.value.status !== "hidden").length, 1, "only the assets/ file is visible to the workspace filter");
const run = (...argv: string[]) => runCli(argv, env, repos, blobs);
const listed = await run("asset", "list", "example-posters", "--status", "hidden", "--tag", "batch:daily-2026-01-10/final-v2", "--json");
assert.equal(listed.exitCode, 0);
const items = JSON.parse(listed.lines.join("\n")).items as Array<{ assetId: string }>;
assert.deepEqual(items.map((i) => i.assetId).sort(), [idOf(A), idOf(C)].sort());
const none = await run("asset", "list", "example-posters", "--tag", "batch:daily-2026-01-10");
assert.equal(none.lines.filter((l) => l.includes("batch:daily-2026-01-10")).length, 3, "exact tag match over every status");
assert.ok((await run("asset", "list", "example-posters", "--tag", "batch:daily")).lines.some((l) => l.includes("Sin assets.")), "a tag filter is an exact match, not a prefix");
assert.ok((await run("asset", "list", "example-posters", "--status", "approved", "--tag", "batch:daily-2026-01-10")).lines.some((l) => l.includes("Sin assets.")), "hidden renders do not match an approved filter");

// Idempotent, and verification covers the batch assets (including their blobs).
const again = await importBrand(repos, opts);
assert.deepEqual(again.counts, { created: 0, updated: 0, unchanged: first.counts.created, conflict: 0 }, "a reimport changes nothing");
assert.deepEqual(await verifyBrand(repos, dir, blobs, env), [], "a clean import verifies");

// A later batch that adds the same bytes only adds a tag: an update, not a conflict.
const B3 = "carousels/daily-2026-01-12";
put(`${B3}/batch.json`, "{}");
put(`${B3}/final/01.png`, B);
const next = await importBrand(repos, opts);
assert.deepEqual(next.items.filter((i) => i.outcome !== "unchanged"), [{ key: `asset:${idOf(B)}`, outcome: "updated" }]);
assert.deepEqual(next.conflicts, []);
assert.deepEqual([...(await repos.assets.get(brand.id, idOf(B))).value.tags].sort(), ["batch:daily-2026-01-10", "batch:daily-2026-01-10/final", "batch:daily-2026-01-12", "batch:daily-2026-01-12/final"]);
assert.deepEqual(await verifyBrand(repos, dir, blobs, env), []);

// `brand workspace` materializes visible assets only: no batch render is copied out of storage.
const out = join(work, "ws");
assert.equal((await run("workspace", "example-posters", "--out", out)).exitCode, 0);
const materialized = readdirSync(out, { recursive: true, encoding: "utf-8" }).filter((f) => statSync(join(out, f)).isFile()).map((f) => createHash("sha256").update(readFileSync(join(out, f))).digest("hex"));
for (const b of [A, B, C]) assert.ok(!materialized.includes(createHash("sha256").update(b).digest("hex")), "a hidden batch render is not materialized");
assert.ok(materialized.includes(createHash("sha256").update(D).digest("hex")), "the visible asset still is");

// An owner edit of a batch asset (unhide) is a conflict on every reimport and keeps verification dirty, like any assets/ item.
const edited = await repos.assets.get(brand.id, idOf(C));
await repos.assets.update(brand.id, idOf(C), { status: "approved" }, { expectedVersion: edited.version, author: "owner", source: "cli", reason: "save" });
assert.match((await importBrand(repos, opts)).conflicts.join(), new RegExp(`asset:${idOf(C)} \\(storage changed since the last import\\)`));
assert.deepEqual(await verifyBrand(repos, dir, blobs, env), [`asset:${idOf(C)}`]);

// Fresh brand for the edge cases.
const dir2 = join(work, "example-extra");
const put2 = (rel: string, body: string | Buffer) => (mkdirSync(join(dir2, rel, ".."), { recursive: true }), writeFileSync(join(dir2, rel), body));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from("webp-body")]);
put2("profile.md", "# Profile\n");
put2("carousels/b1/batch.json", "{}");
put2("carousels/b1/final/photo.jpg", JPEG);
put2("carousels/b1/final/art.webp", WEBP);
put2("carousels/b1/final/real.png", png("real"));
symlinkSync(join(dir2, "carousels/b1/final/real.png"), join(dir2, "carousels/b1/final/link.png"));
symlinkSync(join(dir2, "carousels/b1/final"), join(dir2, "carousels/b1/final-link"));
const repos2 = createMemoryRepositories();
const blobs2 = new FakeObjectStore();
const opts2 = { from: dir2, dryRun: false, author: "cli:tester", blobs: blobs2, env };

// Dry run writes nothing at all; without a blob store nothing is imported or claimed.
const dry = await importBrand(repos2, { ...opts2, dryRun: true });
assert.equal(dry.items.filter((i) => i.key.startsWith("asset:") && i.outcome === "created").length, 3);
await assert.rejects(repos2.brands.getBySlug("example-extra"), "a dry run does not even create the brand");
const noBlobs = await importBrand(createMemoryRepositories(), { from: dir2, dryRun: true, author: "cli:tester", env });
assert.equal(noBlobs.items.filter((i) => i.key.startsWith("asset:")).length, 0);
assert.ok(noBlobs.skipped.some((e) => e.startsWith("carousels/b1/final/photo.jpg") && e.includes("no blob store")));

// jpeg and webp are recognized by content; a symlinked file or folder is not read as a render.
const real = await importBrand(repos2, opts2);
const brand2 = await repos2.brands.getBySlug("example-extra");
const rows2 = await repos2.assets.list(brand2.id);
assert.deepEqual(rows2.map((a) => a.value.mime).sort(), ["image/jpeg", "image/png", "image/webp"]);
assert.ok(rows2.every((a) => !a.value.tags.some((t) => t.includes("final-link"))), "a symlinked final folder is not scanned");
assert.ok(real.skipped.some((e) => e.includes("link.png") && e.includes("not a regular file")), "a symlinked render is reported");

// 21 tags: the 11th placement of the same bytes is reported, never truncated, and the asset keeps its 20 tags.
const MANY = png("many");
for (let i = 1; i <= 11; i++) put2(`carousels/m${String(i).padStart(2, "0")}/batch.json`, "{}"), put2(`carousels/m${String(i).padStart(2, "0")}/final/x.png`, MANY);
const many = await importBrand(repos2, opts2);
assert.equal((await repos2.assets.get(brand2.id, idOf(MANY))).value.tags.length, 20);
assert.ok(many.skipped.some((e) => e.startsWith("carousels/m11/final/x.png") && e.includes("more than 20 batch tags")));
// The same limit when `assets/**` owns the bytes: 19 own tags + 2 placement tags -> placement tags not added, reported.
const OWN = png("own");
put2("assets/own.png", OWN);
put2(`assets/meta/${idOf(OWN)}.json`, JSON.stringify({ tags: Array.from({ length: 19 }, (_, i) => `own-${i}`) }));
put2("carousels/o1/batch.json", "{}");
put2("carousels/o1/final/own.png", OWN);
const own = await importBrand(repos2, opts2);
assert.equal((await repos2.assets.get(brand2.id, idOf(OWN))).value.tags.length, 19);
assert.ok(own.skipped.some((e) => e.startsWith("assets/own.png") && e.includes("batch tags not added")));

// A batch never hides an owner-visible asset: the bytes move from assets/ into a batch folder -> conflict, row untouched.
const LOGO = png("logo");
put2("assets/logo.png", LOGO);
await importBrand(repos2, opts2);
renameSync(join(dir2, "assets/logo.png"), join(dir2, "logo.moved"));
put2("carousels/b1/final/logo.png", LOGO);
const hide = await importBrand(repos2, opts2);
assert.match(hide.conflicts.join(), new RegExp(`asset:${idOf(LOGO)} \\(.*registered outside a batch`));
assert.deepEqual({ status: (await repos2.assets.get(brand2.id, idOf(LOGO))).value.status, kind: (await repos2.assets.get(brand2.id, idOf(LOGO))).value.kind }, { status: "approved", kind: "unclassified" });

// A batch removed from the folder while an assets/ item held its tag: the tag is dropped on the next pass (an update).
const KEEP = png("keep");
put2("assets/keep.png", KEEP);
put2("carousels/k1/batch.json", "{}");
put2("carousels/k1/final/keep.png", KEEP);
await importBrand(repos2, opts2);
assert.deepEqual((await repos2.assets.get(brand2.id, idOf(KEEP))).value.tags, ["batch:k1", "batch:k1/final"]);
rmSync(join(dir2, "carousels/k1"), { recursive: true });
const gone = await importBrand(repos2, opts2);
assert.ok(gone.items.some((i) => i.key === `asset:${idOf(KEEP)}` && i.outcome === "updated"));
assert.deepEqual((await repos2.assets.get(brand2.id, idOf(KEEP))).value.tags, []);
