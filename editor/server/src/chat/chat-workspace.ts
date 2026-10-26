import { basename } from "node:path";

import { NotFoundError, VersionConflictError } from "@personal-brand/storage/contracts";

import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument, ValidateDocumentResult } from "../../../../system/ig-carousel/carousel-document.js";
import { FREE_TEMPLATE_ID } from "../../../../system/ig-carousel/layout-template.js";
import { createStorageAssetLibrary } from "../../../../system/assets/storage-library.js";

import { loadIndexCached } from "../asset-index-cache.js";
import { folderPlannerSource, type PlannerSource } from "../compose/planner.js";
import { DocumentStoreError, readDocumentRevision, snapshotDocument, validateAgainstProfile, writeDocumentThroughRevision } from "../document-store.js";
import { messages } from "../messages.js";
import type { ProfileStore } from "../profile-store.js";
import { persistStoredDocument, assertWritable, storedPlannerSource, type StoredToken } from "../stored-compose.js";
import { storedAssetPath, storedBrandTokens, storedCarousel, storedTemplate, validateStored, type StoredBrand } from "../stored-read.js";
import { folderRasterFonts, storedRasterFonts, type RasterFonts } from "../text-raster.js";
import { assertReferenceMime, readAssetFile, readStoredAsset, saveReference, type AssetFile } from "./chat-references.js";
import { buildChatContext, type ChatContext } from "./chat-context.js";
import { folderChatSource, storedChatSource, type ChatSource } from "./chat-source.js";

/** What the chat routes need of one carousel's brand, folder or stored, so messages, references and apply are one code path: the log, the document and the version a write names, the asset library and the raster fonts. */
export interface ChatWorkspace extends ChatSource {
  /** Refuses a write to an archived stored brand (403) before a model or image provider is paid; a folder is always writable. */
  assertWritable?(): Promise<void>;
  /** The validated document, its template and brand, with the opaque `base` a later `writeDocument` must name. */
  open(): Promise<{ ctx: ChatContext; base: unknown }>;
  validate(document: unknown): Promise<ValidateDocumentResult>;
  /** Writes at `base` (a write that landed since is a conflict); returns the folder's pre-write snapshot path (none when stored: a revision holds the document after a save). */
  writeDocument(document: CarouselDocument, base: unknown): Promise<string | undefined>;
  readAsset(assetId: string): Promise<AssetFile | undefined>;
  /** Registers an uploaded reference image as a `candidate` asset of origin `reference`. */
  saveReference(mime: string, bytes: Buffer): Promise<{ id: string; w?: number; h?: number }>;
  /** The file name the model sees for an asset. */
  assetName(assetId: string): Promise<string>;
  planner: PlannerSource;
  fonts(brand: BrandTokens): () => RasterFonts | Promise<RasterFonts>;
  /** Runs after a proposal's background run: the folder uploads what it wrote to the mirror, a stored brand has nothing to sync. */
  settle?(proposalId: string): Promise<void>;
}

/** The folder carousel's workspace; undefined when it does not exist. */
export function folderChatWorkspace(store: ProfileStore, carouselId: string): ChatWorkspace | undefined {
  const source = folderChatSource(store, carouselId);
  if (!source) return undefined;
  const entries = () => loadIndexCached(store.roots.profileDir).entries;
  return {
    ...source,
    open: async () => ({ ctx: buildChatContext(store, carouselId), base: (await readDocumentRevision(store, carouselId))?.revision ?? null }),
    validate: async (document) => validateAgainstProfile(store, document),
    writeDocument: async (document, base) => {
      const snapshot = snapshotDocument(store, carouselId);
      await writeDocumentThroughRevision(store, document, { expectedRevision: base as string | null });
      return snapshot;
    },
    readAsset: async (assetId) => readAssetFile(store, assetId),
    saveReference: async (mime, bytes) => {
      const id = saveReference(store, mime, bytes);
      const entry = entries().find((e) => e.id === id);
      return { id, w: entry?.w, h: entry?.h };
    },
    assetName: async (assetId) => entries().find((e) => e.id === assetId)?.path.split("/").pop() ?? assetId,
    planner: folderPlannerSource(store),
    fonts: (brand) => () => folderRasterFonts(store, brand),
    settle: async (proposalId) => {
      // A proposal runs after its request, so the per-request sync-up middleware never sees its writes (a no-op in `fs` mode).
      const { syncUpNow } = await import("../storage/runtime.js");
      await syncUpNow(store.slug).catch((error) => console.error(`Chat proposal ${proposalId}: could not sync its output to the bucket:`, error));
    },
  };
}

/** The stored carousel's workspace; undefined when it does not exist. The document is written at its row version (`If-Match` semantics); a stored asset has no file name, so the model sees the virtual `<assetId>.<ext>` the asset routes serve. */
export async function storedChatWorkspace(s: StoredBrand, carouselId: string): Promise<ChatWorkspace | undefined> {
  const source = await storedChatSource(s, carouselId);
  if (!source) return undefined;
  const library = createStorageAssetLibrary({ assets: s.storage.assets, blobs: s.storage.files, brandId: s.brandId, author: "editor" });
  return {
    ...source,
    assertWritable: () => assertWritable(s),
    open: async () => {
      const { result, version, rowId } = await storedCarousel(s, carouselId);
      if (!result.valid) throw new DocumentStoreError(`Stored document "${carouselId}" failed validation at "${result.errors[0]!.path}": ${result.errors[0]!.message}`);
      const document = result.document;
      const [brand, rows] = await Promise.all([storedBrandTokens(s), s.storage.assets.list(s.brandId)]);
      const template = await storedTemplate(s, document.template?.id ?? FREE_TEMPLATE_ID, document.template?.params);
      const assets = rows.map((row) => row.value);
      const catalog = assets
        .filter((a) => a.status === "approved" && a.origin !== "reference" && a.mime.startsWith("image/"))
        .map((a) => ({ id: a.assetId, name: basename(storedAssetPath(a.assetId, a.mime)), kind: a.kind, tags: a.tags, w: a.width ?? undefined, h: a.height ?? undefined }));
      return { ctx: { doc: document, template, brand, library: catalog, assetKinds: new Map(assets.map((a) => [a.assetId, a.kind])) }, base: { rowId, version } satisfies StoredToken };
    },
    validate: (document) => validateStored(s, document),
    writeDocument: async (document, base) => {
      await persistStoredDocument(s, document, base as StoredToken, "snapshot").catch((error: unknown) => { throw error instanceof VersionConflictError ? new Error(messages.saveConflict) : error; });
      return undefined;
    },
    readAsset: (assetId) => readStoredAsset(s, assetId),
    saveReference: async (mime, bytes) => {
      assertReferenceMime(mime);
      const entry = await library.register(bytes, { kind: "unclassified", origin: "reference", status: "candidate" });
      return { id: entry.id, w: entry.w, h: entry.h };
    },
    assetName: (assetId) => s.storage.assets.get(s.brandId, assetId).then((row) => basename(storedAssetPath(assetId, row.value.mime)), (error: unknown) => { if (error instanceof NotFoundError) return assetId; throw error; }),
    planner: storedPlannerSource(s),
    fonts: () => () => storedRasterFonts(s),
  };
}
