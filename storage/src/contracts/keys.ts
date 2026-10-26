/**
 * The only place bucket keys are built. Ids are row UUIDs, never slugs, so
 * renaming a slug moves no objects.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function uuid(label: string, value: string): string {
  if (!UUID.test(value)) throw new Error(`Invalid ${label}: "${value}"`);
  return value;
}

/** The prefix of every object a brand owns in the bucket (ends with `/`). */
export function brandPrefix(brandId: string): string {
  return `brands/${uuid("brandId", brandId)}/`;
}

/**
 * The legacy (pre-storage) layout: where the editor kept one profile in a bucket, `<prefix><slug>/` (ends with `/`). The prefix is joined
 * AS TYPED, never normalized: a prefix without a trailing `/` is a different key space, and the editor's objects live under exactly that.
 */
export function legacyProfileBase(prefix: string, slug: string): string {
  return `${prefix}${slug}/`;
}

export function blobKey(brandId: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error(`Invalid sha256: "${sha256}"`);
  return `brands/${uuid("brandId", brandId)}/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

function version(n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid version: ${n}`);
  return `v${String(n).padStart(3, "0")}`;
}

/** The prefix shared by every file of one carousel export version (ends with `/`). */
export function carouselExportPrefix(brandId: string, carouselId: string, versionNo: number): string {
  return `brands/${uuid("brandId", brandId)}/exports/carousels/${uuid("carouselId", carouselId)}/${version(versionNo)}/`;
}

export function carouselExportKey(brandId: string, carouselId: string, versionNo: number, file: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file === "." || file === "..") throw new Error(`Invalid file name: "${file}"`);
  return `brands/${uuid("brandId", brandId)}/exports/carousels/${uuid("carouselId", carouselId)}/${version(versionNo)}/${file}`;
}

export function reelExportKey(brandId: string, runId: string, versionNo: number): string {
  return `brands/${uuid("brandId", brandId)}/exports/reels/${uuid("runId", runId)}/${version(versionNo)}/reel.mp4`;
}

/** The prefix shared by every export version of one reel run (ends with `/`). */
export function reelExportPrefix(brandId: string, runId: string): string {
  return `brands/${uuid("brandId", brandId)}/exports/reels/${uuid("runId", runId)}/`;
}
