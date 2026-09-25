import { join } from "node:path";

import { createObjectStore, loadStorageConfig, type StorageConfig } from "./config.js";
import type { ObjectStore } from "./object-store.js";
import { hydrateIfStale, syncUp } from "./mirror.js";

/**
 * Process-wide storage state (issue #99): which backend is active, and — in
 * `s3` mode — the bucket client every mirror operation goes through. Reads
 * `process.env` once at startup rather than per-call so a mid-process env
 * mutation (tests aside) can't flip the backend under a request in flight.
 */
export interface StorageRuntime {
  config: StorageConfig;
  store?: ObjectStore;
}

let runtime: StorageRuntime | undefined;

/**
 * Call once at server startup, after `.env` is loaded and before any
 * `ProfileStore` is constructed. In `s3` mode this also points
 * `BRAND_PROFILES_DIR`/`BRAND_OUTPUTS_ROOT` at the local mirror root, so
 * every existing path-based reader (`ProfileStore`, `system/ig-carousel`,
 * `system/assets`) keeps working unmodified against the mirror instead of
 * the real profile tree.
 */
export function initStorageRuntime(env: NodeJS.ProcessEnv = process.env): StorageRuntime {
  const config = loadStorageConfig(env);
  const store = config.backend === "s3" ? createObjectStore(config) : undefined;

  if (config.backend === "s3" && config.s3) {
    const bucketRoot = join(config.cacheDir, config.s3.bucket);
    env.BRAND_PROFILES_DIR = join(bucketRoot, "profiles");
    env.BRAND_OUTPUTS_ROOT = join(bucketRoot, "outputs");
  }

  runtime = { config, store };
  return runtime;
}

/**
 * Returns the process-wide runtime, initializing it from `process.env` on
 * first use if `initStorageRuntime` was never called explicitly (every test
 * file that never touches storage, and any future caller that forgets the
 * explicit call at startup) — falling back to `fs` mode rather than
 * throwing, matching `loadStorageConfig`'s own unconfigured default.
 */
export function getStorageRuntime(): StorageRuntime {
  if (!runtime) {
    return initStorageRuntime();
  }
  return runtime;
}

/** Test-only: clears the process-wide runtime so a test can call `initStorageRuntime` again with a different env. */
export function resetStorageRuntimeForTests(): void {
  runtime = undefined;
}

const SLUG_FROM_PATH = /^\/api\/profiles\/([a-z0-9-]+)(?:\/|$)/;

/** Extracts the profile slug from an `/api/profiles/:slug/...` request path, before Express has matched a route (used by the hydrate/sync-up middleware, which is mounted ahead of every router). */
export function slugFromRequestPath(path: string): string | undefined {
  return SLUG_FROM_PATH.exec(path)?.[1];
}

/**
 * Express middleware: in `s3` mode, hydrates the request's profile mirror
 * before the route handler runs (TTL-limited — see `hydrateIfStale`), and
 * uploads whatever changed in the mirror after the response finishes,
 * regardless of whether the write went through `ProfileStore` or bypassed it
 * (the asset index, Playwright's export PNGs). A no-op entirely in `fs` mode.
 */
export function storageSyncMiddleware() {
  return (req: { path: string; method: string }, res: { on: (event: "finish", cb: () => void) => void }, next: (err?: unknown) => void) => {
    const { config, store } = getStorageRuntime();
    if (config.backend !== "s3" || !store || !config.s3) {
      next();
      return;
    }

    const slug = slugFromRequestPath(req.path);
    if (!slug) {
      next();
      return;
    }

    const s3Config = config.s3;
    const cacheDir = config.cacheDir;

    hydrateIfStale(store, s3Config, cacheDir, slug)
      .then(() => next())
      .catch((error) => next(error));

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.on("finish", () => {
        syncUp(store, s3Config, cacheDir, slug).catch((error) => {
          console.error(`storage sync-up failed for profile "${slug}":`, error);
        });
      });
    }
  };
}
