import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { BlobStore } from "../contracts/blob-store.ts";
import { blobKey } from "../contracts/keys.ts";

/** `BLOB_CACHE_DIR`, else `~/.cache/personal-brand/blobs`. */
export function defaultBlobCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOB_CACHE_DIR || join(homedir(), ".cache", "personal-brand", "blobs");
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The store returned bytes that do not hash to the key they were asked for. */
export class BlobHashMismatchError extends Error {}

/**
 * Read-only, disposable local copy of content-addressed blobs
 * (`<dir>/sha256/<hh>/<sha256>`). It only ever reads from the store, never
 * uploads, and `rm -rf` of the directory is always safe. No size cap yet.
 *
 * The cache is shared across brands by sha256 (design section 6), so a hit
 * does not prove that this brand's store holds the blob; that is intended.
 * Entries are verified once, on fill, and are 0444 afterwards, so a hit is
 * only a `stat`. Use `verify` to re-hash and repair a suspect entry.
 */
export class BlobCache {
  constructor(
    private readonly store: BlobStore,
    private readonly brandId: string,
    private readonly dir: string = defaultBlobCacheDir(),
  ) {}

  pathFor(sha256: string): string {
    blobKey(this.brandId, sha256); // validates the hash and brand id
    return join(this.dir, "sha256", sha256.slice(0, 2), sha256);
  }

  /** Local path of the blob, fetching and verifying it from the store on a miss. */
  async read(sha256: string): Promise<string> {
    const path = this.pathFor(sha256);
    if (await stat(path).then(() => true, () => false)) return path;
    return this.fill(sha256, path);
  }

  /** Like `read`, but re-hashes a cached file and refetches it when it does not match. */
  async verify(sha256: string): Promise<string> {
    const path = this.pathFor(sha256);
    if ((await sha256OfFile(path).catch(() => "")) === sha256) return path;
    await chmod(path, 0o644).catch(() => undefined); // Windows cannot rename over a read-only file
    return this.fill(sha256, path);
  }

  private async fill(sha256: string, path: string): Promise<string> {
    const { stream } = await this.store.getStream(blobKey(this.brandId, sha256));
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const hash = createHash("sha256");
      const hashing = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      // pipeline closes both ends on any error, so no descriptor leaks and no uncaught write error.
      await pipeline(stream, hashing, createWriteStream(temp));
      const actual = hash.digest("hex");
      if (actual !== sha256) throw new BlobHashMismatchError(`Blob hash mismatch for ${sha256}: store returned ${actual}`);
      await chmod(temp, 0o444);
      await rename(temp, path); // atomic; concurrent fills write identical bytes
    } finally {
      await rm(temp, { force: true });
    }
    return path;
  }
}
