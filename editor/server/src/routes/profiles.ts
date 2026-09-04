import { Router } from "express";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { updateEntry } from "../../../../system/assets/index.js";

import {
  documentExists,
  DocumentStoreError,
  listCarousels,
  listVersions,
  readDocumentRaw,
  snapshotDocument,
  validateAgainstProfile,
  writeDocument,
} from "../document-store.js";
import { listProfiles, ProfileStore, ProfileStoreError } from "../profile-store.js";

/**
 * Turns a rejected path or id into a 400, everything else into a 404/500 as
 * appropriate. Every route below funnels its try/catch through this.
 * `DocumentStoreError` covers the non-slug `carousel-id` case, which
 * specs/carousel-document ("Confined writes") requires to answer 400 — not
 * the 500 an unclassified throw would produce.
 */
function handleStoreError(error: unknown, res: import("express").Response): void {
  if (error instanceof ProfileStoreError || error instanceof DocumentStoreError) {
    res.status(400).json({ error: error.message });
    return;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ENOENT|no such file/i.test(message)) {
    res.status(404).json({ error: message });
    return;
  }
  res.status(500).json({ error: message });
}

export function profilesRouter(): Router {
  const router = Router();

  router.get("/api/profiles", (_req, res) => {
    res.json({ profiles: listProfiles() });
  });

  router.get("/api/profiles/:slug/brand", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const brand = loadBrand(store.roots.profileDir);
      res.json(brand);
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/template/:id", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const paramsRaw = req.query.params;
      const params =
        typeof paramsRaw === "string" && paramsRaw.length > 0
          ? (JSON.parse(paramsRaw) as Record<string, unknown>)
          : undefined;
      const template = loadLayoutTemplate(store.roots.profileDir, req.params.id, params);
      res.json(template);
    } catch (error) {
      if (error instanceof LayoutTemplateError) {
        res.status(400).json({ error: error.message });
        return;
      }
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      res.json({ carousels: listCarousels(store) });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      if (!documentExists(store, req.params.id)) {
        res.status(404).json({ error: `No carousel "${req.params.id}"` });
        return;
      }
      const raw = readDocumentRaw(store, req.params.id);
      const result = validateAgainstProfile(store, raw);
      if (!result.valid) {
        res.status(500).json({ error: "Stored document failed validation", details: result.errors });
        return;
      }
      res.json(result.document);
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  /**
   * PUT replaces the whole document. Per specs/carousel-document ("Internal
   * document versions") and carousel-export's version reservation, a
   * snapshot is written first when the request flags `snapshot: true` or
   * when the slide count/kind list changed relative to what's on disk —
   * covering both an explicit "about to redo/replace several pieces" call
   * and an editor-side structural change that forgot to ask for one.
   * Changing `template.id` counts as structural too: it moves every
   * untouched slide's locked zones and slot defaults (design.md D4), which
   * is exactly the kind of blanket change a version snapshot exists for.
   */
  router.put("/api/profiles/:slug/carousels/:id", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      if (req.params.id !== (req.body as { id?: string })?.id) {
        res.status(400).json({ error: `Body "id" must match the URL's carousel id "${req.params.id}"` });
        return;
      }

      const result = validateAgainstProfile(store, req.body);
      if (!result.valid) {
        res.status(400).json({ error: "Invalid document", details: result.errors });
        return;
      }

      const explicitSnapshot = req.query.snapshot === "true" || (req.body as { snapshot?: boolean })?.snapshot === true;
      let structuralChange = false;
      let previousDocForPinDiff: RawDocumentShape | undefined;
      if (documentExists(store, req.params.id)) {
        const previousRaw = readDocumentRaw(store, req.params.id) as RawDocumentShape;
        previousDocForPinDiff = previousRaw;
        const previousShape = (previousRaw.slides ?? []).map((s) => s.kind).join(",");
        const nextShape = result.document.slides.map((s) => s.kind).join(",");
        const templateChanged = previousRaw.template?.id !== undefined && previousRaw.template.id !== result.document.template.id;
        structuralChange =
          (previousRaw.slides?.length ?? 0) !== result.document.slides.length ||
          previousShape !== nextShape ||
          templateChanged;
      }

      // pin false -> true triggers the library's "pinning approves it"
      // rule (asset-library spec's "Generated piece -> always a file,
      // approved -> library"): compared piece-by-piece against what was on
      // disk before this write, any piece whose `pinned` flips to `true`
      // and carries an `assetId` gets promoted to `approved`. The export
      // trigger (candidate -> approved on export) is untouched — this is
      // the second, independent trigger the spec also requires.
      approveNewlyPinnedAssets(store, previousDocForPinDiff, result.document);

      if (explicitSnapshot || structuralChange) {
        snapshotDocument(store, req.params.id);
      }

      writeDocument(store, result.document);
      res.json(result.document);
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/versions", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      res.json({ versions: listVersions(store, req.params.id) });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  return router;
}

/** Loose shape used only to diff the previous on-disk document against the incoming one — deliberately untyped/partial since it reads whatever was actually persisted, which a full `CarouselDocument` cast would hide errors in. */
interface RawDocumentShape {
  slides?: Array<{
    kind?: string;
    background?: { mode?: string; assetId?: string; pinned?: boolean };
    objects?: Array<{ id?: string; assetId?: string; pinned?: boolean; kind?: string }>;
  }>;
  template?: { id?: string };
}

/**
 * Detects every piece (a slide's background, or an `asset` object) whose
 * `pinned` flips from `false`/absent to `true` between `previous` and
 * `next`, and promotes its `assetId` to `status: "approved"` in the asset
 * index (asset-library spec's "Generated piece -> always a file, approved
 * -> library": pinning is one of the two triggers, export being the other).
 * A piece with no `previous` counterpart (a brand-new object) is treated as
 * newly pinned too, since there is nothing to compare it against but it is
 * still the first time this document declares it pinned.
 */
function approveNewlyPinnedAssets(
  store: ProfileStore,
  previous: RawDocumentShape | undefined,
  next: CarouselDocument,
): void {
  next.slides.forEach((slide, slideIndex) => {
    const previousSlide = previous?.slides?.[slideIndex];

    const background = slide.background;
    const wasPinned = previousSlide?.background?.pinned ?? false;
    if (background.mode === "asset" && background.pinned && !wasPinned) {
      updateEntry(store.roots.profileDir, background.assetId, { status: "approved" });
    }

    for (const object of slide.objects) {
      if (object.kind !== "asset" || !object.pinned) continue;
      const previousObject = previousSlide?.objects?.find((o) => o.id === object.id);
      const objectWasPinned = previousObject?.pinned ?? false;
      if (!objectWasPinned) {
        updateEntry(store.roots.profileDir, object.assetId, { status: "approved" });
      }
    }
  });
}

// Re-exported for other route modules that need the same 400/404/500 mapping.
export { handleStoreError };
