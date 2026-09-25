/**
 * The storage seam behind the profile bucket (issue #99). Every backend that
 * can hold a profile's files — the local filesystem today, an S3-compatible
 * bucket tomorrow — implements this interface so the rest of the editor
 * never branches on which one is active.
 *
 * Keys are always POSIX-style relative paths ("<slug>/brand.json",
 * "<slug>/_outputs/carousels/x/v1/01.png"), never absolute paths and never
 * backend-specific (no leading slash, no bucket name baked in).
 */

export interface GetResult {
  body: Buffer;
  etag: string;
}

export interface HeadResult {
  etag: string;
  size: number;
  /** Backend-defined key/value metadata stored alongside the object (e.g. a content hash set by the migration script). Empty object when none was set. */
  metadata: Record<string, string>;
}

export interface ListedObject {
  key: string;
  etag: string;
  size: number;
}

export interface PutOptions {
  /** Succeed only if the object's current etag equals this value. */
  ifMatch?: string;
  /** Succeed only if the object does not exist yet. The only supported value is "*". */
  ifNoneMatch?: "*";
  contentType?: string;
  /** Backend-defined key/value metadata to store alongside the object. */
  metadata?: Record<string, string>;
}

export interface PutResult {
  etag: string;
}

/** Thrown by `get`/`head` when the key does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: "${key}"`);
    this.name = "ObjectNotFoundError";
  }
}

/**
 * Thrown by `put` when `ifMatch`/`ifNoneMatch` was not satisfied — the
 * caller lost a race with another writer and must re-read and retry (or, for
 * the carousel stale-revision check, surface a 409 to the client).
 */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Precondition failed for "${key}"`);
    this.name = "PreconditionFailedError";
  }
}

export interface ObjectStore {
  get(key: string): Promise<GetResult>;
  head(key: string): Promise<HeadResult>;
  put(key: string, body: Buffer, options?: PutOptions): Promise<PutResult>;
  /** Lists every object whose key starts with `prefix`, recursively, in no particular order. */
  list(prefix: string): Promise<ListedObject[]>;
}
