import { Router } from "express";
import type { Page } from "playwright";

import { NotFoundError } from "@personal-brand/storage/contracts";

import { loadBrand, type BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { LayoutTemplateError, type LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { loadWithResolver } from "../../../../system/ig-carousel/render-batch.js";
import { renderFreeLayoutSlide } from "../../../../system/ig-carousel/templates/free-layout.js";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../../../../system/ig-carousel/document.js";
import { measureContrast } from "../../../../system/ig-carousel/contrast.js";

import { assertValidCarouselId, documentExists, DocumentStoreError, readDocumentRaw, validateAgainstProfile } from "../document-store.js";
import { messages } from "../messages.js";
import { guardStorage, resolveStored, storedCarousel, storedSlideHtml, StorageFailure, type EditorStorage } from "../stored-read.js";
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
async function loadSlide(page: Page, html: string): Promise<() => void> {
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
      await route.fulfill({ body: await new ProfileStore(slug!).readFileAsync(`assets/${decodeURIComponent(relUnderAssets!)}`) });
    } catch {
      await route.abort();
    }
  });
  await page.goto(`${SLIDE_ORIGIN}/`, { waitUntil: "networkidle" });
  return () => {};
}

/** Everything a slide route needs once the request is resolved: the HTML, how to load it into a page, and what produced it. */
interface ResolvedSlide {
  html: string;
  brand: BrandTokens;
  doc: CarouselDocument;
  template: LayoutTemplate;
  n: number;
  /**
   * Loads `html` into `page` so its asset URLs are served (from the folder, or from storage's blob cache). Returns the
   * late check: call it after fonts settle, because a request refused after "idle" must not reach the screenshot.
   */
  load(page: Page): Promise<() => void>;
}

type SlideOutcome = { slide: ResolvedSlide } | { status: number; body: unknown };

function bad(status: number, body: unknown): SlideOutcome {
  return { status, body };
}

/** The shared front half of the html, png and contrast routes: slide index, document, validation, range, then the HTML. */
async function resolveSlide(storage: EditorStorage | undefined, slug: string, id: string, rawN: string, preview: boolean): Promise<SlideOutcome> {
  const n = parseSlideIndex(rawN);
  if (n === undefined) return bad(400, { error: `Invalid slide index "${rawN}"` });
  const found = await resolveStored(storage, slug);
  const stored = found && { ...found, storage: guardStorage(found.storage) };
  let doc: CarouselDocument;
  if (stored) {
    assertValidCarouselId(id);
    const { result } = await storedCarousel(stored, id);
    if (!result.valid) return bad(400, { error: "Invalid document", details: result.errors });
    doc = result.document;
  } else {
    const store = new ProfileStore(slug);
    if (!documentExists(store, id)) return bad(404, { error: `No carousel "${id}"` });
    const result = validateAgainstProfile(store, readDocumentRaw(store, id));
    if (!result.valid) return bad(400, { error: "Invalid document", details: result.errors });
    doc = result.document;
  }
  if (n >= doc.slides.length) return bad(404, { error: `Slide index ${n} out of range (${doc.slides.length} slides)` });

  if (stored) {
    const { html, brand, template, resolve } = await storedSlideHtml(stored, doc, n, preview);
    const load = async (page: Page): Promise<() => void> => {
      // Only a failure of the resolver's own storage reads is an outage; a refusal for any other reason is a render error.
      let outage: StorageFailure | undefined;
      const watched: typeof resolve = async (assetId) => {
        try {
          return await resolve(assetId);
        } catch (error) {
          if (error instanceof StorageFailure) outage = error;
          throw error;
        }
      };
      const classify = (error: unknown): unknown => (outage ? outage : error);
      let check: () => void;
      try {
        check = await loadWithResolver(page, html, watched);
      } catch (error) {
        throw classify(error);
      }
      return () => {
        try {
          check();
        } catch (error) {
          throw classify(error);
        }
      };
    };
    return { slide: { html, brand, doc, template, n, load } };
  }
  const store = new ProfileStore(slug);
  const brand = loadBrand(store.roots.profileDir);
  const template = resolveDocumentTemplate(store, brand, doc);
  const html = renderFreeLayoutSlide(brand, template, doc, n, buildRenderContext(store, brand, doc.slides[n]!.background));
  return { slide: { html, brand, doc, template, n, load: (page) => loadSlide(page, html) } };
}

/** `storage` is the stored read path (S10a): a brand cut over to storage renders from its repositories and blob cache. */
export function renderRouter(storage?: EditorStorage): Router {
  const router = Router();

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/html", async (req, res) => {
    try {
      const outcome = await resolveSlide(storage, req.params.slug, req.params.id, req.params.n, true);
      if (!("slide" in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(outcome.slide.html);
    } catch (error) {
      handleRenderError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/png", async (req, res) => {
    try {
      const outcome = await resolveSlide(storage, req.params.slug, req.params.id, req.params.n, false);
      if (!("slide" in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      const { html, n, load } = outcome.slide;
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
            const check = await load(page);
            await page.evaluate(() => document.fonts.ready);
            check();
            return await page.screenshot();
          } finally {
            await page.close();
          }
        });
        pngCache.set(cacheKey, png);
      }

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, no-cache");
      res.send(png);
    } catch (error) {
      handleRenderError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/slides/:n/contrast", async (req, res) => {
    try {
      const outcome = await resolveSlide(storage, req.params.slug, req.params.id, req.params.n, false);
      if (!("slide" in outcome)) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      const { brand, doc, template, n, load } = outcome.slide;
      const browser = await getSharedBrowser();
      const page = await browser.newPage({
        viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        deviceScaleFactor: 1,
      });
      try {
        const check = await load(page);
        await page.evaluate(() => document.fonts.ready);
        check();
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
  if (error instanceof ProfileStoreError || error instanceof LayoutTemplateError || error instanceof DocumentStoreError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof StorageFailure) {
    console.error("Storage read failed while rendering a slide:", error.cause);
    res.status(503).json({ error: messages.storageUnavailable });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: (error as Error).message });
}
