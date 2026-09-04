import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import type { AddressInfo } from "node:net";

/**
 * Exercises `POST /carousels/:id/regenerate` with `scope: "unpinned"`
 * against a fake `PieceGenerator` — never touches a real AI provider.
 * Covers piece-generation spec's "Regeneration per piece": a pinned piece
 * on the target slide is untouched byte-for-byte, and no other slide is
 * modified.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const EXAMPLE_PROFILE = join(REPO_ROOT, "profiles", "example");

const root = mkdtempSync(join(tmpdir(), "editor-server-regenerate-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
cpSync(EXAMPLE_PROFILE, profileDir, { recursive: true });

// A minimal valid 1x1 PNG, registered as an already-approved library asset
// so the pinned object references something real.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const { registerFile } = await import("../../../../system/assets/index.js");
const pinnedAsset = registerFile(profileDir, TINY_PNG, {
  destRelPath: "assets/pinned.png",
  origin: "manual",
  status: "approved",
});

const CAROUSEL_ID = "regen-carousel";
const OTHER_SLIDE_ID = "slide-2";
const now = new Date().toISOString();

/** Two slides: the target has one pinned asset object and one unpinned text object; the other slide must never be touched. */
function makeDocument() {
  return {
    schemaVersion: 1,
    id: CAROUSEL_ID,
    title: "Regenerate test",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "A carousel for the regenerate test", createdAt: now, runs: [] },
    template: { id: "explicativo" },
    slides: [
      {
        id: "slide-1",
        kind: "cover",
        background: { mode: "color", colorKey: "paper", pinned: true, source: "manual" },
        objects: [
          {
            id: "obj-pinned-photo",
            kind: "asset",
            slot: "media",
            pinned: true,
            locked: false,
            source: "manual",
            assetId: pinnedAsset.id,
            fit: "cover",
          },
          {
            id: "obj-unpinned-title",
            kind: "text",
            slot: "title",
            pinned: false,
            locked: false,
            source: "ai",
            text: "Original headline",
          },
        ],
      },
      {
        id: OTHER_SLIDE_ID,
        kind: "closing",
        background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
        objects: [
          {
            id: "obj-other-slide-title",
            kind: "text",
            slot: "title",
            pinned: false,
            locked: false,
            source: "ai",
            text: "Untouched slide's headline",
          },
        ],
      },
    ],
  };
}

mkdirSync(join(profileDir, "carousels", CAROUSEL_ID), { recursive: true });
writeFileSync(
  join(profileDir, "carousels", CAROUSEL_ID, "carousel.json"),
  JSON.stringify(makeDocument(), null, 2) + "\n",
);

/** Fake `PieceGenerator`: deterministic, in-memory, no network — draftCopy returns a fixed new headline, generateImage returns a tiny distinct PNG so a new assetId is registered. */
const OTHER_TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const fakeGenerator = {
  async draftCopy() {
    return {
      slides: [{ slideId: "slide-1", headline: "Regenerated headline" }],
      model: "fake",
      costCents: 0,
    };
  },
  async generateImage() {
    return { buffer: OTHER_TINY_PNG, mime: "image/png", model: "fake", costCents: 1 };
  },
};

const { composeRouter } = await import("../routes/compose.js");

const app = express();
app.use(express.json());
app.use(composeRouter(() => fakeGenerator as never));

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

/** Resets the persisted document back to the fixture before each test, so tests don't observe each other's writes. */
function resetDocument(): ReturnType<typeof makeDocument> {
  const doc = makeDocument();
  writeFileSync(join(profileDir, "carousels", CAROUSEL_ID, "carousel.json"), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

async function regenerateUnpinned(slideId: string) {
  const res = await fetch(`${baseUrl}/api/profiles/${SLUG}/carousels/${CAROUSEL_ID}/regenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { slideId, scope: "unpinned" } }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`regenerate failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body as ReturnType<typeof makeDocument>;
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "scope:unpinned leaves the slide's pinned piece byte-for-byte identical",
    async () => {
      const before = resetDocument();
      const pinnedBefore = before.slides[0]!.objects.find((o) => o.id === "obj-pinned-photo");

      const after = await regenerateUnpinned("slide-1");
      const pinnedAfter = after.slides[0]!.objects.find((o: { id: string }) => o.id === "obj-pinned-photo");

      assert.deepEqual(pinnedAfter, pinnedBefore, "pinned object must be byte-for-byte identical");

      // The pinned background (also pinned: true) must be untouched too.
      assert.deepEqual(after.slides[0]!.background, before.slides[0]!.background);

      // The unpinned text object DID change (regeneration actually ran).
      const unpinnedAfter = after.slides[0]!.objects.find((o: { id: string }) => o.id === "obj-unpinned-title");
      assert.ok(unpinnedAfter);
      assert.equal(unpinnedAfter.text, "Regenerated headline");
    },
  ],
  [
    "scope:unpinned on one slide does not modify any other slide",
    async () => {
      const before = resetDocument();
      const after = await regenerateUnpinned("slide-1");

      const otherSlideBefore = before.slides.find((s) => s.id === OTHER_SLIDE_ID);
      const otherSlideAfter = after.slides.find((s: { id: string }) => s.id === OTHER_SLIDE_ID);

      assert.deepEqual(otherSlideAfter, otherSlideBefore, "the other slide must be untouched");
    },
  ],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}

server.close();
rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
