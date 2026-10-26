import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { putAt } from "@personal-brand/storage/blob";
import { BrandArchivedError, carouselExportKey, InvalidInputError, VersionConflictError } from "@personal-brand/storage/contracts";

import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import { collectAssetIds, hasUnfinishedPieces, queueExportJob, ExportHasPendingPiecesError, type ExportJob, type RenderFn } from "./export/export-queue.js";
import { approveCandidates } from "./stored-assets.js";
import { storedCarouselRaw, storedRenderParts, validateStored, type EditorStorage, type StoredBrand } from "./stored-read.js";

/**
 * Queues the export of a stored carousel. The same contract as the folder's: refused (`ExportHasPendingPiecesError`)
 * while a piece is pending unless `allowPending`; one serial queue with the folder exports. The deliverables go to the
 * bucket under the carousel's next export version (`exports` row first, then PNGs and `manifest.json` at the keys of
 * storage's `keys.ts`, write-once), and a `draft` carousel becomes `exported`, conditional on the version that was
 * exported, like the folder's revision check. Candidate assets the document uses become `approved`. A render runs in a scratch dir that is removed afterwards.
 */
export async function enqueueStoredExport(s: StoredBrand, id: string, render: RenderFn, options?: { allowPending?: boolean }): Promise<ExportJob> {
  if ((await s.storage.brands.getBySlug(s.slug)).value.status === "archived") throw new BrandArchivedError(s.slug);
  const raw = await storedCarouselRaw(s, id);
  const result = await validateStored(s, raw.document);
  if (!result.valid) throw new InvalidInputError(`Carousel "${id}" is not a valid document: ${result.errors[0]?.message}`);
  const doc = result.document;
  if (!options?.allowPending && hasUnfinishedPieces(doc)) {
    throw new ExportHasPendingPiecesError(`Carousel "${id}" still has pending or awaiting-image pieces — export refused unless "allowPending" is set.`);
  }
  const job: ExportJob = { id: randomUUID(), slug: s.slug, carouselId: id, status: "queued", totalSlides: doc.slides.length, renderedSlides: 0 };
  queueExportJob(job, () => runStoredExport(s, doc, raw.rowId, raw.version, job, render));
  return job;
}

async function runStoredExport(s: StoredBrand, doc: CarouselDocument, rowId: string, carouselVersion: number, job: ExportJob, render: RenderFn): Promise<void> {
  job.status = "running";
  // Scratch first, reservation inside the try: whatever fails after a version is reserved marks that row failed.
  const scratch = mkdtempSync(join(tmpdir(), "editor-stored-export-"));
  let reserved: Awaited<ReturnType<typeof s.storage.exports.reserveNextVersion>> | undefined;
  let completed = false;
  try {
    reserved = await s.storage.exports.reserveNextVersion(rowId, carouselVersion);
    const { brand, template, base, resolve } = await storedRenderParts(s, doc);
    const library = await s.storage.assets.list(s.brandId);
    const known = new Set(library.map((row) => row.value.assetId));
    const paths = await render({ brand, template, doc, ctx: base, outputDir: scratch, assetExists: (assetId) => known.has(assetId), resolve });
    job.renderedSlides = paths.length;

    const slides = paths.filter((path) => path.endsWith(".png")).sort();
    for (const path of slides) await putAt(s.storage.files, carouselExportKey(s.brandId, rowId, reserved.versionNo, basename(path)), readFileSync(path), "image/png");
    const manifest = {
      carouselId: doc.id,
      version: reserved.versionNo,
      carouselVersion,
      exportedAt: new Date().toISOString(),
      engine: { templateId: doc.template?.id ?? null },
      brand,
      document: doc,
      assets: collectAssetIds(doc),
      slides: doc.slides.map((slide) => slide.id),
      files: slides.map((path) => basename(path)),
    };
    await putAt(s.storage.files, carouselExportKey(s.brandId, rowId, reserved.versionNo, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
    await s.storage.exports.complete(reserved.id, manifest);
    completed = true;
    // The export is complete from here: a failure in the steps below still reports its version.
    job.version = reserved.versionNo;

    await approveUsedAssets(s, doc, library);
    await markExported(s, doc, rowId, carouselVersion);
    job.status = "done";
  } catch (error) {
    // `queueExportJob` records the job's error; this only closes the reserved row, and never one that already completed.
    if (reserved && !completed) {
      await s.storage.exports.fail(reserved.id).catch((failure) => console.error(`Marking export ${reserved!.id} failed did not stick:`, failure));
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type Library = Awaited<ReturnType<EditorStorage["assets"]["list"]>>;

/**
 * Pieces the export used leave `candidate` for `approved` (carousel-export: "Status and library after export"). The
 * versions come from the library listing taken before the render, so a row changed meanwhile (a pin, a rename) is
 * re-read and retried once; one that is no longer a candidate is left alone. Audited as a status change by `editor:export`.
 */
async function approveUsedAssets(s: StoredBrand, doc: CarouselDocument, library: Library): Promise<void> {
  await approveCandidates(s, new Set(collectAssetIds(doc)), "editor:export", library);
}

/** Draft -> exported only if nothing saved the carousel meanwhile: a lost race fails the job (the export itself is complete). */
async function markExported(s: StoredBrand, doc: CarouselDocument, rowId: string, carouselVersion: number): Promise<void> {
  if (doc.status !== "draft") return;
  try {
    await s.storage.carousels.setStatus(rowId, { status: "exported" }, { expectedVersion: carouselVersion, author: "editor", source: "editor", reason: "status" });
  } catch (error) {
    if (!(await exportedMeanwhile(s, doc.id, error))) throw error;
  }
}

/** An export queued behind another one of the same draft finds it already flipped (a conflict, status no longer draft): not a failure. */
async function exportedMeanwhile(s: StoredBrand, id: string, error: unknown): Promise<boolean> {
  return error instanceof VersionConflictError && (await storedCarouselRaw(s, id)).document.status !== "draft";
}

/** The finished exports of a stored carousel, oldest first, in the shape `GET .../outputs` has for a folder. */
export async function storedOutputVersions(s: StoredBrand, id: string): Promise<Array<{ version: number; exportedAt?: string; slideCount?: number }>> {
  const { rowId } = await storedCarouselRaw(s, id);
  return (await s.storage.exports.list(rowId))
    .filter((row) => row.status === "done")
    .map((row) => ({ version: row.versionNo, exportedAt: row.finishedAt ?? undefined, slideCount: Array.isArray(row.manifest?.slides) ? row.manifest.slides.length : undefined }));
}
