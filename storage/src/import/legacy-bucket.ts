import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { legacyProfileBase, type BlobStore } from "../contracts/index.ts";

/** `--from legacy-bucket:<slug>`: a brand stored in the per-profile bucket layout of the editor's `s3` mode (issue #99). */
export const LEGACY_SOURCE = /^legacy-bucket:/;
/** The editor's default `S3_PREFIX`. */
export const DEFAULT_LEGACY_PREFIX = "profiles/";
/** Largest total size of one brand's objects that is downloaded; `LEGACY_BUCKET_MAX_BYTES` overrides it. */
export const DEFAULT_LEGACY_MAX_BYTES = 2 * 1024 ** 3;
/** Objects of the legacy layout under this sub-prefix are the resolved outputs folder of the brand. */
export const OUTPUTS_MARKER = "_outputs/";

/** The bucket holds nothing for the brand, or more than the cap allows: said in Spanish, nothing is downloaded. */
export class LegacyBucketError extends Error {
  /** `empty`: nothing under the prefix (not found). `cap`: the size cap refused it (a policy refusal, not a crash). */
  constructor(message: string, readonly kind: "empty" | "cap") {
    super(message);
  }
}

/** A byte count a person can read, exact enough for a cap: bytes, KB or MB (never "0 MB" for a small cap). */
const sizeText = (n: number): string => (n >= 1024 ** 2 ? `${+(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} bytes`);
const overCap = (what: string, maxBytes: number) => new LegacyBucketError(`${what}, más que el máximo de ${sizeText(maxBytes)} (LEGACY_BUCKET_MAX_BYTES): no se descargó nada más.`, "cap");

/** A key part that could leave the folder or name no file: empty, `.`, `..`, a backslash or a control character. */
const unsafe = (rel: string): boolean => rel.split("/").some((part) => part === "" || part === "." || part === "..") || /[\\\u0000-\u001f]/.test(rel);
/** Write errors that mean this one key cannot be a file here (and nothing else is wrong). */
const SKIP_CODES = ["EEXIST", "ENOTDIR", "EISDIR", "ENAMETOOLONG"];

/**
 * Copies the legacy objects of `slug` into `into` as a plain brand folder (`into/profiles/<slug>`) plus its outputs folder
 * (`into/outputs/<slug>`), so the folder importer reads them through the same collectors and policy: one code path, no second importer.
 * Read-only on the bucket. Nothing is downloaded when the listing is empty or larger than `maxBytes`. A key that is unsafe as a path,
 * or that clashes with another (they differ only by case or Unicode form, so the result would depend on the file system), is passed
 * over and returned in `skipped`, every member of a clashing group included.
 */
export async function materializeLegacyBucket(store: BlobStore, prefix: string, slug: string, into: string, maxBytes = DEFAULT_LEGACY_MAX_BYTES): Promise<{ dir: string; outputs: string; skipped: string[] }> {
  const dir = join(into, "profiles", slug);
  const outputs = join(into, "outputs");
  mkdirSync(dir, { recursive: true });
  mkdirSync(outputs, { recursive: true });
  const base = legacyProfileBase(prefix, slug);
  const skipped: string[] = [];
  // A zero-size key ending in "/" is a folder placeholder, not a file.
  const listed = (await store.list(base)).filter((o) => !(o.key.endsWith("/") && o.size === 0)).sort((a, b) => (a.key < b.key ? -1 : 1));
  if (!listed.length) throw new LegacyBucketError(`No hay nada en el bucket bajo ${base}.`, "empty");
  const total = listed.reduce((sum, o) => sum + o.size, 0);
  if (total > maxBytes) throw overCap(`El bucket guarda ${sizeText(total)} bajo ${base}`, maxBytes);
  let streamed = 0; // bytes actually received: the listed sizes can be stale or wrong
  const groups = new Map<string, string[]>();
  const folded = (key: string) => key.slice(base.length).normalize("NFC").toLowerCase();
  for (const { key } of listed) groups.set(folded(key), [...(groups.get(folded(key)) ?? []), key]);
  for (const { key } of listed) {
    const rel = key.slice(base.length);
    const isOutput = rel.startsWith(OUTPUTS_MARKER);
    const inner = isOutput ? rel.slice(OUTPUTS_MARKER.length) : rel;
    if (unsafe(inner)) {
      skipped.push(`${rel} (unsafe path in the bucket)`);
      continue;
    }
    if (groups.get(folded(key))!.length > 1) {
      skipped.push(`${rel} (clashes with another key: they differ only by case or Unicode form)`);
      continue;
    }
    const target = join(isOutput ? join(outputs, slug) : dir, inner);
    try {
      mkdirSync(dirname(target), { recursive: true });
      await pipeline((await store.getStream(key)).stream, async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          streamed += chunk.length;
          if (streamed > maxBytes) throw overCap(`El bucket entregó más de lo listado bajo ${base}`, maxBytes);
          yield chunk;
        }
      }, createWriteStream(target, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!SKIP_CODES.includes(code)) throw error;
      skipped.push(`${rel} (${code === "ENAMETOOLONG" ? "name too long for this file system" : "clashes with another key"})`);
    }
  }
  return { dir, outputs, skipped };
}

/** The size cap from `LEGACY_BUCKET_MAX_BYTES` (a positive number of bytes), or the default. */
const capOf = (env: NodeJS.ProcessEnv): number => (Number.isFinite(Number(env.LEGACY_BUCKET_MAX_BYTES)) && Number(env.LEGACY_BUCKET_MAX_BYTES) > 0 ? Number(env.LEGACY_BUCKET_MAX_BYTES) : DEFAULT_LEGACY_MAX_BYTES);

/**
 * Runs `use` against a temporary folder copy of a legacy bucket brand, then removes that copy, whether `use` returns, throws, or the
 * process gets SIGINT/SIGTERM meanwhile (the handlers live only for this call; then the process exits 130/143, `exit` is a test seam).
 * It deletes only what it made. The copy lives under `LEGACY_BUCKET_TMPDIR` (default: the OS temp folder). `env` is given back with
 * `BRAND_OUTPUTS_ROOT` pointing at the copy's outputs, so the brand's configured `outputs.base_dir` can never reach a real folder.
 */
export async function withLegacyBucket<T>(store: BlobStore, prefix: string, slug: string, env: NodeJS.ProcessEnv, use: (source: { dir: string; env: NodeJS.ProcessEnv; skipped: string[] }) => Promise<T>, exit: (code: number) => void = (code) => process.exit(code)): Promise<T> {
  const into = mkdtempSync(join(env.LEGACY_BUCKET_TMPDIR || tmpdir(), "legacy-bucket-"));
  // Whatever happens while removing the copy, the interrupt still ends the process.
  const onSignal = (code: number) => () => { try { rmSync(into, { recursive: true, force: true }); } finally { exit(code); } };
  const handlers = { SIGINT: onSignal(130), SIGTERM: onSignal(143) };
  for (const [signal, handler] of Object.entries(handlers)) process.once(signal, handler);
  try {
    const { dir, outputs, skipped } = await materializeLegacyBucket(store, prefix, slug, into, capOf(env));
    return await use({ dir, env: { ...env, BRAND_OUTPUTS_ROOT: outputs }, skipped });
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
    // A copy that cannot be removed must not hide the real outcome or error: say where it is left.
    try { rmSync(into, { recursive: true, force: true }); } catch { console.warn(`No se pudo borrar la copia temporal ${into}: bórrala a mano.`); }
  }
}
