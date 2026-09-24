import { Router } from "express";
import type { Page } from "playwright";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import { renderFreeLayoutSlide } from "../../../../system/ig-carousel/templates/free-layout.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../../../../system/ig-carousel/document.js";
import { measureContrast } from "../../../../system/ig-carousel/contrast.js";

import { documentExists, readDocumentRaw, validateAgainstProfile } from "../document-store.js";
import { resolveDocumentTemplate } from "../template-resolve.js";
import { buildRenderContext } from "../render-context.js";
import { getSharedBrowser } from "../browser.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";
import { PngCache, pngCacheKey, Semaphore } from "./png-cache.js";

/** One process-wide cache and slot pool for the PNG route — shared across requests, not per-request state. */
const pngCache = new PngCache();
const pngSemaphore = new Semaphore(2);

function parseSlideIndex(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const SLIDE_ORIGIN = "http://editor.local";

/**
 * Loads the slide from a real origin instead of `setContent` on about:blank,
 * so its root-relative `/api/profiles/:slug/assets/files/*` URLs resolve and
 * are fulfilled in-process.
 */
async function loadSlide(page: Page, html: string): Promise<void> {
  await page.route(`${SLIDE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ body: html, contentType: "text/html; charset=utf-8" });
      return;
    }
    const match = url.pathname.match(/^\/api\/profiles\/([^/]+)\/assets\/files\/(.+)$/);
    try {
      if (!match) throw new Error("not an asset");
      const [, slug, relUnderAssets] = match;
      await route.fulfill({ body: new ProfileStore(slug!).readFile(`assets/${decodeURIComponent(relUnderAssets!)}`) });
    } catch {
      await route.abort();
    }
  });
  await page.goto(`${SLIDE_ORIGIN}/`, { waitUntil: "networkidle" });
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
      const template = resolveDocumentTemplate(store, brand, doc);
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
      const template = resolveDocumentTemplate(store, brand, doc);
      const ctx = buildRenderContext(store, brand, doc.slides[n]!.background);
      const html = renderFreeLayoutSlide(brand, template, doc, n, ctx);

      // The rendered HTML string IS the true content key (same slide index
      // can render differently across edits), so a cache hit skips Chromium
      // entirely — the strip fires one request per slide on open and again
      // on every save, and most of those are identical content.
      const cacheKey = pngCacheKey(req.params.slug, req.params.id, n, html);
      let png = pngCache.get(cacheKey);
      if (!png) {
        png = await pngSemaphore.withSlot(async () => {
          const browser = await getSharedBrowser();
          const page = await browser.newPage({
            viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
            deviceScaleFactor: 1,
          });
          try {
            await loadSlide(page, html);
            await page.evaluate(() => document.fonts.ready);
            return await page.screenshot();
          } finally {
            await page.close();
          }
        });
        pngCache.set(cacheKey, png);
      }

      res.setHeader("Content-Type", "image/png");
      // Not `immutable`: the client's `?r=renderVersion` buster restarts at 0
      // on every page load, so the same URL must be revalidated. Express's
      // default weak ETag on `send` answers 304 from the in-memory cache
      // without touching Chromium, which is the expensive part.
      res.setHeader("Cache-Control", "private, no-cache");
      res.send(png);
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
      const template = resolveDocumentTemplate(store, brand, doc);
      const ctx = buildRenderContext(store, brand, doc.slides[n]!.background);
      const html = renderFreeLayoutSlide(brand, template, doc, n, ctx);

      const browser = await getSharedBrowser();
      const page = await browser.newPage({
        viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        deviceScaleFactor: 1,
      });
      try {
        await loadSlide(page, html);
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
  res.status(500).json({ error: (error as Error).message });
}
