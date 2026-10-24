import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { NotFoundError, type CarouselRepository } from "@personal-brand/storage/contracts";

/** Where the carousel documents come from: a profile folder today, the `carousels` repository after cutover. */
export interface UsageSource {
  documents(): unknown[] | Promise<unknown[]>;
}

/** The profile-folder source: every `carousels/<id>/carousel.json`, skipping missing or malformed ones. */
export function folderUsageSource(profileDir: string): { documents(): unknown[] } {
  return {
    documents() {
      const carouselsDir = join(profileDir, "carousels");
      let carouselIds: string[];
      try {
        carouselIds = readdirSync(carouselsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return []; // no carousels/ directory at all: nothing to count
      }

      const documents: unknown[] = [];
      for (const carouselId of carouselIds) {
        try {
          documents.push(JSON.parse(readFileSync(join(carouselsDir, carouselId, "carousel.json"), "utf-8")));
        } catch {
          continue; // no carousel.json (yet), or a malformed one: skip rather than throw
        }
      }
      return documents;
    },
  };
}

/** The storage source: the current document of every carousel of the brand, whatever its status. The shape is not validated. */
export function storageUsageSource(carousels: CarouselRepository, brandId: string): UsageSource {
  return {
    async documents() {
      const heads = await carousels.list(brandId);
      const rows = await Promise.all(
        heads.map((head) =>
          carousels.get<unknown>(brandId, head.value.slug, (body) => body).catch((error) => {
            if (error instanceof NotFoundError) return undefined; // removed meanwhile: skipped, like a missing carousel.json
            throw error;
          }),
        ),
      );
      return rows.flatMap((row) => (row ? [row.value.document] : []));
    },
  };
}

/**
 * Usage counts are derived, never stored (see `system/config/assets.schema.md`,
 * "Usage counts are derived, never stored"). This walks every carousel
 * document a profile has and counts how many times each asset id is
 * referenced, so the count is always a pure function of what's on disk right
 * now — never a cached number that can drift from an edited carousel.
 *
 * Carousel documents may not exist yet (this ships ahead of
 * `carousel-document.ts` in tasks.md group 3), so this reads defensively: any
 * string field named "assetId" anywhere in the JSON counts as one reference,
 * without assuming a fixed document shape.
 */
export async function computeUsageFrom(source: UsageSource): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const document of await source.documents()) collectAssetIds(document, counts);
  return counts;
}

/** Folder usage, synchronous: the editor route depends on it until cutover. */
export function computeUsage(profileDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of folderUsageSource(profileDir).documents()) collectAssetIds(document, counts);
  return counts;
}

function collectAssetIds(value: unknown, counts: Record<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, counts);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key === "assetId" && typeof val === "string") {
        counts[val] = (counts[val] ?? 0) + 1;
      } else {
        collectAssetIds(val, counts);
      }
    }
  }
}
