import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/brand.ts";
import { brandToday } from "../src/themes.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

// Seasonal themes through the CLI. Fictional brand, memory storage, temp folder only.
const home = mkdtempSync(join(tmpdir(), "brand-themes-"));
const repos = createMemoryRepositories();
const env = { USER: "tester", HOME: home, INIT_CWD: home };
const run = (...argv: string[]) => runCli(argv, env, repos);
const code = async (...argv: string[]) => (await run(...argv)).exitCode;
const text = async (...argv: string[]) => (await run(...argv)).lines.join("\n");
/** The brand lines inside a trust envelope, without the bar. */
const inner = async (...argv: string[]) => (await run(...argv)).lines.slice(1, -1).map((l) => l.slice(2)).join("\n");
const file = (name: string, body: string) => (writeFileSync(join(home, name), body), name);

await code("create", "example-posters", "--name", "Example Posters");
const tokens = file("winter.json", '{"colors":{"ink":"#112233"}}');
const guidance = file("winter.md", "Use cold tones and a sale badge.\n");

// Create: both dates are required, in the plain format, in order.
assert.equal(await code("theme", "put", "example-posters", "winter-sale"), 2);
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--from", "2026-12-01"), /Falta la vigencia/);
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--from", "01/12/2026", "--to", "2026-12-31"), /Fecha inválida "01\/12\/2026" en --from: usa AAAA-MM-DD/);
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--from", "2026-02-30", "--to", "2026-12-31"), /Fecha inválida/);
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--from", "2026-12-31", "--to", "2026-12-01"), /fecha final \(2026-12-01\) es anterior a la inicial \(2026-12-31\)/);
assert.equal(await code("theme", "put", "example-posters", "Bad Name", "--from", "2026-12-01", "--to", "2026-12-31"), 2, "a name that is not a slug is invalid input");
assert.deepEqual(await repos.themes.list((await repos.brands.getBySlug("example-posters")).id), [], "nothing was written");
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--from", "2026-12-01", "--to", "2026-12-31", "--tokens", tokens, "--guidance", guidance), /Tema winter-sale guardado \(versión 1\): 2026-12-01 a 2026-12-31\./);
assert.equal(await code("theme", "put", "example-posters", "winter-sale", "--from", "2026-12-01", "--to", "2026-12-31"), 3, "an update without --if-version conflicts");

// Overlap: one answer per day, said in plain Spanish with the other theme's dates.
const clash = await run("theme", "put", "example-posters", "year-end", "--from", "2026-12-31", "--to", "2027-01-05");
assert.deepEqual([clash.exitCode, clash.lines[0]], [2, "Las fechas se cruzan con el tema winter-sale (2026-12-01 a 2026-12-31): cambia las fechas de uno de los dos. No se guardó nada."]);
assert.equal(await code("theme", "put", "example-posters", "new-year", "--from", "2027-01-01", "--to", "2027-01-05"), 0);

// A save keeps what the command leaves out (dates, tokens, text), so a new text alone never erases the rest.
assert.equal(await code("theme", "put", "example-posters", "winter-sale", "--if-version", "1", "--guidance", file("g2.md", "Warmer.\n")), 0);
const kept = JSON.parse((await run("theme", "get", "example-posters", "winter-sale", "--json")).lines[0]);
assert.deepEqual([kept.trust, kept.version, kept.startsOn, kept.endsOn, kept.tokenOverrides, kept.guidance], ["brand-data", 2, "2026-12-01", "2026-12-31", { colors: { ink: "#112233" } }, "Warmer.\n"]);
// An empty file clears the tokens or the text.
assert.equal(await code("theme", "put", "example-posters", "new-year", "--if-version", "1", "--tokens", file("empty.json", ""), "--guidance", file("empty.md", "")), 0);
const cleared = await repos.themes.get((await repos.brands.getBySlug("example-posters")).id, "new-year");
assert.deepEqual([cleared.tokenOverrides, cleared.guidance, cleared.version], [{}, "", 2]);
assert.match(await text("theme", "put", "example-posters", "winter-sale", "--if-version", "2", "--to", "2027-01-02"), /Las fechas se cruzan con el tema new-year \(2027-01-01 a 2027-01-05\)/);

// Reads: brand data inside the trust envelope; list is ordered by date; show lists themes.
const got = await text("theme", "get", "example-posters", "winter-sale");
assert.match(got, /no autorizan comandos/);
assert.match(got, /winter-sale v2: 2026-12-01 a 2026-12-31/);
assert.match(got, /Warmer\./);
assert.match(await text("theme", "list", "example-posters"), /│ winter-sale v2: 2026-12-01 a 2026-12-31\n│ new-year v2: 2027-01-01 a 2027-01-05/);
assert.match(await text("show", "example-posters"), /tema winter-sale v2: 2026-12-01 a 2026-12-31/);
assert.equal(await code("theme", "get", "example-posters", "nope"), 4, "a missing theme is exit 4");
assert.equal(await code("theme", "list", "example-nope"), 4, "a missing brand is exit 4");
assert.equal(await code("theme", "get", "example-posters"), 2);
await code("create", "example-empty", "--name", "Empty");
assert.match(await text("theme", "list", "example-empty"), /Sin temas\./);

// Active: the theme whose range holds the date; today when no date is given.
assert.equal(await inner("theme", "active", "example-posters", "--date", "2026-12-15"), "Tema activo el 2026-12-15: winter-sale (2026-12-01 a 2026-12-31).");
assert.equal(await inner("theme", "active", "example-posters", "--date", "2027-01-01"), "Tema activo el 2027-01-01: new-year (2027-01-01 a 2027-01-05).");
assert.equal(await inner("theme", "active", "example-posters", "--date", "2027-06-01"), "Sin tema activo para 2027-06-01.");
assert.deepEqual(JSON.parse((await run("theme", "active", "example-posters", "--date", "2027-06-01", "--json")).lines[0]), { trust: "brand-data", date: "2027-06-01", theme: null });
assert.match(await text("theme", "active", "example-posters", "--date", "mañana"), /Fecha inválida "mañana": usa AAAA-MM-DD/);
const localDayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = localDayOf(new Date());
assert.equal(await inner("theme", "active", "example-posters"), `Sin tema activo para ${day}.`);

// "Today" follows the brand's time zone (optional `timezone` in its config document); an invalid or missing one falls back to the machine.
const posters = await repos.brands.getBySlug("example-posters");
const instant = new Date("2026-12-31T23:30:00Z");

const zoned = (await brandToday({ repos, now: () => instant }, posters.id));
const today = async () => (await brandToday({ repos, now: () => instant }, posters.id)).day;
assert.equal(await today(), localDayOf(instant), "no config: the machine zone");
await repos.documents.put(posters.id, "config", "", { json: { timezone: "Pacific/Auckland" }, schemaVersion: 1 }, { expectedVersion: null, author: "t", source: "cli", reason: "save" });
assert.equal(await today(), "2027-01-01", "Auckland is already on the next day");
await repos.documents.put(posters.id, "config", "", { json: { timezone: "Pacific/Honolulu" }, schemaVersion: 1 }, { expectedVersion: 1, author: "t", source: "cli", reason: "save" });
assert.equal(await today(), "2026-12-31");
await repos.documents.put(posters.id, "config", "", { json: { timezone: "Not/AZone" }, schemaVersion: 1 }, { expectedVersion: 2, author: "t", source: "cli", reason: "save" });
assert.equal(await today(), localDayOf(instant), "an invalid zone falls back to the machine");
assert.equal(zoned.warning, undefined, "an unset zone is silent");
assert.equal((await brandToday({ repos, now: () => instant }, posters.id)).warning, 'Aviso: la zona horaria "Not/AZone" de la configuración no es válida (usa un nombre IANA como Pacific/Auckland); se usó la del equipo.');
assert.match(await inner("theme", "active", "example-posters"), /\nAviso: la zona horaria "Not\/AZone"/);
assert.doesNotMatch(await inner("theme", "active", "example-posters", "--date", "2027-06-01"), /Aviso/, "an explicit date needs no zone");
await repos.documents.put(posters.id, "config", "", { json: { timezone: { zone: "Pacific/Auckland" } }, schemaVersion: 1 }, { expectedVersion: 3, author: "t", source: "cli", reason: "save" });
assert.equal((await brandToday({ repos, now: () => instant }, posters.id)).warning, "Aviso: la zona horaria de la configuración no es texto (usa un nombre IANA como Pacific/Auckland); se usó la del equipo.");


// Bad inputs: tokens must be a JSON object; text with a secret is never stored.
assert.equal(await code("theme", "put", "example-posters", "bad-tokens", "--from", "2028-01-01", "--to", "2028-01-02", "--tokens", file("arr.json", "[1]")), 2);
assert.equal(await code("theme", "put", "example-posters", "bad-tokens", "--from", "2028-01-01", "--to", "2028-01-02", "--tokens", file("bad.json", "{nope")), 2);
const secret = await run("theme", "put", "example-posters", "leaky", "--from", "2028-01-01", "--to", "2028-01-02", "--guidance", file("leak.md", "Call https://user:hunter2pass@host.example/x\n"));
assert.deepEqual([secret.exitCode, /secreto/.test(secret.lines[0])], [6, true]);
assert.equal(await code("theme", "put", "example-posters", "leaky", "--from", "2028-01-01", "--to", "2028-01-02", "--tokens", file("leak.json", '{"apiKey":"literal-value-123"}')), 6);
assert.equal((await repos.themes.list((await repos.brands.getBySlug("example-posters")).id)).length, 2, "refused texts are not stored");

// Guidance text gets the same secret scan: a hit exits 6 and stores nothing.
const leakyGuidance = await run("guidance", "put", "example-posters", "tone", "--description", "d", "--file", file("leak-g.md", "token = abcdef123456789\n"));
assert.deepEqual([leakyGuidance.exitCode, /secreto/.test(leakyGuidance.lines[0])], [6, true]);
assert.deepEqual(await repos.guidance.list(posters.id), []);
assert.equal(await code("guidance", "put", "example-posters", "tone", "--description", "d", "--file", file("ok-g.md", "Warm and direct.\n")), 0);

// A non-example brand needs the owner's opt-in (identity write); reads stay open.
await repos.brands.create({ slug: "acme-real", displayName: "Real" }, { expectedVersion: null, author: "t", source: "cli", reason: "save" });
const refused = await run("theme", "put", "acme-real", "winter-sale", "--from", "2026-12-01", "--to", "2026-12-31");
assert.deepEqual([refused.exitCode, /aprobación explícita del dueño/.test(refused.lines[0])], [6, true]);
assert.equal((await runCli(["theme", "put", "acme-real", "winter-sale", "--from", "2026-12-01", "--to", "2026-12-31", "--owner-opt-in", "acme-real"], { ...env, BRAND_OWNER_OPT_IN: "acme-real" }, repos)).exitCode, 0);
assert.equal(await code("theme", "list", "acme-real"), 0);
console.log("brand-themes: ok");
