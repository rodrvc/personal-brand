import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import type { LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { resolveOutputSubfolder } from "../../../../system/ig-carousel/profile.js";
import { hashContent, loadIndex, updateEntry } from "../../../../system/assets/index.js";

import type { CarouselDocument, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { buildExportRenderContext } from "../render-context.js";
import { readValidatedDocument, writeDocument } from "../document-store.js";
import { resolveDocumentTemplate } from "../template-resolve.js";
import { ProfileStore } from "../profile-store.js";

/**
 * Renders to PNGs via injectable function, so tests can mock the renderer
 * and never launch real Chromium (design.md's export test requirement).
 * The production implementation lives in `runExport`'s default, wired from
 * `system/ig-carousel/render-batch.ts`'s `renderCarouselDocument`.
 */
export type RenderFn = (opts: {
  brand: ReturnType<typeof loadBrand>;
  template: LayoutTemplate;
  doc: unknown;
  ctx: ReturnType<typeof buildExportRenderContext>;
  outputDir: string;
  assetExists: (assetId: string) => boolean;
  browser?: Browser;
}) => Promise<string[]>;

export interface ExportJob {
  id: string;
  slug: string;
  carouselId: string;
  status: "queued" | "running" | "done" | "error";
  totalSlides: number;
  renderedSlides: number;
  version?: number;
  outputDir?: string;
  error?: string;
}

const jobs = new Map<string, ExportJob>();
let queueTail: Promise<void> = Promise.resolve();

export function getExportJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

/**
 * Output layout: `<outputs.base_dir>/<sub>/<carousel-id>/v<N>/`, where `<sub>`
 * comes from `resolveOutputSubfolder(profileDir, "editor")` (carousel-export
 * spec's "Output in the brand's bucket, versioned"). All output paths below
 * route through this so the `<sub>` segment can't drift out of sync between
 * reservation, the manifest write and the version listing.
 */
function outputSub(store: ProfileStore): string {
  return resolveOutputSubfolder(store.roots.profileDir, "editor");
}

function reserveVersionDir(store: ProfileStore, carouselId: string): { version: number; relDir: string } {
  const sub = outputSub(store);
  let version = 1;
  // Atomic reservation: `mkdirSync` with no `recursive` throws EEXIST if the
  // directory is already there, which is exactly the race-free "claim this
  // slot" primitive carousel-export's spec calls for. On EEXIST, try the
  // next number — never overwrite, never delete (design.md D11).
  for (;;) {
    try {
      // Ensure the parent (`outputs/<sub>/<carouselId>/`) exists first —
      // that part IS safe to create recursively, since collisions can only
      // happen on the version leaf itself.
      store.mkdir(`outputs/${sub}/${carouselId}`);
      const abs = store.resolveInOutputs(`${sub}/${carouselId}/v${version}`);
      mkdirSync(abs); // no {recursive:true}: throws EEXIST if taken
      return { version, relDir: `${sub}/${carouselId}/v${version}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        version += 1;
        continue;
      }
      throw error;
    }
  }
}

function gitShaOrUnknown(): string {
  try {
    const serverDir = dirname(fileURLToPath(import.meta.url));
    return execSync("git rev-parse HEAD", { cwd: serverDir, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function hashTemplate(template: unknown): string {
  return hashContent(Buffer.from(JSON.stringify(template)));
}

function collectAssetIds(doc: CarouselDocument): string[] {
  const ids = new Set<string>();
  for (const slide of doc.slides) {
    if (slide.background.mode === "asset") ids.add(slide.background.assetId);
    for (const object of slide.objects) {
      // A `pending: true` asset object may have no `assetId` yet (the
      // immediate-build compose flow's placeholder, carousel-document.ts) —
      // export shouldn't be reachable while any piece is still pending in
      // practice, but this stays defensive rather than crashing the whole
      // manifest build over one skipped/incomplete slot.
      const assetId = (object as Extract<SlideObject, { kind: "asset" }>).assetId;
      if (object.kind === "asset" && assetId) ids.add(assetId);
    }
  }
  return [...ids];
}

/**
 * True when at least one piece (a slide's background or any object) is
 * still `pending: true` (the compose job hasn't reached it yet) OR
 * `awaitingImage: true` (the compose job reached it, found no library
 * candidate, and — per the owner's decision that image generation is
 * never automatic — stopped there instead of calling the AI provider).
 * Both states mean "this piece has no final content yet", so both block
 * export the same way unless the caller explicitly overrides it.
 */
function hasUnfinishedPieces(doc: CarouselDocument): boolean {
  return doc.slides.some(
    (slide) =>
      slide.background.pending ||
      slide.background.awaitingImage ||
      slide.objects.some((o) => o.pending || (o.kind === "asset" && o.awaitingImage)),
  );
}

/** Thrown by `enqueueExport` when the document still has pending/awaiting-image pieces and the caller didn't pass `allowPending: true` — routed to a 409 by the export route (piece-generation/editor-api: exporting mid-compose, or with an ungenerated image, is refused unless explicitly overridden). */
export class ExportHasPendingPiecesError extends Error {}

/**
 * Queues one export, running strictly after any export already queued
 * (carousel-export spec's "Serial queue with a warm browser": "neither
 * fails from browser contention"). `render` is injected so tests can
 * substitute a fake and never touch Playwright.
 *
 * Refuses to queue at all (throws `ExportHasPendingPiecesError`, synchronously,
 * before anything is added to `jobs`) when the document still has a
 * `pending: true` piece — the API/script-only `plan/apply` flow
 * (routes/compose.ts) hasn't finished filling in every placeholder yet, so
 * exporting now would bake an empty text box or a missing image into the
 * PNGs. Passing `allowPending: true` skips this check for a caller (the
 * web's "Exportar igual" button) that explicitly wants to export anyway.
 */
export function enqueueExport(
  store: ProfileStore,
  carouselId: string,
  render: RenderFn,
  options?: { allowPending?: boolean },
): string {
  const doc = readValidatedDocument(store, carouselId);
  if (!options?.allowPending && hasUnfinishedPieces(doc)) {
    throw new ExportHasPendingPiecesError(
      `Carousel "${carouselId}" still has pending or awaiting-image pieces — export refused unless "allowPending" is set.`,
    );
  }
  const jobId = `${store.slug}-${carouselId}-${Date.now()}`;
  const job: ExportJob = {
    id: jobId,
    slug: store.slug,
    carouselId,
    status: "queued",
    totalSlides: doc.slides.length,
    renderedSlides: 0,
  };
  jobs.set(jobId, job);

  queueTail = queueTail
    .then(() => runExport(store, doc, job, render))
    .catch((error) => {
      job.status = "error";
      job.error = (error as Error).message;
    });

  return jobId;
}

async function runExport(store: ProfileStore, doc: CarouselDocument, job: ExportJob, render: RenderFn): Promise<void> {
  job.status = "running";
  try {
    const brand = loadBrand(store.roots.profileDir);
    const template = resolveDocumentTemplate(store, brand, doc);
    const index = loadIndex(store.roots.profileDir);
    const assetExists = (assetId: string) => index.entries.some((e) => e.id === assetId);

    const { version, relDir } = reserveVersionDir(store, doc.id);
    const outputDir = store.resolveInOutputs(relDir);

    const ctx = buildExportRenderContext(store, brand, doc.slides[0]?.background ?? { mode: "color", colorKey: brand.roles.surface });

    const paths = await render({ brand, template, doc, ctx, outputDir, assetExists });
    job.renderedSlides = paths.length;

    const assetIds = collectAssetIds(doc);
    // `entry.id` already IS the asset's content hash (asset-library spec:
    // "first 16 hex chars of the content's sha256"), so there is no second,
    // independently-computed hash to report here. `contentHash` is kept
    // (rather than dropped) because carousel-export's spec names `hash` as
    // a manifest field; naming it `contentHash` and pointing that out here
    // makes the equality with `id` obvious instead of silently duplicating it.
    const assetManifest = assetIds.map((id) => {
      const entry = index.entries.find((e) => e.id === id);
      if (!entry) {
        throw new Error(`Manifest: no asset with id "${id}" in the index (used by carousel "${doc.id}")`);
      }
      return { id, path: entry.path, contentHash: id };
    });
    const fontManifest = index.entries
      .filter((e) => e.kind === "font")
      .map((e) => ({ id: e.id, contentHash: e.id }));

    const manifest = {
      carouselId: doc.id,
      version,
      exportedAt: new Date().toISOString(),
      engine: {
        gitSha: gitShaOrUnknown(),
        // `null` — not a sentinel id — for a document with no template
        // reference: the manifest records what the document declared, and
        // "nothing" is a real answer. `templateHash` below still hashes the
        // RESOLVED template (the free one in that case), so the engine
        // fingerprint stays complete either way.
        templateId: doc.template?.id ?? null,
        templateHash: hashTemplate(template),
      },
      brand,
      document: doc,
      assets: assetManifest,
      fonts: fontManifest,
      slides: doc.slides.map((s) => s.id),
    };
    store.writeJson(`outputs/${relDir}/manifest.json`, manifest);

    // Status -> exported (if it was draft), and used AI pieces -> approved
    // (carousel-export spec's "Status and library after export").
    for (const assetId of assetIds) {
      const entry = index.entries.find((e) => e.id === assetId);
      if (entry && entry.status === "candidate") {
        updateEntry(store.roots.profileDir, assetId, { status: "approved" });
      }
    }
    if (doc.status === "draft") {
      writeDocument(store, { ...doc, status: "exported", updatedAt: new Date().toISOString() });
    }

    job.status = "done";
    job.version = version;
    job.outputDir = outputDir;
  } catch (error) {
    job.status = "error";
    job.error = (error as Error).message;
    throw error;
  }
}

export function listOutputVersions(store: ProfileStore, carouselId: string): Array<{ version: number; exportedAt?: string; slideCount?: number }> {
  const sub = outputSub(store);
  const entries = store.list(`outputs/${sub}/${carouselId}`);
  const versions = entries
    .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
    .map((e) => Number(e.name.slice(1)))
    .sort((a, b) => a - b);

  return versions.map((version) => {
    try {
      const manifest = store.readJson<{ exportedAt: string; slides: string[] }>(
        `outputs/${sub}/${carouselId}/v${version}/manifest.json`,
      );
      return { version, exportedAt: manifest.exportedAt, slideCount: manifest.slides.length };
    } catch {
      return { version };
    }
  });
}
