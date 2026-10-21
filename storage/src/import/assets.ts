import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { putBlob } from "../blob/put-blob.ts";
import { blobKey, InvalidInputError, ObjectNotFoundError, type AssetKind, type AssetOrigin, type AssetStatus, type BlobStore } from "../contracts/index.ts";
import { canon, found, readRegular, sha256, type CollectContext, type Item } from "./shared.ts";

const KINDS: AssetKind[] = ["background", "character", "photo", "logo", "decoration", "font", "unclassified"];
const STATUSES: AssetStatus[] = ["candidate", "approved", "hidden"];
const FONT_EXT = [".woff2", ".woff", ".ttf", ".otf"];
const MIME_BY_EXT: Record<string, string> = { ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml" };

/** The file's own bytes decide PNG / JPEG / WebP (never the extension); everything else falls back to the extension. */
function mimeOf(bytes: Buffer, rel: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return MIME_BY_EXT[extname(rel).toLowerCase()] ?? "application/octet-stream";
}

/** Every path under `dir` (relative, `/`-separated, sorted); symlinks are listed as files so the reader reports them. */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
}

const asObject = (raw: Buffer | null): Record<string, unknown> | null => {
  try {
    const v = raw && JSON.parse(raw.toString("utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null; // a malformed sidecar counts as absent: the file it describes is still imported
  }
};

/**
 * `assets/**` becomes blobs (through `putBlob`, content-addressed) plus one `assets` row per distinct content, keyed by
 * the first 16 hex of its sha256 exactly as today. `index.json` is a rebuildable cache, so it is not imported: the
 * classification is rebuilt the way the folder library's own scan does it (generated and reference folders, font
 * sidecars, then the `meta/<id>.json` choice of the user), and only its `w`/`h` are borrowed when it has them.
 * Same bytes at two paths are one asset (the first path wins, the other is reported). Without a blob store nothing
 * is imported and the folder is reported, so it can never be mistaken for imported.
 */
export function collectAssets(ctx: CollectContext): Item[] {
  const { dir, root, repos, blobs, skipped, handled } = ctx;
  const base = join(dir, "assets");
  if (!existsSync(base)) return [];
  handled.add("assets");
  const files = walk(base);
  const read = (rel: string, expected = false) => readRegular(root, join(base, rel), `assets/${rel}`, skipped, expected);
  // `index.json` is a cache the editor rewrites: a malformed or wrongly-shaped one is ignored (and reported), never fatal.
  const rawIndex = read("index.json");
  const entries = asObject(rawIndex)?.entries;
  if (rawIndex && !Array.isArray(entries)) skipped.push("assets/index.json (unreadable cache: ignored)");
  const dims = new Map<unknown, Record<string, unknown>>();
  for (const e of Array.isArray(entries) ? entries : []) if (e && typeof e === "object" && !Array.isArray(e)) dims.set((e as Record<string, unknown>).id, e as Record<string, unknown>);
  const bookkeeping = (rel: string) => rel === "index.json" || /^(meta|generated)\/[^/]+\.json$/.test(rel) || rel.endsWith(".meta.json");
  const assetFiles = files.filter((rel) => !bookkeeping(rel) && !rel.endsWith(".json"));
  for (const rel of files.filter((r) => r.endsWith(".json") && !bookkeeping(r))) skipped.push(`assets/${rel} (not an asset: unrecognised .json file)`);
  if (assetFiles.length && !blobs) {
    skipped.push("assets (no blob store configured: nothing imported)");
    return [];
  }
  const items: Item[] = [];
  const firstPath = new Map<string, string>();
  for (const rel of assetFiles) {
    const bytes = read(rel);
    if (!bytes) continue;
    const sha = sha256(bytes);
    const id = sha.slice(0, 16);
    if (firstPath.has(id)) {
      skipped.push(`assets/${rel} (same content as assets/${firstPath.get(id)})`);
      continue;
    }
    firstPath.set(id, rel);
    const dirs = rel.split("/").slice(0, -1);
    // The folder library's own rules: either folder anywhere in the path counts, and a reference wins over generated.
    const reference = dirs.includes("references");
    const generated = dirs.includes("generated") && !reference;
    const isFont = FONT_EXT.includes(extname(rel).toLowerCase());
    const raws = {
      generation: generated ? read(`generated/${id}.json`) : null,
      font: isFont ? read(`${rel.slice(0, -extname(rel).length)}.meta.json`) : null,
      user: read(`meta/${id}.json`),
    };
    const user = asObject(raws.user);
    // A sidecar without a usable family falls back to the file name, like a missing one.
    const sidecarFamily = asObject(raws.font)?.family;
    const family = isFont ? (typeof sidecarFamily === "string" && sidecarFamily ? sidecarFamily : basename(rel, extname(rel)).split(/[-_]/)[0] || undefined) : undefined;
    const kind = KINDS.includes(user?.kind as AssetKind) ? (user!.kind as AssetKind) : isFont ? "font" : "unclassified";
    const candidate = generated || reference;
    const origin: AssetOrigin = reference ? "reference" : generated ? "ai" : "manual";
    const status = STATUSES.includes(user?.status as AssetStatus) ? (user!.status as AssetStatus) : candidate ? "candidate" : "approved";
    const tags = Array.isArray(user?.tags) && user!.tags.every((t) => typeof t === "string") ? (user!.tags as string[]) : [];
    const size = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
    const [width, height] = [size(dims.get(id)?.w), size(dims.get(id)?.h)];
    const mime = mimeOf(bytes, rel);
    const generation = asObject(raws.generation);
    // width/height are best-effort: filled from the cache at registration only, never compared afterwards (not in the
    // payload, the item hash or the update check), so cache drift can neither conflict nor dirty verification.
    const row = { sha256: sha, kind, mime, bytes: bytes.length, origin, status, tags, family: family ?? null, generation };
    items.push({
      key: `asset:${id}`, entityType: "brand_asset",
      hash: sha256([sha, ...Object.values(raws).map((r) => (r ? sha256(r) : ""))].join("\n")),
      payload: row,
      read: async (brandId) => {
        const a = await found(repos.assets.get(brandId, id));
        return a && { id: a.id, version: a.version, value: { sha256: a.value.sha256, kind: a.value.kind, mime: a.value.mime, bytes: a.value.bytes, origin: a.value.origin, status: a.value.status, tags: a.value.tags, family: a.value.family, generation: a.value.generation } };
      },
      write: async (brandId, expectedVersion, meta) => {
        if (expectedVersion !== null) {
          // Only what a user can reclassify moves (keep this list in step with `AssetPatch`, contracts/repositories.ts).
          // Everything else is fixed at registration, so a difference is reported instead of stored: the item hash would
          // otherwise move without the row and verification would stay dirty. That includes `origin` and `mime`: moving
          // a file into references/ or generated/, or renaming its extension, is a conflict by design.
          const current = (await repos.assets.get(brandId, id)).value as unknown as Record<string, unknown>;
          const fixed: Record<string, unknown> = { sha256: sha, mime, bytes: bytes.length, origin, generation };
          const changed = [...Object.keys(fixed).filter((k) => canon(current[k] ?? null) !== canon(fixed[k] ?? null)), ...(current.family && !family ? ["family"] : [])];
          if (changed.length) throw new InvalidInputError(`asset ${id}: ${changed.join(", ")} changed in the folder; registered fields cannot be updated`);
          return repos.assets.update(brandId, id, { kind, tags, status, ...(family ? { family } : {}) }, { ...meta, expectedVersion });
        }
        await putBlob(blobs as BlobStore, brandId, bytes, mime);
        return repos.assets.register(brandId, { sha256: sha, kind, mime, bytes: bytes.length, origin, status, tags, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(family ? { family } : {}), ...(generation ? { generation } : {}) }, { ...meta, expectedVersion: null });
      },
      // The blob is re-downloaded and hashed: a row pointing at a missing or different object is not a clean import.
      verifyBlobs: async (brandId) => {
        try {
          return sha256((await (blobs as BlobStore).get(blobKey(brandId, sha))).body) === sha;
        } catch (error) {
          if (error instanceof ObjectNotFoundError) return false;
          throw error;
        }
      },
    });
  }
  // A sidecar whose asset is not in the folder describes nothing; it is reported, never imported.
  for (const rel of files) {
    const m = /^(meta|generated)\/([^/]+)\.json$/.exec(rel);
    if (m && !firstPath.has(m[2])) skipped.push(`assets/${rel} (sidecar without an asset)`);
  }
  return items;
}
