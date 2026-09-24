import { hashContent, loadIndex, registerFile } from "../../../../system/assets/index.js";

import { ImageToolUnavailableError, withSips } from "../image-tools.js";
import { messages } from "../messages.js";
import type { ProfileStore } from "../profile-store.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export interface ChatReference {
  id: string;
  name: string;
  role?: "layout" | "content";
}

export class ChatReferenceError extends Error {}

const HEIC_MIMES = new Set(["image/heic", "image/heif"]);
const MAX_REFERENCE_BYTES = 6 * 1024 * 1024;
const MAX_REFERENCE_SIDE = 2048;

export function normalizeReference(bytes: Buffer, mime: string): { bytes: Buffer; mime: string } {
  const heic = HEIC_MIMES.has(mime);
  if (!heic && bytes.length <= MAX_REFERENCE_BYTES) return { bytes, mime };
  try {
    const jpeg = withSips(
      bytes,
      [(input, output) => ["-s", "format", "jpeg", "-Z", String(MAX_REFERENCE_SIDE), input, "--out", output]],
      heic ? ".heic" : "",
    );
    return { bytes: jpeg, mime: "image/jpeg" };
  } catch (error) {
    if (error instanceof ImageToolUnavailableError) throw new ChatReferenceError(error.message);
    throw new ChatReferenceError(heic ? messages.heicNotConverted : messages.photoNotReduced);
  }
}

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
