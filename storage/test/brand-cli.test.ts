import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

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

  // Unknown flags and verbs print usage; a typo never swallows the next argument.
  assert.equal((await run("bogus")).exitCode, 2, "unknown verb");
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
  assert.equal((await repos.brands.getBySlug("acme-coffee")).value.cutoverAt, null);

  console.log(`  ok - ${label}: import, no-op re-run, conflict`);
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
