import { createHash } from "node:crypto";

import type { BlobStore } from "../contracts/blob-store.ts";
import { ObjectNotFoundError, PreconditionFailedError } from "../contracts/errors.ts";
import { blobKey } from "../contracts/keys.ts";

export interface PutBlobResult {
  sha256: string;
  key: string;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 50;

/**
 * Content-addressed write: the key is derived from the bytes, so writing the
 * same bytes twice is a no-op (`If-None-Match: *` loses the race harmlessly).
 * If the key already exists, its `sha256` metadata must match; anything else
 * means the store holds different bytes under a hash-derived key and is an error.
 *
 * On AWS a concurrent conditional PUT can be rejected while the winning write
 * is not yet visible to `head`; that case retries the put a couple of times.
 */
export async function putBlob(store: BlobStore, brandId: string, bytes: Buffer, mime?: string): Promise<PutBlobResult> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = blobKey(brandId, sha256);
  for (let attempt = 1; ; attempt++) {
    try {
      await store.put(key, bytes, { ifNoneMatch: "*", contentType: mime, metadata: { sha256 } });
      return { sha256, key };
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
    }
    try {
      const existing = await store.head(key);
      if (existing.metadata.sha256 !== sha256 || existing.size !== bytes.byteLength) {
        throw new Error(`Blob "${key}" already exists with different content`);
      }
      return { sha256, key };
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`putBlob: conditional put rejected but "${key}" never became visible`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}
