import { tmpdir } from "node:os";
import { join } from "node:path";

import { S3ObjectStore } from "./s3-object-store.js";
import type { ObjectStore } from "./object-store.js";

export type StorageBackend = "fs" | "s3";

export interface S3StorageConfig {
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  forcePathStyle: boolean;
  /** Lower-cased filename extensions (with the leading dot) `syncDown` excludes from eager hydration everywhere else large media can appear — a resolved export's rendered media under `_outputs/`, or a stray image/video outside both profile-area prefix lists below. Falls back to `mirror.ts`'s `DEFAULT_LAZY_MEDIA_EXTENSIONS` when unset. */
  lazyMediaExtensions?: string[];
  /** Profile-relative path prefixes always excluded from eager hydration, whatever the extension — a profile's own `outputs/`/`reels/` tree. Falls back to `mirror.ts`'s `DEFAULT_LAZY_PROFILE_PREFIXES` when unset. */
  lazyProfilePrefixes?: string[];
  /** Profile-relative path prefixes always hydrated eagerly, whatever the extension — content `ProfileStore` reads back synchronously on every request. Falls back to `mirror.ts`'s `DEFAULT_EAGER_PROFILE_PREFIXES` when unset. */
  eagerProfilePrefixes?: string[];
}

export interface StorageConfig {
  backend: StorageBackend;
  s3?: S3StorageConfig;
  cacheDir: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== "false" && value !== "0";
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Reads the storage backend selection and (when `s3`) its bucket
 * configuration from `process.env`. `fs` is the default so an unconfigured
 * clone keeps today's behaviour byte-for-byte.
 *
 * `S3_PREFIX` defaults to `"profiles/"` — every key this module hands out is
 * `<prefix><slug>/...` for a profile file or `<prefix><slug>/_outputs/...`
 * for its resolved outputs root.
 */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const backend: StorageBackend = env.STORAGE_BACKEND === "s3" ? "s3" : "fs";
  const cacheDir = env.PROFILE_CACHE_DIR || join(tmpdir(), "personal-brand-profile-cache");

  if (backend !== "s3") {
    return { backend, cacheDir };
  }

  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "STORAGE_BACKEND=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to be set.",
    );
  }

  return {
    backend,
    cacheDir,
    s3: {
      endpoint: env.S3_ENDPOINT,
      bucket,
      region: env.S3_REGION || "us-east-1",
      accessKeyId,
      secretAccessKey,
      prefix: env.S3_PREFIX ?? "profiles/",
      forcePathStyle: parseBool(env.S3_FORCE_PATH_STYLE, true),
      lazyMediaExtensions: parseList(env.S3_MIRROR_LAZY_MEDIA_EXTENSIONS)?.map((ext) => ext.toLowerCase()),
      lazyProfilePrefixes: parseList(env.S3_MIRROR_LAZY_PROFILE_PREFIXES),
      eagerProfilePrefixes: parseList(env.S3_MIRROR_EAGER_PROFILE_PREFIXES),
    },
  };
}

/** Builds the `ObjectStore` for a resolved `s3` config. Throws for `fs` — the fs backend has no object store, it uses the filesystem directly. */
export function createObjectStore(config: StorageConfig): ObjectStore {
  if (config.backend !== "s3" || !config.s3) {
    throw new Error("createObjectStore requires an s3 StorageConfig.");
  }
  return new S3ObjectStore({
    bucket: config.s3.bucket,
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
    forcePathStyle: config.s3.forcePathStyle,
  });
}
