import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * Exercises `GET /api/profiles/:slug/templates` (ACU-230) over a real HTTP
 * request against the router, rather than calling internals directly — the
 * behavior under test is the route's own existence check (404 for an
 * unresolvable slug, without `ProfileStore`/`listLayoutTemplates` ever
 * reading outside the profiles root), which a direct function call would
 * bypass.
 *
 * `BRAND_PROFILES_DIR` must be set before importing `../profile-store.js`
 * (and anything that imports it), same requirement as
 * `profile-store.test.ts` and `compose-job.test.ts`.
 */

const root = mkdtempSync(join(tmpdir(), "editor-server-profiles-route-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });

// A second, fully-formed profile (a copy of the tracked `example`) for the
// document routes, which need a brand and an asset index to validate.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FULL_SLUG = "acme-full";
cpSync(join(REPO_ROOT, "profiles", "example"), join(root, FULL_SLUG), { recursive: true });

const { default: express } = await import("express");
const { profilesRouter } = await import("./profiles.js");
const { ProfileStore } = await import("../profile-store.js");
const { writeDocument, readDocumentRaw, listVersions } = await import("../document-store.js");
const { buildEmptyDocument } = await import("../compose/planner.js");

const app = express();
app.use(express.json());
app.use(profilesRouter());

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

async function put(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, body: json };
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "GET /api/profiles/:slug/templates 404s for an unresolvable slug",
    async () => {
      const { status, body } = await get("/api/profiles/does-not-exist/templates");
      assert.equal(status, 404);
      assert.match((body as { error: string }).error, /does-not-exist/);
    },
  ],

  [
    "GET /api/profiles/:slug/templates lists the engine default for a profile with no override",
    async () => {
      const { status, body } = await get(`/api/profiles/${SLUG}/templates`);
      assert.equal(status, 200);
      const { templates } = body as { templates: Array<{ id: string; origin: string }> };
      const explicativo = templates.find((t) => t.id === "explicativo");
      assert.ok(explicativo, "engine default must be listed");
      assert.equal(explicativo!.origin, "engine-default");
      const { freeTemplateId } = body as { freeTemplateId: string };
      assert.equal(freeTemplateId, "__free__", "listing names the free template's sentinel as a field");
      assert.ok(!templates.some((t) => t.id === freeTemplateId), "the sentinel is never a listing entry");
    },
  ],

  [
    "GET /api/profiles/:slug/template/__free__ validates the slug like any other id",
    async () => {
      const bad = await get("/api/profiles/INVALID_SLUG/template/__free__");
      assert.equal(bad.status, 400, "a malformed slug is rejected before the sentinel is answered");
      const ok = await get(`/api/profiles/${SLUG}/template/__free__`);
      assert.equal(ok.status, 200);
      assert.equal((ok.body as { zones: { footer: { height: number } } }).zones.footer.height, 0);
    },
  ],

  [
    "deleting a slide versions the document before the write, without asking for a snapshot",
    async () => {
      const store = new ProfileStore(FULL_SLUG);
      const slide = (id: string) => ({
        id,
        kind: "step" as const,
        background: { mode: "color" as const, colorKey: "paper", pinned: false, source: "manual" as const },
        objects: [],
      });
      const doc = { ...buildEmptyDocument("explicativo", "delete-slide", "Delete slide"), slides: [slide("slide-1"), slide("slide-2")] };
      writeDocument(store, doc);
      assert.deepEqual(listVersions(store, doc.id), [], "no versions before any PUT");

      // What the editor's delete button sends: one slide fewer.
      const { status } = await put(`/api/profiles/${FULL_SLUG}/carousels/${doc.id}`, { ...doc, slides: [slide("slide-1")] });
      assert.equal(status, 200);
      const [version] = listVersions(store, doc.id);
      assert.ok(version, "removing a slide writes a version");

      // The version must be the document as it was BEFORE the delete —
      // a snapshot taken after the write would be worth nothing.
      const snapshot = store.readJson(`carousels/${doc.id}/versions/${version}.json`) as { slides: unknown[] };
      assert.equal(snapshot.slides.length, 2, "the version holds the deck as it was before the delete");
      assert.equal((readDocumentRaw(store, doc.id) as { slides: unknown[] }).slides.length, 1, "and the write itself lands");
    },
  ],

  [
    "PUT /api/profiles/:slug/carousels/:id keeps the on-disk lifecycle status over the client's copy",
    async () => {
      const store = new ProfileStore(FULL_SLUG);
      const doc = buildEmptyDocument("explicativo", "status-test", "Status test");
      writeDocument(store, { ...doc, status: "exported" });

      // A stale client (its copy predates the export) saves "draft" back.
      const { status, body } = await put(`/api/profiles/${FULL_SLUG}/carousels/${doc.id}`, { ...doc, status: "draft" });
      assert.equal(status, 200);
      assert.equal((body as { status: string }).status, "exported", "response keeps the server's status");
      assert.equal((readDocumentRaw(store, doc.id) as { status: string }).status, "exported", "disk keeps the server's status");
    },
  ],

  [
    "PUT /api/profiles/:slug/carousels/:id refuses a copy that does not descend from the saved revision",
    async () => {
      const store = new ProfileStore(FULL_SLUG);
      const doc = buildEmptyDocument("explicativo", "revision-test", "Revision test");
      writeDocument(store, doc);
      const path = `/api/profiles/${FULL_SLUG}/carousels/${doc.id}`;
      const edited = { ...doc, title: "Edited", updatedAt: "2026-01-01T00:00:01.000Z" };

      assert.equal((await put(`${path}?base=${encodeURIComponent(doc.updatedAt)}`, edited)).status, 200);
      const stale = await put(`${path}?base=${encodeURIComponent(doc.updatedAt)}`, { ...doc, title: "Stale" });
      assert.equal(stale.status, 409, "a second writer still on the old revision is refused");
      assert.equal((readDocumentRaw(store, doc.id) as { title: string }).title, "Edited", "and the file keeps the newer write");
      assert.equal((await put(`${path}?base=${encodeURIComponent(edited.updatedAt)}`, { ...edited, title: "Next" })).status, 200);
    },
  ],

  [
    "PUT /api/profiles/:slug/carousels/:id refuses a stale base after a background bucket write, in s3 mode too",
    async () => {
      // The same stale-base check above, but with the storage backend
      // actually routed through a bucket (a `FakeObjectStore`, no real S3
      // needed) instead of the plain filesystem — the editor PUT route and
      // `writeDocumentThroughRevision`'s bucket-backed write guarantees are
      // exactly what a chat proposal or export job also goes through.
      const { setStorageRuntimeForTests, resetStorageRuntimeForTests } = await import("../storage/runtime.js");
      const { FakeObjectStore } = await import("../storage/fake-object-store.js");
      const { writeDocumentThroughRevision } = await import("../document-store.js");

      const cacheDir = mkdtempSync(join(tmpdir(), "editor-server-profiles-route-s3-test-"));
      const bucket = "brand-profiles";
      const s3Slug = "acme-s3";
      cpSync(join(REPO_ROOT, "profiles", "example"), join(cacheDir, bucket, "profiles", s3Slug), { recursive: true });

      setStorageRuntimeForTests({
        config: {
          backend: "s3",
          cacheDir,
          s3: {
            bucket,
            region: "us-east-1",
            accessKeyId: "id",
            secretAccessKey: "secret",
            prefix: "profiles/",
            forcePathStyle: true,
          },
        },
        store: new FakeObjectStore(),
      });
      const previousProfilesDir = process.env.BRAND_PROFILES_DIR;
      process.env.BRAND_PROFILES_DIR = join(cacheDir, bucket, "profiles");

      try {
        const store = new ProfileStore(s3Slug);
        const doc = buildEmptyDocument("explicativo", "s3-revision-test", "S3 revision test");
        await writeDocumentThroughRevision(store, doc, { create: true });

        // A chat proposal (or export job) saves in the background, through
        // the exact same bucket-backed write path — advancing the
        // document's revision (and `updatedAt`) the editor's client never
        // saw.
        await writeDocumentThroughRevision(store, { ...doc, title: "changed by a background write", updatedAt: "2026-01-01T00:00:05.000Z" });

        // The editor still holds the pre-write revision (`doc.updatedAt`).
        const path = `/api/profiles/${s3Slug}/carousels/${doc.id}`;
        const stale = await put(`${path}?base=${encodeURIComponent(doc.updatedAt)}`, { ...doc, title: "editor's stale PUT" });
        assert.equal(stale.status, 409, "a stale base after a concurrent bucket write is refused in s3 mode too");
      } finally {
        resetStorageRuntimeForTests();
        if (previousProfilesDir === undefined) delete process.env.BRAND_PROFILES_DIR;
        else process.env.BRAND_PROFILES_DIR = previousProfilesDir;
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
  ],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split("\n")[0]}`);
  }
}

server.close();
rmSync(root, { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
