import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BlobCache, FakeObjectStore } from "@personal-brand/storage/blob";
import { BrandArchivedError, InvalidInputError, VersionConflictError } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

/** The editor's save for a stored brand (S10b), over real HTTP against the routers and the memory repositories. */
const root = mkdtempSync(join(tmpdir(), "editor-server-stored-write-"));
process.env.BRAND_PROFILES_DIR = join(root, "profiles");

const { default: express } = await import("express");
const { createStorageAssetLibrary } = await import("../../../../system/assets/storage-library.js");
const { profilesRouter } = await import("./profiles.js");
const { renderRouter } = await import("./render.js");
const { composeRouter } = await import("./compose.js");
const { NonePieceGenerator } = await import("../ai/none.js");
const { storedBrandGuard } = await import("../stored-read.js");
type EditorStorage = import("../stored-read.js").EditorStorage;

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

const objects = new FakeObjectStore();
const library = createStorageAssetLibrary({ assets: repos.assets, blobs: objects, brandId: brand.id });
const storage = { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, exports: repos.exports, revisions: repos.revisions, files: objects, blobs: (brandId: string) => new BlobCache(new FakeObjectStore(), brandId, join(root, ".blobs")) };
const app = express();
app.use(express.json());
app.use("/api/profiles/:slug", storedBrandGuard(storage));
app.use(profilesRouter(storage));
app.use(renderRouter(storage));
app.use(composeRouter(() => new NonePieceGenerator(), storage));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profiles`;

const put = (body: unknown, ifMatch?: string, path = `/${SLUG}/carousels/week-one`) =>
  fetch(`${base}${path}`, { method: "PUT", headers: { ...JSON_HEADERS, ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }) }, body: JSON.stringify(body) });
const current = async () => (await repos.carousels.get(brand.id, "week-one", (b) => b)).version;

/** A second app over the same rows, with `override` laid over the storage (a wrapped repository, a failing one). */
async function withApp(override: Partial<EditorStorage>, run: (url: string) => Promise<void>): Promise<void> {
  const extra = express();
  extra.use(express.json());
  extra.use(profilesRouter({ ...storage, ...override }));
  const extraServer = extra.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => extraServer.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(extraServer.address() as AddressInfo).port}/api/profiles/${SLUG}`);
  } finally {
    extraServer.close();
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["a save without If-Match is 428 and a malformed one is 400, and nothing is written", async () => {
    const before = await current();
    assert.equal((await put(document)).status, 428);
    for (const bad of ["*", "3", '"x"', '"1","2"', `W/"${before}"`]) assert.equal((await put(document, bad)).status, 400, bad);
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
  ["GET versions lists only the snapshot and structural revisions, newest first, in the folder's stamp format; an unknown carousel is 404", async () => {
    const row = await repos.carousels.create(brand.id, { slug: "versions-one", title: "V", document: { json: { ...document, id: "versions-one" }, schemaVersion: 1 } }, meta);
    const edit = (body: object, query = "") => put({ ...document, id: "versions-one", ...body }, `"${row.version + steps}"`, `/${SLUG}/carousels/versions-one${query}`);
    let steps = 0;
    for (const [body, query] of [[{ title: "Plain save" }, ""], [{ slides: [slide("s1"), slide("s2")] }, ""], [{ slides: [slide("s1"), slide("s2")] }, "?snapshot=true"]] as const) {
      assert.equal((await edit(body, query)).status, 200);
      steps += 1;
    }
    const revisions = await repos.revisions.list("carousel", row.id);
    assert.deepEqual(revisions.map((r) => r.reason), ["save", "save", "structural", "snapshot"], "create, plain save, structural, snapshot");
    const res = await fetch(`${base}/${SLUG}/carousels/versions-one/versions`);
    const { versions } = (await res.json()) as { versions: string[] };
    assert.equal(res.status, 200);
    assert.equal(versions.length, 2, "the plain save and the creation are not snapshots");
    for (const stamp of versions) assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
    assert.deepEqual(versions, [...versions].sort().reverse());
    assert.deepEqual([...versions].sort(), [revisions[2]!.createdAt, revisions[3]!.createdAt].map((at) => at.replace(/[:.]/g, "-")).sort());
    assert.equal((await fetch(`${base}/${SLUG}/carousels/nope-one/versions`)).status, 404);
  }],
  ["POST /carousels creates a blank stored carousel as a draft with its ETag, saves with that tag, and refuses duplicates, prompts and unknown templates", async () => {
    const create = (body: object, path = `/${SLUG}/carousels`) => fetch(`${base}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const res = await create({ title: "Brand new", blank: true, id: "fresh-one" });
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const { document: created } = (await res.json()) as { document: { id: string; status: string; slides: unknown[] } };
    assert.deepEqual([created.id, created.status, created.slides.length], ["fresh-one", "draft", 1]);
    const row = await repos.carousels.get(brand.id, "fresh-one", (b) => b);
    assert.deepEqual([res.headers.get("etag"), row.value.title, row.value.status], [`"${row.version}"`, "Brand new", "draft"]);
    assert.equal("status" in ((await repos.revisions.get("carousel", row.id, 1)).body as { document: object }).document, false, "the column owns status");
    assert.equal((await put({ ...created, title: "Renamed" }, res.headers.get("etag")!, `/${SLUG}/carousels/fresh-one`)).status, 200);
    const duplicate = await create({ title: "Again", blank: true, id: "fresh-one" });
    assert.equal(duplicate.status, 409);
    assert.equal(((await duplicate.json()) as { error: string }).error, 'Ya existe un carrusel "fresh-one".', "the guarded storage passes AlreadyExistsError (a VersionConflictError) through, so the message is the duplicate's, not the save conflict's");
    for (const bad of [{ title: 7, blank: true }, { title: {}, blank: true }, { title: "T", templateId: 3 }, { title: "T", blank: true, id: 9 }]) assert.equal((await create(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await create({ title: "Both", blank: true, templateId: null })).status, 400);
    assert.equal((await create({ blank: true })).status, 400);
    assert.equal((await create({ title: "Planned", prompt: "make slides" })).status, 501);
    // A plan preview is served (S10b5) and needs its prompt; the planner itself is tested in stored-compose.test.ts.
    assert.equal((await create({ title: "P", preview: true })).status, 400);
    assert.equal((await create({ title: "Planned" }, `/${SLUG}/carousels?mode=plan`)).status, 400);
    assert.equal((await create({ title: "Missing template", templateId: "no-such-template", id: "tmpl-one" })).status, 400);
    assert.equal((await repos.carousels.list(brand.id)).some((c) => c.value.slug === "tmpl-one"), false);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
  }],
  ["saving a document that pins an asset approves it once, and an unpinned candidate stays a candidate", async () => {
    const [pinned, loose] = await Promise.all(["pinned piece", "loose piece"].map(async (text, i) => {
      const asset = await library.register(Buffer.from(text), { destRelPath: `pin-${i}.png` });
      await repos.assets.update(brand.id, asset.id, { status: "candidate" }, { ...meta, expectedVersion: (await repos.assets.get(brand.id, asset.id)).version });
      return asset;
    }));
    const pin = (id: string, isPinned: boolean) => ({ id: `s-${id}`, kind: "cover", background: { mode: "asset", assetId: id, pinned: isPinned, source: "ai" }, objects: [] });
    const v = await current();
    const res = await put({ ...document, slides: [pin(pinned.id, true), pin(loose.id, false)] }, `"${v}"`);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal((await repos.assets.get(brand.id, pinned.id)).value.status, "approved");
    assert.equal((await repos.assets.get(brand.id, loose.id)).value.status, "candidate");
    const audit = (await repos.revisions.list("brand_asset", (await repos.assets.get(brand.id, pinned.id)).id)).at(-1)!;
    assert.deepEqual([audit.reason, audit.author], ["status", "editor"]);
  }],
  ["a failing approval of a pinned asset after the committed save still answers 200 with the new ETag, and the candidate is retried by the next save", async () => {
    const asset = await library.register(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { kind: "photo", origin: "ai", status: "candidate" });
    const pinned = { id: "s-pin", kind: "cover", background: { mode: "asset", assetId: asset.id, pinned: true, source: "ai" }, objects: [] };
    const failing = { ...storage.assets, update: async () => { throw new Error("assets outage"); } };
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await withApp({ assets: failing }, async (url) => {
        const res = await fetch(`${url}/carousels/week-one`, { method: "PUT", headers: { ...JSON_HEADERS, "If-Match": `"${await current()}"` }, body: JSON.stringify({ ...document, slides: [pinned] }) });
        assert.equal(res.status, 200, "the save is committed, so it answers 200");
        assert.equal(res.headers.get("etag"), `"${await current()}"`);
      });
    } finally {
      console.error = original;
    }
    assert.equal(logged.length > 0, true, "the failed approval is logged");
    assert.equal((await repos.assets.get(brand.id, asset.id)).value.status, "candidate");
    assert.equal((await put({ ...document, slides: [pinned] }, `"${await current()}"`)).status, 200);
    assert.equal((await repos.assets.get(brand.id, asset.id)).value.status, "approved", "the next save retries the approval");
  }],
  ["approving pinned assets reads each id (never lists the library), and one failure does not stop the others: they fail together at the end", async () => {
    const { approveCandidates } = await import("../stored-assets.js");
    const [first, second] = await Promise.all(["first piece", "second piece"].map(async (text, i) => {
      const asset = await library.register(Buffer.from(text), { destRelPath: `multi-${i}.png` });
      await repos.assets.update(brand.id, asset.id, { status: "candidate" }, { ...meta, expectedVersion: (await repos.assets.get(brand.id, asset.id)).version });
      return asset;
    }));
    const assets = { ...repos.assets, list: async () => { throw new Error("must not list"); }, update: async (...args: Parameters<typeof repos.assets.update>) => { if (args[1] === first.id) throw new Error("disk full"); return repos.assets.update(...args); } };
    await assert.rejects(
      () => approveCandidates({ storage: { ...storage, assets } as EditorStorage, slug: SLUG, brandId: brand.id }, new Set([first.id, "0000000000000000", second.id]), "editor"),
      (error) => error instanceof AggregateError && error.errors.length === 1 && /1 of 3.*disk full/.test(error.message),
    );
    assert.equal((await repos.assets.get(brand.id, second.id)).value.status, "approved", "the other asset was approved despite the failure");
    assert.equal((await repos.assets.get(brand.id, first.id)).value.status, "candidate");
  }],
  ["creating with a template id (and with none, the default) works; an archived brand is 403, a bad id 400 and a storage outage 503", async () => {
    const create = (body: object, url = `${base}/${SLUG}`) => fetch(`${url}/carousels`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const templateOf = async (res: Response) => ((await res.json()) as { document: { template?: { id: string } } }).document.template?.id;
    const templated = await create({ title: "Templated", templateId: "explicativo", id: "templated-one" });
    assert.deepEqual([templated.status, await templateOf(templated)], [201, "explicativo"]);
    const defaulted = await create({ title: "Default", id: "default-one" });
    assert.deepEqual([defaulted.status, await templateOf(defaulted)], [201, "explicativo"]);
    const free = await create({ title: "Free", templateId: null, id: "free-one" });
    assert.deepEqual([free.status, await templateOf(free)], [201, undefined]);
    assert.equal((await create({ title: "Bad id", blank: true, id: "Not Valid!" })).status, 400);
    const old = await repos.brands.create({ slug: "old-create", displayName: "Old" }, meta);
    const cut = await repos.brands.markCutover(old.id, { ...meta, expectedVersion: old.version });
    await repos.brands.archive(old.id, { ...meta, expectedVersion: cut.version });
    assert.equal((await create({ title: "Late", blank: true }, `${base}/old-create`)).status, 403);
    // No `storedBrandGuard` here on purpose: the guard would answer the outage first, and this test is about the route's own mapping.
    const down = express();
    down.use(express.json());
    const unreachable = async () => { throw new Error("connection refused"); };
    down.use(composeRouter(() => new NonePieceGenerator(), { ...storage, brands: { getBySlug: unreachable, list: unreachable } }));
    const downServer = down.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => downServer.once("listening", resolve));
    try {
      assert.equal((await create({ title: "Down", blank: true }, `http://127.0.0.1:${(downServer.address() as AddressInfo).port}/api/profiles/${SLUG}`)).status, 503);
    } finally {
      downServer.close();
    }
  }],
  ["a race lost inside the repository (after the pre-check passed) is the same 409 with the competitor's version and document", async () => {
    let raced = false;
    type Save = typeof repos.carousels.save;
    const save: Save = async (id, input, m) => {
      if (!raced) await ((raced = true), repos.carousels.save(id, { title: "Competitor", document: { json: { ...document, title: "Competitor" }, schemaVersion: 1 } }, m));
      return repos.carousels.save(id, input, m);
    };
    const racing = { get: repos.carousels.get.bind(repos.carousels), list: repos.carousels.list.bind(repos.carousels), save, setStatus: repos.carousels.setStatus.bind(repos.carousels), create: repos.carousels.create.bind(repos.carousels) };
    await withApp({ carousels: racing }, async (url) => {
      const version = await current();
      const res = await fetch(`${url}/carousels/week-one`, { method: "PUT", headers: { ...JSON_HEADERS, "If-Match": `"${version}"` }, body: JSON.stringify({ ...document, title: "Loser" }) });
      assert.ok(raced);
      assert.equal(res.status, 409);
      const body = (await res.json()) as { currentVersion: number; document: { title: string } };
      assert.equal(body.currentVersion, version + 1);
      assert.equal(body.document.title, "Competitor");
      assert.equal(await current(), version + 1);
    });
  }],
  ["repository-side refusals map like the pre-checks: BrandArchivedError is 403, InvalidInputError is 400, a bare conflict is 409 with its ETag", async () => {
    const failing = (error: Error) => ({ get: repos.carousels.get.bind(repos.carousels), list: repos.carousels.list.bind(repos.carousels), save: async () => { throw error; }, setStatus: repos.carousels.setStatus.bind(repos.carousels), create: repos.carousels.create.bind(repos.carousels) });
    const attempt = async (url: string) => fetch(`${url}/carousels/week-one`, { method: "PUT", headers: { ...JSON_HEADERS, "If-Match": `"${await current()}"` }, body: JSON.stringify(document) });
    await withApp({ carousels: failing(new BrandArchivedError("write-example")) }, async (url) => {
      const res = await attempt(url);
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /archivada/);
    });
    await withApp({ carousels: failing(new InvalidInputError("title is too long")) }, async (url) => {
      const res = await attempt(url);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /title is too long/);
    });
    // A conflict that reaches the generic handler (outside the save route) still names the version, as body and ETag.
    await withApp({ carousels: { ...failing(new VersionConflictError(7)), get: async () => { throw new VersionConflictError(7); } } }, async (url) => {
      const res = await fetch(`${url}/carousels/week-one`);
      assert.equal(res.status, 409);
      assert.equal(res.headers.get("etag"), '"7"');
      assert.equal(((await res.json()) as { currentVersion: number }).currentVersion, 7);
    });
  }],
  ["a PUT through an encoded slug takes the same stored path and creates no folder", async () => {
    const res = await put({ ...document, title: "Encoded" }, `"${await current()}"`, "/write%2Dexample/carousels/week-one");
    assert.equal(res.status, 200);
    assert.equal(existsSync(join(root, "profiles", SLUG)), false);
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
    corruptApp.use(express.json());
    corruptApp.use(profilesRouter(corrupt));
    const corruptServer = corruptApp.listen(0, "127.0.0.1");
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
      const saved = await fetch(`${url}/carousels/week-one`, { method: "PUT", headers: { ...JSON_HEADERS, "If-Match": `"${await current()}"` }, body: JSON.stringify(document) });
      assert.equal(saved.status, 503, "save");
      assert.doesNotMatch(JSON.stringify(await saved.json()), /Unexpected token/);
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
    assert.equal((await put(document, undefined, "/old-write/carousels/week-one")).status, 403, "no header is 403, not 428: archived is checked first");
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
