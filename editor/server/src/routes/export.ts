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

export function exportRouter(): Router {
  const router = Router();

  router.post("/api/profiles/:slug/carousels/:id/export", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const allowPending = (req.body as { allowPending?: boolean } | undefined)?.allowPending === true;
      const jobId = enqueueExport(store, req.params.id, productionRender, { allowPending });
      res.status(202).json(toExportJobResponse(getExportJob(jobId)!));
    } catch (error) {
      if (error instanceof ExportHasPendingPiecesError) {
        res.status(409).json({ error: error.message });
        return;
      }
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

  router.get("/api/profiles/:slug/carousels/:id/outputs", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      res.json({ versions: listOutputVersions(store, req.params.id) });
    } catch (error) {
      const status =
        error instanceof ProfileStoreError || error instanceof DocumentStoreError ? 400 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  });

  return router;
}
