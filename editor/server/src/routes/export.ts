import { Router } from "express";

import { renderCarouselDocument } from "../../../../system/ig-carousel/render-batch.js";

import { DocumentStoreError } from "../document-store.js";
import { enqueueExport, getExportJob, listOutputVersions, type RenderFn } from "../export/export-queue.js";
import { getSharedBrowser } from "../browser.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";

const productionRender: RenderFn = async (opts) => {
  const browser = await getSharedBrowser();
  return renderCarouselDocument({ ...opts, browser });
};

export function exportRouter(): Router {
  const router = Router();

  router.post("/api/profiles/:slug/carousels/:id/export", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const jobId = enqueueExport(store, req.params.id, productionRender);
      res.status(202).json({ jobId });
    } catch (error) {
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
    res.json(job);
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
