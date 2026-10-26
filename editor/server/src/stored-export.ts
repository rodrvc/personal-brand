import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { putAt } from "@personal-brand/storage/blob";
import { BrandArchivedError, carouselExportKey, InvalidInputError, VersionConflictError } from "@personal-brand/storage/contracts";

import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import { collectAssetIds, hasUnfinishedPieces, queueExportJob, ExportHasPendingPiecesError, type ExportJob, type RenderFn } from "./export/export-queue.js";
import { storedCarouselRaw, storedRenderParts, validateStored, type StoredBrand } from "./stored-read.js";

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
    // The export is complete from here: a failure in the steps below still reports its version.
    job.version = reserved.versionNo;

    // Pieces the export used leave `candidate` for `approved` (carousel-export: "Status and library after export").
    const used = new Set(collectAssetIds(doc));
    for (const { value, version } of library.filter((row) => used.has(row.value.assetId) && row.value.status === "candidate")) {
      await s.storage.assets.update(s.brandId, value.assetId, { status: "approved" }, { expectedVersion: version, author: "editor", source: "editor", reason: "save" });
    }
    // Draft -> exported only if nothing saved the carousel meanwhile (a conflict fails the job; the export itself is complete).
    if (doc.status === "draft") {
      try {
        await s.storage.carousels.setStatus(rowId, { status: "exported" }, { expectedVersion: carouselVersion, author: "editor", source: "editor", reason: "status" });
      } catch (error) {
        // An export queued behind another one of the same draft finds it already flipped: that is not a failure.
        if (!(error instanceof VersionConflictError) || (await storedCarouselRaw(s, doc.id)).document.status === "draft") throw error;
      }
    }
    job.status = "done";
  } catch (error) {
    job.status = "error";
    job.error = (error as Error).message;
    if (reserved) await s.storage.exports.fail(reserved.id).catch(() => {});
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The finished exports of a stored carousel, oldest first, in the shape `GET .../outputs` has for a folder. */
export async function storedOutputVersions(s: StoredBrand, id: string): Promise<Array<{ version: number; exportedAt?: string; slideCount?: number }>> {
  const { rowId } = await storedCarouselRaw(s, id);
  return (await s.storage.exports.list(rowId))
    .filter((row) => row.status === "done")
    .map((row) => ({ version: row.versionNo, exportedAt: row.finishedAt ?? undefined, slideCount: Array.isArray(row.manifest?.slides) ? row.manifest.slides.length : undefined }));
}
