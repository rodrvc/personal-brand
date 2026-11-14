import { existsSync } from "node:fs";

import { Router } from "express";

import { loadBrand } from "../../../../system/ig-carousel/brand-schema.js";
import { FREE_TEMPLATE_ID, freeLayoutTemplate, listLayoutTemplates, loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { updateEntry } from "../../../../system/assets/index.js";
import { loadBrandStyle } from "../../../../system/ig-carousel/brand-style.js";

import { invalidateAssetIndex } from "../asset-index-cache.js";
import {
  assertValidCarouselId,
  documentExists,
  isStructuralChange,
  listCarousels,
  listVersions,
  readDocumentRaw,
  readDocumentRevision,
  snapshotDocument,
  validateAgainstProfile,
  writeDocumentIfRevision,
} from "../document-store.js";
import { messages } from "../messages.js";
import { handleStoreError } from "./store-errors.js";
import {
  etagOf,
  guardStorage,
  storedVersions,
  resolveStored,
  storedBrandTokens,
  storedCarousel,
  storedCarouselListing,
  cutOverSlugs,
  storedStyle,
  storedTemplate,
  storedTemplates,
  StorageFailure,
  type EditorStorage,
} from "../stored-read.js";
import { saveStoredCarousel } from "../stored-write.js";
import { listProfilesAsync, ProfileStore, ProfileStoreError, RevisionConflictError } from "../profile-store.js";
import { buildCardSummary } from "../profile-card.js";

/**
 * `storage` is the stored path: a brand cut over to storage is read through its repositories (S10a) and saved through
 * them (S10b, `If-Match`), every other brand uses its folder, exactly as before.
 */
export function profilesRouter(rawStorage?: EditorStorage): Router {
  const router = Router();
  // Every repository call is classified at the source: an outage or a corrupt row is a StorageFailure (503), never a raw 500.
  const storage = rawStorage && guardStorage(rawStorage);

  /**
   * `card` is computed on top of `listProfilesAsync()`'s cheap slug/hasBrand
   * pair (editor-ui restyle: the picker's "generic slop" feedback) — one
   * `buildCardSummary` per profile, wrapped so a single broken profile
   * (corrupt brand.json, unreadable asset index, no local mirror yet in `s3`
   * mode) never 500s the whole listing: it just answers with
   * `card: undefined`, same as a profile with no brand.json at all.
   */
  router.get("/api/profiles", async (_req, res) => {
    try {
      // A cut-over brand is served from storage: its folder entry (if any) is replaced, never read for a card.
      let cut: Awaited<ReturnType<typeof cutOverSlugs>>;
      try {
        cut = await cutOverSlugs(storage);
      } catch (error) {
        // Without the stored list a folder entry could shadow a cut-over brand: fail the listing, never guess.
        console.error("Storage listing failed:", error);
        return void res.status(503).json({ error: messages.storageUnavailable });
      }
      const folders = (await listProfilesAsync())
        .filter((entry) => !cut.shadowed.includes(entry.slug))
        .map((entry) => {
          if (!entry.hasBrand) return entry;
          try {
            return { ...entry, card: buildCardSummary(entry.slug) };
          } catch {
            return entry;
          }
        });
      // A stored brand has no card yet (it is built from the folder): it is listed like a profile mid-setup.
      const stored = cut.listed.map((slug) => ({ slug, hasBrand: true }));
      const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug);
      // Archived brands come last, flagged: the picker shows them apart and opens them read-only.
      const archived = cut.archived.map((slug) => ({ slug, hasBrand: true, archived: true })).sort(bySlug);
      res.json({ profiles: [...[...folders, ...stored].sort(bySlug), ...archived] });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  /**
   * Slug-scoped card summary (brand home dashboard) — same data as the
   * `card` field `GET /api/profiles` attaches to each listing entry, but
   * without paying for every other profile's cover/asset-index work just
   * to read one brand's wordmark and font. Never 500s: `buildCardSummary`
   * degrades to `card: undefined` for a profile with no/broken brand.json,
   * same as the listing does.
   */
  router.get("/api/profiles/:slug/card", async (req, res) => {
    try {
      if (await resolveStored(storage, req.params.slug)) {
        res.json({});
        return;
      }
      res.json({ card: buildCardSummary(req.params.slug) });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/brand", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        res.json(await storedBrandTokens(stored));
        return;
      }
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
        res.status(422).json({ error: messages.profileWithoutBrand(req.params.slug) });
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
  router.get("/api/profiles/:slug/style", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        res.json(await storedStyle(stored));
        return;
      }
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
  router.get("/api/profiles/:slug/templates", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        res.json({ templates: await storedTemplates(stored), freeTemplateId: FREE_TEMPLATE_ID });
        return;
      }
      const store = new ProfileStore(req.params.slug);
      if (!existsSync(store.roots.profileDir)) {
        res.status(404).json({ error: `No profile "${req.params.slug}"` });
        return;
      }
      // `freeTemplateId` is a field, not a listing entry: the picker renders
      // "no template" from data without hardcoding the sentinel, and every
      // `templates.map()` in the client stays free of it.
      res.json({ templates: listLayoutTemplates(store.roots.profileDir), freeTemplateId: FREE_TEMPLATE_ID });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  /**
   * Resolves one template by id. The sentinel `__free__` (`FREE_TEMPLATE_ID`)
   * is answered from `freeLayoutTemplate()` without touching disk — it is
   * not a file and `loadLayoutTemplate` would 400 on it — so a picker that
   * offers "sin template" can fetch the resulting geometry through the same
   * endpoint as any real template. `GET .../templates` still never lists it:
   * it is a choice the UI offers, not a template the brand owns.
   */
  router.get("/api/profiles/:slug/template/:id", async (req, res) => {
    try {
      // Parsed only when a template is actually loaded, so the free sentinel never depends on it. Only this parse
      // maps to a 400: any other SyntaxError (a corrupt engine layout) is a server problem and stays a 500.
      const paramsRaw = req.query.params;
      const parseParams = (): Record<string, unknown> | undefined | "invalid" => {
        if (typeof paramsRaw !== "string" || paramsRaw.length === 0) return undefined;
        try {
          return JSON.parse(paramsRaw) as Record<string, unknown>;
        } catch (error) {
          res.status(400).json({ error: `"params" is not valid JSON: ${(error as Error).message}` });
          return "invalid";
        }
      };
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        const params = req.params.id === FREE_TEMPLATE_ID ? undefined : parseParams();
        if (params === "invalid") return;
        res.json(await storedTemplate(stored, req.params.id, params));
        return;
      }
      // Constructing the store validates the slug (400 on a malformed one)
      // without any I/O, so the sentinel inherits the same check as a real id.
      const store = new ProfileStore(req.params.slug);
      if (req.params.id === FREE_TEMPLATE_ID) {
        res.json(freeLayoutTemplate());
        return;
      }
      const params = parseParams();
      if (params === "invalid") return;
      res.json(loadLayoutTemplate(store.roots.profileDir, req.params.id, loadBrand(store.roots.profileDir), params));
    } catch (error) {
      if (error instanceof LayoutTemplateError) {
        res.status(400).json({ error: error.message });
        return;
      }
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        res.json({ carousels: await storedCarouselListing(stored) });
        return;
      }
      const store = new ProfileStore(req.params.slug);
      res.json({ carousels: listCarousels(store) });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        assertValidCarouselId(req.params.id);
        const { result, version } = await storedCarousel(stored, req.params.id);
        if (!result.valid) {
          res.status(500).json({ error: "Stored document failed validation", details: result.errors });
          return;
        }
        // The version this copy was read at: S10b's save answers 409 unless `If-Match` still names it.
        res.setHeader("ETag", etagOf(version));
        res.json(result.document);
        return;
      }
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
  router.put("/api/profiles/:slug/carousels/:id", async (req, res) => {
    try {
      const stored = await resolveStored(storage, req.params.slug);
      if (stored) {
        const snapshot = req.query.snapshot === "true" || (req.body as { snapshot?: boolean })?.snapshot === true;
        const outcome = await saveStoredCarousel(stored, req.params.id, req.body, req.header("If-Match"), snapshot);
        if (outcome.etag) res.setHeader("ETag", outcome.etag);
        res.status(outcome.status).json(outcome.body);
        return;
      }
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
      // The authoritative read for both the app-level stale-copy check
      // below and the low-level conditional write at the end: in `s3` mode
      // this reads straight from the bucket (not the local mirror), and
      // `revision` (the bucket's ETag, or a content hash in `fs` mode) is
      // what the final write is conditioned on — catching a real
      // concurrent-writer race, not just a stale client copy, once this
      // request actually gets to write.
      const existing = await readDocumentRevision(store, req.params.id);
      const revision = existing?.revision ?? null;
      if (existing) {
        const previousRaw = existing.value as RawDocumentShape;
        const base = req.query.base;
        if (typeof base === "string" && base !== previousRaw.updatedAt) {
          res.status(409).json({ error: "The carousel changed on disk since this copy was loaded." });
          return;
        }
        previousDocForPinDiff = previousRaw;
        structuralChange = isStructuralChange(previousRaw, result.document);
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

      // `status` is a server-side lifecycle fact (the export queue sets
      // "exported"); the editor only reads it. A client whose copy predates
      // an export must not write "draft" back, so the on-disk value wins.
      const document =
        previousDocForPinDiff?.status !== undefined
          ? { ...result.document, status: previousDocForPinDiff.status }
          : result.document;
      try {
        await writeDocumentIfRevision(store, document, revision);
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          res.status(409).json({ error: "The carousel changed on disk since this copy was loaded." });
          return;
        }
        throw error;
      }
      res.json(document);
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/versions", async (req, res) => {
    try {
      const found = await resolveStored(storage, req.params.slug);
      if (found) {
        res.json({ versions: await storedVersions(found, req.params.id) });
        return;
      }
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
  status?: CarouselDocument["status"];
  updatedAt?: string;
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
      invalidateAssetIndex(store.roots.profileDir);
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
        invalidateAssetIndex(store.roots.profileDir);
      }
    }
  });
}

