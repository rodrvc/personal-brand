import { Router } from "express";

import { renderCarouselDocument } from "../../../../system/ig-carousel/render-batch.js";

import { DocumentStoreError } from "../document-store.js";
import {
  enqueueExport,
  ExportHasPendingPiecesError,
  getExportJob,
  listOutputVersions,
  type ExportJob,
  type RenderFn,
} from "../export/export-queue.js";
import { getSharedBrowser } from "../browser.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";
import { enqueueStoredExport, storedOutputVersions } from "../stored-export.js";
import { guardStorage, resolveStored, StorageFailure, type EditorStorage } from "../stored-read.js";
import { handleStoreError } from "./profiles.js";

const productionRender: RenderFn = async (opts) => {
  const browser = await getSharedBrowser();
  return renderCarouselDocument({ ...opts, browser });
};

/**
 * Explicit projection to the wire shape both endpoints return — this is the
 * one place a server-internal field (e.g. `outputDir`, an absolute host
 * path) can leak into the response. Duplicated on the client as
 * `web/src/api/types.ts`'s `ExportJob`; keeping the two in sync by hand is
 * what caused the `jobId` drift this route used to have.
 */
function toExportJobResponse(job: ExportJob) {
  return {
    jobId: job.id,
    slug: job.slug,
    carouselId: job.carouselId,
    status: job.status,
    error: job.error,
    version: job.version,
  };
}

/** `storage` serves a brand cut over to storage (S10b2): its export lands in the bucket. `render` is injectable for tests. */
export function exportRouter(storage?: EditorStorage, render: RenderFn = productionRender): Router {
  const router = Router();
  const stored = async (slug: string) => {
    const found = await resolveStored(storage, slug);
    return found && { ...found, storage: guardStorage(found.storage) };
  };

  router.post("/api/profiles/:slug/carousels/:id/export", async (req, res) => {
    try {
      const allowPending = (req.body as { allowPending?: boolean } | undefined)?.allowPending === true;
      const found = await stored(req.params.slug);
      if (found) {
        try {
          res.status(202).json(toExportJobResponse(await enqueueStoredExport(found, req.params.id, render, { allowPending })));
        } catch (error) {
          if (error instanceof ExportHasPendingPiecesError) res.status(409).json({ error: error.message });
          else handleStoreError(error, res);
        }
        return;
      }
      const store = new ProfileStore(req.params.slug);
      const jobId = await enqueueExport(store, req.params.id, render, { allowPending });
      res.status(202).json(toExportJobResponse(getExportJob(jobId)!));
    } catch (error) {
      if (error instanceof ExportHasPendingPiecesError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof StorageFailure) return handleStoreError(error, res);
      const status =
        error instanceof ProfileStoreError || error instanceof DocumentStoreError ? 400 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/export/:jobId", (req, res) => {
    const job = getExportJob(req.params.jobId);
    if (!job || job.slug !== req.params.slug || job.carouselId !== req.params.id) {
      res.status(404).json({ error: `No export job "${req.params.jobId}"` });
      return;
    }
    res.json(toExportJobResponse(job));
  });

  router.get("/api/profiles/:slug/carousels/:id/outputs", async (req, res) => {
    try {
      const found = await stored(req.params.slug);
      if (found) {
        res.json({ versions: await storedOutputVersions(found, req.params.id) });
        return;
      }
      const store = new ProfileStore(req.params.slug);
      res.json({ versions: listOutputVersions(store, req.params.id) });
    } catch (error) {
      if (error instanceof StorageFailure) return handleStoreError(error, res);
      const status =
        error instanceof ProfileStoreError || error instanceof DocumentStoreError ? 400 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  });

  return router;
}
