import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeObjectStore } from "../src/blob/index.ts";
import { runCli } from "../src/cli/brand.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";
import { applyThemeOverrides, missingThemeFonts } from "../src/themes.ts";

// The overlay rule, then `brand workspace` carrying the theme active on a day. Fictional brand, placeholder colors, temp folders.
const base = { colors: { ink: "#111111", paper: "#ffffff" }, categories: ["a", "b"], copy: { site: "example.test" } };
const merged = applyThemeOverrides(base, { colors: { ink: "#222222" }, categories: ["c"], extra: { deep: 1 } }) as typeof base & { extra: unknown };
assert.deepEqual(merged, { colors: { ink: "#222222", paper: "#ffffff" }, categories: ["c"], copy: { site: "example.test" }, extra: { deep: 1 } }, "objects merge, arrays and scalars replace");
assert.deepEqual(base.colors, { ink: "#111111", paper: "#ffffff" }, "the input is not mutated");
const hostile = applyThemeOverrides(base, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"colors":{"prototype":1,"ink":"#333333"}}')) as { colors: Record<string, unknown> };
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.equal(Object.hasOwn(hostile, "constructor"), false);
assert.deepEqual(hostile.colors, { ink: "#333333", paper: "#ffffff" });
assert.deepEqual(applyThemeOverrides(base, {}), base, "no overrides, same tokens");
const deep = applyThemeOverrides(base, JSON.parse('{"copy":{"nested":{"__proto__":{"p":1},"ok":1}},"list":[{"constructor":1,"k":2}]}')) as { copy: { nested: Record<string, unknown> }; list: Array<Record<string, unknown>> };
assert.deepEqual([Object.keys(deep.copy.nested), Object.keys(deep.list[0]!)], [["ok"], ["k"]], "prototype keys are dropped at every depth");
assert.deepEqual(missingThemeFonts({ fonts: { logo: "'Example Display', serif", body: "Georgia, serif" } }, ["example sans"]), ["Example Display"]);
assert.deepEqual(missingThemeFonts({ fonts: { logo: "Example Sans, serif" } }, ["Example Sans"]), []);

const work = mkdtempSync(join(tmpdir(), "brand-theme-overlay-"));
const repos = createMemoryRepositories();
const env = { USER: "tester", HOME: work, INIT_CWD: work };
const run = (...argv: string[]) => runCli(argv, env, repos, new FakeObjectStore());
const write = (name: string, body: string) => (writeFileSync(join(work, name), body), join(work, name));
assert.equal((await run("create", "example-posters", "--name", "Example Posters")).exitCode, 0);
assert.equal((await run("doc", "put", "example-posters", "tokens", "--file", write("t.json", JSON.stringify(base)))).exitCode, 0);
assert.equal((await run("theme", "put", "example-posters", "winter-sale", "--from", "2026-12-01", "--to", "2026-12-31", "--tokens", write("o.json", '{"colors":{"ink":"#abcdef"}}'), "--guidance", write("g.md", "Cold tones.\n"))).exitCode, 0);

const ws = async (name: string, ...extra: string[]) => {
  const out = join(work, name);
  const r = await run("workspace", "example-posters", "--out", out, ...extra);
  assert.equal(r.exitCode, 0, r.lines.join("\n"));
  return { out, text: r.lines.join("\n"), tokens: () => JSON.parse(readFileSync(join(out, "brand.json"), "utf-8")), manifest: () => JSON.parse(readFileSync(join(out, "workspace.json"), "utf-8")) };
};

// Inside the range, both ends included: the override, the guidance and the manifest entry.
for (const day of ["2026-12-01", "2026-12-15", "2026-12-31"]) {
  const w = await ws(`in-${day}`, "--date", day);
  assert.equal(w.tokens().colors.ink, "#abcdef", day);
  assert.equal(w.tokens().colors.paper, "#ffffff", "the rest of the brand is untouched");
  assert.deepEqual(w.manifest().theme, { name: "winter-sale", version: 1, startsOn: "2026-12-01", endsOn: "2026-12-31" });
  assert.match(w.text, /Tema activo: winter-sale \(del 2026-12-01 al 2026-12-31\)\./);
  assert.match(readFileSync(join(w.out, "skills/tema-winter-sale/SKILL.md"), "utf-8"), /^---\nname: tema-winter-sale\n[\s\S]*Cold tones\./);
}
// Outside: nothing changes, nothing is said.
for (const day of ["2026-11-30", "2027-01-01"]) {
  const w = await ws(`out-${day}`, "--date", day);
  assert.equal(w.tokens().colors.ink, "#111111", day);
  assert.equal(w.manifest().theme, null);
  assert.doesNotMatch(w.text, /Tema activo/);
  assert.equal(existsSync(join(w.out, "skills/tema-winter-sale")), false);
}
// A theme naming a font the brand does not hold warns; the guidance name `tema-…` is reserved.
await repos.themes.put((await repos.brands.getBySlug("example-posters")).id, "winter-sale", { startsOn: "2026-12-01", endsOn: "2026-12-31", tokenOverrides: { fonts: { logo: "Example Display, serif" } }, guidance: "Cold tones.\n" }, { expectedVersion: 1, author: "t", source: "cli", reason: "save" });
assert.match((await ws("font-warn", "--date", "2026-12-10")).text, /Aviso: el tema winter-sale usa la fuente Example Display y la marca no la tiene como asset/);
const reserved = await run("guidance", "put", "example-posters", "tema-winter-sale", "--description", "d", "--file", write("g2.md", "x\n"));
assert.deepEqual([reserved.exitCode, /reservado/.test(reserved.lines[0])], [2, true]);
// Default date is the brand's today: an invalid zone warns once and the machine day decides.
const posters = await repos.brands.getBySlug("example-posters");
await repos.documents.put(posters.id, "config", "", { json: { timezone: "Not/AZone" }, schemaVersion: 1 }, { expectedVersion: null, author: "t", source: "cli", reason: "save" });
assert.match((await ws("zone")).text, /Aviso: la zona horaria "Not\/AZone" de la configuración no es válida/);
const bad = await run("workspace", "example-posters", "--out", join(work, "bad-date"), "--date", "mañana");
assert.deepEqual([bad.exitCode, bad.lines[0]], [2, 'Fecha inválida "mañana": usa AAAA-MM-DD.']);
assert.equal(existsSync(join(work, "bad-date")), false);
console.log("brand-theme-overlay: ok");
