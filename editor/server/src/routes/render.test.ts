import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/** This file lives at `editor/server/src/routes/`, four levels under the repo root. Resolved from `import.meta.url` rather than `process.cwd()` so it works regardless of which directory the test is invoked from. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Regression test for a bug the brand-cards feature surfaced: a brand-new
 * `browser.newPage()` starts at `about:blank`, which has no real origin to
 * resolve a *relative* URL against — so a `<img src="/api/profiles/...">`
 * inside HTML handed to `page.setContent()` never even attempted a fetch.
 * No request fired, nothing for `page.route` to intercept, the image just
 * silently never painted. Every slide with an image object rendered as
 * background-only. Fixed in `render.ts`'s `loadSlide`, which loads the
 * slide HTML from a real origin (itself served in-process, no real
 * network) instead of `setContent` on about:blank.
 *
 * Exercised over a real HTTP request against the router, with a real
 * Chromium render (this is the one thing a lower-level test can't catch:
 * the bug was entirely in how Chromium resolves the HTML, not in the HTML
 * string itself, which was always correct — see the comment on
 * `ASSET_CAROUSEL_ID`'s fixture below for why a plain string assertion on
 * the HTML wouldn't have caught this).
 *
 * `BRAND_PROFILES_DIR` must be set before importing `../profile-store.js`
 * (and anything that imports it), same requirement as the other route
 * tests in this directory.
 */

const root = mkdtempSync(join(tmpdir(), "editor-server-render-route-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "render-fixture";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
writeFileSync(
  join(profileDir, "brand.json"),
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
    fonts: { logo: "Georgia, serif", body: "Arial, sans-serif", handwritten: "Georgia, serif" },
    radius: { card: "12px" },
    copy: { wordmark: "Render Fixture", site: "renderfixture.example" },
  }),
);

const { default: express } = await import("express");
const { assetsRouter } = await import("./assets.js");
const { renderRouter } = await import("./render.js");
const { registerFile } = await import("../../../../system/assets/index.js");
const { closeSharedBrowser } = await import("../browser.js");

// A real, high-entropy photographic image already tracked in the repo's
// fictional `profiles/example` fixture (public-safe, generic) — reused
// here rather than committing a new binary. A flat/solid-color or 1x1
// image would be a bad choice: it compresses to a tiny PNG whether or not
// it actually painted, which is exactly the ambiguity this test needs to
// avoid (see the size assertion below).
const FIXTURE_IMAGE = readFileSync(join(REPO_ROOT, "profiles", "example", "assets", "reel", "item1.jpg"));
const registeredAsset = registerFile(profileDir, FIXTURE_IMAGE, {
  kind: "photo",
  origin: "manual",
  status: "approved",
  destRelPath: "assets/fixture.jpg",
});

function minimalCarouselDoc(id: string, objects: unknown[]): unknown {
  return {
    schemaVersion: 1,
    id,
    title: id,
    status: "draft",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "", createdAt: "2026-09-01T00:00:00.000Z" },
    template: { id: "explicativo" },
    slides: [
      {
        id: "s1",
        kind: "cover",
        background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
        objects,
      },
    ],
  };
}

// Control: background only, no objects — this is the "asset silently
// didn't load" shape a regression would collapse the asset carousel into.
const CONTROL_CAROUSEL_ID = "control-carousel";
mkdirSync(join(profileDir, "carousels", CONTROL_CAROUSEL_ID), { recursive: true });
writeFileSync(
  join(profileDir, "carousels", CONTROL_CAROUSEL_ID, "carousel.json"),
  JSON.stringify(minimalCarouselDoc(CONTROL_CAROUSEL_ID, [])),
);

// Same background, plus one full-bleed asset object referencing the
// registered photo — the exact shape of the real carousel that surfaced
// this bug (a single full-bleed `kind: "asset"` object, no text).
const ASSET_CAROUSEL_ID = "asset-carousel";
mkdirSync(join(profileDir, "carousels", ASSET_CAROUSEL_ID), { recursive: true });
writeFileSync(
  join(profileDir, "carousels", ASSET_CAROUSEL_ID, "carousel.json"),
  JSON.stringify(
    minimalCarouselDoc(ASSET_CAROUSEL_ID, [
      {
        id: "a1",
        geometry: { x: 0, y: 0, w: 1080, h: 1350, rotation: 0 },
        pinned: true,
        locked: false,
        source: "manual",
        kind: "asset",
        assetId: registeredAsset.id,
        fit: "cover",
      },
    ]),
  ),
);

const app = express();
app.use(express.json());
app.use(assetsRouter());
app.use(renderRouter());

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

async function getPng(carouselId: string): Promise<{ status: number; bytes: number }> {
  const res = await fetch(`${base}/api/profiles/${SLUG}/carousels/${carouselId}/slides/0/png`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes: buf.length };
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "GET .../slides/0/png actually paints a full-bleed asset object, not just the background",
    async () => {
      const control = await getPng(CONTROL_CAROUSEL_ID);
      const withAsset = await getPng(ASSET_CAROUSEL_ID);
      assert.equal(control.status, 200);
      assert.equal(withAsset.status, 200);
      // A flat-color-only render compresses to a few KB; a real
      // photograph does not. Before the fix, both PNGs would be
      // near-identical in size (the asset silently failed to load and
      // Chromium painted background-only for both).
      assert.ok(
        withAsset.bytes > control.bytes * 3,
        `expected the asset render (${withAsset.bytes}b) to be substantially larger than the ` +
          `background-only control (${control.bytes}b) — the asset object did not paint`,
      );
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
await closeSharedBrowser();
rmSync(root, { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
