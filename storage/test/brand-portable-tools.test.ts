import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { machinePathLines, portabilityWarning } from "../src/import/allowlist.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// Portable brand tools (C1b): the portability warning, the workspace's engine libraries and the fictional example-posters brand.
const repoRoot = join(import.meta.dirname, "..", "..");
const work = mkdtempSync(join(tmpdir(), "brand-portable-"));

// 1. The scanner. A path that starts a token is machine-specific; relative paths, system paths, URLs and variables are not.
const at = (text: string) => machinePathLines(text);
assert.deepEqual(at('const a = "/Users/someone/project/x.js";'), [1], "macOS home");
assert.deepEqual(at("x\ncd /home/someone/work\ny\n/home/other/z"), [2, 4], "Linux home, with line numbers");
assert.deepEqual(at('require("C:\\Users\\someone\\x")'), [1], "Windows, single backslashes");
assert.deepEqual(at('"c:\\\\Users\\\\someone\\\\x"'), [1], "Windows, escaped backslashes and lowercase drive");
assert.deepEqual(at("D:/Users/someone/x"), [1], "Windows with forward slashes");
assert.deepEqual(at("import 'file:///Users/someone/x.mjs'"), [1], "file URL");
assert.deepEqual(at("// see /Users/someone/notes in the old setup"), [1], "a comment is flagged too: the warning is cheap and never blocks");
assert.deepEqual(at("const p = `${base}/home/x`; join(dir)/Users/x"), [], "a path built from a variable is not a fixed one");
for (const ok of ["/usr/bin/env node", "./Users/x", "../home/x", "https://host.example/Users/x/y", "https://host.example/home/x", "~/Users/x", "$HOME/work", "import { chromium } from 'playwright'", "/Users", "/home/", "const users = '/users-list'"]) assert.deepEqual(at(ok), [], ok);
const warning = portabilityWarning("render.mjs", "a\n/Users/someone/p\n/home/other/q\n");
assert.equal(warning, 'la herramienta render.mjs usa una ruta fija de este equipo (líneas 2, 3). En otro equipo no funcionará: importa las librerías por nombre (import ... from "playwright") y recibe la carpeta de salida como dato.');
assert.equal(warning!.includes("someone") || warning!.includes("other"), false, "the path is never echoed");
assert.match(portabilityWarning("t.mjs", "/home/a/b")!, /\(línea 1\)/);
assert.match(portabilityWarning("t.mjs", Array.from({ length: 9 }, () => "/home/a/b").join("\n"))!, /\(líneas 1, 2, 3, 4, 5, 6, \.\.\.\)/, "a long list is cut");
assert.equal(portabilityWarning("t.mjs", "console.log(1)"), null);

// 2. `tool put` warns after saving; a portable script does not.
const repos = createMemoryRepositories();
const blobs = new FakeObjectStore();
const env = { USER: "tester", HOME: work, INIT_CWD: work };
const run = (...argv: string[]) => runCli(argv, env, repos, blobs);
const write = (name: string, body: string) => (writeFileSync(join(work, name), body), join(work, name));
assert.equal((await run("create", "example-ports", "--name", "Example Ports")).exitCode, 0);
const fixed = await run("tool", "put", "example-ports", "fixed.mjs", "--file", write("fixed.in", 'import { createRequire } from "node:module";\nconst r = createRequire("/Users/someone/repo/x.js");\n'));
assert.equal(fixed.exitCode, 0, fixed.lines.join("\n"));
assert.ok(fixed.lines.some((l) => l.startsWith("Herramienta fixed.mjs guardada (versión 1).")));
assert.ok(fixed.lines.some((l) => l.startsWith("Aviso: la herramienta fixed.mjs usa una ruta fija de este equipo (línea 2).")));
assert.equal(fixed.lines.join("\n").includes("someone"), false);
assert.equal((await repos.tools.list((await repos.brands.getBySlug("example-ports")).id)).length, 1, "saved anyway");
const clean = await run("tool", "put", "example-ports", "clean.mjs", "--file", write("clean.in", 'import { chromium } from "playwright";\n'));
assert.equal(clean.lines.some((l) => l.includes("Aviso")), false);

// 3. The import and the cutover report it as a notice per tool, and neither refuses nor blocks.
const brandDir = join(work, "example-noticeshop");
cpSync(join(repoRoot, "profiles", "example"), brandDir, { recursive: true });
cpSync(join(repoRoot, "profiles", "example-posters", "scripts"), join(brandDir, "scripts"), { recursive: true });
writeFileSync(join(brandDir, "scripts", "legacy.mjs"), 'const lib = "/home/someone/engine/node_modules/playwright";\n');
const imported = await run("import", "--from", brandDir, "--dry-run");
assert.equal(imported.exitCode, 0, imported.lines.join("\n"));
const at0 = imported.lines.indexOf("Avisos de herramientas:");
assert.ok(at0 >= 0, "the tool warnings have their own block");
const notice = imported.lines[at0 + 1];
assert.match(notice, /^  - la herramienta legacy\.mjs usa una ruta fija de este equipo \(línea 1\)/);
assert.equal(imported.lines.some((l) => l.startsWith("Avisos:") && l.includes("herramienta")), false, "not mixed with the English notices");
assert.equal(notice.includes("render-sample.mjs"), false, "the portable tool is not named");
assert.equal(imported.lines.join("\n").includes("someone"), false);
const cut = await run("cutover", "example-noticeshop", "--confirm", "example-noticeshop", "--from", brandDir, "--partial");
assert.equal(cut.exitCode, 0, cut.lines.join("\n"));
assert.match(cut.lines.join("\n"), /Avisos de herramientas:\n  - la herramienta legacy\.mjs usa una ruta fija/, "the cutover shows the warning and is not blocked");

// 4. End to end with the tracked fictional brand: import, workspace, the engine libraries, the batch render.
const exRepos = createMemoryRepositories();
const exBlobs = new FakeObjectStore();
const exRun = (...argv: string[]) => runCli(argv, env, exRepos, exBlobs);
const imp = await exRun("import", "--from", join(repoRoot, "profiles", "example-posters"));
assert.equal(imp.exitCode, 0, imp.lines.join("\n"));
assert.equal(imp.lines.join("\n").includes("ruta fija"), false, "the example tool is portable");
const out = join(work, "example-posters-ws");
const ws = await exRun("workspace", "example-posters", "--out", out);
assert.equal(ws.exitCode, 0, ws.lines.join("\n"));
const text = ws.lines.join("\n");
assert.equal(text.includes("ruta fija"), false, "no portability warning for the example tool");
assert.ok(existsSync(join(out, "scripts", "render-sample.mjs")));
const hasModules = existsSync(join(repoRoot, "node_modules"));
if (hasModules) {
  assert.ok(lstatSync(join(out, "node_modules")).isSymbolicLink(), "node_modules is a link");
  assert.equal(realpathSync(join(out, "node_modules")), realpathSync(join(repoRoot, "node_modules")));
  assert.match(text, /Los scripts pueden importar las librerías del motor \(por ejemplo playwright\) sin rutas fijas\./);
}
const manifest = JSON.parse(readFileSync(join(out, "workspace.json"), "utf-8"));
assert.equal(manifest.engineModules, hasModules ? join(repoRoot, "node_modules") : null);
assert.equal("node_modules" in manifest.files, false, "the link is not a data file");
assert.deepEqual(readdirSync(out).sort().filter((n) => n !== "node_modules").every((n) => !n.startsWith("carousels")), true, "the batch folder is not materialized");
const exBrand = await exRepos.brands.getBySlug("example-posters");
const batchAsset = (await exRepos.assets.list(exBrand.id, { status: "hidden" })).find((a) => a.value.tags.includes("batch:daily-2026-01-10"));
assert.ok(batchAsset, "the batch PNG is a hidden tagged asset");
assert.equal(existsSync(join(out, "assets")), false, "and it is not materialized (the brand has no visible asset)");

// A workspace without engine libraries still works, with a plain warning (never a failure): point the engine at an empty folder.
const bare = mkdtempSync(join(tmpdir(), "brand-portable-bare-"));
const noModules = await runCli(["workspace", "example-posters", "--out", join(work, "ws-bare")], env, exRepos, exBlobs, { repoRoot: bare });
assert.equal(noModules.exitCode, 0, noModules.lines.join("\n"));
assert.match(noModules.lines.join("\n"), /Aviso: el motor no tiene node_modules instalado/);
assert.equal(existsSync(join(work, "ws-bare", "node_modules")), false);
assert.equal(JSON.parse(readFileSync(join(work, "ws-bare", "workspace.json"), "utf-8")).engineModules, null);

// A link the system refuses (Windows without Developer Mode: EPERM) is the same warning, never a failure, and nothing half-built is left.
mkdirSync(join(bare, "node_modules"));
const refusedLink = await runCli(["workspace", "example-posters", "--out", join(work, "ws-eperm")], env, exRepos, exBlobs, { repoRoot: bare, link: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } });
assert.equal(refusedLink.exitCode, 0, refusedLink.lines.join("\n"));
assert.match(refusedLink.lines.join("\n"), /Aviso: no se pudo enlazar node_modules del motor \(el sistema rechazó el enlace\); las herramientas no podrán/);
assert.equal(existsSync(join(work, "ws-eperm", "node_modules")), false);
assert.equal(JSON.parse(readFileSync(join(work, "ws-eperm", "workspace.json"), "utf-8")).engineModules, null);
assert.deepEqual(readdirSync(work).filter((f) => f.endsWith(".tmp")), []);

// The tool runs from the workspace: it resolves `playwright` through the link. playwright is a root dependency, so a missing one is a failure.
assert.ok(hasModules && existsSync(join(repoRoot, "node_modules", "playwright")), "the engine has no node_modules/playwright: run `pnpm install` at the repo root");
const checked = spawnSync(process.execPath, [join(out, "scripts", "render-sample.mjs"), "--check"], { encoding: "utf-8", timeout: 60_000 });
assert.equal(checked.stdout.trim(), "ok", checked.stderr);
const missing = spawnSync(process.execPath, [join(out, "scripts", "render-sample.mjs")], { encoding: "utf-8", timeout: 60_000 });
assert.equal(missing.status, 2);
assert.match(missing.stderr, /Falta la carpeta de salida/);
console.log("portable brand tools: ok");
