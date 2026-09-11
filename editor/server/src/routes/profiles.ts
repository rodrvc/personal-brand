import { existsSync } from "node:fs";

import { Router } from "express";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { listLayoutTemplates, loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { updateEntry } from "../../../../system/assets/index.js";
import { loadBrandStyle } from "../../../../system/ig-carousel/brand-style.js";

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
      // `loadBrand` throws a plain `Error` (system/ig-carousel/brand-schema.ts
      // has no dedicated error class) whose message starts with "No
      // brand.json found at" for exactly this case — matched here, ahead of
      // `handleStoreError`, because that function's generic ENOENT sniff
      // would otherwise answer 404 ("no such carousel/profile") for what is
      // really "the profile exists but isn't configured yet", a 422.
      const message = (error as Error)?.message ?? String(error);
      if (/^No brand\.json found at/.test(message)) {
        res.status(422).json({ error: `El perfil "${req.params.slug}" no tiene brand.json.` });
        return;
      }
      handleStoreError(error, res);
    }
  });

  /**
   * The brand's optional style guide (piece-generation spec's "Brand style
   * context in every generation"): palette/fonts/keywords/tone/positioning/
   * image direction/logo rules, plus which files actually contributed —
   * consumed by the web app's read-only "Marca" tab. Never 404s or 422s on
   * a profile with no style files: an all-empty style with `sources: []` is
   * a valid, expected answer (the UI shows "no hay guía todavía" for that).
   */
  router.get("/api/profiles/:slug/style", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      res.json(loadBrandStyle(store.roots.profileDir));
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  /**
   * Listing endpoint (ACU-230): before this, a template could only be
   * fetched by `GET .../template/:id`, which requires an id the caller
   * already knows — there was no way to discover what templates a brand
   * actually has. Checks the profile directory exists before touching
   * anything else so an unresolvable slug answers 404 without `ProfileStore`
   * ever reading outside the profiles root (a nonexistent slug still
   * resolves to a syntactically valid path under it).
   */
  router.get("/api/profiles/:slug/templates", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      if (!existsSync(store.roots.profileDir)) {
        res.status(404).json({ error: `No profile "${req.params.slug}"` });
        return;
      }
      res.json({ templates: listLayoutTemplates(store.roots.profileDir) });
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
        // Plain inequality over both sides' optional `template?.id` — this
        // already covers every case: unchanged (equal, both real ids or
        // both undefined), swapped to another template, or swapped to/from
        // "no template" (one side undefined). No `!== undefined` guard is
        // needed since `undefined !== undefined` is `false`.
        const templateChanged = previousRaw.template?.id !== result.document.template?.id;
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
      // A pinned placeholder with no `assetId` yet (pending, immediate-build
      // compose flow) has nothing to approve into the library — skip it
      // rather than calling `updateEntry` with `undefined`.
      if (object.kind !== "asset" || !object.pinned || !object.assetId) continue;
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
