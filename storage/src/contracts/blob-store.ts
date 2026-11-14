/**
 * Files by key. Mirrors the editor's existing `ObjectStore` shape; there is
 * deliberately no `delete` (the application credentials cannot delete).
 * Keys are POSIX-style relative paths built with `keys.ts`.
 */
export interface BlobPutOptions {
  /** Succeed only if the object's current etag equals this value. */
  ifMatch?: string;
  /** Succeed only if the object does not exist yet. */
  ifNoneMatch?: "*";
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface BlobGetResult {
  body: Buffer;
  etag: string;
}
export interface BlobStreamResult {
  stream: AsyncIterable<Buffer>;
  etag: string;
}
export interface BlobHeadResult {
  etag: string;
  size: number;
  metadata: Record<string, string>;
}
export interface BlobListEntry {
  key: string;
  etag: string;
  size: number;
}
export interface BlobPutResult {
  etag: string;
}

export interface BlobStore {
  get(key: string): Promise<BlobGetResult>;
  getStream(key: string): Promise<BlobStreamResult>;
  head(key: string): Promise<BlobHeadResult>;
  put(key: string, body: Buffer, options?: BlobPutOptions): Promise<BlobPutResult>;
  /** Every object whose key starts with `prefix`, recursively, in no particular order. */
  list(prefix: string): Promise<BlobListEntry[]>;
}
