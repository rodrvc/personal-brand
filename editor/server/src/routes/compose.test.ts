import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * Covers the "no template" paths added in C2b over real HTTP, against the
 * same temp-profile harness `profiles.test.ts` uses (a copy of the tracked
 * `profiles/example`):
 *
 * - creating a carousel with `templateId: null` persists a document with no
 *   `template` key at all
 * - `GET .../template/__free__` answers the built-in free template without
 *   touching disk
 * - `PUT` snapshots when the template reference appears or disappears
 * - the preview HTML route renders a template-less document (no footer zone)
 *
 * None of these needs Chromium: `POST /carousels` is inert (no generator
 * call), and `/slides/:n/html` is pure string rendering — only `/png` and
 * `/contrast` launch a browser, and neither is exercised here. The compose
 * router's generator factory is therefore a stub that throws if called,
 * which is itself part of the assertion that create is inert.
 *
 * `BRAND_PROFILES_DIR` must be set before importing anything that pulls in
 * `../profile-store.js`, same requirement as the other route tests.
 */

const root = mkdtempSync(join(tmpdir(), "editor-server-compose-route-test-"));
process.env.BRAND_PROFILES_DIR = root;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SLUG = "acme-full";
cpSync(join(REPO_ROOT, "profiles", "example"), join(root, SLUG), { recursive: true });

const { default: express } = await import("express");
const { composeRouter } = await import("./compose.js");
const { profilesRouter } = await import("./profiles.js");
const { renderRouter } = await import("./render.js");
const { ProfileStore } = await import("../profile-store.js");
const { readDocumentRaw, listVersions } = await import("../document-store.js");
const { FREE_TEMPLATE_ID } = await import("../../../../system/ig-carousel/layout-template.js");

const app = express();
app.use(express.json());
app.use(
  composeRouter(() => {
    throw new Error("the generator must never be constructed by an inert create");
  }),
);
app.use(profilesRouter());
app.use(renderRouter());

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function put(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "POST /carousels with templateId: null writes a document with no template key",
    async () => {
      const { status, body } = await post(`/api/profiles/${SLUG}/carousels`, {
        id: "free-one",
        title: "Free one",
        templateId: null,
      });
      assert.equal(status, 201);
      const { document } = body as { document: Record<string, unknown> };
      assert.equal("template" in document, false, "response document must omit `template`");

      const store = new ProfileStore(SLUG);
      const onDisk = readDocumentRaw(store, "free-one") as Record<string, unknown>;
      assert.equal("template" in onDisk, false, "persisted document must omit `template`");
      assert.ok(Array.isArray(onDisk.slides) && (onDisk.slides as unknown[]).length > 0);
    },
  ],

  [
    "POST /carousels with no templateId keeps the explicativo default",
    async () => {
      const { status, body } = await post(`/api/profiles/${SLUG}/carousels`, {
        id: "default-one",
        title: "Default one",
      });
      assert.equal(status, 201);
      const { document } = body as { document: { template?: { id: string } } };
      assert.equal(document.template?.id, "explicativo");
    },
  ],

  [
    "POST /carousels?mode=plan with templateId: null is a 400",
    async () => {
      const { status } = await post(`/api/profiles/${SLUG}/carousels?mode=plan`, {
        id: "plan-free",
        prompt: "anything",
        templateId: null,
      });
      assert.equal(status, 400);
    },
  ],

  [
    "GET /template/__free__ returns the inert free template",
    async () => {
      const { status, body } = await get(`/api/profiles/${SLUG}/template/${FREE_TEMPLATE_ID}`);
      assert.equal(status, 200);
      const template = body as {
        id: string;
        zones: { footer: { height: number; logo: string; pagination: string }; margins: Record<string, number> };
        slides: Record<string, { slots: unknown[] }>;
      };
      assert.equal(template.id, FREE_TEMPLATE_ID);
      assert.equal(template.zones.footer.height, 0);
      assert.equal(template.zones.footer.logo, "none");
      assert.equal(template.zones.footer.pagination, "none");
      assert.deepEqual(template.zones.margins, { top: 0, right: 0, bottom: 0, left: 0 });
      for (const kind of Object.keys(template.slides)) {
        assert.deepEqual(template.slides[kind]!.slots, [], `${kind} must declare no slots`);
      }
    },
  ],

  [
    "GET /templates still never lists the free sentinel",
    async () => {
      const { body } = await get(`/api/profiles/${SLUG}/templates`);
      const { templates } = body as { templates: Array<{ id: string }> };
      assert.ok(templates.every((t) => t.id !== FREE_TEMPLATE_ID));
    },
  ],

  [
    "PUT snapshots when the template reference appears and again when it disappears",
    async () => {
      const store = new ProfileStore(SLUG);
      const free = readDocumentRaw(store, "free-one") as Record<string, unknown>;
      assert.deepEqual(listVersions(store, "free-one"), [], "no versions before any PUT");

      // undefined -> "explicativo" is structural: every slide's locked
      // zones and slot defaults move.
      const withTemplate = { ...free, template: { id: "explicativo" } };
      const first = await put(`/api/profiles/${SLUG}/carousels/free-one`, withTemplate);
      assert.equal(first.status, 200);
      assert.equal(listVersions(store, "free-one").length, 1, "adding a template snapshots");

      // ...and back: "explicativo" -> undefined must snapshot too.
      const second = await put(`/api/profiles/${SLUG}/carousels/free-one`, free);
      assert.equal(second.status, 200);
      assert.equal(listVersions(store, "free-one").length, 2, "removing the template snapshots");
      assert.equal("template" in (readDocumentRaw(store, "free-one") as object), false);

      // A PUT that changes nothing structural writes no third version.
      await put(`/api/profiles/${SLUG}/carousels/free-one`, free);
      assert.equal(listVersions(store, "free-one").length, 2, "an unchanged template writes no version");
    },
  ],

  [
    "GET /slides/0/html renders a template-less document with no footer zone",
    async () => {
      const res = await fetch(`${base}/api/profiles/${SLUG}/carousels/free-one/slides/0/html`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.equal(html.includes('data-zone="footer"'), false, "free render paints no footer zone");
      assert.ok(html.includes("<html"), "still a full HTML document");
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
    console.error(error);
  }
}

server.close();
rmSync(root, { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
