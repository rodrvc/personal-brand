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

/**
 * A row write lost an optimistic-concurrency race. `currentVersion` is null when the row does not exist.
 * HTTP mapping: a missing brand is `NotFoundError` (404); a document put with an `expectedVersion` for a
 * document that does not exist is `VersionConflictError(null)` (409).
 */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number | null) {
    super(`Version conflict (current version: ${currentVersion ?? "none"})`);
    this.name = "VersionConflictError";
  }
}

/** A repository lookup found no row. */
export class NotFoundError extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`Not found: ${what}`, options);
    this.name = "NotFoundError";
  }
}

/** A create hit an existing slug or document key; `currentVersion` is the existing row's version. */
export class AlreadyExistsError extends VersionConflictError {
  constructor(what: string, currentVersion: number) {
    super(currentVersion);
    this.name = "AlreadyExistsError";
    this.message = `Already exists: ${what} (current version: ${currentVersion})`;
  }
}

/** Input rejected before reaching storage (bad slug, malformed body envelope). */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** A content write reached an archived brand; archived brands take no content writes (design §8). */
export class BrandArchivedError extends Error {
  constructor(what: string) {
    super(`Brand ${what} is archived`);
    this.name = "BrandArchivedError";
  }
}

/** The purge refused before deleting anything (wrong database role, not local, changed since the bundle). The message is user-facing Spanish. */
export class PurgeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurgeRefusedError";
  }
}
