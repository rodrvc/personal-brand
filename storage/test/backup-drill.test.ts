import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import postgres from "postgres";

import { runCli } from "../src/cli/brand.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories, DrillToolMissingError, migrate, pgEnv, RECENT_DRILL_MS, runBackupDrill } from "../src/pg/index.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const REMOTE = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x", USER: "tester" };
const drill = (status: "verified" | "failed", finishedAt: string) => ({ databaseName: "x", status, startedAt: finishedAt, finishedAt, detail: {} });

// The backup gate: a remote write needs the newest drill to be verified and recent. Local writes never look at it.
for (const [label, rows, allowed] of [
  ["no drill", [], false],
  ["a stale verified drill", [drill("verified", ago(RECENT_DRILL_MS + 1000))], false],
  ["a recent verified drill", [drill("verified", ago(RECENT_DRILL_MS - 1000))], true],
  ["a verified drill dated in the future", [drill("verified", new Date(NOW.getTime() + 3_600_000).toISOString())], false],
  ["a failed drill", [drill("failed", ago(1000))], false],
  ["a failed drill after a verified one", [drill("verified", ago(5000)), drill("failed", ago(1000))], false],
] as const) {
  const repos = createMemoryRepositories(() => NOW);
  for (const row of rows) await repos.restoreDrills.record(row);
  const hooks = { now: () => NOW };
  const write = await runCli(["create", "example-gate", "--name", "Gate"], REMOTE, repos, undefined, hooks);
  const imported = await runCli(["import", "--from", "/nonexistent/example-gate"], REMOTE, repos, undefined, hooks);
  // Past the gate the missing folder answers 4; refused by the gate it is 6 and says why.
  assert.deepEqual([write.exitCode, imported.exitCode], allowed ? [0, 4] : [6, 6], `${label}: ${write.lines.join(" ")} | ${imported.lines.join(" ")}`);
  if (!allowed) assert.match(write.lines.join(" "), /remota/);
  console.log(`  ok - backup gate: ${label} ${allowed ? "allows" : "refuses"} a remote write`);
}
// The CLI verb with a stubbed drill: the result is always recorded, the exit code and the Spanish text follow it, a missing tool records nothing.
const stub = (result: () => Promise<Awaited<ReturnType<typeof runBackupDrill>>>) => ({ now: () => NOW, runDrill: result as typeof runBackupDrill });
const row = (status: "verified" | "failed", detail: Record<string, unknown>) => async () => ({ databaseName: "x", status, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), detail });
const LOCAL = { DATABASE_URL: "postgres://u:p@localhost:5432/x" };
for (const [label, run, exit, text, recorded] of [
  ["verified", row("verified", { tables: { brands: 1 } }), 0, /verificado/, "verified"],
  ["failed", row("failed", { code: "counts_differ", differing: ["brands"], error: "english detail" }), 1, /las filas no coinciden.*brands/, "failed"],
  ["a leaked scratch database", row("verified", { tables: {}, scratchLeaked: "drill_abc" }), 1, /"drill_abc".*bórrala/, "verified"],
  ["a missing binary", async () => { throw new DrillToolMissingError("no se encontró pg_dump"); }, 1, /No se hizo el simulacro/, null],
] as const) {
  const repos = createMemoryRepositories(() => NOW);
  const result = await runCli(["backup", "drill"], LOCAL, repos, undefined, stub(run));
  assert.deepEqual([result.exitCode, text.test(result.lines.join(" ")), (await repos.restoreDrills.latest())?.status ?? null], [exit, true, recorded], `${label}: ${result.lines.join(" ")}`);
  assert.ok(!/english detail/.test(result.lines.join(" ")), "user-facing text is Spanish");
}

// The child's environment is built, not inherited; ssl maps to PGSSLMODE.
process.env.PGPASSWORD = "stray";
process.env.PGSERVICE = "stray";
process.env.DATABASE_URL_STRAY = "stray";
const childEnv = pgEnv("postgres://u:p%40ss@db.example.com:6543/x?ssl=require");
assert.deepEqual([childEnv.PGPASSWORD, childEnv.PGHOST, childEnv.PGPORT, childEnv.PGSSLMODE, childEnv.PGSERVICE, childEnv.DATABASE_URL_STRAY], ["p@ss", "db.example.com", "6543", "require", undefined, undefined]);
assert.deepEqual(Object.keys(childEnv).filter((k) => !/^(PATH|HOME|LANG|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSSLMODE)$/.test(k)), []);
assert.deepEqual(["postgres://u:p@db.example.com/x?ssl=verify-full", "postgres://u:p@db.example.com/x?ssl=true", "postgres://u:p@db.example.com/x?ssl=1", "postgres://u:p@db.example.com/x?sslmode=verify-ca"].map((u) => pgEnv(u).PGSSLMODE), ["verify-full", "require", "require", "verify-ca"], "a valid mode is never downgraded");
assert.deepEqual([pgEnv("postgres://u:p@db.example.com/x").PGSSLMODE, pgEnv("postgres://u:p@localhost/x").PGSSLMODE, pgEnv("postgres://u:p@db.example.com/x?sslmode=verify-full").PGSSLMODE], ["require", undefined, "verify-full"]);
delete process.env.PGPASSWORD;
delete process.env.PGSERVICE;
delete process.env.DATABASE_URL_STRAY;
console.log("  ok - backup drill: CLI results, minimal child environment");

const local = await runCli(["create", "example-local", "--name", "Local"], { DATABASE_URL: "postgres://u:p@localhost:5432/x" }, createMemoryRepositories(() => NOW), undefined, { now: () => NOW });
assert.equal(local.exitCode, 0, "a local database needs no drill");
assert.equal((await runCli(["backup", "restore"], REMOTE, createMemoryRepositories())).exitCode, 2, "an unknown backup subcommand is a usage error");

const url = process.env.DATABASE_URL;
const dumpBin = process.env.PG_DUMP_BIN ?? "pg_dump";
const restoreBin = process.env.PG_RESTORE_BIN ?? "pg_restore";
const tools = [dumpBin, restoreBin].every((bin) => !spawnSync(bin, ["--version"]).error);
if (!url) console.log("SKIP postgres backup drill - DATABASE_URL not set");
else if (!tools) console.log(`SKIP postgres backup drill - ${dumpBin} / ${restoreBin} are not installed (set PG_DUMP_BIN and PG_RESTORE_BIN, or install the PostgreSQL client tools)`);
else {
  const admin = postgres(url, { connect_timeout: 3, onnotice: () => {}, max: 1 });
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const scratchCount = async () => (await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'drill\\_%'`)[0].n;
  try {
    await migrate(admin, { schema });
    const sql = postgres(url, { connection: { search_path: schema }, onnotice: () => {}, max: 1 });
    try {
      const repos = createPgRepositories(sql);
      await repos.brands.create({ slug: "example-drill", displayName: "Drill" }, { expectedVersion: null, author: "t", source: "cli", reason: "structural" });
      const before = await scratchCount();
      const verified = await runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: restoreBin });
      assert.equal(verified.status, "verified", JSON.stringify(verified.detail));
      assert.equal((verified.detail.tables as Record<string, number>).brands, 1, "the restored copy has the brand row");
      assert.equal(await scratchCount(), before, "the scratch database is dropped");
      await repos.restoreDrills.record(verified);
      assert.equal((await repos.restoreDrills.latest())?.status, "verified");
      console.log("  ok - backup drill: dump, restore into a scratch database, row counts match, scratch dropped");

      const failed = await runBackupDrill({ sourceUrl: url, schema: `${schema}_missing`, pgDump: dumpBin, pgRestore: restoreBin });
      assert.equal(failed.status, "failed");
      assert.equal(await scratchCount(), before, "a failed drill drops its scratch database too");
      await repos.restoreDrills.record(failed);
      assert.equal((await repos.restoreDrills.latest())?.status, "failed", "the newest drill wins");
      console.log("  ok - backup drill: a dump that fails is recorded as failed");

      // A row written for another database (a restored copy keeps the rows of its origin) is never read.
      await admin.unsafe(`INSERT INTO ${schema}.restore_drills (database_name, status, started_at, finished_at, detail) VALUES ('another_db', 'verified', now(), now(), '{}')`);
      assert.equal((await repos.restoreDrills.latest())?.status, "failed", "latest() skips a row of another database");
      console.log("  ok - restore_drills: latest() ignores rows of another database");
    } finally {
      await sql.end({ timeout: 1 });
    }
  } finally {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end({ timeout: 1 });
  }
}
if (url) {
  await assert.rejects(() => runBackupDrill({ sourceUrl: url, pgDump: join("/nonexistent", "pg_dump") }), DrillToolMissingError);
  console.log("  ok - backup drill: a missing binary is reported, not recorded as a failed drill");
}
console.log("backup drill: ok");
