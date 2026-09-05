import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exercises the critical fix from the compose-job review: `runComposeJob`
 * must re-read the on-disk document before every single-piece write,
 * apply ONLY that piece's result onto whatever is on disk at that moment,
 * and skip a piece the user edited (no longer `pending`) or pinned while
 * the job was still running — never clobbering a concurrent PUT with its
 * own stale in-memory copy of the document (compose-job.ts's
 * `persistPiece` / `isStillWritable`).
 *
 * Uses a fake `PieceGenerator` with a slow `draftCopy`/`generateImage` so a
 * PUT issued mid-job (simulated directly via `writeDocument`, the same
 * primitive the real PUT route uses) lands while the job is still working,
 * and asserts it survives once the job finishes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const EXAMPLE_PROFILE = join(REPO_ROOT, "profiles", "example");

const root = mkdtempSync(join(tmpdir(), "editor-server-compose-job-test-"));
process.env.BRAND_PROFILES_DIR = root;

const SLUG = "acme";
const profileDir = join(root, SLUG);
mkdirSync(profileDir, { recursive: true });
cpSync(EXAMPLE_PROFILE, profileDir, { recursive: true });

const { ProfileStore } = await import("../profile-store.js");
const { writeDocument, readValidatedDocument } = await import("../document-store.js");
const { loadBrand } = await import("../../../../system/ig-carousel/brand-schema.js");
const { enqueueComposeJob, getComposeJob } = await import("./compose-job.js");

const store = new ProfileStore(SLUG);
const brand = loadBrand(store.roots.profileDir);

const CAROUSEL_ID = "compose-job-carousel";
const now = new Date().toISOString();

/** Two pending text objects (slide-1, slide-2) and one already-final object (slide-2's "other-text") used to prove an unrelated concurrent edit survives. */
function makeInitialDocument() {
  return {
    schemaVersion: 1,
    id: CAROUSEL_ID,
    title: "Compose job test",
    status: "draft" as const,
    createdAt: now,
    updatedAt: now,
    canvas: { w: 1080, h: 1350 },
    prompt: { text: "A carousel for the compose job test", createdAt: now, runs: [] },
    template: { id: "explicativo" },
    slides: [
      {
        id: "slide-1",
        kind: "cover" as const,
        background: { mode: "color" as const, colorKey: "paper", pinned: false, source: "ai" as const },
        objects: [
          {
            id: "obj-slide1-title",
            kind: "text" as const,
            slot: "title",
            pinned: false,
            locked: false,
            source: "ai" as const,
            text: "",
            pending: true,
          },
        ],
      },
      {
        id: "slide-2",
        kind: "step" as const,
        background: { mode: "color" as const, colorKey: "paper", pinned: false, source: "ai" as const },
        objects: [
          {
            id: "obj-slide2-title",
            kind: "text" as const,
            slot: "title",
            pinned: false,
            locked: false,
            source: "ai" as const,
            text: "",
            pending: true,
          },
          {
            id: "obj-slide2-other",
            kind: "text" as const,
            slot: "body",
            pinned: false,
            locked: false,
            source: "manual" as const,
            text: "Never touched by the job",
          },
        ],
      },
    ],
  };
}

/** Fake generator: `draftCopy` is slow (so a concurrent PUT has time to land) and deterministic per slideId. */
function makeSlowFakeGenerator(delayMs: number) {
  return {
    async draftCopy(plan: { slides: Array<{ slideId: string }> }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const slideId = plan.slides[0]!.slideId;
      return {
        slides: [{ slideId, headline: `Generated for ${slideId}` }],
        model: "fake",
        costCents: 1,
      };
    },
    async generateImage() {
      throw new Error("not used in this test");
    },
  };
}

function resetDocument(): ReturnType<typeof makeInitialDocument> {
  mkdirSync(join(profileDir, "carousels", CAROUSEL_ID), { recursive: true });
  const doc = makeInitialDocument();
  writeDocument(store, doc as never);
  return doc;
}

async function waitForJobDone(jobId: string): Promise<void> {
  for (;;) {
    const job = getComposeJob(jobId);
    if (!job) throw new Error(`No job "${jobId}"`);
    if (job.status === "done" || job.status === "error" || job.status === "skipped") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  [
    "a PUT that edits another object's text while the job runs is preserved after the job finishes",
    async () => {
      const initial = resetDocument();
      const generator = makeSlowFakeGenerator(150);

      const jobId = enqueueComposeJob(store, brand, CAROUSEL_ID, initial as never, generator as never, initial.prompt.text);

      // Simulate a concurrent PUT (same primitive routes/profiles.ts's PUT
      // handler uses) landing on the ALREADY-PERSISTED "other" object's
      // text while the job is still drafting slide-1/slide-2's headlines.
      // This must survive: the job never touches obj-slide2-other, but the
      // bug being fixed is that a naive "keep the whole in-memory doc,
      // overwrite the file" job would silently revert this edit anyway.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const midFlight = readValidatedDocument(store, CAROUSEL_ID);
      const editedDoc = {
        ...midFlight,
        updatedAt: new Date().toISOString(),
        slides: midFlight.slides.map((s) =>
          s.id === "slide-2"
            ? {
                ...s,
                objects: s.objects.map((o) =>
                  o.id === "obj-slide2-other" ? { ...o, text: "Edited concurrently by the user" } : o,
                ),
              }
            : s,
        ),
      };
      writeDocument(store, editedDoc);

      await waitForJobDone(jobId);

      const final = readValidatedDocument(store, CAROUSEL_ID);
      const finalOther = final.slides
        .find((s) => s.id === "slide-2")!
        .objects.find((o) => o.id === "obj-slide2-other") as { text?: string } | undefined;
      assert.equal(finalOther?.text, "Edited concurrently by the user", "concurrent edit must survive the job");

      // And the job still did its actual work on the pieces it owns.
      const slide1Title = final.slides
        .find((s) => s.id === "slide-1")!
        .objects.find((o) => o.id === "obj-slide1-title") as { text?: string; pending?: boolean } | undefined;
      assert.equal(slide1Title?.pending, false);
      assert.equal(slide1Title?.text, "Generated for slide-1");
    },
  ],
  [
    "a piece the user set pending:false during the job is not touched by the job's own write",
    async () => {
      resetDocument();
      const generator = makeSlowFakeGenerator(150);
      const initial = readValidatedDocument(store, CAROUSEL_ID);

      const jobId = enqueueComposeJob(store, brand, CAROUSEL_ID, initial, generator as never, initial.prompt.text);

      // Concurrently, the user finishes editing slide-2's title by hand
      // (a PUT clearing `pending`) before the job gets to it.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const midFlight = readValidatedDocument(store, CAROUSEL_ID);
      const userEdited = {
        ...midFlight,
        updatedAt: new Date().toISOString(),
        slides: midFlight.slides.map((s) =>
          s.id === "slide-2"
            ? {
                ...s,
                objects: s.objects.map((o) =>
                  o.id === "obj-slide2-title" ? { ...o, text: "User's own wording", pending: false } : o,
                ),
              }
            : s,
        ),
      };
      writeDocument(store, userEdited);

      await waitForJobDone(jobId);

      const final = readValidatedDocument(store, CAROUSEL_ID);
      const slide2Title = final.slides
        .find((s) => s.id === "slide-2")!
        .objects.find((o) => o.id === "obj-slide2-title") as { text?: string; pending?: boolean } | undefined;
      assert.equal(slide2Title?.text, "User's own wording", "the job must not overwrite text the user already finalized");
      assert.equal(slide2Title?.pending, false);
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
