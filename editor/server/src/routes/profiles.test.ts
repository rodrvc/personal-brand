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
const { writeDocument, readDocumentRaw } = await import("../document-store.js");
const { buildEmptyDocument } = await import("../compose/planner.js");
const { loadBrand } = await import("../../../../system/ig-carousel/brand-schema.js");
const { loadLayoutTemplate } = await import("../../../../system/ig-carousel/layout-template.js");

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
    },
  ],

  [
    "PUT /api/profiles/:slug/carousels/:id keeps the on-disk lifecycle status over the client's copy",
    async () => {
      const store = new ProfileStore(FULL_SLUG);
      const brand = loadBrand(store.roots.profileDir);
      const template = loadLayoutTemplate(store.roots.profileDir, "explicativo", brand);
      const doc = buildEmptyDocument(brand, template, "explicativo", "status-test", "Status test");
      writeDocument(store, { ...doc, status: "exported" });

      // A stale client (its copy predates the export) saves "draft" back.
      const { status, body } = await put(`/api/profiles/${FULL_SLUG}/carousels/${doc.id}`, { ...doc, status: "draft" });
      assert.equal(status, 200);
      assert.equal((body as { status: string }).status, "exported", "response keeps the server's status");
      assert.equal((readDocumentRaw(store, doc.id) as { status: string }).status, "exported", "disk keeps the server's status");
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
