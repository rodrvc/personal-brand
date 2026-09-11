import { Router } from "express";
import type { Page } from "playwright";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import { renderFreeLayoutSlide } from "../../../../system/ig-carousel/templates/free-layout.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../../../../system/ig-carousel/document.js";
import { measureContrast } from "../../../../system/ig-carousel/contrast.js";

import { documentExists, readDocumentRaw, requireTemplateRef, TemplateNotSupportedError, validateAgainstProfile } from "../document-store.js";
import { buildRenderContext } from "../render-context.js";
import { getSharedBrowser } from "../browser.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";

function parseSlideIndex(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Routes the preview HTML's `/api/profiles/:slug/assets/files/*` `<img>`
 * requests back into this same process instead of over the network — the
 * server IS the asset host, so Chromium fetching from it directly (rather
 * than through a real HTTP round trip to itself) avoids a pointless
 * loopback dependency during PNG/contrast capture.
 */
async function routeAssetRequestsInProcess(page: Page): Promise<void> {
  await page.route("**/api/profiles/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/assets\/files\/(.+)$/);
    if (!match) {
      await route.continue();
      return;
    }
    try {
      const [, slug, relUnderAssets] = match;
      const fileStore = new ProfileStore(slug!);
      const buffer = fileStore.readFile(`assets/${relUnderAssets}`);
      await route.fulfill({ body: buffer });
    } catch {
      await route.abort();
    }
  });
}

export function renderRouter(): Router {
  const router = Router();

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/html", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const n = parseSlideIndex(req.params.n);
      if (n === undefined) {
        res.status(400).json({ error: `Invalid slide index "${req.params.n}"` });
        return;
      }
      if (!documentExists(store, req.params.id)) {
        res.status(404).json({ error: `No carousel "${req.params.id}"` });
        return;
      }
      const raw = readDocumentRaw(store, req.params.id);
      const result = validateAgainstProfile(store, raw);
      if (!result.valid) {
        res.status(400).json({ error: "Invalid document", details: result.errors });
        return;
      }
      const doc = result.document;
      if (n >= doc.slides.length) {
        res.status(404).json({ error: `Slide index ${n} out of range (${doc.slides.length} slides)` });
        return;
      }

      const brand = loadBrand(store.roots.profileDir);
      const templateRef = requireTemplateRef(doc);
      const template = loadLayoutTemplate(store.roots.profileDir, templateRef.id, templateRef.params);
      const ctx = buildRenderContext(store, brand, doc.slides[n]!.background);
      const html = renderFreeLayoutSlide(brand, template, doc, n, ctx);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (error) {
      handleRenderError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/png", async (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const n = parseSlideIndex(req.params.n);
      if (n === undefined) {
        res.status(400).json({ error: `Invalid slide index "${req.params.n}"` });
        return;
      }
      if (!documentExists(store, req.params.id)) {
        res.status(404).json({ error: `No carousel "${req.params.id}"` });
        return;
      }
      const raw = readDocumentRaw(store, req.params.id);
      const result = validateAgainstProfile(store, raw);
      if (!result.valid) {
        res.status(400).json({ error: "Invalid document", details: result.errors });
        return;
      }
      const doc = result.document;
      if (n >= doc.slides.length) {
        res.status(404).json({ error: `Slide index ${n} out of range (${doc.slides.length} slides)` });
        return;
      }

      const brand = loadBrand(store.roots.profileDir);
      const templateRef = requireTemplateRef(doc);
      const template = loadLayoutTemplate(store.roots.profileDir, templateRef.id, templateRef.params);
      const ctx = buildRenderContext(store, brand, doc.slides[n]!.background);
      const html = renderFreeLayoutSlide(brand, template, doc, n, ctx);

      const browser = await getSharedBrowser();
      const page = await browser.newPage({
        viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        deviceScaleFactor: 1,
      });
      try {
        // The HTML references `/api/profiles/:slug/assets/files/*` URLs —
        // Chromium needs to reach this same server to fetch them, so
        // `setContent` is paired with a `baseURL`-equivalent: routing asset
        // requests back to this process rather than the network.
        await routeAssetRequestsInProcess(page);
        await page.setContent(html, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const png = await page.screenshot();
        res.setHeader("Content-Type", "image/png");
        res.send(png);
      } finally {
        await page.close();
      }
    } catch (error) {
      handleRenderError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/contrast", async (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const n = parseSlideIndex(req.params.n);
      if (n === undefined) {
        res.status(400).json({ error: `Invalid slide index "${req.params.n}"` });
        return;
      }
      if (!documentExists(store, req.params.id)) {
        res.status(404).json({ error: `No carousel "${req.params.id}"` });
        return;
      }
      const raw = readDocumentRaw(store, req.params.id);
      const result = validateAgainstProfile(store, raw);
      if (!result.valid) {
        res.status(400).json({ error: "Invalid document", details: result.errors });
        return;
      }
      const doc = result.document;
      if (n >= doc.slides.length) {
        res.status(404).json({ error: `Slide index ${n} out of range (${doc.slides.length} slides)` });
        return;
      }

      const brand = loadBrand(store.roots.profileDir);
      const templateRef = requireTemplateRef(doc);
      const template = loadLayoutTemplate(store.roots.profileDir, templateRef.id, templateRef.params);
      const ctx = buildRenderContext(store, brand, doc.slides[n]!.background);
      const html = renderFreeLayoutSlide(brand, template, doc, n, ctx);

      const browser = await getSharedBrowser();
      const page = await browser.newPage({
        viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        deviceScaleFactor: 1,
      });
      try {
        await routeAssetRequestsInProcess(page);
        await page.setContent(html, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const measurements = await measureContrast(page, brand, doc, doc.slides[n]!, template);
        res.json({ measurements });
      } finally {
        await page.close();
      }
    } catch (error) {
      handleRenderError(error, res);
    }
  });

  return router;
}

function handleRenderError(error: unknown, res: import("express").Response): void {
  if (error instanceof ProfileStoreError || error instanceof LayoutTemplateError) {
    res.status(400).json({ error: error.message });
    return;
  }
  // `requireTemplateRef` throws this specific subclass for a valid document
  // with no template — 422 ("unprocessable"), not 400 ("malformed").
  // Matching only this subclass (not every `DocumentStoreError`) keeps a
  // malformed carousel id or an on-disk validation failure falling through
  // to the same 500 catch-all they hit before this branch existed.
  if (error instanceof TemplateNotSupportedError) {
    res.status(422).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: (error as Error).message });
}
