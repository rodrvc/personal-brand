import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import postgres from "postgres";

import type { RestoreDrill, RestoreDrillRepository } from "../contracts/index.ts";
import { PRODUCT_SCHEMA } from "./connect.ts";

/** How long a verified drill keeps the import backup gate open (design section 10). */
export const RECENT_DRILL_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound for the dump and the restore together. */
const DRILL_TIMEOUT_MS = 15 * 60 * 1000;
const STDERR_CAP = 2000;
/** How far ahead of the clock a drill's finish time may be before the gate distrusts it. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Why the newest drill does not open the gate, or null when it does. Only the newest counts: a later failed drill closes it. */
export async function drillRefusal(drills: RestoreDrillRepository, now: Date): Promise<string | null> {
  const latest = await drills.latest();
  if (!latest) return "No hay ningún simulacro de restauración registrado (brand backup drill).";
  // A row from the future (a wrong client clock) would stay "recent" forever.
  if (Date.parse(latest.finishedAt) - now.getTime() > FUTURE_SKEW_MS) return `El último simulacro (${latest.finishedAt}) tiene fecha futura: revisa el reloj y repítelo con brand backup drill.`;
  if (latest.status !== "verified") return `El último simulacro de restauración (${latest.finishedAt}) falló: repítelo con brand backup drill.`;
  if (now.getTime() - Date.parse(latest.finishedAt) > RECENT_DRILL_MS) return `El último simulacro verificado (${latest.finishedAt}) tiene más de ${RECENT_DRILL_MS / 86_400_000} días: repítelo con brand backup drill.`;
  return null;
}

/** The binary needed for the drill is not installed: no drill happened, so nothing is recorded. */
export class DrillToolMissingError extends Error {}

export interface DrillOptions {
  /** The database to back up (`DATABASE_URL`). */
  sourceUrl: string;
  /** A server where `CREATE DATABASE` is allowed; defaults to the source's server. The scratch database is dropped afterwards. */
  scratchUrl?: string;
  schema?: string;
  pgDump?: string;
  pgRestore?: string;
  now?: () => Date;
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

/** `pg_dump | pg_restore`: the dump streams into the restore, so no dump file is ever written. Resolves with the stderr of both. */
function pipeDump(opts: Required<Pick<DrillOptions, "pgDump" | "pgRestore" | "schema">> & { snapshot: string }, sourceUrl: string, scratchUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(DRILL_TIMEOUT_MS);
    const dump = spawn(opts.pgDump, ["--format=custom", "--no-owner", "--no-privileges", `--schema=${opts.schema}`, `--exclude-table-data=${opts.schema}.restore_drills`, `--snapshot=${opts.snapshot}`], { env: pgEnv(sourceUrl), stdio: ["ignore", "pipe", "pipe"], signal });
    const restore = spawn(opts.pgRestore, ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${new URL(scratchUrl).pathname.slice(1)}`], { env: pgEnv(scratchUrl), stdio: ["pipe", "ignore", "pipe"], signal });
    let stderr = "";
    const keep = (chunk: Buffer) => { if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length); };
    dump.stderr.on("data", keep);
    restore.stderr.on("data", keep);
    dump.stdout.pipe(restore.stdin);
    restore.stdin.on("error", () => {}); // a restore that exits early closes the pipe; its exit code tells why
    const codes: Record<string, number | null> = {};
    const finish = (who: string) => (code: number | null) => {
      codes[who] = code;
      if (Object.keys(codes).length === 2) codes.dump === 0 && codes.restore === 0 ? resolve(stderr) : reject(new Error(`pg_dump exit ${codes.dump}, pg_restore exit ${codes.restore}: ${stderr.trim()}`));
    };
    for (const [who, child] of [["dump", dump], ["restore", restore]] as const) {
      child.on("exit", finish(who));
      child.on("error", (error) => reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new DrillToolMissingError(`no se encontró ${error.message.split(" ")[1] ?? "el programa"}: instala las herramientas de cliente de PostgreSQL o define PG_DUMP_BIN y PG_RESTORE_BIN`) : error));
    }
  });
}

export type DrillResult = Omit<RestoreDrill, "id" | "recordedAt">;

/**
 * Dumps `schema` of the source, restores it into a fresh scratch database and compares the row count of every table except
 * `restore_drills` (whose data the dump leaves out). Dump and counts read ONE snapshot (`pg_export_snapshot`), so a concurrent
 * write cannot cause a mismatch. The scratch database is dropped at the end, and only a database this call created is ever
 * dropped; if the drop fails the name is returned in `detail.scratchLeaked`. The caller records the returned row.
 */
export async function runBackupDrill(options: DrillOptions): Promise<DrillResult> {
  const schema = options.schema ?? PRODUCT_SCHEMA;
  const tools = { pgDump: options.pgDump ?? "pg_dump", pgRestore: options.pgRestore ?? "pg_restore", schema };
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const scratchName = `drill_${randomBytes(6).toString("hex")}`;
  const scratchUrl = new URL(options.scratchUrl ?? options.sourceUrl);
  scratchUrl.pathname = `/${scratchName}`;
  const source = postgres(options.sourceUrl, { onnotice: () => {}, max: 1 });
  const admin = postgres(options.scratchUrl ?? options.sourceUrl, { onnotice: () => {}, max: 1 });
  let created = false;
  let result: DrillResult | undefined;
  let thrown: unknown;
  try {
    const [{ db }] = await source`SELECT current_database() AS db`;
    const finish = (status: "verified" | "failed", detail: Record<string, unknown>): DrillResult => ({ databaseName: db as string, status, startedAt, finishedAt: now().toISOString(), detail });
    try {
      await admin.unsafe(`CREATE DATABASE "${scratchName}"`);
      created = true;
      result = await source.begin("isolation level repeatable read", async (tx) => {
        const [{ snapshot }] = await tx`SELECT pg_export_snapshot() AS snapshot`;
        await pipeDump({ ...tools, snapshot }, options.sourceUrl, scratchUrl.toString());
        const scratch = postgres(scratchUrl.toString(), { onnotice: () => {}, max: 1 });
        try {
          const [expected, restored] = [await tableCounts(tx as unknown as postgres.Sql, schema), await tableCounts(scratch, schema)];
          delete expected.restore_drills;
          delete restored.restore_drills;
          const names = [...new Set([...Object.keys(expected), ...Object.keys(restored)])].sort();
          const differing = names.filter((t) => expected[t] !== restored[t]);
          if (!names.length) return finish("failed", { code: "no_tables", error: `the schema ${schema} has no tables` });
          return differing.length ? finish("failed", { code: "counts_differ", error: `row counts differ after the restore: ${differing.join(", ")}`, differing, expected, restored }) : finish("verified", { schema, tables: expected });
        } finally {
          await scratch.end({ timeout: 1 });
        }
      });
    } catch (error) {
      if (error instanceof DrillToolMissingError) thrown = error;
      else result = finish("failed", { code: "tool_failed", error: (error as Error).message.slice(0, STDERR_CAP) });
    }
  } catch (error) {
    thrown = error;
  }
  let leaked: string | undefined;
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => { leaked = scratchName; });
  await Promise.all([source.end({ timeout: 1 }), admin.end({ timeout: 1 })]);
  if (thrown) throw leaked && thrown instanceof Error ? Object.assign(thrown, { message: `${thrown.message}; scratch database left behind: ${leaked}` }) : thrown;
  return leaked ? { ...result!, detail: { ...result!.detail, scratchLeaked: leaked } } : result!;
}
