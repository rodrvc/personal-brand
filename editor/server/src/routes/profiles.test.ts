import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Another profile with a valid, minimal brand.json plus a registered
 * `kind: "logo"` asset — exercises the `GET /api/profiles` card-summary
 * enrichment (brand cards feature): colors/fonts/wordmark read straight
 * from brand.json, and `logoAssetUrl` pointing at the registered file.
 */
const BRANDED_SLUG = "branded";
const brandedDir = join(root, BRANDED_SLUG);
mkdirSync(brandedDir, { recursive: true });
writeFileSync(
  join(brandedDir, "brand.json"),
  JSON.stringify({
    locale: "es-CL",
    colors: { ink: "#111111", paper: "#fafafa" },
    roles: {
      accent: "ink",
      wordmark: "ink",
      surface: "paper",
      onSurface: "ink",
      onSurfaceMuted: "ink",
      flourish: "ink",
      highlight: "ink",
    },
    fonts: { logo: "Fraunces", body: "Inter", handwritten: "Caveat" },
    googleFontsHref: "https://fonts.googleapis.com/css2?family=Fraunces",
    radius: { card: "12px" },
    copy: { wordmark: "Marca Ficticia", site: "marcaficticia.example" },
  }),
);

// A 1x1 transparent PNG, just enough for `detectImage` to classify it.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * Another profile whose brand.json exists but is missing a required field
 * (`roles`) — `loadBrand` throws for it. Proves the listing degrades that
 * one profile's `card` to `undefined` instead of 500ing the whole endpoint.
 */
const BROKEN_SLUG = "broken-brand";
const brokenDir = join(root, BROKEN_SLUG);
mkdirSync(brokenDir, { recursive: true });
writeFileSync(join(brokenDir, "brand.json"), JSON.stringify({ colors: {} }));

/**
 * A fourth profile isolating the cover-picking behavior: two carousels, the
 * *newer* one still essentially empty (default color background, no
 * objects — what `POST /carousels` actually creates) and an *older* one
 * whose first slide has real text. Proves the card's cover skips the
 * empty-but-newest carousel and falls through to the older one that
 * actually has content, instead of a blank sheet.
 */
const COVER_SLUG = "cover-pick";
const coverDir = join(root, COVER_SLUG);
mkdirSync(coverDir, { recursive: true });
writeFileSync(
  join(coverDir, "brand.json"),
  JSON.stringify({
    locale: "es-CL",
    colors: { ink: "#222222", paper: "#eeeeee" },
    roles: {
      accent: "ink",
      wordmark: "ink",
      surface: "paper",
      onSurface: "ink",
      onSurfaceMuted: "ink",
      flourish: "ink",
      highlight: "ink",
    },
    fonts: { logo: "Fraunces", body: "Inter", handwritten: "Caveat" },
    radius: { card: "12px" },
    copy: { wordmark: "Cover Pick", site: "coverpick.example" },
  }),
);

function minimalCarouselDoc(id: string, updatedAt: string, slide0Objects: unknown[]): unknown {
  return {
    schemaVersion: 1,
    id,
    title: id,
    status: "draft",
    createdAt: updatedAt,
    updatedAt,
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "", createdAt: updatedAt },
    template: { id: "explicativo" },
    slides: [
      {
        id: "s1",
        kind: "cover",
        background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
        objects: slide0Objects,
      },
    ],
  };
}

const EMPTY_NEWEST_ID = "empty-newest";
const CONTENT_OLDER_ID = "content-older";
mkdirSync(join(coverDir, "carousels", EMPTY_NEWEST_ID), { recursive: true });
writeFileSync(
  join(coverDir, "carousels", EMPTY_NEWEST_ID, "carousel.json"),
  JSON.stringify(minimalCarouselDoc(EMPTY_NEWEST_ID, "2026-09-28T00:00:00.000Z", [])),
);
mkdirSync(join(coverDir, "carousels", CONTENT_OLDER_ID), { recursive: true });
writeFileSync(
  join(coverDir, "carousels", CONTENT_OLDER_ID, "carousel.json"),
  JSON.stringify(
    minimalCarouselDoc(CONTENT_OLDER_ID, "2026-09-01T00:00:00.000Z", [
      { id: "t1", kind: "text", text: "Hola mundo", pinned: false, locked: false, source: "manual" },
    ]),
  ),
);

const { default: express } = await import("express");
const { profilesRouter } = await import("./profiles.js");
const { ProfileStore } = await import("../profile-store.js");
const { writeDocument, readDocumentRaw, listVersions } = await import("../document-store.js");
const { buildEmptyDocument } = await import("../compose/planner.js");
const { registerFile } = await import("../../../../system/assets/index.js");

registerFile(brandedDir, ONE_PIXEL_PNG, { kind: "logo", origin: "manual", status: "approved" });

/**
 * A newest carousel whose only content is a `kind: "asset"` object
 * pointing at an assetId that resolves to nothing — the two causes named
 * for this are "not in the profile's asset index" and "in the index but
 * its file is missing on disk"; this fixture exercises the first (a
 * never-registered id), since the second is inherently self-healing in
 * `loadIndex` (any stale index entry gets rescanned away the moment disk
 * and index disagree, which is exactly what makes the profile's own asset
 * index trustworthy in the first place). Either way the observable
 * contract is the same: this carousel — despite being the newest, and
 * despite carrying an `asset` object rather than an empty slide — must not
 * win the cover race over an older carousel that has real, renderable
 * content. Its `updatedAt` is newer than both `EMPTY_NEWEST_ID` and
 * `CONTENT_OLDER_ID`.
 */
const ASSET_UNRESOLVABLE_ID = "asset-unresolvable";
mkdirSync(join(coverDir, "carousels", ASSET_UNRESOLVABLE_ID), { recursive: true });
writeFileSync(
  join(coverDir, "carousels", ASSET_UNRESOLVABLE_ID, "carousel.json"),
  JSON.stringify(
    minimalCarouselDoc(ASSET_UNRESOLVABLE_ID, "2026-09-29T00:00:00.000Z", [
      {
        id: "a1",
        kind: "asset",
        assetId: "0000000000000000",
        pinned: true,
        locked: false,
        source: "manual",
      },
    ]),
  ),
);

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

  [
    "GET /api/profiles enriches a profile with brand.json with a card summary",
    async () => {
      const { status, body } = await get("/api/profiles");
      assert.equal(status, 200);
      const { profiles } = body as {
        profiles: Array<{
          slug: string;
          hasBrand: boolean;
          card?: {
            colors: string[];
            logoFont?: string;
            googleFontsHref?: string;
            wordmark?: string;
            logoAssetUrl?: string;
            carouselCount: number;
          };
        }>;
      };
      const branded = profiles.find((p) => p.slug === BRANDED_SLUG);
      assert.ok(branded, "branded profile must be listed");
      assert.equal(branded!.hasBrand, true);
      assert.ok(branded!.card, "a profile with brand.json must carry a card summary");
      assert.deepEqual(branded!.card!.colors.sort(), ["#111111", "#fafafa"]);
      assert.equal(branded!.card!.logoFont, "Fraunces");
      assert.equal(branded!.card!.googleFontsHref, "https://fonts.googleapis.com/css2?family=Fraunces");
      assert.equal(branded!.card!.wordmark, "Marca Ficticia");
      assert.equal(branded!.card!.carouselCount, 0);
      assert.match(branded!.card!.logoAssetUrl ?? "", new RegExp(`^/api/profiles/${BRANDED_SLUG}/assets/files/`));
    },
  ],

  [
    "GET /api/profiles omits card for a profile with no brand.json, without failing the listing",
    async () => {
      const { status, body } = await get("/api/profiles");
      assert.equal(status, 200);
      const { profiles } = body as { profiles: Array<{ slug: string; hasBrand: boolean; card?: unknown }> };
      const noBrand = profiles.find((p) => p.slug === SLUG);
      assert.ok(noBrand);
      assert.equal(noBrand!.hasBrand, false);
      assert.equal(noBrand!.card, undefined);
    },
  ],

  [
    "GET /api/profiles picks the newest carousel that actually has content, skipping an empty newer one",
    async () => {
      const { status, body } = await get("/api/profiles");
      assert.equal(status, 200);
      const { profiles } = body as {
        profiles: Array<{ slug: string; card?: { coverImageUrl?: string; carouselCount: number } }>;
      };
      const coverPick = profiles.find((p) => p.slug === COVER_SLUG);
      assert.ok(coverPick?.card, "cover-pick profile must carry a card summary");
      assert.equal(
        coverPick!.card!.coverImageUrl,
        `/api/profiles/${COVER_SLUG}/carousels/${CONTENT_OLDER_ID}/slides/0/png`,
        "cover must point at the older carousel with content, not the empty newest one",
      );
    },
  ],

  [
    "GET /api/profiles skips a newest carousel whose only content is an unresolvable assetId, in favor of an older carousel with real content",
    async () => {
      const { status, body } = await get("/api/profiles");
      assert.equal(status, 200);
      const { profiles } = body as {
        profiles: Array<{ slug: string; card?: { coverImageUrl?: string; carouselCount: number } }>;
      };
      const coverPick = profiles.find((p) => p.slug === COVER_SLUG);
      assert.ok(coverPick?.card, "cover-pick profile must carry a card summary");
      assert.notEqual(
        coverPick!.card!.coverImageUrl,
        `/api/profiles/${COVER_SLUG}/carousels/${ASSET_UNRESOLVABLE_ID}/slides/0/png`,
        "the newest carousel's unresolvable asset must never win the cover race",
      );
      assert.equal(
        coverPick!.card!.coverImageUrl,
        `/api/profiles/${COVER_SLUG}/carousels/${CONTENT_OLDER_ID}/slides/0/png`,
        "cover must still fall through to the older carousel with real content",
      );
    },
  ],

  [
    "GET /api/profiles degrades a broken brand.json to a missing card instead of 500ing",
    async () => {
      const { status, body } = await get("/api/profiles");
      assert.equal(status, 200);
      const { profiles } = body as { profiles: Array<{ slug: string; hasBrand: boolean; card?: unknown }> };
      const broken = profiles.find((p) => p.slug === BROKEN_SLUG);
      assert.ok(broken, "broken-brand profile must still be listed");
      assert.equal(broken!.hasBrand, true, "brand.json exists on disk, even though it fails to parse");
      assert.equal(broken!.card, undefined);
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
