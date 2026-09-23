import { hashContent } from "../../../../system/assets/index.js";

import { assertValidCarouselId } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const REFERENCE_ID = /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

export interface ChatReference {
  id: string;
  name: string;
}

export class ChatReferenceError extends Error {}

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

export function loadReferenceImages(store: ProfileStore, carouselId: string, ids: string[]): Array<{ mime: string; base64: string }> {
  return ids.map((id) => {
    if (!store.exists(referencePath(carouselId, id))) throw new ChatReferenceError(`Reference "${id}" not found`);
    const mime = Object.entries(EXTENSIONS).find(([, ext]) => id.endsWith(`.${ext}`))![0];
    return { mime, base64: store.readFile(referencePath(carouselId, id)).toString("base64") };
  });
}
