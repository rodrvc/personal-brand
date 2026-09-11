import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// Exercises `GET .../export/:jobId` over real HTTP (profiles.test.ts style).
// Never POSTs — the route hardcodes the Playwright renderer — so a job is
// minted directly via `enqueueExport` with a fake renderer, as in
// `export-versioning.test.ts`. `BRAND_PROFILES_DIR` must be set before any
// import that reaches `../profile-store.js`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PROFILE = join(__dirname, "..", "..", "..", "..", "profiles", "example");

const root = mkdtempSync(join(tmpdir(), "editor-server-export-route-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const CAROUSEL_ID = "launch-week";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
cpSync(EXAMPLE_PROFILE, profileDir, { recursive: true });

const now = new Date().toISOString();
const document = {
  schemaVersion: 1,
  id: CAROUSEL_ID,
  title: "Launch week",
  status: "draft",
  createdAt: now,
  updatedAt: now,
  canvas: { w: 1080, h: 1350 },
  prompt: { text: "Explain the launch", createdAt: now },
  template: { id: "explicativo" },
  slides: [
    {
      id: "slide-1",
      kind: "cover",
      background: { mode: "color", colorKey: "paper", pinned: false, source: "manual" },
      objects: [
        { id: "obj-title", kind: "text", slot: "title", pinned: false, locked: false, source: "manual", text: "We shipped it" },
      ],
    },
  ],
};
mkdirSync(join(profileDir, "carousels", CAROUSEL_ID), { recursive: true });
writeFileSync(join(profileDir, "carousels", CAROUSEL_ID, "carousel.json"), JSON.stringify(document, null, 2) + "\n");

const { default: express } = await import("express");
const { ProfileStore } = await import("../profile-store.js");
const { enqueueExport, getExportJob } = await import("../export/export-queue.js");
const { exportRouter } = await import("./export.js");

/** Writes a placeholder PNG per slide — never touches Playwright, same contract as `export-versioning.test.ts`'s fake. */
const fakeRender: Parameters<typeof enqueueExport>[2] = async (opts) => {
  mkdirSync(opts.outputDir, { recursive: true });
  const paths = (opts.doc as typeof document).slides.map((_slide, i) => {
    const path = join(opts.outputDir, `${String(i + 1).padStart(2, "0")}.png`);
    writeFileSync(path, `fake-png-${i}`);
    return path;
  });
  return paths;
};

async function waitForDone(jobId: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const job = getExportJob(jobId);
    if (job && (job.status === "done" || job.status === "error")) return;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for job ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const app = express();
app.use(express.json());
app.use(exportRouter());
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const store = new ProfileStore(SLUG);
  const jobId = enqueueExport(store, CAROUSEL_ID, fakeRender);
  await waitForDone(jobId);

  const res = await fetch(`${base}/api/profiles/${SLUG}/carousels/${CAROUSEL_ID}/export/${jobId}`);
  const body = (await res.json()) as { jobId: string; status: string; outputDir?: string };
  assert.equal(res.status, 200);
  assert.equal(body.jobId, jobId);
  assert.equal(body.status, "done");
  assert.equal(body.outputDir, undefined);

  console.log("ok - GET export/:jobId returns jobId and never leaks outputDir");
} catch (error) {
  console.error("FAIL - GET export/:jobId returns jobId and never leaks outputDir");
  console.error(error);
  process.exitCode = 1;
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
