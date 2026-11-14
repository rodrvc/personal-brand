import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/brand.ts";
import { FakeObjectStore } from "../src/blob/index.ts";
import { importBrand, verifyBrand } from "../src/import/importer.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// Brand-owned scripts (`scripts/*`) become tools; everything else in the folder is left as before. Fictional brand, temp folder only.
const work = mkdtempSync(join(tmpdir(), "brand-tools-"));
const dir = join(work, "example-posters");
mkdirSync(join(dir, "scripts", "nested"), { recursive: true });
const put = (rel: string, body: string | Buffer) => writeFileSync(join(dir, rel), body);
put("profile.md", "# Profile\n");
put("scripts/render-cover.mjs", "console.log('cover');\n");
put("scripts/build.sh", "#!/bin/sh\necho ok\n");
put("scripts/render-cover.mjs.bak", "old\n");
put("scripts/render-cover.bak.mjs", "old\n");
put("scripts/render-cover.mjs~", "old\n");
put("scripts/notes.md", "# notes\n");
put("scripts/binary.py", Buffer.from([0xff, 0xfe, 0x00]));
put("scripts/nested/inner.mjs", "console.log('inner');\n");

const repos = createMemoryRepositories();
const blobs = new FakeObjectStore();
const env = { USER: "tester", HOME: work };
const opts = { from: dir, dryRun: false, author: "cli:tester", blobs, env };

const first = await importBrand(repos, opts);
const keys = first.items.map((i) => `${i.key}:${i.outcome}`);
assert.deepEqual(keys.filter((k) => k.startsWith("tool:")), ["tool:build.sh:created", "tool:render-cover.mjs:created"], "only flat script files are tools");
const brand = await repos.brands.getBySlug("example-posters");
assert.deepEqual((await repos.tools.list(brand.id)).map((t) => t.name), ["build.sh", "render-cover.mjs"]);
assert.equal((await repos.tools.get(brand.id, "render-cover.mjs")).body, "console.log('cover');\n");
assert.ok(first.skipped.some((s) => s.startsWith("scripts/binary.py")), "a non-UTF-8 script is reported, not imported");
// Backups, notes and the subfolder stay as they were: bytes kept (known types) or listed as unimported (unknown types), never tools.
assert.ok(first.unimported.some((u) => u.startsWith("scripts/render-cover.mjs.bak")), "a backup is left behind");
assert.ok(first.unimported.some((u) => u.startsWith("scripts/nested/inner.mjs")), "a subfolder script is left behind");
assert.ok(first.legacy.manifest["scripts/notes.md"], "a known type next to the scripts still goes to the legacy bucket");
assert.equal(first.legacy.manifest["scripts/render-cover.mjs"], undefined, "an imported script is not duplicated as legacy");

const again = await importBrand(repos, opts);
assert.deepEqual(again.counts, { created: 0, updated: 0, unchanged: first.counts.created, conflict: 0 }, "a reimport changes nothing");
assert.deepEqual(await verifyBrand(repos, dir, blobs, env), [], "a clean import verifies");

put("scripts/build.sh", "#!/bin/sh\necho changed\n");
assert.deepEqual(await verifyBrand(repos, dir, blobs, env), ["tool:build.sh"], "a script that differs from storage is reported");
const updated = await importBrand(repos, opts);
assert.deepEqual(updated.items.filter((i) => i.outcome !== "unchanged"), [{ key: "tool:build.sh", outcome: "updated" }]);
const owner = await repos.tools.put(brand.id, "render-cover.mjs", { description: "edited", body: "x" }, { expectedVersion: 1, author: "owner", source: "cli", reason: "save" });
assert.equal(owner.version, 2);
assert.match((await importBrand(repos, opts)).conflicts.join(), /tool:render-cover\.mjs \(storage changed since the last import\)/, "a stored edit is never overwritten");

// A folder whose scripts are all tools has nothing left behind under `scripts`.
const clean = join(work, "example-clean");
mkdirSync(join(clean, "scripts"), { recursive: true });
writeFileSync(join(clean, "profile.md"), "# Profile\n");
writeFileSync(join(clean, "scripts", "a.mjs"), "1\n");
const cleanReport = await importBrand(createMemoryRepositories(), { ...opts, from: clean, dryRun: true });
assert.deepEqual([cleanReport.notImported, cleanReport.unimported, cleanReport.items.map((i) => i.key)], [[], [], ["document:identity", "tool:a.mjs"]]);
// Secrets: a script with a secret signature is refused (never a tool; it blocks cutover without --partial); ordinary env reads still import.
const guarded = join(work, "example-guarded");
mkdirSync(join(guarded, "scripts"), { recursive: true });
const g = (name: string, body: string) => writeFileSync(join(guarded, name), body);
g("profile.md", "# Profile\n");
g("scripts/url.mjs", "fetch('https://user:hunter2pass@host.example/x');\n");
g("scripts/key.mjs", `const k = "sk-${"a1B2".repeat(6)}";\n`);
g("scripts/literal.mjs", 'const apiKey = "literal-value-123";\n');
g("scripts/env.mjs", "const apiKey = process.env.POSTER_KEY;\nconst token = process.env.T;\n");
g("scripts/big.mjs", "x".repeat(256 * 1024 + 1));
g("real.mjs", "console.log(1);\n");
symlinkSync(join(guarded, "real.mjs"), join(guarded, "scripts", "link.mjs"));
const guardedRepos = createMemoryRepositories();
const guardedReport = await importBrand(guardedRepos, { ...opts, from: guarded });
const guardedBrand = await guardedRepos.brands.getBySlug("example-guarded");
assert.deepEqual((await guardedRepos.tools.list(guardedBrand.id)).map((t) => t.name), ["env.mjs"], "only the script without a secret literal is a tool");
assert.deepEqual(guardedReport.refused.map((r) => r.split(" ")[0]), ["scripts/key.mjs", "scripts/literal.mjs", "scripts/url.mjs"], "secrets are refused");
assert.ok(guardedReport.skipped.some((s) => s.startsWith("scripts/big.mjs")), "an oversized script is reported");
assert.ok(guardedReport.skipped.some((s) => s.startsWith("scripts/link.mjs")), "a symlinked script is never read");
assert.ok(!guardedReport.unimported.some((u) => /url\.mjs|key\.mjs|literal\.mjs/.test(u)), "a refused secret is not also left-behind data");
assert.deepEqual(await verifyBrand(guardedRepos, guarded, blobs, env), [], "refused scripts are not verified as tools");
// A refused script blocks a cutover (it would be stranded); --partial accepts it. `tool put` refuses the same body with exit 6.
const cli = (...argv: string[]) => runCli(argv, env, guardedRepos, blobs);
const stranded = await cli("cutover", "example-guarded", "--confirm", "example-guarded", "--from", guarded);
assert.equal(stranded.exitCode, 6, stranded.lines.join("\n"));
assert.match(stranded.lines[0], /scripts\/key\.mjs/);
assert.equal((await cli("cutover", "example-guarded", "--confirm", "example-guarded", "--partial", "--from", guarded)).exitCode, 0);
const toolFile = join(work, "secret.mjs");
writeFileSync(toolFile, 'const password = "placeholder-1";\n');
const refusedPut = await cli("tool", "put", "example-guarded", "secret.mjs", "--file", toolFile);
assert.equal(refusedPut.exitCode, 6, refusedPut.lines.join("\n"));
assert.match(refusedPut.lines[0], /secreto/);
assert.equal((await guardedRepos.tools.list(guardedBrand.id)).some((t) => t.name === "secret.mjs"), false);
// `tool put` without --description on a missing tool is a plain create (no --if-version), with an empty description.
const plainFile = join(work, "plain.mjs");
writeFileSync(plainFile, "console.log(1);\n");
assert.equal((await cli("tool", "put", "example-guarded", "plain.mjs", "--file", plainFile)).exitCode, 0);
assert.equal((await guardedRepos.tools.get(guardedBrand.id, "plain.mjs")).description, "");
// A `scripts` entry that is a file is left unclaimed (reported), never walked.
const fileScripts = join(work, "example-filescripts");
mkdirSync(fileScripts);
writeFileSync(join(fileScripts, "profile.md"), "# Profile\n");
writeFileSync(join(fileScripts, "scripts"), "not a folder\n");
const fileScriptsReport = await importBrand(createMemoryRepositories(), { ...opts, from: fileScripts, dryRun: true });
assert.ok([...fileScriptsReport.notImported, ...fileScriptsReport.unimported].some((e) => e.startsWith("scripts")), "a scripts file is reported as left behind");
assert.deepEqual(fileScriptsReport.items.map((i) => i.key), ["document:identity"]);
console.log("brand tools importer: ok");
