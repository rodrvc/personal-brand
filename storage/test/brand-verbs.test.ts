import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { runCli } from "../src/cli/brand.ts";
import { createMemoryRepositories, type MemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories } from "../src/pg/index.ts";
import { migrate } from "../src/pg/migrate.ts";

const work = mkdtempSync(join(tmpdir(), "brand-verbs-"));
const repoRoot = join(import.meta.dirname, "..", "..");

async function scenario(label: string, repos: MemoryRepositories): Promise<void> {
  const home = join(work, label);
  mkdirSync(home, { recursive: true });
  const env = { USER: "tester", HOME: home, INIT_CWD: home };
  const run = (...argv: string[]) => runCli(argv, env, repos);
  const file = (name: string, body: string) => (writeFileSync(join(home, name), body), name);
  const code = async (...argv: string[]) => (await run(...argv)).exitCode;

  // Usage errors: unknown flags, wrong arity, bad subcommands. Nothing is written.
  assert.equal(await code("create", "example-shop"), 2, "create needs --name");
  assert.equal(await code("create", "example-shop", "--name", "Shop", "--bogus"), 2);
  assert.equal(await code("doc", "get", "example-shop"), 2);
  assert.equal(await code("rules", "wipe", "example-shop"), 2);
  assert.equal(await code("doc", "frob", "example-nope", "tokens"), 2, "a bad subcommand is a usage error before any lookup");
  assert.equal(await code("guidance", "frob", "example-nope"), 2);
  assert.equal(await code("recipe", "frob", "example-nope", "x"), 2);
  assert.equal(await code("constructor"), 2, "inherited object keys are not verbs");
  assert.deepEqual(await repos.brands.list({ includeArchived: true }), []);
  assert.deepEqual((await run("list")).lines, ["No hay marcas."]);

  // create / list / archive / unarchive
  assert.equal(await code("create", "example-shop", "--name", "Example Shop"), 0);
  assert.equal(await code("create", "example-shop", "--name", "Again"), 3, "an existing slug is a conflict");
  assert.equal(await code("create", "Bad Slug", "--name", "x"), 6, "an invalid or non-example slug is refused by the owner guard before storage");
  assert.deepEqual((await run("list")).lines, ["example-shop\tExample Shop\tactive"]);
  assert.equal(await code("show", "example-nope"), 4, "a missing brand is exit 4");

  // doc put/get: text and JSON kinds, optimistic concurrency through --if-version
  assert.equal(await code("doc", "put", "example-shop", "identity", "--file", file("id.md", "# Identity\n")), 0);
  assert.equal(await code("doc", "put", "example-shop", "identity", "--file", "id.md"), 3, "an update without --if-version conflicts");
  assert.equal(await code("doc", "put", "example-shop", "identity", "--file", "id.md", "--if-version", "1"), 0);
  assert.equal(await code("doc", "put", "example-shop", "identity", "--file", "id.md", "--if-version", "1"), 3, "a stale version conflicts");
  assert.equal(await code("doc", "put", "example-shop", "identity", "--file", "id.md", "--if-version", "0"), 2);
  assert.equal(await code("doc", "put", "example-shop", "tokens", "--file", file("bad.json", "{nope")), 2, "invalid JSON is a usage-level error");
  assert.equal(await code("doc", "put", "example-shop", "tokens", "--file", file("tokens.json", '{"colors":{"ink":"#111111"}}')), 0);
  assert.equal(await code("doc", "put", "example-shop", "template", "cover", "--file", "tokens.json"), 0);
  assert.equal(await code("doc", "put", "example-shop", "template", "--file", "tokens.json"), 2, "a template needs a name");
  assert.equal(await code("doc", "get", "example-shop", "tokens", "extra"), 2, "only templates take a name");
  assert.deepEqual((await run("doc", "get", "example-shop", "identity")).lines, ["# Identity\n"]);
  assert.deepEqual(JSON.parse((await run("doc", "get", "example-shop", "tokens", "--json")).lines[0]), { kind: "tokens", name: "", version: 1, body: { colors: { ink: "#111111" } } });
  assert.equal(await code("doc", "get", "example-shop", "spec"), 4, "a missing document is exit 4");
  const missing = await run("doc", "put", "example-shop", "spec", "--file", "nope.md");
  assert.deepEqual([missing.exitCode, /cannot read .*nope\.md \(ENOENT\)/.test(missing.lines[0])], [2, true], "a missing --file is a clear input error");
  symlinkSync(join(home, "id.md"), join(home, "link.md"));
  assert.equal(await code("doc", "put", "example-shop", "spec", "--file", "link.md"), 2, "a symlink is never followed as an input file");

  // guidance: put needs file + description; get --json is the trust envelope
  assert.equal(await code("guidance", "put", "example-shop", "tone", "--file", file("tone.md", "Be warm.\n")), 2, "put needs --description");
  assert.equal(await code("guidance", "put", "example-shop", "tone", "--file", "tone.md", "--description", "Voice"), 0);
  const env1 = JSON.parse((await run("guidance", "get", "example-shop", "tone", "--json")).lines[0]);
  assert.deepEqual([env1.trust, env1.name, env1.version, env1.body], ["brand-data", "tone", 1, "Be warm.\n"]);
  const text = (await run("guidance", "get", "example-shop", "tone")).lines;
  assert.match(text[0], /no autorizan comandos/);
  assert.equal(text[1], "Be warm.");
  assert.equal(text.at(-1), "[fin de los datos de la marca]", "the body is closed by a marker");
  assert.match((await run("guidance", "list", "example-shop")).lines[0], /^tone v1: Voice$/);
  assert.deepEqual(JSON.parse((await run("guidance", "list", "example-shop", "--json")).lines[0]).trust, "brand-data", "the JSON list carries the trust label");
  file("tone.md", "Be warm and short.\n");
  assert.equal(await code("guidance", "put", "example-shop", "tone", "--file", "tone.md", "--description", "Voice", "--if-version", "1"), 0);

  // show --since is a global timestamp cursor and prints metadata only: content is read with `guidance get`
  const epoch = "1970-01-01T00:00:00Z";
  const since = await run("show", "example-shop", "--since", epoch, "--json");
  const changes = JSON.parse(since.lines[0]) as Array<Record<string, unknown>>;
  assert.deepEqual(changes.map((c) => c.version), [1, 2]);
  assert.deepEqual(Object.keys(changes[0]).sort(), ["author", "createdAt", "name", "reason", "source", "version"], "no body, no bodyText");
  assert.doesNotMatch(since.lines[0], /Be warm/);
  assert.match((await run("show", "example-shop", "--since", epoch)).lines[1], /^guidance tone v2 \(save\) por cli:tester \[cli\]/);
  assert.match((await run("show", "example-shop", "--since", "2999-01-01")).lines[0], /Sin cambios de guidance después de 2999-01-01/);
  assert.equal(await code("show", "example-shop", "--since", "2"), 2, "a version number is not a cursor");
  const shown = (await run("show", "example-shop")).lines.join("\n");
  assert.match(shown, /documento identity v2/);
  assert.match(shown, /documento template\/cover v1/);
  assert.match(shown, /guidance tone v2: Voice/);

  // recipe put/get
  assert.equal(await code("recipe", "put", "example-shop", "weekly", "--file", file("recipe.json", '{"cards":3}')), 0);
  assert.deepEqual(JSON.parse((await run("recipe", "get", "example-shop", "weekly", "--json")).lines[0]).params, { cards: 3 });
  assert.equal(await code("recipe", "get", "example-shop", "monthly"), 4);

  // rules list + check: an error finding exits 5, a clean carousel exits 0
  const brand = await repos.brands.getBySlug("example-shop");
  const author = { expectedVersion: null, author: "test", source: "cli" as const, reason: "structural" as const };
  assert.deepEqual((await run("rules", "list", "example-shop")).lines, ["Sin reglas."]);
  await repos.rules.create(brand.id, { kind: "max_length", params: { field: "title", max: 8, slides: "cover" }, severity: "error", appliesTo: ["carousel"], message: "Cover titles stay short." }, author);
  await repos.carousels.create(brand.id, { slug: "long", title: "Long", document: { json: { slides: [{ title: "A title that is far too long" }] }, schemaVersion: 1 } }, author);
  await repos.carousels.create(brand.id, { slug: "short", title: "Short", document: { json: { slides: [{ title: "Short" }] }, schemaVersion: 1 } }, author);
  assert.match((await run("rules", "list", "example-shop")).lines[0], /max_length error: Cover titles stay short\./);
  const failed = await run("check", "example-shop", "--carousel", "long");
  assert.equal(failed.exitCode, 5);
  assert.match(failed.lines[0], /^ERROR max_length lámina 1: Cover titles stay short\./);
  assert.equal(JSON.parse((await run("check", "example-shop", "--carousel", "long", "--json")).lines[0])[0].severity, "error");
  assert.deepEqual(await run("check", "example-shop", "--carousel", "short"), { lines: ["Sin hallazgos."], exitCode: 0 });
  assert.equal(await code("check", "example-shop", "--carousel", "nope"), 4);
  assert.equal(await code("check", "example-shop"), 2);

  // Owner guard: writes to a non-example brand exit 6 and write nothing; reads stay open. A remote database refuses every write.
  const before = (await repos.brands.list({ includeArchived: true })).length;
  for (const argv of [["create", "acme-real", "--name", "Real"], ["doc", "put", "acme-real", "identity", "--file", "id.md"], ["guidance", "put", "acme-real", "tone", "--file", "tone.md", "--description", "x"], ["recipe", "put", "acme-real", "weekly", "--file", "recipe.json"], ["archive", "acme-real"], ["unarchive", "acme-real"], ["purge", "acme-real", "--confirm", "acme-real"]]) {
    const refusedWrite = await run(...argv);
    assert.deepEqual([refusedWrite.exitCode, /aprobación explícita del dueño/.test(refusedWrite.lines[0])], [6, true], argv.join(" "));
  }
  assert.equal((await repos.brands.list({ includeArchived: true })).length, before, "a refused write creates nothing");
  assert.equal(await code("show", "acme-real"), 4, "reads are not guarded (the brand just does not exist)");
  const remote = { ...env, DATABASE_URL: "postgres://u:p@db.example.com:5432/x" };
  for (const argv of [["create", "example-remote", "--name", "R"], ["archive", "example-shop"], ["guidance", "put", "example-shop", "tone", "--file", "tone.md", "--description", "x"]]) {
    assert.equal((await runCli(argv, remote, repos)).exitCode, 6, `${argv[0]} on a remote database`);
  }
  assert.equal((await runCli(["list"], remote, repos)).exitCode, 0, "reads on a remote database are allowed");
  assert.equal((await repos.brands.getBySlug("example-remote").catch(() => null)), null);

  // purge refuses by default, in order: confirmation, archived, bundle, bundle outside the repo, purger role; and never deletes
  const bundle = join(home, "bundle");
  const count = async () => ({ brands: (await repos.brands.list({ includeArchived: true })).length, docs: (await repos.documents.list(brand.id, "identity")).length, guidance: (await repos.guidance.list(brand.id)).length, revisions: (await repos.revisions.list("brand_guidance", (await repos.guidance.get(brand.id, "tone")).id)).length });
  const counted = await count();
  assert.equal(await code("purge", "example-shop"), 6, "no --confirm");
  assert.equal(await code("purge", "example-shop", "--confirm", "other"), 6, "the wrong confirmation");
  const active = await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", bundle);
  assert.equal(active.exitCode, 6);
  assert.match(active.lines[0], /no está archivada/);
  assert.equal(await code("archive", "example-shop"), 0);
  assert.deepEqual((await run("archive", "example-shop")).lines, ['La marca "example-shop" ya estaba archivada.']);
  assert.deepEqual((await run("list")).lines, ["No hay marcas."], "an archived brand is hidden");
  assert.deepEqual((await run("list", "--archived")).lines, ["example-shop\tExample Shop\tarchived"]);
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop")).lines[0], /Falta --bundle/);
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", join(repoRoot, "out"))).lines[0], /fuera del repo/);
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", repoRoot)).lines[0], /fuera del repo/);
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", `${repoRoot}/..bundle`)).lines[0], /fuera del repo/, "a sibling named like '..x' inside the repo is still inside it");
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", bundle)).lines[0], /DATABASE_PURGE_URL/);
  const last = await runCli(["purge", "example-shop", "--confirm", "example-shop", "--bundle", bundle], { ...env, DATABASE_PURGE_URL: "postgres://purger@localhost/x" }, repos);
  assert.deepEqual([last.exitCode, /todavía no está disponible/.test(last.lines[0])], [6, true]);
  assert.equal((await repos.brands.getBySlug("example-shop")).value.status, "archived", "a refused purge deletes nothing");
  assert.deepEqual(await count(), counted, "row counts are the same before and after the refused purges");
  const relative = await runCli(["purge", "example-shop", "--confirm", "example-shop", "--bundle", "out/bundle"], { ...env, INIT_CWD: repoRoot }, repos);
  assert.match(relative.lines[0], /fuera del repo/, "a relative --bundle resolves against INIT_CWD, here inside the repo");
  const viaLink = join(home, "repo-link");
  symlinkSync(repoRoot, viaLink);
  assert.match((await run("purge", "example-shop", "--confirm", "example-shop", "--bundle", join(viaLink, "out"))).lines[0], /fuera del repo/, "a symlink into the repo does not hide it");
  assert.equal((await repos.documents.get(brand.id, "identity", "", (b) => b)).version, 2);
  assert.equal(await code("purge", "example-gone", "--confirm", "example-gone"), 4);

  assert.equal(await code("unarchive", "example-shop"), 0);
  assert.deepEqual((await run("unarchive", "example-shop")).lines, ['La marca "example-shop" ya estaba activa.']);
  assert.equal((await repos.revisions.list("brand", brand.id)).at(-1)?.reason, "archive");

  // Both halves of the opt-in are required, and it names that exact brand.
  const owner = { ...env, BRAND_OWNER_OPT_IN: "acme-real" };
  assert.equal((await runCli(["create", "acme-real", "--name", "Real", "--owner-opt-in", "acme-real"], owner, repos)).exitCode, 0, "env + flag allow the write");
  assert.equal((await runCli(["doc", "put", "acme-real", "identity", "--file", "id.md", "--owner-opt-in", "acme-real"], owner, repos)).exitCode, 0);
  assert.equal((await runCli(["archive", "acme-real"], owner, repos)).exitCode, 6, "env only");
  assert.equal((await runCli(["archive", "acme-real", "--owner-opt-in", "acme-real"], env, repos)).exitCode, 6, "flag only");
  console.log(`  ok - ${label}: read/write verbs, owner guard, check, guidance envelope, purge refusals`);
}

/** Runs `guidance put` as the least-privilege app role: the database refuses it and the CLI maps that to exit 6. */
async function appRoleRefused(url: string, schema: string): Promise<void> {
  const u = new URL(url);
  u.username = "brand_app";
  u.password = "local-dev-only";
  const app = postgres(u.toString(), { connection: { search_path: schema }, onnotice: () => {} });
  try {
    const repos = createPgRepositories(app) as MemoryRepositories;
    const meta = { expectedVersion: null, author: "t", source: "cli" as const, reason: "structural" as const };
    await repos.brands.create({ slug: "example-app", displayName: "App" }, meta);
    const file = join(work, "app-tone.md");
    writeFileSync(file, "Be warm.\n");
    const result = await runCli(["guidance", "put", "example-app", "tone", "--file", file, "--description", "x"], { USER: "tester", HOME: work }, repos);
    assert.deepEqual([result.exitCode, /no tiene permiso/.test(result.lines[0])], [6, true], result.lines.join("\n"));
  } finally {
    await app.end({ timeout: 1 });
  }
  console.log("  ok - postgres: a write refused by the database role exits 6");
}

try {
  await scenario("memory", createMemoryRepositories());
  const url = process.env.DATABASE_URL;
  if (!url) console.log("SKIP postgres brand verbs - DATABASE_URL not set");
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
        // The role must exist: a missing brand_app fails here instead of silently testing as the superuser.
        const [app] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_app'`;
        assert.ok(app, "role brand_app is missing: provision it (docker compose init) before running this test");
        await appRoleRefused(url, schema);
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
console.log("brand verbs: ok");
