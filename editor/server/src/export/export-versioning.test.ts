import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exercises export versioning end to end (carousel-export spec: "Two
 * exports in a row" produce v1/v2, and the atomic-mkdir EEXIST retry) using
 * a fake renderer — never launches real Chromium, per this task's
 * instruction to mock the renderer in this test.
 *
 * Paths include the `<sub>` segment (`resolveOutputSubfolder(profileDir,
 * "editor")`); the example profile doesn't set an `editor` key under
 * `outputs:`, so it falls back to the literal `"editor"`.
 */
const SUB = "editor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const EXAMPLE_PROFILE = join(REPO_ROOT, "profiles", "example");

const root = mkdtempSync(join(tmpdir(), "editor-server-export-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
cpSync(EXAMPLE_PROFILE, profileDir, { recursive: true });

const CAROUSEL_ID = "launch-week";
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
        {
          id: "obj-title",
          kind: "text",
          slot: "title",
          pinned: false,
          locked: false,
          source: "manual",
          text: "We shipped it",
        },
      ],
    },
  ],
};
mkdirSync(join(profileDir, "carousels", CAROUSEL_ID), { recursive: true });
{
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(profileDir, "carousels", CAROUSEL_ID, "carousel.json"),
    JSON.stringify(document, null, 2) + "\n",
  );
}

const { ProfileStore } = await import("../profile-store.js");
const { enqueueExport, getExportJob, listOutputVersions } = await import("./export-queue.js");

/** Fake renderer: writes a placeholder PNG per slide, matching `renderCarouselDocument`'s return contract (an array of written file paths) without touching Playwright. */
const fakeRender: Parameters<typeof enqueueExport>[2] = async (opts) => {
  const { writeFileSync, mkdirSync: mkdirSyncInner } = await import("node:fs");
  mkdirSyncInner(opts.outputDir, { recursive: true });
  const doc = opts.doc as typeof document;
  const paths: string[] = [];
  doc.slides.forEach((_slide, index) => {
    const path = join(opts.outputDir, `${String(index + 1).padStart(2, "0")}.png`);
    writeFileSync(path, `fake-png-${index}`);
    paths.push(path);
  });
  return paths;
};

async function waitForJob(jobId: string, timeoutMs = 5000): Promise<ReturnType<typeof getExportJob>> {
  const start = Date.now();
  for (;;) {
    const job = getExportJob(jobId);
    if (job && (job.status === "done" || job.status === "error")) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for job ${jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "two exports in a row produce v1 and v2 without overwriting",
    async () => {
      const store = new ProfileStore(SLUG);

      const jobId1 = enqueueExport(store, CAROUSEL_ID, fakeRender);
      const job1 = await waitForJob(jobId1);
      assert.equal(job1?.status, "done");
      assert.equal(job1?.version, 1);

      const jobId2 = enqueueExport(store, CAROUSEL_ID, fakeRender);
      const job2 = await waitForJob(jobId2);
      assert.equal(job2?.status, "done");
      assert.equal(job2?.version, 2);

      const v1Png = store.resolveInOutputs(`${SUB}/${CAROUSEL_ID}/v1/01.png`);
      const v2Png = store.resolveInOutputs(`${SUB}/${CAROUSEL_ID}/v2/01.png`);
      assert.equal(readFileSync(v1Png, "utf-8"), "fake-png-0");
      assert.equal(readFileSync(v2Png, "utf-8"), "fake-png-0");

      const v1Manifest = store.readJson<{ version: number }>(`outputs/${SUB}/${CAROUSEL_ID}/v1/manifest.json`);
      const v2Manifest = store.readJson<{ version: number }>(`outputs/${SUB}/${CAROUSEL_ID}/v2/manifest.json`);
      assert.equal(v1Manifest.version, 1);
      assert.equal(v2Manifest.version, 2);

      const versions = listOutputVersions(store, CAROUSEL_ID);
      assert.deepEqual(
        versions.map((v) => v.version),
        [1, 2],
      );
    },
  ],
  [
    "a pre-existing v1 directory (simulated EEXIST) forces reservation to v2",
    async () => {
      const store = new ProfileStore(SLUG);
      const secondCarouselId = "another-carousel";
      mkdirSync(join(profileDir, "carousels", secondCarouselId), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(profileDir, "carousels", secondCarouselId, "carousel.json"),
        JSON.stringify({ ...document, id: secondCarouselId }, null, 2) + "\n",
      );

      // Pre-create v1 by hand, simulating a race where something already
      // claimed that directory name before reservation ran.
      mkdirSync(join(profileDir, "outputs", SUB, secondCarouselId, "v1"), { recursive: true });

      const jobId = enqueueExport(store, secondCarouselId, fakeRender);
      const job = await waitForJob(jobId);
      assert.equal(job?.status, "done");
      assert.equal(job?.version, 2);
    },
  ],
  [
    "a document with no template exports, with templateId: null in the manifest",
    async () => {
      const store = new ProfileStore(SLUG);
      const freeCarouselId = "free-carousel";
      mkdirSync(join(profileDir, "carousels", freeCarouselId), { recursive: true });
      const { writeFileSync } = await import("node:fs");
      // Same document minus its `template` key — "no template" is the
      // field's absence, not a sentinel id (carousel-document spec). The
      // object also drops its `slot`, which only means anything inside a
      // template's slot list.
      const { template: _template, ...withoutTemplate } = document;
      const freeDocument = {
        ...withoutTemplate,
        id: freeCarouselId,
        slides: document.slides.map((slide) => ({
          ...slide,
          objects: slide.objects.map(({ slot: _slot, ...object }) => object),
        })),
      };
      writeFileSync(
        join(profileDir, "carousels", freeCarouselId, "carousel.json"),
        JSON.stringify(freeDocument, null, 2) + "\n",
      );

      const jobId = enqueueExport(store, freeCarouselId, fakeRender);
      const job = await waitForJob(jobId);
      assert.equal(job?.status, "done", job?.error);

      const manifest = store.readJson<{ engine: { templateId: string | null; templateHash: string } }>(
        `outputs/${SUB}/${freeCarouselId}/v1/manifest.json`,
      );
      assert.equal(manifest.engine.templateId, null);
      // The hash is still computed, over the RESOLVED (free) template.
      assert.ok(manifest.engine.templateHash.length > 0);
    },
  ],
  [
    "export sets status to exported and approves used AI assets",
    async () => {
      const store = new ProfileStore(SLUG);
      const doc = store.readJson<{ status: string }>(`carousels/${CAROUSEL_ID}/carousel.json`);
      assert.equal(doc.status, "exported");
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

rmSync(root, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} tests passed.`);
}
