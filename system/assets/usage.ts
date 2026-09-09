import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
export function computeUsage(profileDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const carouselsDir = join(profileDir, "carousels");

  let carouselIds: string[];
  try {
    carouselIds = readdirSync(carouselsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return counts; // no carousels/ directory at all: nothing to count
  }

  for (const carouselId of carouselIds) {
    const docPath = join(carouselsDir, carouselId, "carousel.json");
    let raw: string;
    try {
      raw = readFileSync(docPath, "utf-8");
    } catch {
      continue; // this carousel has no carousel.json (yet)
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed document: skip rather than throw
    }

    collectAssetIds(parsed, counts);
  }

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
