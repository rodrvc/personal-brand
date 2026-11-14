import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { runCli } from "../src/cli/brand.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories, DrillNotRunError, DrillToolMissingError, errorLines, migrate, pgEnv, RECENT_DRILL_MS, runBackupDrill } from "../src/pg/index.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const REMOTE = { DATABASE_URL: "postgres://u:p@db.example.com:5432/x", USER: "tester" };
/** A drill row recorded `recordedAgo` ms before NOW (the store's clock), finishing `finishedAfter` ms after it was recorded. */
const drill = (status: "verified" | "failed", recordedAgo: number, finishedAfter = 0) => ({ status, recordedAgo, finishedAfter });

// The backup gate: a remote write needs the newest drill to be verified and recent, by the store's clock. Local writes never look at it.
for (const [label, rows, allowed] of [
  ["no drill", [], false],
  ["a stale verified drill", [drill("verified", RECENT_DRILL_MS + 1000)], false],
  ["a recent verified drill", [drill("verified", RECENT_DRILL_MS - 1000)], true],
  ["a verified drill dated in the future", [drill("verified", 0, 3_600_000)], false],
  ["a row the store recorded in the future", [drill("verified", -3_600_000)], false],
  ["a failed drill", [drill("failed", 1000)], false],
  ["a failed drill after a verified one", [drill("verified", 5000), drill("failed", 1000)], false],
] as const) {
  let clock = NOW;
  const repos = createMemoryRepositories(() => clock);
  for (const r of rows) {
    clock = new Date(NOW.getTime() - r.recordedAgo);
    const at = new Date(clock.getTime() + r.finishedAfter).toISOString();
    await repos.restoreDrills.record({ databaseName: "x", status: r.status, startedAt: clock.toISOString(), finishedAt: at, detail: {} });
  }
  clock = NOW;
  const hooks = { now: () => NOW };
  const write = await runCli(["create", "example-gate", "--name", "Gate"], REMOTE, repos, undefined, hooks);
  const imported = await runCli(["import", "--from", "/nonexistent/example-gate"], REMOTE, repos, undefined, hooks);
  // Past the gate the missing folder answers 4; refused by the gate it is 6 and says why.
  assert.deepEqual([write.exitCode, imported.exitCode], allowed ? [0, 4] : [6, 6], `${label}: ${write.lines.join(" ")} | ${imported.lines.join(" ")}`);
  if (!allowed) assert.match(write.lines.join(" "), /remota/);
  console.log(`  ok - backup gate: ${label} ${allowed ? "allows" : "refuses"} a remote write`);
}
// The memory store reads only the drills of the database it models, like Postgres' current_database().
const scoped = createMemoryRepositories(() => NOW, "x");
await scoped.restoreDrills.record({ databaseName: "x", status: "failed", startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), detail: {} });
await scoped.restoreDrills.record({ databaseName: "another", status: "verified", startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), detail: {} });
assert.equal((await scoped.restoreDrills.latest())?.status, "failed", "a drill of another database is ignored");
// Only the tools' own error lines survive, with quoted text replaced: a CONTEXT line quotes a row.
assert.equal(errorLines('pg_restore: error: COPY failed for table "t": ERROR:  bad \'secret\'\nCONTEXT:  COPY t, line 1: "row data"\nDETAIL:  Key (x)=(7)\npg_dump: warning: x'), 'pg_restore: error: COPY failed for table "...": ERROR:  bad "..."');
assert.equal(errorLines("pg_dump: error: ".padEnd(5000, "x")).length, 500);
// The CLI verb with a stubbed drill: the result is always recorded, the exit code and the Spanish text follow it, a missing tool records nothing.
const stub = (result: () => Promise<Awaited<ReturnType<typeof runBackupDrill>>>) => ({ now: () => NOW, runDrill: result as typeof runBackupDrill });
const row = (status: "verified" | "failed", detail: Record<string, unknown>) => async () => ({ databaseName: "x", status, startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), detail });
const LOCAL = { DATABASE_URL: "postgres://u:p@localhost:5432/x" };
for (const [label, run, exit, text, recorded] of [
  ["verified", row("verified", { tables: { brands: 1 } }), 0, /verificado/, "verified"],
  ["failed", row("failed", { code: "counts_differ", differing: ["brands"], error: "english detail" }), 1, /las filas no coinciden.*brands/, "failed"],
  ["a leaked scratch database", row("verified", { tables: {}, scratchLeaked: "drill_abc" }), 1, /terminó \(verificado\).*"drill_abc".*bórrala/, "verified"],
  ["a failed drill that also leaked", row("failed", { code: "tool_failed", scratchLeaked: "drill_abc" }), 1, /terminó \(falló: pg_dump o pg_restore fallaron.*"drill_abc"/, "failed"],
  ["a failed count read", row("failed", { code: "verify_failed" }), 1, /conteos de filas/, "failed"],
  ["a drill that could not be set up", async () => { throw new DrillNotRunError("no se pudo preparar la base temporal (x)"); }, 1, /No se hizo el simulacro.*preparar/, null],
  ["a missing binary", async () => { throw new DrillToolMissingError("no se encontró pg_dump"); }, 1, /No se hizo el simulacro/, null],
] as const) {
  const repos = createMemoryRepositories(() => NOW);
  const result = await runCli(["backup", "drill"], LOCAL, repos, undefined, stub(run));
  assert.deepEqual([result.exitCode, text.test(result.lines.join(" ")), (await repos.restoreDrills.latest())?.status ?? null], [exit, true, recorded], `${label}: ${result.lines.join(" ")}`);
  assert.ok(!/english detail/.test(result.lines.join(" ")), "user-facing text is Spanish");
}

// The outcome is reported even when it cannot be recorded; DATABASE_PREPARE reaches the drill's own connections.
{
  const repos = createMemoryRepositories(() => NOW);
  const broken = { ...repos, restoreDrills: { ...repos.restoreDrills, record: async () => { throw new Error("relation restore_drills does not exist"); } } };
  const lost = await runCli(["backup", "drill"], LOCAL, broken, undefined, stub(row("verified", { tables: { brands: 1 } })));
  assert.deepEqual([lost.exitCode, /Simulacro verificado/.test(lost.lines.join(" ")), /No se pudo registrar.*restore_drills/.test(lost.lines.join(" "))], [1, true, true]);
  let seen: Parameters<typeof runBackupDrill>[0] | undefined;
  const spy = { now: () => NOW, runDrill: (async (o: Parameters<typeof runBackupDrill>[0]) => ((seen = o), row("verified", { tables: { brands: 1 } })())) as typeof runBackupDrill };
  await runCli(["backup", "drill"], { ...LOCAL, DATABASE_PREPARE: "false" }, repos, undefined, spy);
  assert.equal(seen?.prepare, false);
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

// Everything below needs a real server and the pg_dump / pg_restore client tools. It covers: the verified path and its exact scratch cleanup,
// every failure code, a dump that fails, a child that dies (the sibling is killed, not left blocked on the pipe), the deadline (reported as a
// timeout), a missing tool (found before any lock or CREATE DATABASE), a setup failure (throws, records nothing), the orphan sweep, 0009.
// The gate tests above run on the memory store, whose rows are self-attested like Postgres': whoever may insert a row can write a verified one.
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
      let before = await scratchCount();
      const verified = await runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: restoreBin });
      assert.equal(verified.status, "verified", JSON.stringify(verified.detail));
      assert.equal((verified.detail.tables as Record<string, number>).brands, 1, "the restored copy has the brand row");
      // A scratch database a killed earlier run left behind is swept by this one: the count falls by exactly the swept ones, and this run's own is gone.
      assert.equal(verified.detail.scratchLeaked, undefined);
      assert.equal(await scratchCount(), before - ((verified.detail.swept as string[] | undefined)?.length ?? 0), "the scratch database is dropped");
      before = await scratchCount();
      await repos.restoreDrills.record(verified);
      const recorded = await repos.restoreDrills.latest();
      assert.equal(recorded?.status, "verified");
      // The age is the store's own clock, in milliseconds: a wrong unit or sign here would open or close the remote write gate.
      assert.ok(Number.isFinite(recorded!.ageMs) && recorded!.ageMs >= -1000 && recorded!.ageMs < 60_000, `ageMs ${recorded!.ageMs}`);
      console.log("  ok - backup drill: dump, restore into a scratch database, row counts match, scratch dropped");

      const failed = await runBackupDrill({ sourceUrl: url, schema: `${schema}_missing`, pgDump: dumpBin, pgRestore: restoreBin });
      assert.equal(failed.status, "failed");
      assert.equal(await scratchCount(), before, "a failed drill drops its scratch database too");
      await repos.restoreDrills.record(failed);
      assert.equal((await repos.restoreDrills.latest())?.status, "failed", "the newest drill wins");
      assert.equal(failed.detail.code, "tool_failed");
      console.log("  ok - backup drill: a dump that fails is recorded as failed");

      // An empty schema is `no_tables`.
      await admin.unsafe(`CREATE SCHEMA ${schema}_empty`);
      const empty = await runBackupDrill({ sourceUrl: url, schema: `${schema}_empty`, pgDump: dumpBin, pgRestore: restoreBin });
      assert.deepEqual([empty.status, empty.detail.code], ["failed", "no_tables"]);

      // A restore whose copy has a row the source lacks is `counts_differ`: the real restore runs, then a wrapper ADDS a brand row to the scratch copy.
      const bin = mkdtempSync(join(tmpdir(), "drill-shims-"));
      const extraRow = join(bin, "pg_restore_extra_row.mjs");
      writeFileSync(extraRow, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import postgres from ${JSON.stringify(import.meta.resolve("postgres"))};
const real = spawn(${JSON.stringify(restoreBin)}, process.argv.slice(2), { stdio: "inherit" });
real.on("exit", async (code) => {
  if (code === 0) try {
    const sql = postgres({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.argv.find((a) => a.startsWith("--dbname=")).slice(9) });
    await sql.unsafe(${JSON.stringify(`INSERT INTO ${schema}.brands (slug, display_name) VALUES ('example-extra', 'Extra')`)});
    await sql.end();
  } catch (error) {
    console.error("pg_restore: error: wrapper: " + error.message);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
`);
      chmodSync(extraRow, 0o755);
      const extraRowResult = await runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: extraRow });
      assert.deepEqual([extraRowResult.status, extraRowResult.detail.code, extraRowResult.detail.differing], ["failed", "counts_differ", ["brands"]], JSON.stringify(extraRowResult.detail));
      assert.equal(await scratchCount(), before);
      console.log("  ok - backup drill: an empty schema is no_tables and a restore that adds a row is counts_differ");

      let guard: NodeJS.Timeout | undefined;
      // When the restore dies the dump is killed instead of blocking on the pipe until the timeout.
      const yes = join(bin, "dump_forever.sh");
      const die = join(bin, "restore_dies.sh");
      writeFileSync(yes, "#!/bin/sh\nexec yes\n");
      writeFileSync(die, "#!/bin/sh\nexit 3\n");
      chmodSync(yes, 0o755);
      chmodSync(die, 0o755);
      const timer = new Promise<never>((_, no) => (guard = setTimeout(() => no(new Error("pipeDump did not kill the surviving child")), 30_000)));
      const killed = await Promise.race([runBackupDrill({ sourceUrl: url, schema, pgDump: yes, pgRestore: die }), timer]).finally(() => clearTimeout(guard));
      assert.deepEqual([killed.status, killed.detail.code], ["failed", "tool_failed"]);
      console.log("  ok - backup drill: a failed child ends its sibling");

      // A dump and a restore that never finish are cut at the deadline, and the recorded error says it was a timeout.
      const sleeper = join(bin, "restore_sleeps.sh");
      writeFileSync(sleeper, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(sleeper, 0o755);
      const timedOut = await runBackupDrill({ sourceUrl: url, schema, pgDump: yes, pgRestore: sleeper, timeoutMs: 700 });
      assert.deepEqual([timedOut.status, timedOut.detail.code, /timeout/.test(String(timedOut.detail.error))], ["failed", "tool_failed", true], JSON.stringify(timedOut.detail));
      // The abort path cleans up after itself: no scratch database is left and none is reported as leaked.
      assert.deepEqual([timedOut.detail.scratchLeaked, await scratchCount()], [undefined, before]);
      // The tail of a noisy stderr is what is kept: the failing line comes last, after more output than the buffer holds.
      const noisy = join(bin, "restore_noisy.sh");
      writeFileSync(noisy, "#!/bin/sh\ni=0\nwhile [ $i -lt 300 ]; do echo 'pg_restore: warning: filler line to push the start of stderr out of the buffer' >&2; i=$((i+1)); done\necho 'pg_restore: error: the last thing it said' >&2\nexit 3\n");
      chmodSync(noisy, 0o755);
      const tail = await runBackupDrill({ sourceUrl: url, schema, pgDump: yes, pgRestore: noisy });
      assert.deepEqual([tail.detail.code, /the last thing it said/.test(String(tail.detail.error))], ["tool_failed", true], JSON.stringify(tail.detail));
      // A missing tool is found before anything is locked, swept or created.
      const dbsBefore = await scratchCount();
      await assert.rejects(() => runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: join(bin, "no_such_restore") }), DrillToolMissingError);
      assert.equal(await scratchCount(), dbsBefore);

      // A setup failure (no CREATEDB right on that URL) is not a drill: it throws and records nothing.
      await assert.rejects(() => runBackupDrill({ sourceUrl: url, scratchUrl: "postgres://nobody:wrong@127.0.0.1:1/nope", schema, pgDump: dumpBin, pgRestore: restoreBin }), DrillNotRunError);

      // Orphans of a crashed drill are swept; a lookalike is not.
      await admin.unsafe(`CREATE DATABASE drill_0123456789ab`);
      await admin.unsafe(`COMMENT ON DATABASE drill_0123456789ab IS 'brand-backup-drill'`);
      await admin.unsafe(`CREATE DATABASE drill_0123456789abc`);
      await admin.unsafe(`CREATE DATABASE drill_0123456789ad`); // right name, no drill comment: not ours, so it survives
      await admin.unsafe(`COMMENT ON DATABASE drill_0123456789abc IS 'brand-backup-drill'`);
      const swept = await runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: restoreBin });
      assert.deepEqual(swept.detail.swept, ["drill_0123456789ab"]);
      assert.deepEqual((await admin`SELECT datname FROM pg_database WHERE datname LIKE 'drill\\_0123456789ab%' ORDER BY 1`).map((r) => r.datname), ["drill_0123456789abc"]);
      assert.equal((await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = 'drill_0123456789ad'`)[0].n, 1, "a lookalike without the comment survives");
      await admin.unsafe(`DROP DATABASE drill_0123456789abc`);
      await admin.unsafe(`DROP DATABASE drill_0123456789ad`);
      // A database somebody is connected to is not an orphan: it is left alone.
      await admin.unsafe(`CREATE DATABASE drill_0123456789ac`);
      await admin.unsafe(`COMMENT ON DATABASE drill_0123456789ac IS 'brand-backup-drill'`);
      const busyUrl = new URL(url);
      busyUrl.pathname = "/drill_0123456789ac";
      const busy = postgres(busyUrl.toString(), { onnotice: () => {}, max: 1 });
      await busy`SELECT 1`;
      const kept = await runBackupDrill({ sourceUrl: url, schema, pgDump: dumpBin, pgRestore: restoreBin });
      assert.equal(kept.detail.swept, undefined);
      assert.equal((await admin`SELECT count(*)::int AS n FROM pg_database WHERE datname = 'drill_0123456789ac'`)[0].n, 1);
      await busy.end({ timeout: 1 });
      await admin.unsafe(`DROP DATABASE drill_0123456789ac`);
      // recorded_at cannot be set by the owner role (0009). The migration grants only when the role exists, so the test makes sure it does
      // (creating it only if absent, and dropping only what it created) and migrates a dedicated schema after that.
      const ownerExisted = (await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner'`).length > 0;
      const grantSchema = `${schema}_grants`;
      let roleReady = ownerExisted;
      if (!ownerExisted) roleReady = await admin.unsafe(`CREATE ROLE brand_owner NOLOGIN`).then(() => true, (error) => (console.log(`SKIP 0009 column grant - cannot create brand_owner: ${error.message}`), false));
      if (roleReady) {
        try {
          await migrate(admin, { schema: grantSchema });
          const can = (col: string) => admin.unsafe(`SELECT has_column_privilege('brand_owner', '${grantSchema}.restore_drills', '${col}', 'INSERT') AS ok`).then((r) => r[0].ok);
          assert.deepEqual([await can("detail"), await can("recorded_at"), await can("id")], [true, false, false]);
        } finally {
          await admin.unsafe(`DROP SCHEMA IF EXISTS ${grantSchema} CASCADE`);
          if (!ownerExisted) await admin.unsafe(`DROP ROLE brand_owner`).catch((error) => console.log(`WARN could not drop the brand_owner role the test created: ${error.message}`));
        }
      }
      console.log("  ok - backup drill: setup failure records nothing; orphan scratch databases are swept");

      // A row written for another database (a restored copy keeps the rows of its origin) is never read.
      await admin.unsafe(`INSERT INTO ${schema}.restore_drills (database_name, status, started_at, finished_at, detail) VALUES ('another_db', 'verified', now(), now(), '{}')`);
      assert.equal((await repos.restoreDrills.latest())?.status, "failed", "latest() skips a row of another database");
      console.log("  ok - restore_drills: latest() ignores rows of another database");
    } finally {
      await sql.end({ timeout: 1 });
    }
  } finally {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema}_empty CASCADE`);
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end({ timeout: 1 });
  }
}
// A timeout is a number of milliseconds: anything else is refused before any tool lookup, lock, sweep or connection (no database needed).
for (const timeoutMs of [-1, 0, 1.5, Number.NaN, 2 ** 31]) {
  await assert.rejects(() => runBackupDrill({ sourceUrl: "postgres://nobody@127.0.0.1:1/none", pgDump: join("/nonexistent", "pg_dump"), timeoutMs }), /timeoutMs debe ser un entero positivo/);
}
if (url) {
  await assert.rejects(() => runBackupDrill({ sourceUrl: url, pgDump: join("/nonexistent", "pg_dump") }), DrillToolMissingError);
  console.log("  ok - backup drill: a missing binary is reported, not recorded as a failed drill");
}
console.log("backup drill: ok");
