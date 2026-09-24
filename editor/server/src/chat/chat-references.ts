import { hashContent, loadIndex } from "../../../../system/assets/index.js";

import { assertValidCarouselId } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const REFERENCE_ID = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

export interface ChatReference {
  id: string;
  name: string;
}

export class ChatReferenceError extends Error {}

/** A reference was requested from a library asset id that isn't in the profile's index. */
export class ChatReferenceAssetNotFoundError extends Error {}

/** Stored beside the carousel, outside the asset index: a reference feeds generation and never becomes library material. */
function referencePath(carouselId: string, id: string): string {
  assertValidCarouselId(carouselId);
  if (!REFERENCE_ID.test(id)) throw new ChatReferenceError(`Invalid reference id "${id}"`);
  return `carousels/${carouselId}/references/${id}`;
}

export function saveReference(store: ProfileStore, carouselId: string, mime: string, bytes: Buffer): string {
  const ext = EXTENSIONS[mime];
  if (!ext) throw new ChatReferenceError(`Unsupported reference type "${mime}"`);
  const id = `${hashContent(bytes)}.${ext}`;
  store.writeFile(referencePath(carouselId, id), bytes);
  return id;
}

/**
 * Copies a library asset's bytes into a carousel's chat references, so a
 * Bucket asset dragged into the chat becomes a reference exactly like a
 * dropped OS file — without ever touching the asset itself or its index
 * entry (design.md D3: a reference never becomes library material, and here
 * the reverse also holds — a library asset never becomes reference-only).
 */
export function referenceFromAsset(store: ProfileStore, carouselId: string, assetId: string, name?: string): ChatReference {
  const index = loadIndex(store.roots.profileDir);
  const entry = index.entries.find((e) => e.id === assetId);
  if (!entry) throw new ChatReferenceAssetNotFoundError(`No asset with id "${assetId}"`);
  const bytes = store.readFile(entry.path);
  const id = saveReference(store, carouselId, entry.mime, bytes);
  return { id, name: name ?? entry.path.split("/").pop() ?? entry.id };
}

export function loadReferenceImages(store: ProfileStore, carouselId: string, ids: string[]): Array<{ mime: string; base64: string }> {
  return ids.map((id) => {
    if (!store.exists(referencePath(carouselId, id))) throw new ChatReferenceError(`Reference "${id}" not found`);
    const mime = Object.entries(EXTENSIONS).find(([, ext]) => id.endsWith(`.${ext}`))![0];
    return { mime, base64: store.readFile(referencePath(carouselId, id)).toString("base64") };
  });
}
