import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

import postgres from "postgres";

import type { RestoreDrill, RestoreDrillRepository } from "../contracts/index.ts";
import { PRODUCT_SCHEMA } from "./connect.ts";

/** How long a verified drill keeps the import backup gate open (design section 10). */
export const RECENT_DRILL_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound for the dump and the restore together. */
const DRILL_TIMEOUT_MS = 15 * 60 * 1000;
const STDERR_CAP = 4000;
/** The most a recorded error line may keep. */
const ERROR_CAP = 500;
/**
 * How far ahead of `recorded_at` (the store's clock) a drill's `finished_at` (the clock of the machine that ran the drill) may be before
 * the gate distrusts it. The two clocks are different hosts', so a drill machine more than this far ahead of the store looks "dated in the
 * future" however honest it is; the refusal message names that machine's clock. `finished_at` never decides the age (that is the store's own).
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Why the newest drill does not open the gate, or null when it does. Only the newest counts: a later failed drill closes it. The age is
 * the store's own `now() - recorded_at`, so neither this machine's clock nor the client-supplied times decide it.
 * The gate is self-attested (design section 10): it trusts the newest row, and any role allowed to insert a `restore_drills` row can write a verified one.
 */
export async function drillRefusal(drills: RestoreDrillRepository): Promise<string | null> {
  const latest = await drills.latest();
  if (!latest) return "No hay ningún simulacro de restauración registrado (brand backup drill).";
  // A row recorded in the future by the store's own clock, or a finish time far after it was recorded, is not believed.
  if (latest.ageMs < -FUTURE_SKEW_MS) return "El último simulacro está registrado con fecha futura: revisa el reloj del servidor y repítelo con brand backup drill.";
  if (Date.parse(latest.finishedAt) - Date.parse(latest.recordedAt) > FUTURE_SKEW_MS) return `El último simulacro (${latest.finishedAt}) tiene fecha futura: revisa el reloj de la máquina que hizo el simulacro y repítelo con brand backup drill.`;
  if (latest.status !== "verified") return `El último simulacro de restauración (${latest.finishedAt}) falló: repítelo con brand backup drill.`;
  if (latest.ageMs > RECENT_DRILL_MS) return `El último simulacro verificado (${latest.finishedAt}) tiene más de ${RECENT_DRILL_MS / 86_400_000} días: repítelo con brand backup drill.`;
  return null;
}

/** No drill happened (so nothing is recorded and the gate is untouched): the tool is missing, or the scratch database could not be set up. */
export class DrillNotRunError extends Error {}
/** The binary needed for the drill is not installed. */
export class DrillToolMissingError extends DrillNotRunError {}
/** pg_dump or pg_restore ran and failed (the drill counts as failed). */
class DrillToolError extends Error {}

/** The failure codes a recorded drill carries in `detail.code`; the CLI maps each to Spanish text with a total `Record`. */
export type DrillFailureCode = "no_tables" | "counts_differ" | "tool_failed" | "verify_failed";

export interface DrillOptions {
  /** The database to back up (`DATABASE_URL`). Must be a direct connection, not a pooler: `pg_dump`, `pg_export_snapshot` and `CREATE DATABASE` need a session. */
  sourceUrl: string;
  /** A server where `CREATE DATABASE` is allowed; defaults to the source's server. The scratch database is dropped afterwards. */
  scratchUrl?: string;
  schema?: string;
  pgDump?: string;
  pgRestore?: string;
  /** Prepared statements on the drill's own connections (`DATABASE_PREPARE !== "false"`). */
  prepare?: boolean;
  now?: () => Date;
  /** Upper bound for the dump and the restore together; tests shorten it. Defaults to 15 minutes. */
  timeoutMs?: number;
}

/** Throws `DrillToolMissingError` unless `bin` is an executable file: a path as given, or a name found on `PATH` (the same lookup the child's spawn uses). */
function requireTool(bin: string): void {
  const executable = (file: string) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
  const found = bin.includes("/") ? executable(bin) : (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && executable(join(dir, bin)));
  if (!found) throw new DrillToolMissingError(`no se encontró ${bin}: instala las herramientas de cliente de PostgreSQL o define PG_DUMP_BIN y PG_RESTORE_BIN`);
}

/**
 * The child's whole environment: PATH, HOME and LANG plus the explicit libpq values for `url`. Nothing else is inherited, so a stray
 * `PG*` or `DATABASE_*` variable cannot redirect the dump. The password never appears on a command line. `?sslmode=` and the
 * postgres.js style `?ssl=require` both map to `PGSSLMODE`; a non-local host with neither gets `require`.
 */
export function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // A valid mode passes through untouched (never downgrade verify-full); postgres.js style `true` / `1` mean require.
  const modes = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];
  const ssl0 = u.searchParams.get("sslmode") ?? u.searchParams.get("ssl") ?? "";
  const asked = modes.includes(ssl0) ? ssl0 : ["true", "1"].includes(ssl0) ? "require" : null;
  const ssl = asked ?? (["localhost", "127.0.0.1", "::1"].includes(host) ? null : "require");
  const inherited = Object.fromEntries(["PATH", "HOME", "LANG"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));
  return { ...inherited, PGHOST: host, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)), ...(ssl ? { PGSSLMODE: ssl } : {}) };
}

/** Row count of every table of `schema`. */
async function tableCounts(sql: postgres.Sql, schema: string): Promise<Record<string, number>> {
  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) counts[tablename] = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${schema.replace(/"/g, '""')}"."${String(tablename).replace(/"/g, '""')}"`))[0].n;
  return counts;
}

/**
 * What may be kept of a tool's stderr: only its own `pg_dump: error:` / `pg_restore: error:` lines (never the CONTEXT / DETAIL lines
 * that quote a row), quoted text replaced, capped. Both regexes are linear.
 */
export function errorLines(stderr: string): string {
  return stderr.split("\n").filter((l) => /^pg_(dump|restore): error:/.test(l)).map((l) => l.replace(/"[^"\n]*"|'[^'\n]*'/g, '"..."')).join(" | ").slice(0, ERROR_CAP);
}

/** `pg_dump | pg_restore`: the dump streams into the restore, so no dump file is ever written. When one child fails the other is killed. */
function pipeDump(opts: Required<Pick<DrillOptions, "pgDump" | "pgRestore" | "schema" | "timeoutMs">> & { snapshot: string }, sourceUrl: string, scratchUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    const dump = spawn(opts.pgDump, ["--format=custom", "--no-owner", "--no-privileges", `--schema=${opts.schema}`, `--exclude-table-data=${opts.schema}.restore_drills`, `--snapshot=${opts.snapshot}`], { env: pgEnv(sourceUrl), stdio: ["ignore", "pipe", "pipe"], signal });
    const restore = spawn(opts.pgRestore, ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${new URL(scratchUrl).pathname.slice(1)}`], { env: pgEnv(scratchUrl), stdio: ["pipe", "ignore", "pipe"], signal });
    let stderr = "";
    // Keep the TAIL: the failure is the last thing a tool says, and a noisy run must not push it out of the buffer.
    const keep = (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_CAP); };
    const timedOut = () => new DrillToolError(`timeout: the dump and the restore did not finish within ${opts.timeoutMs < 1000 ? `${opts.timeoutMs} ms` : `${Math.round(opts.timeoutMs / 1000)} s`}${errorLines(stderr) ? `: ${errorLines(stderr)}` : ""}`);
    dump.stderr.on("data", keep);
    restore.stderr.on("data", keep);
    dump.stdout.pipe(restore.stdin);
    restore.stdin.on("error", () => {}); // a restore that exits early closes the pipe; its exit code tells why
    const codes: Record<string, number | null> = {};
    // A child that never started has no pid, and `kill()` on it would signal this whole process group; `kill()` only sends SIGTERM, the exit event still follows.
    const stop = (child: { pid?: number; kill(): boolean }) => child.pid !== undefined && child.kill();
    const finish = (who: "dump" | "restore", other: { pid?: number; kill(): boolean }) => (code: number | null) => {
      codes[who] = code;
      if (signal.aborted) return reject(timedOut());
      if (code !== 0) stop(other); // a survivor would block on a pipe nobody reads until the timeout
      if (Object.keys(codes).length === 2) codes.dump === 0 && codes.restore === 0 ? resolve() : reject(new DrillToolError(`pg_dump exit ${codes.dump}, pg_restore exit ${codes.restore}: ${errorLines(stderr)}`));
    };
    dump.on("exit", finish("dump", restore));
    restore.on("exit", finish("restore", dump));
    for (const [bin, child] of [[opts.pgDump, dump], [opts.pgRestore, restore]] as const) {
      child.on("error", (error) => {
        stop(dump);
        stop(restore);
        reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new DrillToolMissingError(`no se encontró ${bin}: instala las herramientas de cliente de PostgreSQL o define PG_DUMP_BIN y PG_RESTORE_BIN`) : error.name === "AbortError" ? timedOut() : error);
      });
    }
  });
}

export type DrillResult = Omit<RestoreDrill, "id" | "recordedAt" | "ageMs">;

/** Marks a scratch database as a drill's (`COMMENT ON DATABASE`); the sweep drops only databases that carry it. */
const DRILL_COMMENT = "brand-backup-drill";
/** Key of the session advisory lock that keeps two drills (same admin database) from sweeping each other. */
// Same string as before the constant existed, so the hash (and the lock) is unchanged across versions.
const DRILL_LOCK_KEY = "brand-backup-drill";
/**
 * Scratch databases a crashed drill left behind: `drill_` + 12 hex, owned by the connected role AND carrying the drill's comment
 * (set right after CREATE), so a database somebody else made with a lookalike name is never touched. Remaining tiny window: a database
 * a drill with ANOTHER admin URL has created but not yet connected to; each drill holds a connection to its own scratch right after creating it.
 */
async function sweepOrphans(admin: postgres.Sql): Promise<string[]> {
  // No FORCE: a database somebody is connected to is not an orphan, so it is left alone.
  const orphans = await admin`SELECT datname FROM pg_database WHERE datname ~ '^drill_[0-9a-f]{12}$' AND pg_get_userbyid(datdba) = current_user
                              AND shobj_description(oid, 'pg_database') = ${DRILL_COMMENT}
                              AND datname NOT IN (SELECT datname FROM pg_stat_activity WHERE datname IS NOT NULL)`;
  const swept: string[] = [];
  for (const { datname } of orphans) await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`).then(() => swept.push(datname), () => {});
  return swept;
}

/**
 * Dumps `schema` of the source, restores it into a fresh scratch database and compares the row count of every table except
 * `restore_drills` (whose data the dump leaves out). Dump and counts read ONE snapshot (`pg_export_snapshot`), so a concurrent
 * write cannot cause a mismatch. The scratch database is dropped at the end, and only a database this call created is ever
 * dropped; if the drop fails the name is returned in `detail.scratchLeaked`. Before it starts, scratch databases a crashed drill left
 * behind are dropped (a session advisory lock keeps two drills from sweeping each other); their names go in `detail.swept`.
 * The tools are resolved first: a missing binary throws `DrillToolMissingError` before any lock, sweep or `CREATE DATABASE`.
 * Known gap: a process killed between `CREATE DATABASE` and `COMMENT ON DATABASE` leaves a `drill_<12 hex>` database with no comment, which no
 * sweep touches (it only drops what carries the comment): the operator must drop it by hand.
 * A failure to set up (the lock, the sweep, `CREATE DATABASE`, the snapshot) throws `DrillNotRunError`: no drill happened, so none is recorded.
 * The caller records the returned row.
 */
export async function runBackupDrill(options: DrillOptions): Promise<DrillResult> {
  const schema = options.schema ?? PRODUCT_SCHEMA;
  const tools = { pgDump: options.pgDump ?? "pg_dump", pgRestore: options.pgRestore ?? "pg_restore", schema, timeoutMs: options.timeoutMs ?? DRILL_TIMEOUT_MS };
  requireTool(tools.pgDump);
  requireTool(tools.pgRestore);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const scratchName = `drill_${randomBytes(6).toString("hex")}`;
  const scratchUrl = new URL(options.scratchUrl ?? options.sourceUrl);
  scratchUrl.pathname = `/${scratchName}`;
  const client = (url: string) => postgres(url, { onnotice: () => {}, max: 1, prepare: options.prepare ?? true });
  const source = client(options.sourceUrl);
  const admin = client(options.scratchUrl ?? options.sourceUrl);
  let created = false;
  let holder: postgres.Sql | undefined;
  let swept: string[] = [];
  let phase = "setup" as "setup" | "dump" | "verify"; // set inside the transaction callback, which narrowing cannot see
  let result: DrillResult | undefined;
  let thrown: unknown;
  try {
    const [{ db }] = await source`SELECT current_database() AS db`;
    const finish = (status: "verified" | "failed", detail: Record<string, unknown>): DrillResult => ({ databaseName: db as string, status, startedAt, finishedAt: now().toISOString(), detail: swept.length ? { ...detail, swept } : detail });
    try {
      if (!(await admin`SELECT pg_try_advisory_lock(hashtext(${DRILL_LOCK_KEY})) AS ok`)[0].ok) throw new DrillNotRunError("hay otro simulacro en curso con la misma base de administración (DATABASE_DRILL_URL)");
      swept = await sweepOrphans(admin);
      await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
      created = true;
      await admin.unsafe(`COMMENT ON DATABASE "${scratchName}" IS '${DRILL_COMMENT}'`);
      holder = client(scratchUrl.toString());
      await holder`SELECT 1`; // an open connection makes another drill's sweep skip this database
      result = await source.begin("isolation level repeatable read", async (tx) => {
        const [{ snapshot }] = await tx`SELECT pg_export_snapshot() AS snapshot`;
        phase = "dump";
        await pipeDump({ ...tools, snapshot }, options.sourceUrl, scratchUrl.toString());
        phase = "verify";
        const scratch = client(scratchUrl.toString());
        try {
          const [expected, restored] = [await tableCounts(tx as unknown as postgres.Sql, schema), await tableCounts(scratch, schema)];
          delete expected.restore_drills;
          delete restored.restore_drills;
          const names = [...new Set([...Object.keys(expected), ...Object.keys(restored)])].sort();
          const differing = names.filter((t) => expected[t] !== restored[t]);
          if (!names.length) return finish("failed", { code: "no_tables" satisfies DrillFailureCode, error: `the schema ${schema} has no tables` });
          return differing.length ? finish("failed", { code: "counts_differ" satisfies DrillFailureCode, error: `row counts differ after the restore: ${differing.join(", ")}`, differing, expected, restored }) : finish("verified", { schema, tables: expected });
        } finally {
          await scratch.end({ timeout: 1 });
        }
      });
    } catch (error) {
      if (error instanceof DrillNotRunError) thrown = error;
      else if (phase === "setup") thrown = new DrillNotRunError(`no se pudo preparar la base temporal (${(error as Error).message}); revisa DATABASE_DRILL_URL y el permiso CREATE DATABASE`);
      else result = finish("failed", { code: (phase === "dump" ? "tool_failed" : "verify_failed") satisfies DrillFailureCode, error: (error instanceof DrillToolError ? error.message : phase === "dump" ? "the dump or the restore failed" : "the row counts could not be read").slice(0, ERROR_CAP) });
    }
  } catch (error) {
    thrown = error;
  }
  let leaked: string | undefined;
  await holder?.end({ timeout: 1 }).catch(() => {});
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => { leaked = scratchName; });
  await Promise.all([source.end({ timeout: 1 }), admin.end({ timeout: 1 })]);
  if (thrown) throw leaked && thrown instanceof Error ? Object.assign(thrown, { message: `${thrown.message}; scratch database left behind: ${leaked}` }) : thrown;
  return leaked ? { ...result!, detail: { ...result!.detail, scratchLeaked: leaked } } : result!;
}
