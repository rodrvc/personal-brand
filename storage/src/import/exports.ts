import { join } from "node:path";

import { putAt } from "../blob/put-blob.ts";
import { carouselExportKey, InvalidInputError, ObjectNotFoundError, type BlobStore } from "../contracts/index.ts";
import { contentRefusal, nameRefusal } from "./allowlist.ts";
import { OUTPUTS_LABEL } from "./outputs.ts";
import { found, listDir, readRegular, rereadChecked, sha256, type CollectContext, type Item } from "./shared.ts";

const identity = (b: unknown) => b;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", json: "application/json", pdf: "application/pdf" };
const VERSION = /^v([1-9]\d*)$/;

/**
 * The editor's exports, `<outputs.editor>/<carousel-slug>/v<N>/` with a `manifest.json`: one `exports` row per version
 * (`version_no = N`, `done`, manifest stored) whose files go under the carousel export key. Versions are taken in numeric order
 * (`v2` before `v10`), because each one reserves the next number. Exports are not revisioned and never rewritten: a stored
 * version that differs from the folder is a conflict. A version without a manifest, the `.reserved` markers, files with names
 * a key cannot carry, files the allowlist refuses (secrets, guesses, unknown types; a refused manifest leaves the whole version), and
 * exports of a carousel the folder does not have are left to the legacy pass. Versions below N that the
 * folder lacks are reserved and marked failed so that N keeps its number. A version reserved but never completed (an interrupted pass)
 * is completed by the next one.
 */
export function collectExports(ctx: CollectContext): Item[] {
  const { outputs, repos, blobs, used, skipped, carousels } = ctx;
  if (!outputs || !blobs) return [];
  const base = join(outputs.real, outputs.editor);
  const label = (...parts: string[]) => `${OUTPUTS_LABEL}${[outputs.editor, ...parts].join("/")}`;
  const items: Item[] = [];
  const entries = (path: string, rel: string, ofDirs = true) => listDir(path, rel, skipped, ofDirs);
  for (const slug of (entries(base, label()) ?? []).filter((s) => carousels.has(s))) {
    const versions = (entries(join(base, slug), label(slug)) ?? []).filter((v) => VERSION.test(v)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    for (const version of versions) {
      const no = Number(version.slice(1));
      const vdir = join(base, slug, version);
      const scratch: string[] = [];
      // Only allowlisted, non-secret files are claimed, judged on the very bytes that were hashed (the same policy as the legacy
      // pass). A refused or unknown file is left unclaimed, so the legacy pass reports it under its own class. Only the hash of each
      // file is held: the bytes are read again, one file at a time, when it is uploaded.
      const read: { manifest?: Buffer } = {};
      const files = (entries(vdir, label(slug, version), false) ?? []).filter((name) => name !== ".reserved" && /^[A-Za-z0-9._-]+$/.test(name))
        .flatMap((name) => {
          const bytes = readRegular(outputs.real, join(vdir, name), label(slug, version, name), scratch);
          if (!bytes || nameRefusal(name, false) || contentRefusal(name, bytes)) return [];
          if (name === "manifest.json") read.manifest = bytes;
          return [{ name, sha: sha256(bytes), path: join(vdir, name), rel: label(slug, version, name) }];
        });
      let manifest: Record<string, unknown> | null = null;
      try {
        const parsed = read.manifest ? JSON.parse(read.manifest.toString("utf-8")) : null;
        manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        manifest = null;
      }
      // No usable manifest (missing, refused as a secret or a guess, or not a JSON object): the whole version is left to the legacy pass.
      if (!manifest) continue;
      files.forEach((f) => used.add(f.path));
      const idOf = async (brandId: string) => found(repos.carousels.get(brandId, slug, identity));
      const key = (carouselId: string, brandId: string, name: string) => carouselExportKey(brandId, carouselId, no, name);
      items.push({
        key: `export:${slug}/${version}`, entityType: "carousel", revisionless: true,
        hash: sha256(files.map((f) => `${f.name}:${f.sha}`).join("\n")),
        payload: { status: "done", manifest, files: Object.fromEntries(files.map((f) => [f.name, f.sha])) },
        read: async (brandId) => {
          const carousel = await idOf(brandId);
          const stored = carousel && (await repos.exports.list(carousel.id)).find((e) => e.versionNo === no);
          // A reserved export that never completed is resumable: it reads as absent, and `write` completes it.
          if (!carousel || !stored || stored.status === "running") return null;
          // The sha256 of each stored file comes from its object metadata (written with the object), so a changed file is seen without downloading it.
          const shas = await Promise.all(files.map(async (f) => [f.name, await blobs.head(key(carousel.id, brandId, f.name)).then((h) => h.metadata.sha256 ?? null, (e) => (e instanceof ObjectNotFoundError ? null : Promise.reject(e)))] as const));
          return { id: stored.id, version: 0, value: { status: stored.status, manifest: stored.manifest, files: Object.fromEntries(shas) } };
        },
        write: async (brandId) => {
          const carousel = await repos.carousels.get(brandId, slug, identity);
          // Content-keyed per file, so a repeat is harmless; different bytes under an existing key are an InvalidInputError (a reported conflict).
          for (const f of files) await putAt(blobs, key(carousel.id, brandId, f.name), rereadChecked(outputs.real, f.path, f.rel, f.sha), MIME[f.name.split(".").pop()!.toLowerCase()]);
          const reservedAtNo = (await repos.exports.list(carousel.id)).find((e) => e.versionNo === no);
          if (reservedAtNo?.status === "running") return void (await repos.exports.complete(reservedAtNo.id, manifest!)); // an interrupted import resumes here
          if (reservedAtNo) throw new InvalidInputError(`export ${slug}/${version}: its number is already taken in storage (${reservedAtNo.status})`);
          for (;;) {
            const reserved = await repos.exports.reserveNextVersion(carousel.id, carousel.version);
            if (reserved.versionNo > no) throw new InvalidInputError(`export ${slug}/${version}: storage already holds newer versions`);
            if (reserved.versionNo === no) return void (await repos.exports.complete(reserved.id, manifest!));
            await repos.exports.fail(reserved.id);
          }
        },
        verifyBlobs: async (brandId) => {
          const carousel = await idOf(brandId);
          for (const f of files) {
            try {
              if (!carousel || sha256((await blobs.get(key(carousel.id, brandId, f.name))).body) !== f.sha) return false;
            } catch (error) {
              if (error instanceof ObjectNotFoundError) return false;
              throw error;
            }
          }
          return true;
        },
      });
    }
  }
  return items;
}
