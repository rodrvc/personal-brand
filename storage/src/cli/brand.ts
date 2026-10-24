#!/usr/bin/env -S pnpm exec tsx
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { S3ObjectStore } from "../blob/index.ts";
import { NotFoundError, type BlobStore } from "../contracts/index.ts";
import { CutOverError, importBrand, verifyBrand, type ImportReport, type ImportRepos } from "../import/importer.ts";
import { connect, type Sql } from "../pg/connect.ts";
import { createPgRepositories } from "../pg/index.ts";

export interface CliResult {
  lines: string[];
  exitCode: number;
}

/** The only file the system ever writes inside a brand folder (D12). */
export const CUTOVER_MARKER = ".storage-cutover";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
/** Each verb accepts only its own flags: `--dry-run` must never reach a verb that cannot honor it. */
const VERBS: Record<string, { values: string[]; flags: string[] }> = {
  import: { values: ["from", "owner-opt-in"], flags: ["dry-run"] },
  cutover: { values: ["from", "confirm", "owner-opt-in"], flags: ["partial"] },
};
const USAGE = ["Uso:", "  brand import --from <carpeta> [--dry-run] [--owner-opt-in <slug>]", "  brand cutover <slug> --confirm <slug> [--from <carpeta>] [--partial] [--owner-opt-in <slug>]", "  (una marca que no es de ejemplo requiere la aprobación explícita del dueño)"];

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
  const spec = verb ? VERBS[verb] : undefined;
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
 * Top-level folder entries that are never imported by design, so they do not count as left-behind data:
 * the machine-local config (`config.local.yaml` and its variants), our own cutover marker, and macOS `.DS_Store`.
 */
const BY_DESIGN = /^(config\.local\.yaml.*|\.storage-cutover|\.DS_Store)$/;

/** Data a cutover would strand: everything not imported or skipped, minus what is never imported by design. */
const leftBehind = (r: ImportReport) => [...r.notImported.filter((f) => !BY_DESIGN.test(f)), ...r.skipped];

function describe(report: ImportReport): string[] {
  const c = report.counts;
  return [
    `Marca "${report.slug}"${report.dryRun ? " (simulacro: no se escribió nada)" : ""}`,
    ...report.items.map((i) => `  ${i.outcome} ${i.key}`),
    `Creados ${c.created}, actualizados ${c.updated}, sin cambios ${c.unchanged}, conflictos ${c.conflict}.`,
    ...(report.conflicts.length ? [`Conflictos: ${report.conflicts.join(", ")}.`] : []),
    ...(report.notImported.length ? [`Fuera de esta etapa, no importado: ${report.notImported.join(", ")}.`] : []),
    ...report.proposals.map((p) => `Propuesta de regla (no creada): ${p.kind} ${JSON.stringify(p.params)} desde ${p.from}.`),
    ...(report.skipped.length ? [`Omitidos: ${report.skipped.join(", ")}.`] : []),
  ];
}

async function cutover(repos: ImportRepos, blobs: BlobStore | undefined, slug: string, from: string, author: string, partial: boolean): Promise<CliResult> {
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
  const already = (how: string): CliResult => ({ lines: [`La marca "${slug}" ya estaba cortada a storage (marcador ${how}).`], exitCode: 0 });
  const existing = await repos.brands.getBySlug(slug).catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  const present = markerExists(marker);
  if (existing?.value.cutoverAt) {
    // A marker already there must name this brand; anything else is left untouched and reported.
    if (present && !markerNames(marker, existing.id)) return { lines: [`El ${CUTOVER_MARKER} de ${from} no corresponde a la marca "${slug}": revísalo; no se tocó.`], exitCode: 1 };
    // Side effect: a missing marker is restored here (created exclusively, never overwriting).
    const restored = !present && write(existing.id, existing.value.cutoverAt) === "written";
    return already(restored ? "restituido" : "presente");
  }
  if (present) return { lines: [`Ya hay un ${CUTOVER_MARKER} en ${from}, pero la marca no está cortada: revísalo antes de continuar.`], exitCode: 1 };

  // Data the importer does not carry yet would be stranded by a cutover, so it must be acknowledged with --partial.
  const plan = await importBrand(repos, { from, dryRun: true, author, blobs });
  const refuse = (left: string[]): CliResult => ({ lines: [`No se corta: quedan datos sin importar (${left.join(", ")}). Si es intencional, repite con --partial.`], exitCode: 1 });
  if (leftBehind(plan).length && !partial) return refuse(leftBehind(plan));
  const report = await importBrand(repos, { from, dryRun: false, author, blobs });
  // The real pass can see more than the plan did (the folder may have changed in between): check it too.
  if (leftBehind(report).length && !partial) return refuse(leftBehind(report));
  const mismatched = await verifyBrand(repos, from, blobs);
  if (report.counts.conflict || mismatched.length) {
    return { lines: [...describe(report), `No se corta: verificación sucia (${[...report.items.filter((i) => i.outcome === "conflict").map((i) => i.key), ...mismatched].join(", ")}).`], exitCode: 1 };
  }
  const brand = await repos.brands.getBySlug(slug);
  const done = await repos.brands.markCutover(brand.id, { expectedVersion: brand.version, author, source: "cli", reason: "structural" });
  try {
    if (write(done.id, done.value.cutoverAt!) === "exists") return already("presente");
  } catch (error) {
    return { lines: [`La marca "${slug}" quedó cortada en storage, pero no se pudo escribir ${CUTOVER_MARKER} (${(error as Error).message}). Vuelve a ejecutar el mismo cutover para restituirlo.`], exitCode: 1 };
  }
  return { lines: [...describe(report), `Marca "${slug}" cortada a storage. La carpeta no se borra; ya no se lee como fuente.`], exitCode: 0 };
}

/**
 * `repos` is injected by tests; otherwise the Postgres repositories are opened from `DATABASE_URL`
 * (an owner-capable role: guidance and import runs are owner-only). `blobs` is injected by tests; otherwise the bucket
 * comes from the `S3_*` variables, and without one the assets of a folder are reported, not imported.
 * Output lines are user-facing Spanish.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, repos?: ImportRepos, blobs: BlobStore | undefined = repos ? undefined : blobStoreFromEnv(env)): Promise<CliResult> {
  const [verb, ...rest] = argv;
  const args = parseArgs(verb, rest);
  const slug = args?.positionals[0];
  if (!args || args.positionals.length !== (verb === "cutover" ? 1 : 0) || (verb === "import" && !args.values.has("from"))) return { lines: USAGE, exitCode: 2 };
  const dryRun = args.flags.has("dry-run");
  const author = `cli:${env.USER ?? "unknown"}`;
  let from: string;
  if (verb === "import") {
    from = fromCwd(args.values.get("from")!, env);
    const refused = ownerRefusal(folderNames(from), env, args.values.get("owner-opt-in"));
    if (refused) return { lines: [refused], exitCode: 1 };
  } else {
    if (args.values.get("confirm") !== slug) return { lines: [`Para cortar escribe: brand cutover ${slug} --confirm ${slug}`], exitCode: 1 };
    from = args.values.has("from") ? fromCwd(args.values.get("from")!, env) : join(profilesRoot(env), slug!);
    const refused = ownerRefusal([slug!, ...folderNames(from)], env, args.values.get("owner-opt-in"));
    if (refused) return { lines: [refused], exitCode: 1 };
    if (basename(from) !== slug) return { lines: ["La carpeta debe llamarse igual que la marca."], exitCode: 1 };
  }

  // Backup gate (§10). `restore_drills` lands in S8; until then any real write to a remote database is refused.
  if (!dryRun && !isLocalDatabase(env.DATABASE_URL)) {
    return { lines: ["Se rechaza escribir en una base de datos remota: aún no hay un respaldo restaurado y verificado (brand backup drill, etapa S8)."], exitCode: 1 };
  }
  if (!existsSync(from)) return { lines: [`No existe la carpeta ${from}.`], exitCode: 1 };

  if (!repos && !env.DATABASE_URL) return { lines: ["Falta DATABASE_URL: indica la base de datos de storage."], exitCode: 1 };
  let sql: Sql | null = null;
  try {
    if (!repos) sql = connect(env);
    const r = repos ?? createPgRepositories(sql!);
    if (verb === "cutover") return await cutover(r, blobs, slug!, from, author, args.flags.has("partial"));
    const report = await importBrand(r, { from, dryRun, author, blobs });
    return { lines: describe(report), exitCode: report.counts.conflict ? 1 : 0 };
  } catch (error) {
    if (error instanceof CutOverError) return { lines: [`La marca "${error.slug}" ya fue cortada a storage: no se reimporta desde su carpeta.`], exitCode: 1 };
    return { lines: [`Error: ${(error as Error).message}`], exitCode: 1 };
  } finally {
    await sql?.end({ timeout: 1 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli(process.argv.slice(2), process.env);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}
