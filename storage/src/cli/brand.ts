#!/usr/bin/env -S pnpm exec tsx
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3ObjectStore } from "../blob/index.ts";
import { NotFoundError, PurgeRefusedError, type BlobStore } from "../contracts/index.ts";
import { BY_DESIGN, entryPath, isKept } from "../import/legacy.ts";
import { CutOverError, importBrand, verifyBrand, type ImportReport, type ImportRepos } from "../import/importer.ts";
import { DEFAULT_LEGACY_PREFIX, LEGACY_SOURCE, LegacyBucketError, OUTPUTS_MARKER, withLegacyBucket } from "../import/legacy-bucket.ts";
import { EXIT, readInputBytes, readInputFile, runVerb, SLUG_FORMAT, VERB_SPECS, VERB_USAGE, hasUnknownSubcommand, writeTarget, type CliResult } from "./verbs.ts";
import { connect, type Sql } from "../pg/connect.ts";
import { createPgRepositories, drillRefusal, DrillNotRunError, openPurger, runBackupDrill, type DrillFailureCode, type DrillResult, type Purger } from "../pg/index.ts";

export type { CliResult };

/** The only file the system ever writes inside a brand folder (D12). */
export const CUTOVER_MARKER = ".storage-cutover";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
/** Each verb accepts only its own flags: `--dry-run` must never reach a verb that cannot honor it. */
const VERBS: Record<string, { values: string[]; flags: string[]; positionals: [number, number] }> = {
  import: { values: ["from", "owner-opt-in"], flags: ["dry-run"], positionals: [0, 0] },
  cutover: { values: ["from", "confirm", "owner-opt-in"], flags: ["partial"], positionals: [1, 1] },
  backup: { values: [], flags: [], positionals: [1, 1] },
  ...VERB_SPECS,
};
const REMOTE_REFUSAL = "Se rechaza escribir en una base de datos remota sin un simulacro de restauración verificado y reciente.";
const USAGE = ["Uso:", "  brand import --from <carpeta | legacy-bucket:<marca>> [--dry-run] [--owner-opt-in <slug>]", "  brand cutover <slug> --confirm <slug> [--from <carpeta>] [--partial] [--owner-opt-in <slug>]", "  (una marca que no es de ejemplo requiere la aprobación explícita del dueño)", ...VERB_USAGE];

/** Brands the tool may touch freely: the fictional, tracked `profiles/example*` folders. */
const EXAMPLE_BRAND = /^example(-[a-z0-9-]+)?$/;

/**
 * Owner guard: any brand that is not an example brand is refused, `--dry-run` included, unless BOTH the env var
 * `BRAND_OWNER_OPT_IN` and the flag `--owner-opt-in` name that exact slug (never a wildcard). Only the owner sets it,
 * by hand, per brand, after approving that brand's source; agents and automation must not. A local env var is a speed
 * bump against mistakes, not a security boundary. Runs before any database connection or folder read.
 * `names` holds every name the folder goes by: its own and, when it exists, its real one, so a symlink called
 * `example-x` that points at a real brand is judged by the real brand's name too.
 */
function ownerRefusal(names: string[], env: NodeJS.ProcessEnv, flag: string | undefined): string | null {
  const blocked = [...new Set(names)].filter((n) => !EXAMPLE_BRAND.test(n) && !(/^[a-z0-9-]+$/.test(n) && env.BRAND_OWNER_OPT_IN === n && flag === n));
  const many = blocked.length > 1;
  return blocked.length ? `${many ? "Las marcas" : "La marca"} ${blocked.map((n) => `"${n}"`).join(", ")} ${many ? "no son" : "no es"} de ejemplo: ${many ? "requieren" : "requiere"} la aprobación explícita del dueño (BRAND_OWNER_OPT_IN=<marca> y --owner-opt-in <marca>). No se hizo nada.` : null;
}

/**
 * The bucket the importer writes blobs to, from the same `S3_*` variables as the editor (`S3_BUCKET`, `S3_ACCESS_KEY_ID`,
 * `S3_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`); undefined when they are not all set.
 */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv): BlobStore | undefined {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return undefined;
  return new S3ObjectStore({ bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT, region: env.S3_REGION || "us-east-1", accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false" });
}

/** Strict per-verb parser (`--flag value` or `--flag=value`). Returns null for an unknown verb or flag, or a missing value. */
export function parseArgs(verb: string | undefined, argv: string[]) {
  const spec = verb && Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!spec) return null;
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      positionals.push(argv[i]);
      continue;
    }
    const [name, ...inline] = argv[i].slice(2).split("=");
    if (spec.flags.includes(name) && !inline.length) flags.add(name);
    else if (spec.values.includes(name)) {
      const value = inline.length ? inline.join("=") : argv[++i];
      if (!value || value.startsWith("--")) return null;
      values.set(name, value);
    } else return null;
  }
  return { positionals, values, flags };
}

/**
 * Only a plain loopback host counts as local; anything unparseable, multi-host, socket or `?host=` is remote.
 * A missing URL is "local" only because there is nothing to protect: `runCli` reports the missing URL itself.
 */
export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.searchParams.has("host");
  } catch {
    return false;
  }
}

/**
 * Backup gate (design section 10): a write to a remote database needs a recent verified restore drill, read from that
 * database itself. Null when the write may go on. Local databases never reach it.
 */
async function backupGate(repos: ImportRepos | undefined, env: NodeJS.ProcessEnv): Promise<CliResult | null> {
  let sql: Sql | null = null;
  try {
    if (!repos) sql = connect(env);
    const why = await drillRefusal((repos ?? createPgRepositories(sql!)).restoreDrills);
    return why ? { lines: [REMOTE_REFUSAL, why], exitCode: EXIT.REFUSED } : null;
  } catch (error) {
    return { lines: [`Error: ${(error as Error).message}`], exitCode: EXIT.UNEXPECTED };
  } finally {
    await sql?.end({ timeout: 1 });
  }
}

const DRILL_STATUS: Record<DrillResult["status"], string> = { verified: "verificado", failed: "falló" };
/** Spanish reason of each failure code; being a total `Record`, a code added in drill.ts does not compile until it is mapped here. */
const DRILL_WHY: Record<DrillFailureCode, (detail: Record<string, unknown>) => string> = {
  no_tables: () => "el esquema no tiene tablas",
  counts_differ: (d) => `las filas no coinciden tras restaurar (${(d.differing as string[] | undefined)?.join(", ")})`,
  tool_failed: () => "pg_dump o pg_restore fallaron (el detalle queda en el registro)",
  verify_failed: () => "no se pudieron leer los conteos de filas (el detalle queda en el registro)",
};

/** The Spanish report of a finished drill, and its exit code: a leaked scratch database or a failed drill is not a success. */
function describeDrill(outcome: DrillResult): CliResult {
  const leaked = outcome.detail.scratchLeaked;
  const why = outcome.status === "failed" ? `: ${DRILL_WHY[outcome.detail.code as DrillFailureCode]?.(outcome.detail) ?? "motivo desconocido"}` : "";
  if (leaked) return { lines: [`El simulacro terminó (${DRILL_STATUS[outcome.status]}${why}), pero no se pudo borrar la base temporal "${leaked}": bórrala a mano.`], exitCode: EXIT.UNEXPECTED };
  if (outcome.status === "verified") return { lines: [`Simulacro verificado: ${Object.keys(outcome.detail.tables as object).length} tablas restauradas con las mismas filas.`], exitCode: EXIT.OK };
  return { lines: [`El simulacro falló${why}.`], exitCode: EXIT.UNEXPECTED };
}

/**
 * `brand backup drill`: dumps `DATABASE_URL` (a direct connection, not a pooler), restores it into a scratch database (`DATABASE_DRILL_URL`,
 * default the same server), verifies it and records the result. The outcome is reported even when it cannot be recorded.
 */
async function backupDrill(repos: ImportRepos | undefined, env: NodeJS.ProcessEnv, now: () => Date, run = runBackupDrill): Promise<CliResult> {
  if (!env.DATABASE_URL) return { lines: ["Falta DATABASE_URL: indica la base de datos de storage."], exitCode: EXIT.UNEXPECTED };
  let outcome: DrillResult;
  try {
    outcome = await run({ sourceUrl: env.DATABASE_URL, scratchUrl: env.DATABASE_DRILL_URL, pgDump: env.PG_DUMP_BIN, pgRestore: env.PG_RESTORE_BIN, prepare: env.DATABASE_PREPARE !== "false", now });
  } catch (error) {
    return { lines: [error instanceof DrillNotRunError ? `No se hizo el simulacro: ${error.message}.` : `Error: ${(error as Error).message}`], exitCode: EXIT.UNEXPECTED };
  }
  const report = describeDrill(outcome);
  let sql: Sql | null = null;
  try {
    if (!repos) sql = connect(env);
    await (repos ?? createPgRepositories(sql!)).restoreDrills.record(outcome);
    return report;
  } catch (error) {
    return { lines: [...report.lines, `No se pudo registrar el resultado (${(error as Error).message}): el candado de respaldo no cambió.`], exitCode: EXIT.UNEXPECTED };
  } finally {
    await sql?.end({ timeout: 1 });
  }
}

/** The folder's own name plus, when it exists, the name of what it really is (symlinks resolved). */
function folderNames(from: string): string[] {
  try {
    return [basename(from), basename(realpathSync(from))];
  } catch {
    return [basename(from)]; // missing or dangling: nothing to resolve, and nothing will be read either
  }
}

/** Expands `~` and `~/…` only; `~user` is left alone. */
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
/** Relative `--from` values resolve against where the user ran the command (pnpm sets INIT_CWD), not the package dir. */
const fromCwd = (p: string, env: NodeJS.ProcessEnv) => resolve(env.INIT_CWD ?? process.cwd(), expandHome(p));
/** Same rule as `resolveProfilesRoot` in system/ig-carousel/profile.ts (not imported: storage must not depend on system/). */
function profilesRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.BRAND_PROFILES_DIR?.trim();
  if (!configured) return join(REPO_ROOT, "profiles");
  const expanded = expandHome(configured);
  return isAbsolute(expanded) ? expanded : join(REPO_ROOT, expanded);
}

/** `lstat`, so a planted or dangling symlink counts as present and is never followed. */
function markerExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** True when the marker is a regular file (never a followed symlink) naming this brand. */
function markerNames(path: string, brandId: string): boolean {
  try {
    return lstatSync(path).isFile() && JSON.parse(readFileSync(path, "utf-8")).brandId === brandId;
  } catch {
    return false;
  }
}

/**
 * Data a cutover would strand: everything not imported, skipped or refused on a guess (unknown type, suspicious name),
 * minus what is never imported by design, kept as a legacy blob, or proven secret (`refused`: deliberate, never blocks).
 */
const leftBehind = (r: ImportReport) => [...r.notImported.filter((f) => !BY_DESIGN.test(f)), ...r.skipped.filter((e) => !accountedFor(r, entryPath(e))), ...r.unimported];

/**
 * A skipped entry whose files the legacy pass kept, or refused as proven secrets (itself or inside it), is not stranded data:
 * whatever else is inside it that is neither kept nor refused is reported on its own line (`skipped` or `unimported`).
 */
const accountedFor = (r: ImportReport, path: string) => isKept(r.legacy.manifest, path) || r.refused.some((e) => isSameOrUnder(path, entryPath(e)));

/** Whether `entry` (a report path, maybe with a trailing slash) is `path` or lies under it. */
const isSameOrUnder = (path: string, entry: string): boolean => {
  const p = entry.replace(/\/$/, "");
  return p === path || p.startsWith(`${path}/`);
};

function describe(report: ImportReport): string[] {
  const c = report.counts;
  return [
    `Marca "${report.slug}"${report.dryRun ? " (simulacro: no se escribió nada)" : ""}`,
    ...report.items.map((i) => `  ${i.outcome} ${i.key}`),
    `Creados ${c.created}, actualizados ${c.updated}, sin cambios ${c.unchanged}, conflictos ${c.conflict}.`,
    ...(report.conflicts.length ? [`Conflictos: ${report.conflicts.join(", ")}.`] : []),
    ...(report.origin ? [`Origen: ${report.origin}.`] : []),
    ...(report.outputsRoot ? [`Carpeta de salidas leída (fuera de la marca): ${report.outputsRoot}.`] : []),
    ...(report.legacy.count ? [`Guardados como legado, por contenido: ${report.legacy.count} archivo(s)${report.legacy.changed.length ? `; nuevos o cambiados desde la última importación: ${report.legacy.changed.join(", ")}` : ""}.`] : []),
    ...(report.refused.length ? [`Rechazados, nunca importados: ${report.refused.join(", ")}.`] : []),
    ...(report.unimported.length ? [`Sin importar (tipo no reconocido o nombre sospechoso): ${report.unimported.join(", ")}.`] : []),
    ...(report.notices.length ? [`Avisos: ${report.notices.join("; ")}.`] : []),
    ...(report.notImported.length ? [`Fuera de esta etapa, no importado: ${report.notImported.join(", ")}.`] : []),
    ...report.proposals.map((p) => `Propuesta de regla (no creada): ${p.kind} ${JSON.stringify(p.params)} desde ${p.from}.`),
    ...(report.skipped.length ? [`Omitidos: ${report.skipped.join(", ")}.`] : []),
  ];
}

async function cutover(repos: ImportRepos, blobs: BlobStore | undefined, env: NodeJS.ProcessEnv, slug: string, from: string, author: string, partial: boolean): Promise<CliResult> {
  const marker = join(from, CUTOVER_MARKER);
  // Exclusive create: never overwrites or follows anything already at the marker path. A concurrent cutover that
  // already wrote the same brand's marker (EEXIST) counts as success; any other failure is the caller's to report.
  const write = (brandId: string, at: string): "written" | "exists" => {
    try {
      writeFileSync(marker, JSON.stringify({ brandId, cutoverAt: at }, null, 2) + "\n", { flag: "wx" });
      return "written";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && markerNames(marker, brandId)) return "exists";
      throw error;
    }
  };
  const already = (how: string): CliResult => ({ lines: [`La marca "${slug}" ya estaba cortada a storage (marcador ${how}).`], exitCode: EXIT.OK });
  const existing = await repos.brands.getBySlug(slug).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  const present = markerExists(marker);
  if (existing?.value.cutoverAt) {
    // A marker already there must name this brand; anything else is left untouched and reported.
    if (present && !markerNames(marker, existing.id)) return { lines: [`El ${CUTOVER_MARKER} de ${from} no corresponde a la marca "${slug}": revísalo; no se tocó.`], exitCode: EXIT.REFUSED };
    // Side effect: a missing marker is restored here (created exclusively, never overwriting).
    const restored = !present && write(existing.id, existing.value.cutoverAt) === "written";
    return already(restored ? "restituido" : "presente");
  }
  if (present) return { lines: [`Ya hay un ${CUTOVER_MARKER} en ${from}, pero la marca no está cortada: revísalo antes de continuar.`], exitCode: EXIT.REFUSED };

  // Data the importer does not carry yet would be stranded by a cutover, so it must be acknowledged with --partial.
  const plan = await importBrand(repos, { from, dryRun: true, author, blobs, env });
  const refuse = (left: string[]): CliResult => ({ lines: [`No se corta: quedan datos sin importar (${left.join(", ")}). Si es intencional, repite con --partial.`], exitCode: EXIT.REFUSED });
  if (leftBehind(plan).length && !partial) return refuse(leftBehind(plan));
  const report = await importBrand(repos, { from, dryRun: false, author, blobs, env });
  // The real pass can see more than the plan did (the folder may have changed in between): check it too.
  if (leftBehind(report).length && !partial) return refuse(leftBehind(report));
  const mismatched = await verifyBrand(repos, from, blobs, env);
  if (report.counts.conflict || mismatched.length) {
    return { lines: [...describe(report), `No se corta: verificación sucia (${[...report.items.filter((i) => i.outcome === "conflict").map((i) => i.key), ...mismatched].join(", ")}).`], exitCode: EXIT.REFUSED };
  }
  const brand = await repos.brands.getBySlug(slug);
  const done = await repos.brands.markCutover(brand.id, { expectedVersion: brand.version, author, source: "cli", reason: "structural" });
  try {
    if (write(done.id, done.value.cutoverAt!) === "exists") return already("presente");
  } catch (error) {
    return { lines: [`La marca "${slug}" quedó cortada en storage, pero no se pudo escribir ${CUTOVER_MARKER} (${(error as Error).message}). Vuelve a ejecutar el mismo cutover para restituirlo.`], exitCode: EXIT.UNEXPECTED };
  }
  return { lines: [...describe(report), `Marca "${slug}" cortada a storage. La carpeta no se borra; ya no se lee como fuente.`], exitCode: EXIT.OK };
}

/** @internal Test seams: `suffix` names the temporary sibling of `asset get --out`; `beforeRead` runs between the path check and the read of `asset add`. */
export interface CliHooks {
  suffix?: () => string;
  beforeRead?: (path: string) => void;
  /** The clock of the purge bundle name. */
  now?: () => Date;
  /** Replaces the network of `fonts fetch`. */
  fetch?: typeof fetch;
  /** Replaces the `DATABASE_PURGE_URL` connection of `purge` (the host gate still runs first). */
  openPurger?: () => Promise<Purger>;
  /** Replaces the dump-and-restore of `backup drill` (the result is still recorded). */
  runDrill?: typeof runBackupDrill;
}

/**
 * `repos` is injected by tests; otherwise the Postgres repositories are opened from `DATABASE_URL`
 * (an owner-capable role: guidance and import runs are owner-only). `blobs` is injected by tests; otherwise the bucket
 * comes from the `S3_*` variables, and without one the assets of a folder are reported, not imported.
 * Output lines are user-facing Spanish.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, repos?: ImportRepos, blobs: BlobStore | undefined = repos ? undefined : blobStoreFromEnv(env), hooks: CliHooks = {}): Promise<CliResult> {
  const [verb, ...rest] = argv;
  const args = parseArgs(verb, rest);
  const slug = args?.positionals[0];
  const [min, max] = (verb && Object.hasOwn(VERBS, verb) && VERBS[verb].positionals) || [0, 0];
  if (!args || args.positionals.length < min || args.positionals.length > max || (verb === "import" && !args.values.has("from"))) return { lines: USAGE, exitCode: EXIT.USAGE };
  const dryRun = args.flags.has("dry-run");
  const author = `cli:${env.USER ?? "unknown"}`;
  const now = hooks.now ?? (() => new Date());
  if (verb === "backup") return args.positionals[0] === "drill" ? backupDrill(repos, env, now, hooks.runDrill) : { lines: USAGE, exitCode: EXIT.USAGE };
  if (Object.hasOwn(VERB_SPECS, verb!)) {
    // A mistyped subcommand is a usage error whatever the brand: it must not surface as an owner or backup refusal.
    if (hasUnknownSubcommand(verb!, args.positionals)) return { lines: USAGE, exitCode: EXIT.USAGE };
    // D13: on a brand that is not an example, identity writes always need the owner's opt-in; a content write needs it
    // only until the brand is cut over (checked below, once connected). A write on a remote database is refused
    // without a recent verified restore drill (backup gate); reads stay open. The slug format is checked first.
    const target = writeTarget(verb!, args.positionals);
    let ownerRefused: string | null = null;
    if (target !== null) {
      if (typeof target.slug !== "string" || !SLUG_FORMAT.test(target.slug)) return { lines: ["El nombre de la marca solo admite minúsculas, dígitos y guiones."], exitCode: EXIT.USAGE };
      ownerRefused = ownerRefusal([target.slug], env, args.values.get("owner-opt-in"));
      if (ownerRefused && target.identity) return { lines: [ownerRefused], exitCode: EXIT.REFUSED };
      if (!isLocalDatabase(env.DATABASE_URL)) {
        const gate = await backupGate(repos, env);
        if (gate) return gate;
      }
    }
    if (!repos && !env.DATABASE_URL) return { lines: ["Falta DATABASE_URL: indica la base de datos de storage."], exitCode: EXIT.UNEXPECTED };
    let verbSql: Sql | null = null;
    try {
      if (!repos) verbSql = connect(env);
      const verbRepos = repos ?? createPgRepositories(verbSql!);
      // A content write never touches an archived brand; without the opt-in it also needs a brand already cut over (a missing brand is refused too: fail closed).
      if (target && !target.identity) {
        const brand = await verbRepos.brands.getBySlug(target.slug).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
        if (brand && brand.value.status !== "active") return { lines: [`La marca "${target.slug}" está archivada: no se escribe contenido en ella. No se hizo nada.`], exitCode: EXIT.REFUSED };
        if (ownerRefused && !brand?.value.cutoverAt) return { lines: [`${ownerRefused} (Una escritura de contenido sin aprobación solo se permite en una marca ya cortada a storage.)`], exitCode: EXIT.REFUSED };
      }
      const purgerFor = async () => {
        const url = env.DATABASE_PURGE_URL;
        if (!url || !isLocalDatabase(url)) throw new PurgeRefusedError("DATABASE_PURGE_URL no apunta a una base de datos local: la purga solo corre en local");
        return hooks.openPurger ? hooks.openPurger() : openPurger(connect(env, url), verbSql ?? undefined);
      };
      return await runVerb({ repos: verbRepos, openPurger: purgerFor, blobs, env, author, repoRoot: REPO_ROOT, read: (path) => readInputFile(fromCwd(path, env)), readBytes: (path, max) => (hooks.beforeRead?.(fromCwd(path, env)), readInputBytes(fromCwd(path, env), max)), suffix: hooks.suffix ?? (() => randomBytes(6).toString("hex")), now, fetch: hooks.fetch ?? fetch, resolve: (path) => fromCwd(path, env) }, verb!, args);
    } catch (error) {
      return { lines: [`Error: ${(error as Error).message}`], exitCode: EXIT.UNEXPECTED };
    } finally {
      await verbSql?.end({ timeout: 1 });
    }
  }
  /** Where a brand is read from: a folder, or a legacy bucket (by slug). Never an empty-string placeholder. */
  let source: { kind: "folder"; from: string } | { kind: "legacy"; slug: string };
  if (verb === "import") {
    const asked = args.values.get("from")!;
    if (LEGACY_SOURCE.test(asked)) {
      const named = asked.replace(LEGACY_SOURCE, "");
      if (!SLUG_FORMAT.test(named)) return { lines: ["El nombre de la marca solo admite minúsculas, dígitos y guiones."], exitCode: EXIT.USAGE };
      source = { kind: "legacy", slug: named };
    } else source = { kind: "folder", from: fromCwd(asked, env) };
    // The brand's slug is the folder name (or the legacy slug) and nothing inside the files can declare another, so this guard covers both sources.
    const refused = ownerRefusal(source.kind === "legacy" ? [source.slug] : folderNames(source.from), env, args.values.get("owner-opt-in"));
    if (refused) return { lines: [refused], exitCode: EXIT.REFUSED };
    if (source.kind === "legacy" && !blobs) return { lines: ["Falta el bucket (S3_BUCKET, S3_ACCESS_KEY_ID y S3_SECRET_ACCESS_KEY): no se puede leer legacy-bucket."], exitCode: EXIT.UNEXPECTED };
  } else {
    if (args.values.get("confirm") !== slug) return { lines: [`Para cortar escribe: brand cutover ${slug} --confirm ${slug}`], exitCode: EXIT.REFUSED };
    if (LEGACY_SOURCE.test(args.values.get("from") ?? "")) return { lines: ["cutover no admite legacy-bucket: importa con brand import --from legacy-bucket:<marca> y corta desde la carpeta de la marca."], exitCode: EXIT.REFUSED };
    const from = args.values.has("from") ? fromCwd(args.values.get("from")!, env) : join(profilesRoot(env), slug!);
    source = { kind: "folder", from };
    const refused = ownerRefusal([slug!, ...folderNames(from)], env, args.values.get("owner-opt-in"));
    if (refused) return { lines: [refused], exitCode: EXIT.REFUSED };
    if (basename(from) !== slug) return { lines: ["La carpeta debe llamarse igual que la marca."], exitCode: EXIT.REFUSED };
  }

  // Backup gate (§10): a real write to a remote database needs a recent verified restore drill.
  if (!dryRun && !isLocalDatabase(env.DATABASE_URL)) {
    const gate = await backupGate(repos, env);
    if (gate) return gate;
  }
  if (source.kind === "folder" && !existsSync(source.from)) return { lines: [`No existe la carpeta ${source.from}.`], exitCode: EXIT.NOT_FOUND };

  if (!repos && !env.DATABASE_URL) return { lines: ["Falta DATABASE_URL: indica la base de datos de storage."], exitCode: EXIT.UNEXPECTED };
  let sql: Sql | null = null;
  try {
    if (!repos) sql = connect(env);
    const r = repos ?? createPgRepositories(sql!);
    if (verb === "cutover" && source.kind === "folder") return await cutover(r, blobs, env, slug!, source.from, author, args.flags.has("partial"));
    // Joined exactly like the editor does (`<prefix><slug>/`), so a bucket it wrote is read back as written.
    const prefix = env.S3_PREFIX ?? DEFAULT_LEGACY_PREFIX;
    const noSlash = source.kind === "legacy" && prefix !== "" && !prefix.endsWith("/") ? [`Aviso: S3_PREFIX "${prefix}" no termina en "/": se leen las claves "${prefix}<marca>/" tal como las escribió el editor.`] : [];
    // A legacy bucket is copied into a temporary folder and imported by the same code as any folder; the copy is removed afterwards.
    const report = source.kind === "legacy"
      ? await withLegacyBucket(blobs!, prefix, source.slug, env, (src) => importBrand(r, { from: src.dir, dryRun, author, blobs, env: src.env, extraSkipped: src.skipped, origin: `legacy-bucket:${prefix}${source.slug}`, outputsLabel: OUTPUTS_MARKER }))
      : await importBrand(r, { from: source.from, dryRun, author, blobs, env });
    return { lines: [...noSlash, ...describe(report)], exitCode: report.counts.conflict ? EXIT.CONFLICT : EXIT.OK };
  } catch (error) {
    if (error instanceof LegacyBucketError) return { lines: [error.message], exitCode: error.kind === "empty" ? EXIT.NOT_FOUND : EXIT.REFUSED };
    if (error instanceof CutOverError) return { lines: [`La marca "${error.slug}" ya fue cortada a storage: no se reimporta desde su carpeta.`], exitCode: EXIT.REFUSED };
    return { lines: [`Error: ${(error as Error).message}`], exitCode: EXIT.UNEXPECTED };
  } finally {
    await sql?.end({ timeout: 1 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli(process.argv.slice(2), process.env);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}
