import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { assetItem } from "./asset-item.ts";
import { MAX_ASSET_TAG_CHARS, MAX_ASSET_TAGS } from "../contracts/index.ts";
import { mimeOf } from "./assets.ts";
import { listDir, readRegular, sha256, type CollectContext, type Item } from "./shared.ts";

/** A render folder of a batch: `final`, or `final-<suffix>` (`final-v2`). */
const FINAL = /^final(-.+)?$/;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];

/** A batch folder is `carousels/<id>/` made by a brand-owned tool: it has a top-level `batch.json` and no `carousel.json`. Presence decides; the file is never parsed. */
export const isBatchFolder = (folder: string): boolean => !existsSync(join(folder, "carousel.json")) && existsSync(join(folder, "batch.json"));

interface Found {
  bytes: Buffer;
  rel: string;
  tags: Set<string>;
}

/** What the batch folders hold, by asset id: the bytes, where they were first seen, and every tag the placements put on them. */
export interface BatchScan {
  found: Map<string, Found>;
  /** The tags per asset id, for the `assets/` item that owns the same bytes. */
  tags: Map<string, string[]>;
}

/**
 * Finished renders of batch folders (`carousels/<id>/{final,final-*}/*.{png,jpg,jpeg,webp}`) become hidden `unclassified`
 * manual assets tagged `batch:<id>` and `batch:<id>/<folder>`, so they are stored once and never show in the library nor
 * in a brand workspace. Reads only; `collectBatchAssets` makes the items. Files it takes are claimed in `ctx.used`, so
 * the legacy pass does not store them a second time; everything else in the folder keeps its behavior. A file that cannot
 * be tagged within the limits is reported and left unclaimed (never truncated).
 */
export function scanBatches(ctx: CollectContext): BatchScan {
  const { dir, root, blobs, skipped, used } = ctx;
  const scan: BatchScan = { found: new Map(), tags: new Map() };
  const base = join(dir, "carousels");
  // `listDir` reports an unreadable folder instead of throwing; a symlinked folder or file is not listed (the legacy pass reports it).
  for (const id of listDir(base, "carousels", skipped) ?? []) {
    const folder = join(base, id);
    if (!isBatchFolder(folder)) continue;
    for (const sub of (listDir(folder, `carousels/${id}`, skipped) ?? []).filter((n) => FINAL.test(n))) {
      const names = (listDir(join(folder, sub), `carousels/${id}/${sub}`, skipped, false) ?? []).filter((n) => IMAGE_EXT.test(n));
      for (const name of names) {
        const rel = `carousels/${id}/${sub}/${name}`;
        if (!blobs) {
          skipped.push(`${rel} (no blob store configured: nothing imported)`);
          continue;
        }
        const file = join(folder, sub, name);
        const bytes = readRegular(root, file, rel, skipped);
        if (!bytes) continue;
        if (!IMAGE_MIME.includes(mimeOf(bytes, name))) {
          skipped.push(`${rel} (not an image by content)`);
          continue;
        }
        const placement = [`batch:${id}`, `batch:${id}/${sub}`];
        const tooLong = placement.find((t) => t.length > MAX_ASSET_TAG_CHARS);
        if (tooLong) {
          skipped.push(`${rel} (batch tag longer than ${MAX_ASSET_TAG_CHARS} characters: ${tooLong.length})`);
          continue;
        }
        const assetId = sha256(bytes).slice(0, 16);
        const entry = scan.found.get(assetId) ?? { bytes, rel, tags: new Set<string>() };
        if (new Set([...entry.tags, ...placement]).size > MAX_ASSET_TAGS) {
          skipped.push(`${rel} (more than ${MAX_ASSET_TAGS} batch tags on the same content)`);
          continue;
        }
        placement.forEach((t) => entry.tags.add(t));
        const real = realpathSync(file); // once: the file's own real path
        scan.found.set(assetId, entry);
        // Both spellings: under `root` (what the legacy pass compares against) and the file's own real path (a `carousels/` that is a link inside the folder).
        used.add(join(root, rel));
        used.add(real);
      }
    }
  }
  for (const [assetId, entry] of scan.found) scan.tags.set(assetId, [...entry.tags].sort());
  return scan;
}

/** One hidden asset per distinct content not already owned by `assets/**` (`taken`: ids of the asset items already made). */
export function collectBatchAssets(ctx: CollectContext, scan: BatchScan, taken: ReadonlySet<string>): Item[] {
  return [...scan.found].filter(([id]) => !taken.has(id)).map(([id, f]) => {
    const sha = sha256(f.bytes);
    return assetItem(ctx, { id, sha, bytes: f.bytes, mime: mimeOf(f.bytes, f.rel), kind: "unclassified", origin: "manual", status: "hidden", tags: scan.tags.get(id)!, generation: null, adoptOnly: true, hashParts: [`batch-tags:${scan.tags.get(id)!.join(",")}`] });
  });
}
