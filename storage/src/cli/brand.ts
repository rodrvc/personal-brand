#!/usr/bin/env -S npx tsx
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CutOverError, importBrand, type ImportReport, type ImportRepos } from "../import/importer.ts";
import { connect, type Sql } from "../pg/connect.ts";
import { createPgRepositories } from "../pg/index.ts";

export interface CliResult {
  lines: string[];
  exitCode: number;
}

/** Each verb accepts only its own flags: `--dry-run` must never reach a verb that cannot honor it. */
const VERBS: Record<string, { values: string[]; flags: string[] }> = {
  import: { values: ["from"], flags: ["dry-run"] },
};
const USAGE = ["Uso:", "  brand import --from <carpeta> [--dry-run]"];

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

/** Only a plain loopback host counts as local; anything unparseable, multi-host, socket or `?host=` is remote. */
export function isLocalDatabase(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.searchParams.has("host");
  } catch {
    return false;
  }
}

/** Expands `~` and `~/…` only; `~user` is left alone. */
const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
/** Relative `--from` values resolve against where the user ran the command (pnpm sets INIT_CWD), not the package dir. */
const fromCwd = (p: string, env: NodeJS.ProcessEnv) => resolve(env.INIT_CWD ?? process.cwd(), expandHome(p));
function describe(report: ImportReport): string[] {
  const c = report.counts;
  return [
    `Marca "${report.slug}"${report.dryRun ? " (simulacro: no se escribió nada)" : ""}`,
    ...report.items.map((i) => `  ${i.outcome} ${i.key}`),
    `Creados ${c.created}, actualizados ${c.updated}, sin cambios ${c.unchanged}, conflictos ${c.conflict}.`,
    ...(report.notImported.length ? [`Fuera de esta etapa, no importado: ${report.notImported.join(", ")}.`] : []),
  ];
}

/**
 * `repos` is injected by tests; otherwise the Postgres repositories are opened from `DATABASE_URL`
 * (an owner-capable role: guidance and import runs are owner-only). Output lines are user-facing Spanish.
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, repos?: ImportRepos): Promise<CliResult> {
  const [verb, ...rest] = argv;
  const args = parseArgs(verb, rest);
  if (!args || args.positionals.length || !args.values.has("from")) return { lines: USAGE, exitCode: 2 };
  const dryRun = args.flags.has("dry-run");
  const from = fromCwd(args.values.get("from")!, env);

  // Backup gate (§10). `restore_drills` lands in S8; until then any real write to a remote database is refused.
  if (!dryRun && !isLocalDatabase(env.DATABASE_URL)) {
    return { lines: ["Se rechaza escribir en una base de datos remota: aún no hay un respaldo restaurado y verificado (brand backup drill, etapa S8)."], exitCode: 1 };
  }
  if (!existsSync(from)) return { lines: [`No existe la carpeta ${from}.`], exitCode: 1 };

  if (!repos && !env.DATABASE_URL) return { lines: ["Falta DATABASE_URL: indica la base de datos de storage."], exitCode: 1 };
  let sql: Sql | null = null;
  try {
    if (!repos) sql = connect(env);
    const report = await importBrand(repos ?? createPgRepositories(sql!), { from, dryRun, author: `cli:${env.USER ?? "unknown"}` });
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
