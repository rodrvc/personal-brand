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

export interface BlobStore {
  get(key: string): Promise<{ body: Buffer; etag: string }>;
  getStream(key: string): Promise<{ stream: AsyncIterable<Buffer>; etag: string }>;
  head(key: string): Promise<{ etag: string; size: number; metadata: Record<string, string> }>;
  put(key: string, body: Buffer, options?: BlobPutOptions): Promise<{ etag: string }>;
  /** Every object whose key starts with `prefix`, recursively, in no particular order. */
  list(prefix: string): Promise<Array<{ key: string; etag: string; size: number }>>;
}
