import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/** The editor's save for a stored brand (S10b), over real HTTP against the routers and the memory repositories. */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-write-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { profilesRouter } = await import("./profiles.js");
const { renderRouter } = await import("./render.js");
const { storedBrandGuard } = await import("../stored-read.js");

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "profiles", "example");
const SLUG = "write-example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "save" as const };
const STAMP = "2026-08-17T10:00:00.000Z";
const JSON_HEADERS = { "Content-Type": "application/json" };

const repos = createMemoryRepositories();
const brand = await repos.brands.create({ slug: SLUG, displayName: "Write Example" }, meta);
await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
await repos.documents.put(brand.id, "tokens", "", { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 }, meta);
const slide = (id: string) => ({ id, kind: "cover", background: { mode: "color", colorKey: "ink", pinned: false, source: "manual" }, objects: [] });
const document = { schemaVersion: 1, id: "week-one", title: "First title", createdAt: STAMP, updatedAt: STAMP, canvas: { w: 1080, h: 1350 }, prompt: { text: "x", createdAt: STAMP }, slides: [slide("s1")] };
const carousel = await repos.carousels.create(brand.id, { slug: "week-one", title: "First title", document: { json: document, schemaVersion: 1 } }, meta);

const storage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, blobs: (brandId: string) => new BlobCache(new FakeObjectStore(), brandId, join(root, ".blobs")) };
const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(profilesRouter(storage));
app.use(renderRouter(storage));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles`;

const put = (body: unknown, ifMatch?: string, path = `/${SLUG}/carousels/week-one`) =>
  fetch(`${base}${path}`, { method: "PUT", headers: { ...JSON_HEADERS, ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }) }, body: JSON.stringify(body) });
const current = async () => (await repos.carousels.get(brand.id, "week-one", (b) => b)).version;

const tests: Array<[string, () => Promise<void>]> = [
  ["a save without If-Match is 428 and a malformed one is 400, and nothing is written", async () => {
    const before = await current();
    assert.equal((await put(document)).status, 428);
    for (const bad of ["*", "3", '"x"', '"1","2"']) assert.equal((await put(document, bad)).status, 400, bad);
    assert.equal((await fetch(`${base}/${SLUG}/brand`, { method: "PUT", headers: JSON_HEADERS, body: "{}" })).status, 405);
    assert.equal(await current(), before);
  }],
  ["a save at the current version succeeds, moves the ETag and the title, and keeps the row version in step", async () => {
    const res = await put({ ...document, title: "Second title", updatedAt: "2026-08-18T10:00:00.000Z" }, `"${await current()}"`);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(res.headers.get("etag"), `"${await current()}"`);
    assert.equal(((await res.json()) as { title: string }).title, "Second title");
    const row = await repos.carousels.list(brand.id);
    assert.equal(row[0]!.value.title, "Second title");
  }],
  ["two saves with the same If-Match: one wins, the other gets 409 with the winner's version and document", async () => {
    const version = `"${await current()}"`;
    const [a, b] = await Promise.all([put({ ...document, title: "Writer A" }, version), put({ ...document, title: "Writer B" }, version)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const [won, lost] = a.status === 200 ? [a, b] : [b, a];
    const winner = ((await won.json()) as { title: string }).title;
    const body = (await lost.json()) as { currentVersion: number; document: { title: string }; error: string };
    assert.equal(body.currentVersion, await current());
    assert.equal(body.document.title, winner);
    assert.equal(lost.headers.get("etag"), `"${body.currentVersion}"`);
    assert.match(body.error, /Alguien más/);
  }],
  ["a stale If-Match is a 409 that carries the current copy, and the stale save leaves no trace", async () => {
    const stale = `"${(await current()) - 1}"`;
    const before = (await repos.carousels.get(brand.id, "week-one", (b) => b)).value.document;
    const res = await put({ ...document, title: "Stale" }, stale);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { currentVersion: number }).currentVersion, await current());
    assert.deepEqual((await repos.carousels.get(brand.id, "week-one", (b) => b)).value.document, before);
  }],
  ["a scheduled status survives a save: the client's status is ignored and the row column wins", async () => {
    await repos.carousels.setStatus(carousel.id, { status: "scheduled", scheduledFor: STAMP }, { ...meta, expectedVersion: await current() });
    const res = await put({ ...document, status: "draft", title: "Scheduled still" }, `"${await current()}"`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "exported");
    const row = await repos.carousels.get(brand.id, "week-one", (b) => b);
    assert.equal(row.value.status, "scheduled");
    assert.equal(row.value.scheduledFor, STAMP);
  }],
  ["a structural change (a slide added) and a snapshot request each record their reason as a revision", async () => {
    await put({ ...document, slides: [slide("s1"), slide("s2")] }, `"${await current()}"`);
    await put(document, `"${await current()}"`, `/${SLUG}/carousels/week-one?snapshot=true`);
    const reasons = (await repos.revisions.list("carousel", carousel.id)).map((r) => r.reason);
    assert.deepEqual(reasons.slice(-2), ["structural", "snapshot"]);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
  }],
  ["a race lost inside the repository (after the pre-check passed) is the same 409 with the competitor's version and document", async () => {
    let raced = false;
    type Save = typeof repos.carousels.save;
    const save: Save = async (id, input, m) => {
      if (!raced) await ((raced = true), repos.carousels.save(id, { title: "Competitor", document: { json: { ...document, title: "Competitor" }, schemaVersion: 1 } }, m));
      return repos.carousels.save(id, input, m);
    };
    const racing = { ...storage, carousels: { get: repos.carousels.get.bind(repos.carousels), list: repos.carousels.list.bind(repos.carousels), save } };
    const raceApp = express();
    raceApp.use(express.json());
    raceApp.use(profilesRouter(racing));
    const raceServer = raceApp.listen(0);
    await new Promise<void>((resolve) => raceServer.once("listening", resolve));
    try {
      const version = await current();
      const res = await fetch(`http://127.0.0.1:${(raceServer.address() as AddressInfo).port}/api/profiles/${SLUG}/carousels/week-one`, { method: "PUT", headers: { ...JSON_HEADERS, "If-Match": `"${version}"` }, body: JSON.stringify({ ...document, title: "Loser" }) });
      assert.ok(raced);
      assert.equal(res.status, 409);
      const body = (await res.json()) as { currentVersion: number; document: { title: string } };
      assert.equal(body.currentVersion, version + 1);
      assert.equal(body.document.title, "Competitor");
      assert.equal(await current(), version + 1);
    } finally {
      raceServer.close();
    }
  }],
  ["an invalid document is 400, a body id that differs is 400, a bad URL id is 400, an unknown carousel is 404", async () => {
    const version = `"${await current()}"`;
    assert.equal((await put({ ...document, slides: [{ ...slide("s1"), background: { mode: "color", colorKey: "nope", pinned: false, source: "manual" } }] }, version)).status, 400);
    assert.equal((await put({ ...document, id: "other" }, version)).status, 400);
    assert.equal((await put({ ...document, id: "Bad_Id" }, version, `/${SLUG}/carousels/Bad_Id`)).status, 400);
    assert.equal((await put({ ...document, id: "nope" }, version, `/${SLUG}/carousels/nope`)).status, 404);
    assert.equal((await fetch(`${base}/${SLUG}/carousels/Bad_Id/slides/0/png`)).status, 400);
  }],
  ["a corrupt stored document (a validator that throws) is a 503 on every route, not a raw 500", async () => {
    const real = repos.documents;
    const corrupt = { ...storage, documents: { ...real, get: async () => { throw new SyntaxError("Unexpected token in stored tokens"); } } };
    const corruptApp = express();
    corruptApp.use(profilesRouter(corrupt));
    const corruptServer = corruptApp.listen(0);
    await new Promise<void>((resolve) => corruptServer.once("listening", resolve));
    const url = `http://127.0.0.1:${(corruptServer.address() as AddressInfo).port}/api/profiles/${SLUG}`;
    const log = console.error;
    console.error = () => {};
    try {
      for (const path of ["/brand", "/carousels/week-one"]) {
        const res = await fetch(`${url}${path}`);
        assert.equal(res.status, 503, path);
        assert.doesNotMatch(JSON.stringify(await res.json()), /Unexpected token/);
      }
    } finally {
      console.error = log;
      corruptServer.close();
    }
  }],
  ["an archived cut-over brand is opened but refuses a save with a clear Spanish message", async () => {
    const old = await repos.brands.create({ slug: "old-write", displayName: "Old" }, meta);
    const cut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
    await repos.documents.put(old.id, "tokens", "", { json: JSON.parse(readFileSync(join(EXAMPLE, "brand.json"), "utf-8")), schemaVersion: 1 }, meta);
    const row = await repos.carousels.create(old.id, { slug: "week-one", title: "Old", document: { json: document, schemaVersion: 1 } }, meta);
    await repos.brands.archive(old.id, { ...meta, expectedVersion: cut.version });
    const revisions = (await repos.revisions.list("carousel", row.id)).length;
    // Archived wins over a stale copy: 403, not a 409 nobody could resolve.
    for (const ifMatch of [`"${row.version}"`, `"${row.version + 5}"`]) {
      const res = await put(document, ifMatch, "/old-write/carousels/week-one");
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /archivada/);
    }
    assert.equal((await repos.carousels.get(old.id, "week-one", (b) => b)).version, row.version);
    assert.equal((await repos.revisions.list("carousel", row.id)).length, revisions);
  }],
  ["a folder brand's template params are parsed lazily: the free template ignores bad params, a real id does not", async () => {
    assert.equal((await fetch(`${base}/folder-only/template/__free__?params=%7Bnope`)).status, 200);
    assert.equal((await fetch(`${base}/folder-only/template/some-layout?params=%7Bnope`)).status, 400);
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
rmSync(root, { recursive: true, force: true });
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
