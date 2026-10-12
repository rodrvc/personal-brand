import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT_SCHEMA, type Sql } from "./connect.ts";

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** sha256 of the content with CRLF normalized to LF, so a checkout's line endings never change it. */
export function checksum(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

const NON_TRANSACTIONAL: Array<[RegExp, string]> = [
  [/\b(create|drop)\s+(unique\s+)?index\s+concurrently\b/i, "CREATE/DROP INDEX CONCURRENTLY"],
  [/\breindex\b[^;]*\bconcurrently\b/i, "REINDEX ... CONCURRENTLY"],
  [/\bdetach\s+partition\b[^;]*\bconcurrently\b/i, "DETACH PARTITION ... CONCURRENTLY"],
  [/^\s*vacuum\b/im, "VACUUM"],
  // Whole statements only, so a plpgsql BEGIN block does not trip.
  [/^\s*(begin|commit|start\s+transaction)\s*;/im, "top-level BEGIN/COMMIT/START TRANSACTION"],
];

/** Each file runs in its own transaction, so anything that cannot (or controls transactions itself) is refused. */
export function assertTransactional(name: string, content: string): void {
  for (const [pattern, label] of NON_TRANSACTIONAL) {
    if (pattern.test(content)) throw new Error(`Migration ${name} uses ${label}, which cannot run inside the runner's transaction`);
  }
}

export interface MigrateOptions {
  /** Target schema (created if missing); migration files are not schema-qualified. Default: the product schema; tests pass throwaway ones. */
  schema?: string;
  dir?: string;
}

/** Applies pending migrations and returns the names applied by this call. */
export async function migrate(sql: Sql, options: MigrateOptions = {}): Promise<string[]> {
  const schema = options.schema ?? PRODUCT_SCHEMA;
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const contents = new Map<string, string>();
  for (const f of files) {
    const content = await readFile(path.join(dir, f), "utf8");
    assertTransactional(f, content);
    contents.set(f, content);
  }

  // Advisory locks are session-level and postgres.js pools, so everything runs on one reserved connection.
  const conn = await sql.reserve();
  const lockKey = "migrations:" + schema;
  const applied: string[] = [];
  try {
    await conn`SELECT pg_advisory_lock(hashtext(${lockKey}))`;
    try {
      // Only create when missing: CREATE SCHEMA needs CREATE on the database, which a shared-database
      // admin may withhold after pre-creating the schema for the migrator.
      const quoted = `"${schema.replace(/"/g, '""')}"`;
      const [exists] = await conn`SELECT 1 FROM pg_namespace WHERE nspname = ${schema}`;
      if (!exists) await conn.unsafe(`CREATE SCHEMA ${quoted} AUTHORIZATION CURRENT_USER`);
      await conn.unsafe(`SET search_path = ${quoted}`);
      // Created under the lock: concurrent CREATE TABLE IF NOT EXISTS can still race on pg_type.
      await conn`CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
      // Read under the lock: another runner may have applied files while we waited.
      const rows = await conn<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations`;
      const done = new Map(rows.map((r) => [r.name, r.checksum]));
      for (const name of done.keys()) {
        if (!contents.has(name)) throw new Error(`Applied migration ${name} has no file in ${dir}`);
      }
      for (const [name, content] of contents) {
        const sum = checksum(content);
        const prior = done.get(name);
        if (prior !== undefined) {
          if (prior !== sum) throw new Error(`Checksum mismatch for applied migration ${name}`);
          continue;
        }
        await conn.unsafe("BEGIN");
        try {
          await conn.unsafe(content);
          await conn`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${sum})`;
          await conn.unsafe("COMMIT");
        } catch (error) {
          await conn.unsafe("ROLLBACK").catch(() => {});
          throw error;
        }
        applied.push(name);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${lockKey}))`.catch(() => {});
    }
  } finally {
    // The reserved connection returns to the pool: do not leak our search_path.
    await conn.unsafe("RESET search_path").catch(() => {});
    conn.release();
  }
  return applied;
}
