import { resolveBrandSource } from "@personal-brand/storage";
import type { BlobCache } from "@personal-brand/storage/blob";
import { BrandArchivedError, InvalidInputError, NotFoundError, VersionConflictError, type AssetRepository, type BlobStore, type BrandDocumentRepository, type BrandRepository, type CarouselRepository, type ExportRepository, type RevisionRepository } from "@personal-brand/storage/contracts";

import type { BrandTokens } from "../../../system/ig-carousel/brand-schema.js";
import { validateDocument, type CarouselDocument, type ValidateDocumentResult } from "../../../system/ig-carousel/carousel-document.js";
import { FREE_TEMPLATE_ID, freeLayoutTemplate, type LayoutTemplate, type LayoutTemplateSummary } from "../../../system/ig-carousel/layout-template.js";
import { listStoredLayoutTemplates, loadStoredBrand, loadStoredBrandStyle, loadStoredLayoutTemplate } from "../../../system/ig-carousel/stored-brand.js";
import { renderFreeLayoutSlide, type FreeLayoutRenderContext } from "../../../system/ig-carousel/templates/free-layout.js";
import { buildStoredRenderContext, storedAssetResolver } from "../../../system/ig-carousel/stored-render-context.js";
import type { AssetResolve } from "../../../system/ig-carousel/render-batch.js";
import { computeUsageFrom, storageUsageSource } from "../../../system/assets/usage.js";

import type { CarouselListingEntry } from "./document-store.js";
import { messages } from "./messages.js";

/**
 * The repositories and blob cache the editor uses for a brand served from storage. Tests pass the memory ones.
 * Async-only: `guardStorage` turns every function member into an async one, so a sync method added here would silently
 * become a promise. `blobs(brandId)` is the one sync factory; its result is guarded.
 */
export interface EditorStorage {
  brands: Pick<BrandRepository, "getBySlug" | "list">;
  documents: Pick<BrandDocumentRepository, "get" | "list">;
  assets: Pick<AssetRepository, "list" | "get" | "update">;
  carousels: Pick<CarouselRepository, "list" | "get" | "save" | "setStatus" | "create">;
  exports: Pick<ExportRepository, "reserveNextVersion" | "complete" | "fail" | "list">;
  /** Snapshots of a carousel (`GET .../versions`). */
  revisions: Pick<RevisionRepository, "listHeads">;
  /** The bucket, for the deliverables (export keys from storage's `keys.ts`); written write-once. */
  files: BlobStore;
  /** The local blob cache of one brand (content-addressed, read-only). */
  blobs(brandId: string): Pick<BlobCache, "read">;
}

/** A brand served from storage: the only thing a read endpoint needs to ask it anything. */
export interface StoredBrand {
  storage: EditorStorage;
  brandId: string;
  slug: string;
}

const SLUG = /^[a-z0-9-]+$/;

/** A failure of the storage layer itself (database, bucket, blob cache), as opposed to a missing row or a deterministic render error. */
export class StorageFailure extends Error {
  constructor(readonly cause: unknown) {
    super("storage failure");
  }
}

/** Errors that are an answer about the request, not an outage: a missing row, a lost version race, a refused input, an archived brand. */
const isDomainError = (error: unknown): boolean =>
  error instanceof NotFoundError || error instanceof VersionConflictError || error instanceof InvalidInputError || error instanceof BrandArchivedError;

/** Errors the stored layer raises (domain answers and outages), as opposed to the folder's own. */
export const isStoredError = (error: unknown): boolean => error instanceof StorageFailure || isDomainError(error);

/**
 * Classifies at the source: every repository and blob call of `storage` rejects with a `StorageFailure` unless the error
 * is a domain error (a missing row is an answer, not an outage; neither is a lost version race). A validator that throws
 * on a corrupt stored document is a `StorageFailure` too, so a bad row answers 503 everywhere, never a raw 500. Rendering code built on top is untouched, so its own
 * deterministic errors keep their meaning.
 */
export function guardStorage(storage: EditorStorage): EditorStorage {
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          try {
            return await value.apply(obj, args);
          } catch (error) {
            throw isDomainError(error) ? error : new StorageFailure(error);
          }
        };
      },
    });
  return {
    brands: guard(storage.brands),
    documents: guard(storage.documents),
    assets: guard(storage.assets),
    carousels: guard(storage.carousels),
    exports: guard(storage.exports),
    revisions: guard(storage.revisions),
    files: guard(storage.files),
    blobs: (brandId) => guard(storage.blobs(brandId)),
  };
}

/**
 * The one switch between the two live read paths, the same one the engines use (`resolveBrandSource`, D12): a brand is
 * served from storage iff it was cut over; `undefined` means "a folder" (also with no storage configured at all, which
 * is how the editor behaved before storage). A storage failure is never a reason to serve the folder instead.
 */
export async function resolveStored(storage: EditorStorage | undefined, slug: string): Promise<StoredBrand | undefined> {
  if (!storage || !SLUG.test(slug)) return undefined;
  let row: ReturnType<EditorStorage["brands"]["getBySlug"]> | undefined;
  const once = { getBySlug: (s: string) => (row ??= storage.brands.getBySlug(s)) };
  if ((await resolveBrandSource(once, slug)) !== "storage") return undefined;
  return { storage, slug, brandId: (await row!).id };
}

/** The entity tag of a stored row: its version, quoted. S10b reads it back as `If-Match: "<version>"`. */
export function etagOf(version: number): string {
  return `"${version}"`;
}

export const storedBrandTokens = (s: StoredBrand): Promise<BrandTokens> => loadStoredBrand(s.storage.documents, s.brandId, s.slug);
export const storedStyle = (s: StoredBrand) => loadStoredBrandStyle(s.storage.documents, s.brandId);
export const storedTemplates = (s: StoredBrand): Promise<LayoutTemplateSummary[]> => listStoredLayoutTemplates(s.storage.documents, s.brandId);

/** `GET .../template/:id`: the free sentinel is answered without storage, as for a folder. */
export async function storedTemplate(s: StoredBrand, id: string, params?: Record<string, unknown>): Promise<LayoutTemplate> {
  if (id === FREE_TEMPLATE_ID) return freeLayoutTemplate();
  return loadStoredLayoutTemplate(s.storage.documents, s.brandId, id, await storedBrandTokens(s), params);
}

/** The editor knows three statuses; a scheduled carousel is shown as exported (it has been exported). */
export const editorStatus = (status: string): CarouselDocument["status"] => (status === "scheduled" ? "exported" : (status as CarouselDocument["status"]));

/** The raw stored document with the columns that own `title` and `status` overlaid, plus its row version. */
export async function storedCarouselRaw(s: StoredBrand, id: string): Promise<{ rowId: string; document: Record<string, unknown>; version: number; updatedAt: string }> {
  const row = await s.storage.carousels.get(s.brandId, id, (body) => body as Record<string, unknown>);
  const { document, title, status } = row.value;
  return { rowId: row.id, document: { ...document, id, title, status: editorStatus(status) }, version: row.version, updatedAt: row.updatedAt };
}

/** Validates a stored document against the brand's stored tokens and asset library, as `validateAgainstProfile` does for a folder. */
export async function validateStored(s: StoredBrand, document: unknown): Promise<ValidateDocumentResult> {
  const known = new Set((await s.storage.assets.list(s.brandId)).map((row) => row.value.assetId));
  return validateDocument(document, { brand: await storedBrandTokens(s), assetExists: (assetId) => known.has(assetId) });
}

/** A carousel as the editor reads it: the validated document and the version it was read at (the `ETag`). */
export async function storedCarousel(s: StoredBrand, id: string): Promise<{ result: ValidateDocumentResult; version: number }> {
  const { document, version } = await storedCarouselRaw(s, id);
  return { result: await validateStored(s, document), version };
}

/** The listing: raw and shape-checked only (no asset or colour validation), newest first, like `listCarousels`. */
export async function storedCarouselListing(s: StoredBrand): Promise<CarouselListingEntry[]> {
  const heads = await s.storage.carousels.list(s.brandId);
  const entries = await Promise.all(
    heads.map(async (head): Promise<CarouselListingEntry | undefined> => {
      try {
        const { document, updatedAt } = await storedCarouselRaw(s, head.value.slug);
        const stamp = typeof document.updatedAt === "string" ? document.updatedAt : updatedAt;
        return { id: head.value.slug, title: head.value.title, status: document.status as CarouselDocument["status"], updatedAt: stamp, slideCount: Array.isArray(document.slides) ? document.slides.length : 0 };
      } catch (error) {
        // Removed between the list and the get: it is simply not there any more, the rest of the listing still is.
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    }),
  );
  return entries.filter((entry): entry is CarouselListingEntry => entry !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf" };

/** The id of the asset a `files`/`thumbs` URL names: the first dot-separated part of its last segment (`<assetId>.<ext>`). */
export const assetIdOfPath = (relUnderAssets: string): string => (relUnderAssets.split("/").pop() ?? "").split(".")[0]!;

/**
 * The asset library as the web client reads it. A stored asset has no file, but the client builds its URLs from
 * `path`, so each entry carries the virtual `assets/<assetId>.<ext>` that the `files` and `thumbs` routes resolve by id.
 */
export async function storedAssetEntries(s: StoredBrand) {
  const [rows, usage] = await Promise.all([s.storage.assets.list(s.brandId), computeUsageFrom(storageUsageSource(s.storage.carousels, s.brandId))]);
  return rows.map(({ value: a }) => ({
    id: a.assetId,
    path: `assets/${a.assetId}${EXTENSION[a.mime] ? `.${EXTENSION[a.mime]}` : ""}`,
    kind: a.kind,
    mime: a.mime,
    ...(a.width ? { w: a.width } : {}),
    ...(a.height ? { h: a.height } : {}),
    bytes: a.bytes,
    origin: a.origin,
    status: a.status,
    tags: a.tags,
    createdAt: a.createdAt,
    ...(a.family ? { family: a.family } : {}),
    usageCount: usage[a.assetId] ?? 0,
  }));
}

/** The bytes and mime of one stored asset; a hidden asset is not served (as the render does not serve it). */
export async function storedAssetFile(s: StoredBrand, assetId: string): Promise<{ path: string; mime: string; sha256: string } | undefined> {
  const { value: a } = await s.storage.assets.get(s.brandId, assetId);
  if (a.status === "hidden") return undefined;
  return { path: await s.storage.blobs(s.brandId).read(a.sha256), mime: a.mime, sha256: a.sha256 };
}

/**
 * Every brand cut over to storage: it is served from there even when a folder of the same name is still on disk.
 * `shadowed` is every cut-over slug, archived ones included, because `resolveStored` serves them and their folder entry
 * must stay hidden; `listed` is the non-archived subset, the only ones the picker shows.
 */
export async function cutOverSlugs(storage: EditorStorage | undefined): Promise<{ shadowed: string[]; listed: string[] }> {
  if (!storage) return { shadowed: [], listed: [] };
  const cut = (await storage.brands.list({ includeArchived: true })).filter((row) => row.value.cutoverAt);
  return { shadowed: cut.map((row) => row.value.slug), listed: cut.filter((row) => row.value.status !== "archived").map((row) => row.value.slug) };
}

/** What a stored brand answers on the read routes that have a stored branch. Anything else is answered by the guard below. */
const STORED_READS = [/^\/(card|brand|style|templates)$/, /^\/template\/[^/]+$/, /^\/carousels(\/[^/]+(\/versions)?)?$/, /^\/carousels\/[^/]+\/(outputs|stats|export\/[^/]+)$/, /^\/assets(\/(files|thumbs)\/.+)?$/, /^\/carousels\/[^/]+\/slides\/[^/]+\/(html|png|contrast)$/];

/** The writes a stored brand takes so far (S10b): creating, saving and exporting a carousel, and the regenerate preview. Every other write (chat, plan/apply) stays a 405. */
const STORED_WRITES: Array<[string, RegExp]> = [["PUT", /^\/carousels\/[^/]+$/], ["POST", /^\/carousels$/], ["POST", /^\/carousels\/[^/]+\/export$/], ["POST", /^\/carousels\/[^/]+\/regenerate$/]];

/** Read routes the web client calls on every carousel open: an empty answer it already handles (no chat yet). */
const EMPTY_READS: Array<[RegExp, unknown]> = [
  [/^\/carousels\/[^/]+\/chat$/, { records: [], pendingProposalId: null, currency: { code: "USD", rate: 1 } }],
];

/**
 * The one gate for a brand served from storage, mounted as `app.use("/api/profiles/:slug", ...)` ahead of every router
 * (Express decodes `:slug`, so `%2D` cannot dodge it). Reads with a stored branch pass; chat answers empty;
 * every other route (generation sidecars) is a 501; writes other than
 * the carousel create, save and export are a 405, because they would land in a folder nobody reads. No route below this point ever builds a
 * `ProfileStore` for a stored brand, which would create an empty `profiles/<slug>` folder.
 */
export function storedBrandGuard(storage: EditorStorage | undefined) {
  return (
    req: { method: string; path: string; params: Record<string, string> },
    res: { status(code: number): { json(body: unknown): void }; json(body: unknown): void },
    next: (error?: unknown) => void,
  ): void => {
    const slug = req.params.slug;
    if (!storage || !slug) return next();
    resolveStored(storage, slug).then((stored) => {
      if (!stored) return next();
      if (STORED_WRITES.some(([method, re]) => req.method === method && re.test(req.path))) return next();
      if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).json({ error: messages.storedReadOnly(slug) });
      if (STORED_READS.some((re) => re.test(req.path))) return next();
      const empty = EMPTY_READS.find(([re]) => re.test(req.path));
      if (empty) return void res.json(empty[1]);
      res.status(501).json({ error: messages.storedNotYet });
    }, (error: unknown) => {
      // A storage failure is an error, never a reason to serve the folder instead (D12): say so, and log the cause.
      console.error(`Storage lookup failed for "${slug}":`, error);
      res.status(503).json({ error: messages.storageUnavailable });
    });
  };
}

/**
 * One slide's HTML from storage. For Playwright (`preview` false) assets are `http://render.local/assets/<id>`, served
 * by `resolve` out of the blob cache. For the browser preview (the iframe) they are this server's own
 * `/assets/files/<id>` URLs instead, because a browser cannot reach `render.local`.
 */
export async function storedSlideHtml(s: StoredBrand, doc: CarouselDocument, n: number, preview: boolean): Promise<{ html: string; brand: BrandTokens; template: LayoutTemplate; resolve: AssetResolve }> {
  const { brand, template, base, resolve } = await storedRenderParts(s, doc);
  const fileUrl = (assetId: string): string => `/api/profiles/${encodeURIComponent(s.slug)}/assets/files/${assetId}`;
  const ctx: FreeLayoutRenderContext = preview
    ? { ...base, assetUrl: (assetId) => (base.assetUrl(assetId), fileUrl(assetId)), fontFaces: (base.fontFaces ?? []).map((face) => ({ ...face, url: fileUrl(assetIdOfPath(face.url)) })) }
    : base;
  return { html: renderFreeLayoutSlide(brand, template, doc, n, ctx), brand, template, resolve };
}

/** What rendering a stored carousel needs, for a slide's HTML and for an export alike: the brand, the document's template, the render context and the asset resolver. */
export async function storedRenderParts(s: StoredBrand, doc: CarouselDocument) {
  const brand = await storedBrandTokens(s);
  const template = doc.template ? await loadStoredLayoutTemplate(s.storage.documents, s.brandId, doc.template.id, brand, doc.template.params) : freeLayoutTemplate();
  const base = await buildStoredRenderContext(s.storage.assets, s.brandId);
  return { brand, template, base, resolve: storedAssetResolver(s.storage.assets, s.storage.blobs(s.brandId), s.brandId) };
}

/**
 * `GET .../versions` for a stored carousel: one stamp per recorded snapshot (revisions with reason `snapshot` or
 * `structural`, the two the folder writes version files for), most recent first, in the folder's stamp format
 * (`toISOString()` with `:` and `.` as `-`). Meaning differs: a folder version file holds the document as it was BEFORE
 * the save, a revision holds it AFTER, so the stamp marks the save that created the snapshot.
 */
export async function storedVersions(s: StoredBrand, id: string): Promise<string[]> {
  const { rowId } = await storedCarouselRaw(s, id);
  return (await s.storage.revisions.listHeads("carousel", rowId, ["snapshot", "structural"]))
    .map((revision) => revision.createdAt.replace(/[:.]/g, "-"))
    .sort()
    .reverse();
}
