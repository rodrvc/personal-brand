import { NotFoundError, VersionConflictError } from "@personal-brand/storage/contracts";

import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import type { EditorStorage, StoredBrand } from "./stored-read.js";

/** The assets the document pins: a slide background in `asset` mode, or an `asset` object, with `pinned` set. */
export function pinnedAssetIds(doc: CarouselDocument): Set<string> {
  const ids = new Set<string>();
  for (const slide of doc.slides) {
    if (slide.background.mode === "asset" && slide.background.pinned) ids.add(slide.background.assetId);
    for (const object of slide.objects) if (object.kind === "asset" && object.pinned && object.assetId) ids.add(object.assetId);
  }
  return ids;
}

/**
 * Moves the `candidate` assets among `ids` to `approved` (a status change audited as `author`). With a `library` listing the
 * caller already holds (its versions can be stale) nothing else is read; without one each id is read on its own, so a save
 * costs a read per pinned piece, not a listing of the whole library. A row changed meanwhile is re-read and retried once, one that
 * is no longer a candidate is left alone, an id that is not in the library is skipped. One failing asset does not stop the
 * others: every failure is collected and thrown together at the end, so an approval can be partial.
 */
export async function approveCandidates(s: StoredBrand, ids: Set<string>, author: string, library?: Awaited<ReturnType<EditorStorage["assets"]["list"]>>): Promise<void> {
  const known = library && new Map(library.map((row) => [row.value.assetId, row]));
  const errors: unknown[] = [];
  for (const id of ids) {
    try {
      const row = known ? known.get(id) : await s.storage.assets.get(s.brandId, id).catch((error: unknown) => { if (error instanceof NotFoundError) return undefined; throw error; });
      if (row?.value.status !== "candidate") continue;
      const approve = (expectedVersion: number) => s.storage.assets.update(s.brandId, id, { status: "approved" }, { expectedVersion, author, source: "editor", reason: "status" });
      try {
        await approve(row.version);
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        const fresh = await s.storage.assets.get(s.brandId, id);
        if (fresh.value.status === "candidate") await approve(fresh.version);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `Approving ${errors.length} of ${ids.size} asset(s) failed: ${errors.map((e) => e instanceof Error ? e.message : String(e)).join("; ")}`);
}
