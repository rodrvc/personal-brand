import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { importBrand } from "../src/import/importer.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// `brand workspace`: a read-only copy of a fictional brand out of storage. Temp folders and an `example-*` brand only.
const work = mkdtempSync(join(tmpdir(), "brand-workspace-"));
const repoRoot = join(import.meta.dirname, "..", "..");
const env = { USER: "tester", HOME: work, INIT_CWD: work };
const repos = createMemoryRepositories();
const blobs = new FakeObjectStore();
const run = (...argv: string[]) => runCli(argv, env, repos, blobs);
const write = (name: string, body: string | Buffer) => (writeFileSync(join(work, name), body), join(work, name));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]);
const WOFF2 = Buffer.concat([Buffer.from("774f4632", "hex"), Buffer.from("glyphs")]);
const TOKENS = `${JSON.stringify({ colors: { ink: "#111111" }, googleFontsHref: "https://fonts.googleapis.com/css2?family=Example+Sans" }, null, 2)}\n`; // storage keeps the JSON value, so the workspace is its canonical pretty form
const SCRIPT = "import { createRequire } from 'node:module';\nconsole.log('poster');\n";

assert.equal((await run("create", "example-posters", "--name", "Example Posters")).exitCode, 0);
const doc = async (kind: string, body: string) => assert.equal((await run("doc", "put", "example-posters", kind, "--file", write(`${kind}.in`, body))).exitCode, 0);
await doc("tokens", TOKENS);
await doc("config", '{"channels":["feed"],"limit":3}');
await doc("identity", "# Profile\n\nA fictional poster brand.\n");
assert.equal((await run("tool", "put", "example-posters", "render.mjs", "--file", write("render.in", SCRIPT), "--description", "Poster renderer")).exitCode, 0);
assert.equal((await run("guidance", "put", "example-posters", "tone", "--file", write("tone.in", "Be warm.\n"), "--description", "How it sounds: warm")).exitCode, 0);
assert.equal((await run("recipe", "put", "example-posters", "weekly", "--file", write("weekly.json", '{"cadence":"weekly"}'))).exitCode, 0);
assert.equal((await run("asset", "add", "example-posters", write("logo.png", PNG), "--kind", "logo")).exitCode, 0);
assert.equal((await run("asset", "add", "example-posters", write("sans.woff2", WOFF2), "--family", "Example Sans")).exitCode, 0);
const brand = await repos.brands.getBySlug("example-posters");
const hiddenPng = Buffer.concat([PNG, Buffer.from("hidden")]);
assert.equal((await run("asset", "add", "example-posters", write("old.png", hiddenPng), "--kind", "photo")).exitCode, 0);
const hiddenId = (await repos.assets.list(brand.id, { kind: "photo" }))[0].value.assetId;
await repos.assets.update(brand.id, hiddenId, { status: "hidden" }, { expectedVersion: 1, author: "t", source: "cli", reason: "save" });
const logoId = (await repos.assets.list(brand.id, { kind: "logo" }))[0].value.assetId;
const fontId = (await repos.assets.list(brand.id, { kind: "font" }))[0].value.assetId;

// `show` lists the tools next to the guidance.
const shown = (await run("show", "example-posters")).lines.join("\n");
assert.match(shown, /guidance tone v1: How it sounds: warm/);
assert.match(shown, /script render\.mjs v1/);
assert.equal(JSON.parse((await run("show", "example-posters", "--json")).lines[0]).tools[0].name, "render.mjs");

// Refusals write nothing and exit 6: inside the repo, a non-empty folder, a file, a hidden folder.
const outside = join(work, "example-ws");
for (const inside of [join(repoRoot, "ws-out"), repoRoot]) {
  const r = await run("workspace", "example-posters", "--out", inside);
  assert.equal(r.exitCode, 6);
  assert.match(r.lines[0], /fuera del repo/);
  assert.equal(existsSync(join(repoRoot, "ws-out")), false);
}
const busy = join(work, "busy");
mkdirSync(busy);
writeFileSync(join(busy, "keep.txt"), "mine\n");
const refusedBusy = await run("workspace", "example-posters", "--out", busy);
assert.deepEqual([refusedBusy.exitCode, readdirSync(busy)], [6, ["keep.txt"]]);
assert.match(refusedBusy.lines[0], /no está vacío/);
assert.equal((await run("workspace", "example-posters", "--out", write("ws.file", "x"))).exitCode, 6, "a file is not a destination");
assert.equal((await run("workspace", "example-posters", "--out", join(work, ".hidden", "ws"))).exitCode, 6);
assert.equal(existsSync(outside), false);
assert.equal((await run("workspace", "example-posters")).exitCode, 2, "--out is required");
assert.equal((await run("workspace", "example-nope", "--out", outside)).exitCode, 4, "an unknown brand is not found");
assert.deepEqual(readdirSync(work).filter((f) => f.endsWith(".tmp")), [], "no temporary sibling is left behind");

// The produced files and bytes. An existing empty folder is a valid destination.
mkdirSync(outside);
const made = await run("workspace", "example-posters", "--out", outside);
assert.equal(made.exitCode, 0, made.lines.join("\n"));
assert.match(made.lines.join("\n"), /3 documento\(s\), 1 script\(s\), 1 guidance, 1 receta\(s\), 2 asset\(s\)/);
assert.match(made.lines.join("\n"), new RegExp(`engineRoot\\): ${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
assert.deepEqual(readdirSync(work).filter((f) => f.endsWith(".tmp")), []);
const at = (rel: string) => readFileSync(join(outside, rel));
assert.equal(at("brand.json").toString(), TOKENS, "tokens come back as the stored JSON");
assert.deepEqual(parseYaml(at("config.yaml").toString()), { channels: ["feed"], limit: 3 });
assert.equal(at("profile.md").toString(), "# Profile\n\nA fictional poster brand.\n");
assert.equal(existsSync(join(outside, "brand-spec.md")), false, "a document that does not exist is not invented");
assert.equal(at("scripts/render.mjs").toString(), SCRIPT, "a script is byte exact");
assert.equal(statSync(join(outside, "scripts", "render.mjs")).mode & 0o777, 0o644, "never executable");
assert.equal(at("skills/tone/SKILL.md").toString(), '---\nname: tone\ndescription: "How it sounds: warm"\n---\nBe warm.\n');
assert.deepEqual(parseYaml(at("recipes/weekly.yaml").toString()), { cadence: "weekly" });
assert.ok(at(`assets/logo/${logoId}.png`).equals(PNG));
assert.ok(at(`assets/fonts/${fontId}.woff2`).equals(WOFF2));
assert.equal(readdirSync(join(outside, "assets")).includes("photo"), false, "a hidden asset is not materialized");
assert.equal(at("fonts.css").toString().includes(`font-family: "Example Sans";\n  src: url("assets/fonts/${fontId}.woff2") format("woff2");`), true);

// The manifest on disk is the --json output of the same run.
const manifest = JSON.parse(at("workspace.json").toString());
assert.deepEqual([manifest.schemaVersion, manifest.trust, manifest.slug, manifest.brandId, manifest.brandVersion, manifest.cutoverAt, manifest.engineRoot], [1, "brand-data", "example-posters", brand.id, brand.version, null, repoRoot]);
assert.match(manifest.engineCommit, /^[0-9a-f]{40}$/, "the engine revision is recorded");
assert.equal(typeof manifest.engineDirty, "boolean");
assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));
assert.deepEqual(manifest.items["tool:render.mjs"], { version: 1 });
assert.deepEqual(manifest.items[`asset:${logoId}`], { sha256: (await repos.assets.get(brand.id, logoId)).value.sha256 });
assert.deepEqual(Object.keys(manifest.items).sort(), ["asset:" + [fontId, logoId].sort()[0], "asset:" + [fontId, logoId].sort()[1], "document:config", "document:identity", "document:tokens", "guidance:tone", "recipe:weekly", "tool:render.mjs"].sort());
assert.equal(manifest.files["scripts/render.mjs"], createHash("sha256").update(SCRIPT).digest("hex"), "every file has its sha256");
assert.deepEqual(Object.keys(manifest.files), Object.keys(manifest.files).sort());
assert.ok(manifest.files["fonts.css"] && !("workspace.json" in manifest.files), "the manifest cannot hash itself");
const second = join(work, "ws-json");
const json = await run("workspace", "example-posters", "--out", second, "--json");
assert.deepEqual({ ...JSON.parse(json.lines[0]), generatedAt: "" }, { ...JSON.parse(readFileSync(join(second, "workspace.json"), "utf-8")), generatedAt: "" });
assert.match(made.lines[0], /^\[datos de la marca/, "the text output keeps the trust banner");

// The verb changes nothing in storage (the brand version is the same).
assert.equal((await repos.brands.getBySlug("example-posters")).version, brand.version);

// A destination that is a symlink is refused with its own message, nothing written through it.
const real = join(work, "real-dest");
mkdirSync(real);
symlinkSync(real, join(work, "link-dest"));
const linked = await run("workspace", "example-posters", "--out", join(work, "link-dest"));
assert.deepEqual([linked.exitCode, readdirSync(real)], [6, []]);
assert.match(linked.lines[0], /enlace simbólico/);

// A blob whose bytes no longer match the asset hash stops the copy before anything exists: no destination, no temp, no new parents.
const tampered = Object.create(blobs, { get: { value: async (key: string) => ({ ...(await blobs.get(key)), body: Buffer.from("tampered") }) } });
const bad = await runCli(["workspace", "example-posters", "--out", join(work, "fresh-parent", "example-bad")], env, repos, tampered);
assert.equal(bad.exitCode, 1);
assert.match(bad.lines[0], /no coinciden con su hash/);
assert.deepEqual([existsSync(join(work, "fresh-parent")), readdirSync(work).filter((f) => f.endsWith(".tmp"))], [false, []]);

// The pre-created temporary sibling is not ours: mkdir meets EEXIST and the copy leaves it exactly as it was.
const taken = join(work, "taken-parent");
mkdirSync(join(taken, "example-t.fixed.tmp"), { recursive: true });
writeFileSync(join(taken, "example-t.fixed.tmp", "theirs.txt"), "mine\n");
const clash = await runCli(["workspace", "example-posters", "--out", join(taken, "example-t")], env, repos, blobs, { suffix: () => "fixed" });
assert.equal(clash.exitCode, 1);
assert.deepEqual([readdirSync(taken).sort(), readdirSync(join(taken, "example-t.fixed.tmp"))], [["example-t.fixed.tmp"], ["theirs.txt"]], "a sibling this call did not create is never removed");
// A failure after the parents were created removes them. The suffix seam makes the temporary folder impossible to create (its parent is missing); a failing later write is not reachable without fault injection, since every file is new inside a fresh folder.
const failed = await runCli(["workspace", "example-posters", "--out", join(work, "new-a", "new-b", "example-f")], env, repos, blobs, { suffix: () => "x/y" });
assert.equal(failed.exitCode, 1);
assert.equal(existsSync(join(work, "new-a")), false, "parents created by this call are removed");

// A merely suspicious name is fine: it came from storage.
assert.equal((await run("create", "example-names", "--name", "Example Names")).exitCode, 0);
assert.equal((await run("tool", "put", "example-names", "token.mjs", "--file", write("t.in", "console.log(1);\n"))).exitCode, 0);
assert.equal((await run("guidance", "put", "example-names", "token-rules", "--file", write("g.in", "Rules.\n"), "--description", "d")).exitCode, 0);
assert.equal((await run("workspace", "example-names", "--out", join(work, "names-out"))).exitCode, 0);
assert.deepEqual([existsSync(join(work, "names-out", "scripts", "token.mjs")), existsSync(join(work, "names-out", "skills", "token-rules", "SKILL.md"))], [true, true]);

// A workspace is never an import source: import and cutover refuse the folder with exit 6 and write nothing.
const before = (await repos.brands.list()).length;
const imported = await run("import", "--from", outside, "--dry-run");
assert.equal(imported.exitCode, 6, imported.lines.join("\n"));
assert.match(imported.lines[0], /espacio de trabajo/);
await assert.rejects(importBrand(repos, { from: outside, dryRun: true, author: "t", blobs, env }), /workspace\.json/);
// Even for a brand that is already cut over (its cutover branch would otherwise restore a marker inside the copy).
assert.equal((await run("create", "example-cut", "--name", "Example Cut")).exitCode, 0);
const cut = await repos.brands.getBySlug("example-cut");
await repos.brands.markCutover(cut.id, { expectedVersion: cut.version, author: "t", source: "cli", reason: "structural" });
const cutDir = join(work, "cutdir", "example-cut");
assert.equal((await run("workspace", "example-cut", "--out", cutDir)).exitCode, 0);
const listed = readdirSync(cutDir).sort();
const refusedCut = await run("cutover", "example-cut", "--confirm", "example-cut", "--from", cutDir);
assert.equal(refusedCut.exitCode, 6, refusedCut.lines.join("\n"));
assert.match(refusedCut.lines[0], /espacio de trabajo/);
assert.deepEqual(readdirSync(cutDir).sort(), listed, "no marker is written into the workspace");
assert.equal(existsSync(join(cutDir, ".storage-cutover")), false);
assert.equal((await repos.brands.list()).length, before + 1);
const fileSource = await run("import", "--from", write("example-file", "x"), "--dry-run");
assert.doesNotMatch(fileSource.lines.join(" "), /espacio de trabajo/, "a --from that is a file is not mistaken for a workspace (ENOTDIR)");
console.log("brand workspace: ok");
