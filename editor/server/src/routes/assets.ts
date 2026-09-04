import Busboy from "busboy";
import { createHash } from "node:crypto";
import { Router } from "express";

import { computeUsage } from "../../../../system/assets/usage.js";
import {
  loadIndex,
  registerFile,
  updateEntry,
  ASSET_KINDS,
  ASSET_STATUSES,
  type AssetKind,
  type AssetStatus,
} from "../../../../system/assets/index.js";

import { ProfileStore, ProfileStoreError } from "../profile-store.js";

/**
 * Max upload size, defensive rather than product-driven — the spec doesn't
 * set a limit, but an unbounded multipart body is an easy way to wedge the
 * process. 25 MB comfortably covers any still image this editor handles.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const table: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  return table[ext] ?? "application/octet-stream";
}

export function assetsRouter(): Router {
  const router = Router();

  router.get("/api/profiles/:slug/assets", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const index = loadIndex(store.roots.profileDir);
      const usage = computeUsage(store.roots.profileDir);
      const entries = index.entries.map((entry) => ({
        ...entry,
        usageCount: usage[entry.id] ?? 0,
      }));
      res.json({ entries });
    } catch (error) {
      res.status((error instanceof ProfileStoreError && 400) || 500).json({
        error: (error as Error).message,
      });
    }
  });

  /**
   * Multipart upload, parsed with busboy directly rather than buffering the
   * whole request via `express.raw` — a small, well-scoped dependency for
   * exactly the "one file field" shape this endpoint needs (editor-api
   * spec's "Upload an asset" scenario).
   */
  router.post("/api/profiles/:slug/assets", (req, res) => {
    let store: ProfileStore;
    try {
      store = new ProfileStore(req.params.slug);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    let handled = false;
    let filename = "upload.bin";
    const chunks: Buffer[] = [];
    let tooLarge = false;

    bb.on("file", (_name, stream, info) => {
      filename = info.filename || filename;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => {
        tooLarge = true;
      });
    });

    bb.on("error", (error: Error) => {
      if (handled) return;
      handled = true;
      res.status(400).json({ error: error.message });
    });

    bb.on("close", () => {
      if (handled) return;
      handled = true;
      if (tooLarge) {
        res.status(413).json({ error: `Upload exceeds ${MAX_UPLOAD_BYTES} bytes.` });
        return;
      }
      if (chunks.length === 0) {
        res.status(400).json({ error: "No file field found in the upload." });
        return;
      }
      try {
        const buffer = Buffer.concat(chunks);
        const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
        const ext = filename.includes(".") ? "." + filename.split(".").pop() : "";
        const destRelPath = `assets/${hash}${ext}`;
        const entry = registerFile(store.roots.profileDir, buffer, {
          kind: "unclassified",
          origin: "manual",
          status: "approved",
          destRelPath,
        });
        res.status(201).json(entry);
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });

    req.pipe(bb);
  });

  router.patch("/api/profiles/:slug/assets/:assetId", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const body = req.body as { kind?: string; tags?: string[]; status?: string };
      const changes: Partial<{ kind: AssetKind; tags: string[]; status: AssetStatus }> = {};

      if (body.kind !== undefined) {
        if (!ASSET_KINDS.includes(body.kind as AssetKind)) {
          res.status(400).json({ error: `Invalid kind "${body.kind}"` });
          return;
        }
        changes.kind = body.kind as AssetKind;
      }
      if (body.status !== undefined) {
        if (!ASSET_STATUSES.includes(body.status as AssetStatus)) {
          res.status(400).json({ error: `Invalid status "${body.status}"` });
          return;
        }
        changes.status = body.status as AssetStatus;
      }
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) {
          res.status(400).json({ error: `"tags" must be a string array` });
          return;
        }
        changes.tags = body.tags;
      }

      const entry = updateEntry(store.roots.profileDir, req.params.assetId, changes);
      res.json(entry);
    } catch (error) {
      const message = (error as Error).message;
      const status = error instanceof ProfileStoreError ? 400 : /no asset with id/i.test(message) ? 404 : 500;
      res.status(status).json({ error: message });
    }
  });

  /**
   * Read-only, confined static serving of `assets/**` (editor-api spec's
   * "Asset and font serving"). `req.params.splat` is Express 5's named
   * wildcard capture for `*splat` (path-to-regexp v8 no longer allows a
   * bare `*`); `ProfileStore.readFile` re-confines it regardless, so a
   * request shaped like `../brand.json` 404s rather than ever touching disk
   * outside `assets/`.
   */
  router.get("/api/profiles/:slug/assets/files/*splat", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const wildcard = (req.params as unknown as Record<string, string | string[]>).splat;
      const relUnderAssets = Array.isArray(wildcard) ? wildcard.join("/") : String(wildcard ?? "");
      const relPath = `assets/${relUnderAssets}`;
      const buffer = store.readFile(relPath);
      res.setHeader("Content-Type", mimeFromPath(relPath));
      // Hash-based cache: the path itself never changes for the same
      // content (identity is the file's hash in the library), so this is
      // safe to cache forever from the client's perspective.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(buffer);
    } catch {
      // Never leak *why* — ENOENT vs. confinement rejection both 404, per
      // the spec's "Path outside assets" scenario: "responds 404 without
      // reading the file".
      res.status(404).end();
    }
  });

  return router;
}
