import { hashContent, loadIndex, registerFile } from "../../../../system/assets/index.js";

import type { ProfileStore } from "../profile-store.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export interface ChatReference {
  id: string;
  name: string;
}

export class ChatReferenceError extends Error {}

/** Registered as a reference asset: indexed so generation can resolve it by id, kept out of the library. */
export function saveReference(store: ProfileStore, mime: string, bytes: Buffer): string {
  const ext = EXTENSIONS[mime];
  if (!ext) throw new ChatReferenceError(`Unsupported reference type "${mime}"`);
  return registerFile(store.roots.profileDir, bytes, {
    kind: "unclassified",
    origin: "reference",
    status: "candidate",
    destRelPath: `assets/references/${hashContent(bytes)}.${ext}`,
  }).id;
}

export function readAssetFile(store: ProfileStore, assetId: string): { bytes: Buffer; mime: string } | undefined {
  const entry = loadIndex(store.roots.profileDir).entries.find((e) => e.id === assetId);
  if (!entry || !store.exists(entry.path)) return undefined;
  return { bytes: store.readFile(entry.path), mime: entry.mime };
}

export function loadReferenceImages(store: ProfileStore, ids: string[]): Array<{ mime: string; base64: string }> {
  return ids.map((id) => {
    const file = readAssetFile(store, id);
    if (!file || !EXTENSIONS[file.mime]) throw new ChatReferenceError(`Reference "${id}" is not an image in this profile`);
    return { mime: file.mime, base64: file.bytes.toString("base64") };
  });
}
