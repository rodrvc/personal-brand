import { createHash } from "node:crypto";

import {
  ObjectNotFoundError,
  PreconditionFailedError,
  type GetResult,
  type HeadResult,
  type ListedObject,
  type ObjectStore,
  type PutOptions,
  type PutResult,
} from "./object-store.js";

function etagOf(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * In-memory `ObjectStore` with real conditional-write semantics, for unit
 * tests that need to exercise `ifMatch`/`ifNoneMatch` races without a real
 * bucket. Never used outside tests.
 */
export class FakeObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Buffer; etag: string; metadata: Record<string, string> }>();

  async get(key: string): Promise<GetResult> {
    const entry = this.objects.get(key);
    if (!entry) throw new ObjectNotFoundError(key);
    return { body: Buffer.from(entry.body), etag: entry.etag };
  }

  async head(key: string): Promise<HeadResult> {
    const entry = this.objects.get(key);
    if (!entry) throw new ObjectNotFoundError(key);
    return { etag: entry.etag, size: entry.body.byteLength, metadata: { ...entry.metadata } };
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<PutResult> {
    const existing = this.objects.get(key);

    if (options?.ifNoneMatch === "*" && existing) {
      throw new PreconditionFailedError(key);
    }
    if (options?.ifMatch !== undefined && (!existing || existing.etag !== options.ifMatch)) {
      throw new PreconditionFailedError(key);
    }

    const copy = Buffer.from(body);
    const etag = etagOf(copy);
    this.objects.set(key, { body: copy, etag, metadata: { ...options?.metadata } });
    return { etag };
  }

  async list(prefix: string): Promise<ListedObject[]> {
    const results: ListedObject[] = [];
    for (const [key, entry] of this.objects) {
      if (key.startsWith(prefix)) {
        results.push({ key, etag: entry.etag, size: entry.body.byteLength });
      }
    }
    return results;
  }

  /** Test helper: true count of stored objects, for assertions unrelated to a prefix. */
  size(): number {
    return this.objects.size;
  }
}
