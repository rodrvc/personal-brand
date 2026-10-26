import { BrandArchivedError, InvalidInputError, NotFoundError, VersionConflictError } from "@personal-brand/storage/contracts";

import { DocumentStoreError } from "../document-store.js";
import { messages } from "../messages.js";
import { ProfileStoreError } from "../profile-store.js";
import { etagOf, StorageFailure } from "../stored-read.js";

/**
 * Turns a rejected path or id into a 400, everything else into a 404/500 as
 * appropriate. Every route below funnels its try/catch through this.
 * `DocumentStoreError` covers the non-slug `carousel-id` case, which
 * specs/carousel-document ("Confined writes") requires to answer 400 — not
 * the 500 an unclassified throw would produce.
 */
export function handleStoreError(error: unknown, res: import("express").Response): void {
  if (error instanceof ProfileStoreError || error instanceof DocumentStoreError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof VersionConflictError) {
    // A conflict that escaped the save route's own handling (the save answers it with the document too): the version, as body and `ETag`.
    if (error.currentVersion !== null) res.setHeader("ETag", etagOf(error.currentVersion));
    return void res.status(409).json({ error: messages.saveConflict, currentVersion: error.currentVersion });
  }
  if (error instanceof InvalidInputError) return void res.status(400).json({ error: error.message });
  if (error instanceof BrandArchivedError) return void res.status(403).json({ error: messages.storedArchivedAny });
  if (error instanceof StorageFailure) {
    // Includes a validator that threw on a corrupt stored document: one answer for every storage-side failure.
    console.error("Storage read failed:", error.cause);
    res.status(503).json({ error: messages.storageUnavailable });
    return;
  }
  const message = (error as Error)?.message ?? String(error);
  if (/ENOENT|no such file/i.test(message)) {
    res.status(404).json({ error: message });
    return;
  }
  res.status(500).json({ error: message });
}
