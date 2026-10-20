import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { resolveBrandSource } from "../src/brand-source.ts";
import { isLocalDatabase, runCli } from "../src/cli/brand.ts";
import { createMemoryRepositories, type MemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories } from "../src/pg/index.ts";
import { migrate } from "../src/pg/migrate.ts";

const example = join(import.meta.dirname, "..", "..", "profiles", "example");
const work = mkdtempSync(join(tmpdir(), "brand-cli-"));
const identity = (b: unknown) => b;

/** A throwaway copy of the fictional example brand plus one guidance skill, under the given slug. */
function fixture(label: string, slug: string): string {
  const dir = join(work, label, slug);
  cpSync(example, dir, { recursive: true });
  mkdirSync(join(dir, "skills", "tone"), { recursive: true });
  writeFileSync(join(dir, "skills", "tone", "SKILL.md"), "---\nname: tone\ndescription: How this brand sounds\n---\nBe warm.\n");
  return dir;
}

async function scenario(label: string, repos: MemoryRepositories): Promise<void> {
  const env = { USER: "tester" };
  let recorded = 0;
  const spied = { ...repos, importRuns: { record: (i: Parameters<typeof repos.importRuns.record>[0]) => (recorded++, repos.importRuns.record(i)) } };
  const run = (...argv: string[]) => runCli(argv, env, spied);
  const dir = fixture(label, "acme-coffee");
  const REMOTE = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };

  assert.equal((await run()).exitCode, 2, "no verb prints usage");
  const remote = await runCli(["import", "--from", dir], REMOTE, repos);
  assert.equal(remote.exitCode, 1);
  assert.match(remote.lines[0], /remota/);
  const noUrl = await runCli(["import", "--from", dir], {});
  assert.deepEqual([noUrl.exitCode, /DATABASE_URL/.test(noUrl.lines[0])], [1, true], "a missing DATABASE_URL is a clean message, not a stack trace");

  // Each verb accepts only its own flags; a typo never swallows the next argument or reaches a verb that cannot honor it.
  const noDryRun = await runCli(["cutover", "acme-coffee", "--confirm", "acme-coffee", "--dry-run", "--from", dir], REMOTE, repos);
  assert.equal(noDryRun.exitCode, 2, "cutover has no --dry-run, so the remote gate cannot be skipped");
  assert.equal((await run("import", "--dryrun", "--from", dir)).exitCode, 2);
  assert.equal((await run("import", "--from")).exitCode, 2);
  assert.equal((await run("import", "--from", dir, "stray")).exitCode, 2);
  assert.deepEqual(await repos.brands.list(), [], "refused invocations write nothing");

  const dry = await run("import", "--from", dir, "--dry-run");
  assert.equal(dry.exitCode, 0);
  assert.match(dry.lines.join("\n"), /simulacro/);
  assert.equal((await runCli(["import", `--from=acme-coffee`, "--dry-run"], { INIT_CWD: join(work, label) }, repos)).exitCode, 0, "relative --from resolves against INIT_CWD");
  assert.deepEqual(await repos.brands.list(), [], "a dry run writes nothing, not even the brand");

  const first = await run("import", "--from", dir);
  assert.equal(first.exitCode, 0, first.lines.join("\n"));
  const brand = await repos.brands.getBySlug("acme-coffee");
  assert.deepEqual((await repos.guidance.get(brand.id, "tone")).body, "Be warm.\n");
  assert.ok((await repos.recipes.get(brand.id, "reel-week", identity)).value);
  assert.match((await repos.documents.get(brand.id, "identity", "", identity)).value as string, /^# Perfil/);
  assert.ok((await repos.documents.get(brand.id, "tokens", "", identity)).value);
  assert.ok((await repos.documents.get(brand.id, "config", "", identity)).value);
  assert.match(first.lines.join("\n"), /no importado:.*assets/);
  const revisions = (await repos.revisions.list("brand_document", (await repos.documents.get(brand.id, "spec", "", identity)).id)).length;

  const again = await run("import", "--from", dir);
  assert.match(again.lines.join("\n"), /Creados 0, actualizados 0, sin cambios 6, conflictos 0/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).version, 1, "re-run is a no-op");
  assert.equal((await repos.revisions.list("brand_document", (await repos.documents.get(brand.id, "spec", "", identity)).id)).length, revisions);
  assert.equal(recorded, 2, "each real pass is logged");

  writeFileSync(join(dir, "brand-spec.md"), "# Changed spec\n");
  assert.match((await run("import", "--from", dir)).lines.join("\n"), /actualizados 1/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).version, 2);

  // A write that lands between classify and write is reported as a conflict; the pass still finishes and is logged.
  writeFileSync(join(dir, "skills", "tone", "SKILL.md"), "---\ndescription: new\n---\nSource moved on\n");
  const racing = { ...spied, guidance: { ...repos.guidance, put: async (...a: Parameters<typeof repos.guidance.put>) => {
    await repos.guidance.put(brand.id, "tone", { description: "x", body: "Racing edit" }, { expectedVersion: 1, author: "editor", source: "editor", reason: "save" });
    return repos.guidance.put(...a);
  } } };
  const before = recorded;
  const raced = await runCli(["import", "--from", dir], env, racing);
  assert.equal(raced.exitCode, 1);
  assert.match(raced.lines.join("\n"), /conflict guidance:tone/);
  assert.equal(recorded, before + 1, "a pass with a conflict still records its import run");
  assert.equal((await repos.guidance.get(brand.id, "tone")).body, "Racing edit");

  // Edited in storage, source untouched since the last import: still a conflict, never "unchanged".
  const spec = await repos.documents.get(brand.id, "spec", "", identity);
  await repos.documents.put(brand.id, "spec", "", { text: "Edited in storage", schemaVersion: 1 }, { expectedVersion: spec.version, author: "editor", source: "editor", reason: "save" });
  const edited = await run("import", "--from", dir);
  assert.match(edited.lines.join("\n"), /conflict document:spec/);
  assert.equal((await repos.documents.get(brand.id, "spec", "", identity)).value, "Edited in storage");
  const refused = await run("cutover", "acme-coffee", "--confirm", "acme-coffee", "--partial", "--from", dir);
  assert.equal(refused.exitCode, 1, "a dirty verification does not cut over");
  assert.equal((await repos.brands.getBySlug("acme-coffee")).value.cutoverAt, null);
  assert.equal(existsSync(join(dir, ".storage-cutover")), false);

  const clean = fixture(label, "other-shop");
  assert.equal((await run("cutover", "other-shop", "--confirm", "nope", "--from", clean)).exitCode, 1);
  assert.equal(existsSync(join(clean, ".storage-cutover")), false, "no marker without a matching --confirm");
  assert.equal(await resolveBrandSource(repos.brands, "other-shop"), "folder");
  const guarded = await run("cutover", "other-shop", "--confirm", "other-shop", "--from", clean);
  assert.equal(guarded.exitCode, 1, "data the importer does not carry yet blocks a cutover without --partial");
  assert.match(guarded.lines[0], /sin importar \(.*assets.*\).*--partial/);
  assert.doesNotMatch(guarded.lines[0], /config\.local/, "files never imported by design are not listed");
  await assert.rejects(() => repos.brands.getBySlug("other-shop"), /Not found/);
  const cut = await run("cutover", "other-shop", "--confirm", "other-shop", "--partial", "--from", clean);
  assert.equal(cut.exitCode, 0, cut.lines.join("\n"));
  const cutBrand = await repos.brands.getBySlug("other-shop");
  assert.ok(cutBrand.value.cutoverAt);
  assert.deepEqual(JSON.parse(readFileSync(join(clean, ".storage-cutover"), "utf-8")), { brandId: cutBrand.id, cutoverAt: cutBrand.value.cutoverAt });
  assert.equal(await resolveBrandSource(repos.brands, "other-shop"), "storage");

  const reimport = await run("import", "--from", clean);
  assert.equal(reimport.exitCode, 1);
  assert.match(reimport.lines[0], /ya fue cortada/);
  assert.match((await run("cutover", "other-shop", "--confirm", "other-shop", "--from", clean)).lines[0], /marcador presente/);
  unlinkSync(join(clean, ".storage-cutover"));
  assert.match((await run("cutover", "other-shop", "--confirm", "other-shop", "--from", clean)).lines[0], /marcador restituido/);
  assert.deepEqual(JSON.parse(readFileSync(join(clean, ".storage-cutover"), "utf-8")), { brandId: cutBrand.id, cutoverAt: cutBrand.value.cutoverAt }, "a deleted marker is restored");

  // A planted dangling symlink is never followed.
  const planted = fixture(label, "planted-shop");
  symlinkSync(join(work, "nowhere"), join(planted, ".storage-cutover"));
  assert.equal((await run("cutover", "planted-shop", "--confirm", "planted-shop", "--from", planted)).exitCode, 1);
  assert.equal(existsSync(join(work, "nowhere")), false);
  assert.equal((await repos.brands.getBySlug("planted-shop").catch(() => null)), null, "refused before importing anything");
  // Name must match the slug; the profiles root comes from BRAND_PROFILES_DIR (a temp dir here, never <repo>/profiles).
  assert.match((await run("cutover", "acme-coffee", "--confirm", "acme-coffee", "--partial", "--from", clean)).lines[0], /igual que la marca/);
  fixture(label, "home-shop");
  const home = await runCli(["cutover", "home-shop", "--confirm", "home-shop", "--partial"], { ...env, BRAND_PROFILES_DIR: join(work, label) }, spied);
  assert.equal(home.exitCode, 0, home.lines.join("\n"));
  assert.equal(existsSync(join(work, label, "home-shop", ".storage-cutover")), true);

  // The marker cannot be written after markCutover: the brand is cut over, the message says so, and a re-run restores it.
  const locked = fixture(label, "locked-shop");
  chmodSync(locked, 0o555);
  try {
    const failed = await run("cutover", "locked-shop", "--confirm", "locked-shop", "--partial", "--from", locked);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.lines[0], /quedó cortada en storage.*Vuelve a ejecutar/);
    assert.ok((await repos.brands.getBySlug("locked-shop")).value.cutoverAt);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.match((await run("cutover", "locked-shop", "--confirm", "locked-shop", "--from", locked)).lines[0], /marcador restituido/);

  // A concurrent cutover wrote this brand's marker first: that is success, not an error.
  const twin = fixture(label, "twin-shop");
  const twinned = { ...spied, brands: { ...repos.brands, markCutover: async (...a: Parameters<typeof repos.brands.markCutover>) => {
    const done = await repos.brands.markCutover(...a);
    writeFileSync(join(twin, ".storage-cutover"), JSON.stringify({ brandId: done.id, cutoverAt: done.value.cutoverAt }));
    return done;
  } } };
  const twinRun = await runCli(["cutover", "twin-shop", "--confirm", "twin-shop", "--partial", "--from", twin], env, twinned);
  assert.deepEqual([twinRun.exitCode, /ya estaba cortada/.test(twinRun.lines[0])], [0, true]);

  // Entries passed over are reported, and a symlink is never followed out of the folder.
  const edge = fixture(label, "edge-shop");
  mkdirSync(join(edge, "skills", "empty"));
  writeFileSync(join(edge, "recipes", "notes.txt"), "not a recipe");
  writeFileSync(join(work, "outside.yaml"), "recipe: outside\n");
  symlinkSync(join(work, "outside.yaml"), join(edge, "recipes", "linked.yaml"));
  mkdirSync(join(work, "outside-skill"), { recursive: true });
  writeFileSync(join(work, "outside-skill", "SKILL.md"), "---\ndescription: x\n---\nOutside\n");
  symlinkSync(join(work, "outside-skill"), join(edge, "skills", "escaped"));
  const edgeRun = await run("import", "--from", edge);
  assert.equal(edgeRun.exitCode, 0, edgeRun.lines.join("\n"));
  assert.match(edgeRun.lines.join("\n"), /Omitidos: .*skills\/empty\/SKILL\.md \(missing\).*recipes\/linked\.yaml \(not a regular file\).*recipes\/notes\.txt \(not a \.yaml file\)/);
  await assert.rejects(async () => repos.recipes.get((await repos.brands.getBySlug("edge-shop")).id, "linked", identity), /Not found/);
  assert.match(edgeRun.lines.join("\n"), /skills\/escaped\/SKILL\.md \(outside the folder\)/, "a symlinked directory pointing out of the folder is not read");
  await assert.rejects(async () => repos.guidance.get((await repos.brands.getBySlug("edge-shop")).id, "escaped"), /Not found/);
  symlinkSync(edge, join(work, label, "linked-shop"));
  assert.match((await run("import", "--from", join(work, label, "linked-shop"), "--dry-run")).lines.join("\n"), /created document:tokens/, "the brand folder itself may be a symlink");

  // A brand created by a concurrent importer is adopted; it does not abort the pass.
  const raceDir = fixture(label, "race-shop");
  const creating = { ...spied, brands: { ...repos.brands, create: async (...a: Parameters<typeof repos.brands.create>) => {
    await repos.brands.create({ slug: "race-shop", displayName: "other importer" }, a[1]);
    return repos.brands.create(...a);
  } } };
  assert.equal((await runCli(["import", "--from", raceDir], env, creating)).exitCode, 0);
  assert.equal((await repos.documents.get((await repos.brands.getBySlug("race-shop")).id, "tokens", "", identity)).version, 1);

  // A pass that throws part-way still leaves a run row saying so, and the caller sees the original error.
  const reports: Array<Record<string, unknown>> = [];
  const failing = { ...repos, importRuns: { record: (i: Parameters<typeof repos.importRuns.record>[0]) => (reports.push(i.report), repos.importRuns.record(i)) },
    guidance: { ...repos.guidance, put: async () => { throw new Error("disk full"); } } };
  const aborted = await runCli(["import", "--from", fixture(label, "abort-shop")], env, failing);
  assert.deepEqual([aborted.exitCode, aborted.lines[0]], [1, "Error: disk full"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].aborted, "disk full");
  assert.ok((reports[0].counts as { created: number }).created >= 4, "the items done before the failure are counted");

  // If recording the aborted run fails too, that is warned about and the original error is still the one reported.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  try {
    const both = { ...failing, importRuns: { record: async () => { throw new Error("db gone"); } } };
    assert.equal((await runCli(["import", "--from", fixture(label, "abort2-shop")], env, both)).lines[0], "Error: disk full");
  } finally {
    console.warn = warn;
  }
  assert.match(warnings[0], /Could not record the aborted import run: db gone/);

  // Remaining CLI error branches.
  assert.match((await run("import", "--from", join(work, label, "nope"))).lines[0], /No existe la carpeta/);
  const empty = join(work, label, "empty-shop");
  mkdirSync(empty);
  assert.deepEqual((await run("import", "--from", empty)).lines, [`Error: Nothing to import under ${empty}`]);

  console.log(`  ok - ${label}: import, no-op re-run, conflict, cutover`);
}

// Hosts the backup gate treats as local, and everything else (lookalikes, multi-host, sockets, `?host=`, short IPv4) as remote.
for (const url of ["postgres://u:p@localhost:5442/db", "postgres://u@127.0.0.1/db", "postgres://u@[::1]:5432/db"]) assert.equal(isLocalDatabase(url), true, url);
for (const url of ["postgres://u@localhost.evil.com/db", "postgres://localhost,evil.com/db", "postgres://localhost:1,evil.com:2/db", "postgres:///db", "postgres://%2Fvar%2Frun%2Fpostgresql/db", "postgres://u@127.1/db", "postgres://localhost/db?host=evil.com", "not a url"]) {
  assert.equal(isLocalDatabase(url), false, url);
}

try {
  await scenario("memory", createMemoryRepositories());
  const url = process.env.DATABASE_URL;
  if (!url) console.log("SKIP postgres brand cli - DATABASE_URL not set");
  else {
    const admin = postgres(url, { connect_timeout: 3, onnotice: () => {} });
    const schema = `test_${randomBytes(6).toString("hex")}`;
    try {
      await migrate(admin, { schema });
      const u = new URL(url);
      u.username = "brand_owner";
      u.password = "local-dev-only";
      const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner'`;
      const sql = postgres(role ? u.toString() : url, { connection: { search_path: schema }, onnotice: () => {} });
      try {
        await scenario("postgres", createPgRepositories(sql) as MemoryRepositories);
      } finally {
        await sql.end({ timeout: 1 });
      }
    } finally {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("brand cli: ok");
