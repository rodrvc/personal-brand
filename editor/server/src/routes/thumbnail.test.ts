import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * Covers the Bucket pane thumbnail route (`GET
 * /api/profiles/:slug/assets/thumbs/*splat`): a thumbnail is smaller than
 * its original, a second request for the same asset is a cache hit (no
 * re-encode), the cache lives OUTSIDE both of `ProfileStore`'s allowed
 * roots (so the s3 mirror's `syncUp` — which walks exactly those roots,
 * `storage/mirror.ts`'s `listLocalFiles` — can never see or upload a
 * thumbnail), and a path-traversal attempt 404s exactly like the plain
 * `files/*splat` route it sits next to.
 *
 * `BRAND_PROFILES_DIR` must be set before importing `../profile-store.js`
 * (and anything that imports it), same requirement as the other route
 * tests in this directory. `EDITOR_THUMB_CACHE_DIR` is pointed at its own
 * temp dir too, so this test never writes into (or depends on) whatever a
 * real dev server already cached at the default OS temp location.
 */

const root = mkdtempSync(join(tmpdir(), "editor-server-thumbnail-route-test-"));
process.env.BRAND_PROFILES_DIR = root;

const thumbCacheRoot = mkdtempSync(join(tmpdir(), "editor-server-thumbnail-cache-test-"));
process.env.EDITOR_THUMB_CACHE_DIR = thumbCacheRoot;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SLUG = "acme-thumbs";
cpSync(join(REPO_ROOT, "profiles", "example"), join(root, SLUG), { recursive: true });

const { default: express } = await import("express");
const { assetsRouter } = await import("./assets.js");

const app = express();
app.use(express.json());
app.use(assetsRouter());

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

// A tracked fixture (same image `render.test.ts` uses), so this passes on a
// clean checkout with nothing generated under the example profile.
const ORIGINAL_REL = "reel/item1.jpg";
const originalAbs = join(root, SLUG, "assets", ORIGINAL_REL);
const originalBytes = statSync(originalAbs).size;

const tests: Array<[string, () => Promise<void>]> = [
  [
    "GET thumbs/ returns a WebP thumbnail smaller than the original",
    async () => {
      const res = await fetch(`${base}/api/profiles/${SLUG}/assets/thumbs/${ORIGINAL_REL}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/webp");
      const buffer = Buffer.from(await res.arrayBuffer());
      assert.ok(buffer.length > 0, "thumbnail must not be empty");
      assert.ok(
        buffer.length < originalBytes,
        `thumbnail (${buffer.length}b) must be smaller than the original (${originalBytes}b)`,
      );
    },
  ],

  [
    "a second request for the same asset+width is a cache hit (byte-identical, served from the on-disk cache)",
    async () => {
      const first = await fetch(`${base}/api/profiles/${SLUG}/assets/thumbs/${ORIGINAL_REL}`);
      const firstBuffer = Buffer.from(await first.arrayBuffer());

      const { ProfileStore } = await import("../profile-store.js");
      const { getOrCreateThumbnail, resolveThumbCachePath, resolveThumbWidth } = await import("../thumbnail.js");
      const store = new ProfileStore(SLUG);
      const width = resolveThumbWidth(undefined);

      const cachePath = await resolveThumbCachePath(store, ORIGINAL_REL, width);
      assert.ok(existsSync(cachePath), "the first request must have written a cache entry on disk");
      const statBefore = statSync(cachePath).mtimeMs;

      const second = await getOrCreateThumbnail(store, ORIGINAL_REL, width);
      const statAfter = statSync(cachePath).mtimeMs;
      assert.equal(statAfter, statBefore, "a cache hit must not rewrite (re-encode) the cache file");
      assert.deepEqual(second, firstBuffer, "a cache hit returns the exact same bytes as the first request");
    },
  ],

  [
    "the thumbnail cache lives outside BOTH of ProfileStore's allowed roots, so the s3 mirror's syncUp can never upload it",
    async () => {
      const { ProfileStore } = await import("../profile-store.js");
      const { getOrCreateThumbnail, thumbCachePath } = await import("../thumbnail.js");
      const store = new ProfileStore(SLUG);
      await getOrCreateThumbnail(store, ORIGINAL_REL, 256);

      // `storage/mirror.ts`'s `syncUp` walks exactly `store.roots.profileDir`
      // and `store.roots.outputsBaseDir` (via `listLocalFiles`) and uploads
      // every file it finds there with no extension/name exclusion beyond
      // `.DS_Store`. Proving the cache directory sits outside both is a
      // direct guarantee that a real syncUp pass can never reach it,
      // without needing to spin up a fake bucket here.
      const cacheRoot = dirname(thumbCachePath(SLUG, "0".repeat(16), 256));
      for (const confinedRoot of [store.roots.profileDir, store.roots.outputsBaseDir]) {
        const withSep = confinedRoot.endsWith(sep) ? confinedRoot : confinedRoot + sep;
        assert.ok(
          !cacheRoot.startsWith(withSep) && cacheRoot !== confinedRoot,
          `thumbnail cache dir "${cacheRoot}" must not be inside the confined root "${confinedRoot}"`,
        );
      }
    },
  ],

  [
    "GET thumbs/ with a ?w= override produces a narrower image than the default",
    async () => {
      const wide = await fetch(`${base}/api/profiles/${SLUG}/assets/thumbs/${ORIGINAL_REL}?w=256`);
      const narrow = await fetch(`${base}/api/profiles/${SLUG}/assets/thumbs/${ORIGINAL_REL}?w=128`);
      const wideBuffer = Buffer.from(await wide.arrayBuffer());
      const narrowBuffer = Buffer.from(await narrow.arrayBuffer());
      assert.ok(narrowBuffer.length < wideBuffer.length, "a narrower requested width must produce a smaller file");
    },
  ],

  [
    "?w= snaps to a fixed set of widths, so a client cannot mint unbounded cache entries",
    async () => {
      const { resolveThumbWidth } = await import("../thumbnail.js");
      assert.equal(resolveThumbWidth("64"), 128, "below the smallest size snaps up to it");
      assert.equal(resolveThumbWidth("200"), 256, "between sizes snaps up to the next one");
      assert.equal(resolveThumbWidth("512"), 512);
      assert.equal(resolveThumbWidth("9999"), 512, "above the largest size is capped");
      assert.equal(resolveThumbWidth("nope"), 256, "an invalid value falls back to the default");
      assert.equal(resolveThumbWidth(undefined), 256);
    },
  ],

  [
    "a cache hit never reads the original (no on-demand bucket hydration on a hit)",
    async () => {
      const { ProfileStore } = await import("../profile-store.js");
      const { getOrCreateThumbnail } = await import("../thumbnail.js");
      const store = new ProfileStore(SLUG);
      const first = await getOrCreateThumbnail(store, ORIGINAL_REL, 512);
      store.readFileAsync = async () => {
        throw new Error("the original must not be read on a cache hit");
      };
      const second = await getOrCreateThumbnail(store, ORIGINAL_REL, 512);
      assert.deepEqual(second, first, "served from the cache");
    },
  ],

  [
    // `fetch`/the WHATWG URL parser normalizes a literal ".." out of a
    // request path before it ever reaches the server (same for its
    // percent-encoded form, `%2e%2e` — normalized identically), so an HTTP
    // round-trip can't actually exercise this. Calling the handler's own
    // `getOrCreateThumbnail` directly with a raw traversal segment — the
    // same thing a non-browser HTTP client could send — proves the route
    // never reaches `sharp`/disk for it: it rejects exactly like
    // `store.readFileAsync` already does for the plain `files/*splat`
    // route (profile-store.ts's confinement, shared by both routes).
    "a raw path-traversal segment is rejected before any read, not just 404'd after",
    async () => {
      const { ProfileStore, ProfileStoreError } = await import("../profile-store.js");
      const { getOrCreateThumbnail } = await import("../thumbnail.js");
      const store = new ProfileStore(SLUG);
      await assert.rejects(
        () => getOrCreateThumbnail(store, "../../../etc/passwd", 256),
        ProfileStoreError,
        "a traversal segment must be rejected by store confinement, not silently resolved",
      );
    },
  ],

  [
    "GET thumbs/ for a nonexistent asset 404s",
    async () => {
      const res = await fetch(`${base}/api/profiles/${SLUG}/assets/thumbs/does-not-exist.png`);
      assert.equal(res.status, 404);
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
rmSync(thumbCacheRoot, { recursive: true, force: true });

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) {
  process.exitCode = 1;
}
