// The editor re-exports these exact classes (not copies); `instanceof`
// must keep working across both packages.

/** Thrown by `BlobStore.get`/`head` when the key does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object not found: "${key}"`);
    this.name = "ObjectNotFoundError";
  }
}

/** Thrown by `BlobStore.put` when `ifMatch`/`ifNoneMatch` was not satisfied. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Precondition failed for "${key}"`);
    this.name = "PreconditionFailedError";
  }
}

/** A row write lost an optimistic-concurrency race. `currentVersion` is null when the row does not exist. */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number | null) {
    super(`Version conflict (current version: ${currentVersion ?? "none"})`);
    this.name = "VersionConflictError";
  }
}

/** A repository lookup found no row. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`Not found: ${what}`);
    this.name = "NotFoundError";
  }
}
