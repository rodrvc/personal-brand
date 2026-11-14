import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { LegacyBucketError, withLegacyBucket } from "../src/import/legacy-bucket.ts";
import { verifyBrand } from "../src/import/importer.ts";
import { createMemoryRepositories, type MemoryRepositories } from "../src/memory/index.ts";

const example = join(import.meta.dirname, "..", "..", "profiles", "example");
const work = mkdtempSync(join(tmpdir(), "lb-test-"));
// Temporary copies go under a per-test folder, so "nothing is left" is proven here and not against the whole OS temp folder.
const tmpRoot = join(work, "tmp");
mkdirSync(tmpRoot, { recursive: true });
const env = { USER: "tester", HOME: join(work, "home"), LEGACY_BUCKET_TMPDIR: tmpRoot };

/** A throwaway copy of the fictional example brand, with one guidance skill. */
function folder(slug: string): string {
  const dir = join(work, "folders", slug);
  cpSync(example, dir, { recursive: true });
  mkdirSync(join(dir, "skills", "tone"), { recursive: true });
  writeFileSync(join(dir, "skills", "tone", "SKILL.md"), "---\ndescription: How this brand sounds\n---\nBe warm.\n");
  return dir;
}

/** Writes every file of a folder to the bucket the way the #99 migration does: `<prefix><slug>/<relative path>`. */
async function toLegacyBucket(dir: string, slug: string, store: FakeObjectStore, prefix = "profiles/"): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else await store.put(`${prefix}${slug}/${relative(dir, join(d, e.name)).split("\\").join("/")}`, readFileSync(join(d, e.name)));
    }
  };
  await walk(dir);
}

const SLUG = "example-coffee";
const dir = folder(SLUG);

// The same fixture, with an outputs tree (one export version and one reel run), imported from its folder and from a legacy bucket, gives the same result.
const card = parseYaml(readFileSync(join(dir, "reels", "2026-08-10", "storyboard.yaml"), "utf-8")).cards[0].id as string;
mkdirSync(join(dir, "carousels", "launch"), { recursive: true });
writeFileSync(join(dir, "carousels", "launch", "carousel.json"), JSON.stringify({ schemaVersion: 1, title: "Launch", slides: [] }));
const outputs: Record<string, string> = { "editor/launch/v1/manifest.json": JSON.stringify({ version: 1 }), "editor/launch/v1/01.png": "png-1", [`reels/2026-08-10/clips/0-${card}.mp4`]: "clip-0" };
const outRoot = join(work, "out-root");
for (const [rel, data] of Object.entries(outputs)) (mkdirSync(dirname(join(outRoot, SLUG, rel)), { recursive: true }), writeFileSync(join(outRoot, SLUG, rel), data));
const fromFolder = { repos: createMemoryRepositories(), blobs: new FakeObjectStore() };
const fromBucket = { repos: createMemoryRepositories(), blobs: new FakeObjectStore() };
const legacy = new FakeObjectStore();
await toLegacyBucket(dir, SLUG, legacy);
for (const [rel, data] of Object.entries(outputs)) await legacy.put(`profiles/${SLUG}/_outputs/${rel}`, Buffer.from(data));
await legacy.put(`profiles/${SLUG}/placeholder/`, Buffer.alloc(0)); // a folder placeholder: skipped silently
const tmpLeft = () => readdirSync(tmpRoot).filter((n) => n.startsWith("legacy-bucket-"));
const folderRun = await runCli(["import", "--from", dir], { ...env, BRAND_OUTPUTS_ROOT: outRoot }, fromFolder.repos, fromFolder.blobs);
const bucketRun = await runCli(["import", "--from", `legacy-bucket:${SLUG}`], env, fromBucket.repos, legacy);
assert.equal(folderRun.exitCode, 0, folderRun.lines.join("\n"));
assert.equal(bucketRun.exitCode, 0, bucketRun.lines.join("\n"));
const runOf = async (x: { repos: MemoryRepositories }) => (await x.repos.importRuns.list((await x.repos.brands.getBySlug(SLUG)).id))[0];
const clips = async (x: { repos: MemoryRepositories }) => {
  const brandId = (await x.repos.brands.getBySlug(SLUG)).id;
  return (await x.repos.runArtifacts.current((await x.repos.runs.list(brandId, { recipe: "reel-week" }))[0].id, { kind: "clip" })).map((a) => a.sha256);
};
assert.ok(folderRun.lines.includes("  created export:launch/v1"), "the fixture imports an export");
const unlabelled = (lines: string[]) => lines.filter((l) => !l.startsWith("Origen:") && !l.startsWith("Carpeta de salidas"));
assert.deepEqual(unlabelled(bucketRun.lines), unlabelled(folderRun.lines), "same report, same words");
assert.ok(bucketRun.lines.includes(`Origen: legacy-bucket:profiles/${SLUG}.`) && !bucketRun.lines.join("\n").includes(tmpRoot), "the origin is named and no temporary path leaks");
assert.equal(((await runOf(fromBucket)).report as { slug: string }).slug, SLUG, "the stored brand is the slug that passed the owner guard");
assert.ok(bucketRun.lines.some((l) => l.startsWith("Carpeta de salidas") && l.includes("_outputs/")));
assert.deepEqual(await verifyBrand(fromBucket.repos, dir, legacy, { ...env, BRAND_OUTPUTS_ROOT: outRoot }), [], "what the bucket import stored reads back as the folder says");
assert.equal((await runOf(fromBucket)).sourceRootHash, (await runOf(fromFolder)).sourceRootHash, "equal source root hash");
assert.equal(((await runOf(fromBucket)).report as { origin?: string }).origin, `legacy-bucket:profiles/${SLUG}`);
assert.equal((await clips(fromFolder)).length, 1, "and a reel clip");
assert.deepEqual(await clips(fromBucket), await clips(fromFolder));
assert.deepEqual(tmpLeft(), [], "no temporary copy is left after a success");
await assert.rejects(() => withLegacyBucket(legacy, "profiles/", SLUG, env, async () => { throw new Error("boom"); }), /boom/);
assert.deepEqual(tmpLeft(), [], "none is left after a throwing use either");
console.log("  ok - legacy bucket: imports like a folder (report, storage, source hash, outputs) and leaves no temporary copy");

// Idempotent, and a storage edit is a conflict exactly as with a folder.
const again = await runCli(["import", "--from", `legacy-bucket:${SLUG}`], env, fromBucket.repos, legacy);
assert.match(again.lines.join("\n"), /Creados 0, actualizados 0, sin cambios \d+, conflictos 0/);
const brand = await fromBucket.repos.brands.getBySlug(SLUG);
const spec = await fromBucket.repos.documents.get(brand.id, "spec", "", (x) => x);
await fromBucket.repos.documents.put(brand.id, "spec", "", { text: "Edited in storage", schemaVersion: 1 }, { expectedVersion: spec.version, author: "editor", source: "editor", reason: "save" });
const conflict = await runCli(["import", "--from", `legacy-bucket:${SLUG}`], env, fromBucket.repos, legacy);
assert.deepEqual([conflict.exitCode, /conflict document:spec/.test(conflict.lines.join("\n"))], [3, true]);
console.log("  ok - legacy bucket: re-run is a no-op and a stored edit is a conflict");

const dry = await runCli(["import", "--from", `legacy-bucket:${SLUG}`, "--dry-run"], env, createMemoryRepositories(), legacy);
assert.match(dry.lines.join("\n"), /simulacro/);

// Guards: the owner opt-in, the slug format, a missing bucket, an empty prefix.
const real = await runCli(["import", "--from", "legacy-bucket:acme-coffee"], env, createMemoryRepositories(), legacy);
assert.equal(real.exitCode, 6, "a brand that is not an example needs the owner opt-in, dry run included");
assert.equal((await runCli(["import", "--from", "legacy-bucket:../x", "--dry-run"], env, createMemoryRepositories(), legacy)).exitCode, 2);
assert.match((await runCli(["import", "--from", `legacy-bucket:${SLUG}`], env, createMemoryRepositories(), undefined)).lines.join(" "), /Falta el bucket/);
const empty = await runCli(["import", "--from", "legacy-bucket:example-none"], env, createMemoryRepositories(), legacy);
assert.deepEqual([empty.exitCode, /No hay nada en el bucket/.test(empty.lines.join(" "))], [4, true]);
const cutover = await runCli(["cutover", SLUG, "--confirm", SLUG, "--from", `legacy-bucket:${SLUG}`], env, createMemoryRepositories(), legacy);
assert.deepEqual([cutover.exitCode, /no admite legacy-bucket/.test(cutover.lines.join(" "))], [6, true]);
const capped = await runCli(["import", "--from", `legacy-bucket:${SLUG}`], { ...env, LEGACY_BUCKET_MAX_BYTES: "10" }, createMemoryRepositories(), legacy);
assert.deepEqual([capped.exitCode, /más que el máximo de 10 bytes \(LEGACY_BUCKET_MAX_BYTES\)/.test(capped.lines.join(" "))], [6, true]);
assert.ok(/máximo de 10 bytes/.test(capped.lines.join(" ")) && !/0 MB/.test(capped.lines.join(" ")), "a tiny cap is shown in bytes, and the refusal is a policy refusal (6), not a crash (1)");
console.log("  ok - legacy bucket: owner guard, slug, missing bucket, empty prefix, cutover and size cap");

// Keys that are unsafe as paths or clash are reported, never written; the configured S3_PREFIX is honoured; a sibling slug is not read.
const odd = new FakeObjectStore();
await toLegacyBucket(dir, SLUG, odd, "tenant");
await odd.put(`tenant${SLUG}/../escape.md`, Buffer.from("x"));
await odd.put(`tenant${SLUG}/a`, Buffer.from("x"));
await odd.put(`tenant${SLUG}/a/b`, Buffer.from("y"));
await odd.put(`tenant${SLUG}-other/profile.md`, Buffer.from("other brand"));
await odd.put(`tenant${SLUG}/Notes.md`, Buffer.from("1"));
await odd.put(`tenant${SLUG}/notes.md`, Buffer.from("2"));
await odd.put(`tenant${SLUG}/${"x".repeat(300)}.md`, Buffer.from("long"));
const oddRun = await runCli(["import", "--from", `legacy-bucket:${SLUG}`], { ...env, S3_PREFIX: "tenant" }, createMemoryRepositories(), odd);
const text = oddRun.lines.join("\n");
assert.match(text, /\.\.\/escape\.md \(unsafe path in the bucket\)/);
assert.match(text, /a\/b \(clashes with another key\)/);
assert.ok(/Notes\.md \(clashes with another key: they differ only by case/.test(text) && /notes\.md \(clashes with another key: they differ only by case/.test(text), "every member of a case clash is reported");
assert.match(text, /x{300}\.md \(name too long/);
assert.ok(!/other brand/.test(text) && !/placeholder/.test(text));
// No outputs folder here: the "outputs root missing" notice is not produced at all, and the stored report holds no temporary path.
const oddReport = JSON.stringify((await (async () => { const r = createMemoryRepositories(); await runCli(["import", "--from", `legacy-bucket:${SLUG}`], { ...env, S3_PREFIX: "tenant" }, r, odd); return r.importRuns.list((await r.brands.getBySlug(SLUG)).id); })())[0].report);
assert.ok(!oddReport.includes(tmpRoot) && !/outputs root .* does not exist/.test(oddReport), "the stored report never names the temporary copy");
assert.ok(oddRun.lines[0].startsWith('Aviso: S3_PREFIX "tenant" no termina en "/"'), "a prefix without a slash is read as the editor wrote it, and said so");
console.log("  ok - legacy bucket: unsafe and clashing keys are reported, S3_PREFIX honoured, siblings ignored");

// The outputs folder comes from `_outputs/`; the brand's configured `outputs.base_dir` is never followed to a real folder.
const decoy = join(work, "decoy");
mkdirSync(decoy, { recursive: true });
writeFileSync(join(decoy, "secret.txt"), "must not be read");
const cfg = join(dir, "config.yaml");
const outDir = folder("example-outputs");
const config = parseYaml(readFileSync(cfg, "utf-8"));
config.outputs = { ...config.outputs, base_dir: decoy };
writeFileSync(join(outDir, "config.yaml"), stringifyYaml(config));
const withOut = new FakeObjectStore();
await toLegacyBucket(outDir, "example-outputs", withOut);
await withOut.put("profiles/example-outputs/_outputs/editor/note.txt", Buffer.from("rendered"));
const outRun = await runCli(["import", "--from", "legacy-bucket:example-outputs", "--dry-run"], env, createMemoryRepositories(), withOut);
const outText = outRun.lines.join("\n");
assert.match(outText, /Carpeta de salidas leída \(fuera de la marca\): _outputs\/\./);
assert.ok(!outText.includes(decoy) && !outText.includes("secret.txt"));
console.log("  ok - legacy bucket: outputs come from _outputs/, never from outputs.base_dir");

// Interrupted: SIGINT/SIGTERM remove the temporary copy, then exit 130/143; the handlers are gone afterwards.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  const before = process.listenerCount(signal);
  const exits: number[] = [];
  await withLegacyBucket(legacy, "profiles/", SLUG, env, async () => {
    assert.equal(tmpLeft().length, 1, "the copy exists while in use");
    process.emit(signal, signal);
    assert.deepEqual([exits, tmpLeft()], [[code], []], "the handler removed the copy, then exited (exit is stubbed)");
  }, (c) => exits.push(c));
  assert.deepEqual(exits, [code]);
  assert.equal(process.listenerCount(signal), before, `${signal} handler removed afterwards`);
}
console.log("  ok - legacy bucket: SIGINT and SIGTERM remove the temporary copy and exit 130/143");

// The cap counts bytes actually streamed: a store that lists small sizes but serves more is refused, and nothing stays behind.
class Understated extends FakeObjectStore {
  override async list(prefix: string) {
    return (await super.list(prefix)).map((o) => ({ ...o, size: 1 }));
  }
}
const liar = new Understated();
await liar.put(`profiles/${SLUG}/a.md`, Buffer.alloc(30, "a"));
await liar.put(`profiles/${SLUG}/b.md`, Buffer.alloc(30, "b"));
await assert.rejects(() => withLegacyBucket(liar, "profiles/", SLUG, { ...env, LEGACY_BUCKET_MAX_BYTES: "40" }, async () => "unreachable"), (e: unknown) => e instanceof LegacyBucketError && e.kind === "cap" && /40 bytes/.test(e.message));
assert.deepEqual(tmpLeft(), []);
console.log("  ok - legacy bucket: the size cap counts streamed bytes");

// init:profile prints the pointer: --help exits 0, a plain run exits 2 on purpose, and neither writes anything.
const script = join(import.meta.dirname, "..", "..", "scripts", "init-profile.mjs");
const cwd = join(work, "init-cwd");
mkdirSync(cwd, { recursive: true });
const help = spawnSync(process.execPath, [script, "--help"], { cwd, encoding: "utf-8" });
const plain = spawnSync(process.execPath, [script], { cwd, encoding: "utf-8" });
assert.deepEqual([help.status, plain.status, readdirSync(cwd)], [0, 2, []]);
assert.ok(help.stdout.includes("brand create") && plain.stderr.includes("brand create"));
console.log("  ok - init-profile: --help exits 0, a plain run exits 2, nothing is written");
assert.ok(!existsSync(join(work, "profiles")), "no profile folder is ever created");
rmSync(work, { recursive: true, force: true });
console.log("legacy bucket: ok");
