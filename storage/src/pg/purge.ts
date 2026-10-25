import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { blobKey } from "../contracts/keys.ts";
import { PurgeRefusedError } from "../contracts/errors.ts";
import type { Sql } from "./connect.ts";
import { checksum, DEFAULT_MIGRATIONS_DIR } from "./migrate.ts";

/** Every table a brand owns, in delete order (children first), with the predicate that scopes it to one brand (`$1`). Design §8. */
export const PURGE_TABLES: Array<[table: string, scope: string]> = [
  ["chat_messages", "carousel_id IN (SELECT id FROM carousels WHERE brand_id = $1)"],
  ["exports", "carousel_id IN (SELECT id FROM carousels WHERE brand_id = $1)"],
  ["run_artifacts", "run_id IN (SELECT id FROM recipe_runs WHERE brand_id = $1)"],
  ["carousels", "brand_id = $1"], ["recipe_runs", "brand_id = $1"], ["content_items", "brand_id = $1"], ["assets", "brand_id = $1"], ["tts_cache", "brand_id = $1"],
  ["brand_rules", "brand_id = $1"], ["brand_guidance", "brand_id = $1"], ["brand_recipes", "brand_id = $1"], ["brand_documents", "brand_id = $1"],
  ["import_runs", "brand_id = $1"], ["revisions", "brand_id = $1"], ["brands", "id = $1"],
];

export interface BrandBundle {
  /** Every row of the brand, by table, as `to_jsonb` (full fidelity, no driver type mapping). */
  tables: Record<string, unknown[]>;
  /** Row count per table: what the delete must remove, exactly. */
  counts: Record<string, number>;
  /** The blob keys the database knows (assets, TTS audio and run artifacts), with their hashes. */
  blobs: Array<{ key: string; sha256: string }>;
  /** The migrations this code ships (name and checksum). `schema_migrations` is not readable by the purger role. */
  migrations: { head: string; files: Array<{ name: string; checksum: string }> };
}

/** The only connection that may delete: it runs as `brand_purger` (checked on open). */
export interface Purger {
  /**
   * One transaction: lock the brand (it must be archived) and the parents of the grandchild tables, read every row,
   * hand them to `writeBundle` (which must make the bundle durable before it returns), delete in FK order, and require
   * the deleted counts to equal the bundled counts. Any failure rolls everything back. Returns the deleted counts.
   */
  purge(brandId: string, writeBundle: (bundle: BrandBundle) => void | Promise<void>): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** Epoch seconds, not text: a timestamptz cast to text follows the session TimeZone, which two roles may set differently. `host()` drops the `/32` or `/128` mask. */
const where = async (sql: Sql) => (await sql`SELECT current_database() AS db, inet_server_port() AS port, host(inet_server_addr()) AS addr, extract(epoch FROM pg_postmaster_start_time())::text AS started`)[0];

/** Loopback is one address however it is reached (`::1`, `::ffff:127.0.0.1`, `127.0.0.1`). */
export const sameAddr = (a: string, b: string) => [a, b].every((x) => /^(::1|(::ffff:)?127(\.\d{1,3}){3})$/.test(x)) || a === b;

/**
 * Opens a purger on `sql`, refusing (and closing it) unless the session really is `brand_purger`, and, when `sameAs` is
 * given (the `DATABASE_URL` connection), unless both connections reach the same database, address, port and server start time.
 */
export async function openPurger(sql: Sql, sameAs?: Sql): Promise<Purger> {
  try {
    const [{ who }] = await sql`SELECT current_user AS who`;
    if (who !== "brand_purger") throw new PurgeRefusedError(`la conexión de purga corre como "${who}", no como brand_purger`);
    if (sameAs) {
      const [a, b] = [await where(sql), await where(sameAs)];
      // `addr` is null on a Unix-socket connection: there is nothing to compare then, and the other three checks still apply.
      if (a.db !== b.db || a.port !== b.port || (a.addr && b.addr && !sameAddr(a.addr, b.addr)) || a.started !== b.started) throw new PurgeRefusedError("DATABASE_URL y DATABASE_PURGE_URL apuntan a bases de datos distintas");
    }
  } catch (error) {
    await sql.end({ timeout: 1 });
    throw error;
  }
  return {
    async purge(brandId, writeBundle) {
      // Repeatable read: the snapshot is taken when the first statement starts, before it waits for the brand lock, so a row changed after that
      // makes the delete fail (serialization error or the RESTRICT key) instead of vanishing unbundled.
      return sql.begin("isolation level repeatable read", async (tx) => {
        const [brand] = await tx`SELECT status FROM brands WHERE id = ${brandId} FOR UPDATE`;
        if (!brand) throw new PurgeRefusedError("la marca no existe (¿ya fue purgada?)");
        if (brand.status !== "archived") throw new PurgeRefusedError("la marca ya no está archivada");
        // Writers take a share lock on the brand (direct children) or on their parent row (chat, exports, run artifacts): both block from here on.
        await tx`SELECT id FROM carousels WHERE brand_id = ${brandId} FOR UPDATE`;
        await tx`SELECT id FROM recipe_runs WHERE brand_id = ${brandId} FOR UPDATE`;
        const tables: Record<string, unknown[]> = {};
        for (const [table, scope] of PURGE_TABLES) tables[table] = (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${scope}`, [brandId])).map((r) => r.row);
        const rows = (name: string) => tables[name] as Array<{ sha256: string; blob_key?: string }>;
        const found = [...rows("assets").map((a) => ({ key: a.blob_key!, sha256: a.sha256 })), ...[...rows("tts_cache"), ...rows("run_artifacts")].map((r) => ({ key: blobKey(brandId, r.sha256), sha256: r.sha256 }))];
        const counts = Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length]));
        await writeBundle({ tables, counts, blobs: [...new Map(found.map((b) => [b.key, b])).values()].sort((a, b) => (a.key < b.key ? -1 : 1)), migrations: shippedMigrations() });
        // SET LOCAL: the flag the `revisions` trigger checks dies with this transaction.
        await tx`SELECT set_config('app.purge_brand', ${brandId}, true)`;
        // A derived item points at its source with a RESTRICT key: detach them first so the rows can go in any order.
        await tx`UPDATE content_items SET derived_from = NULL WHERE brand_id = ${brandId}`;
        const deleted: Record<string, number> = {};
        for (const [table, scope] of PURGE_TABLES) deleted[table] = (await tx.unsafe(`DELETE FROM ${table} WHERE ${scope}`, [brandId])).count;
        // Defensive only: the locks and the snapshot already make a mismatch unreachable; this guards a future change to either.
        for (const [table, n] of Object.entries(counts)) if (deleted[table] !== n) throw new PurgeRefusedError(`la tabla ${table} cambió durante la purga (${n} en el paquete, ${deleted[table]} borradas)`);
        return deleted;
      });
    },
    close: () => sql.end({ timeout: 1 }),
  };
}

function shippedMigrations(): BrandBundle["migrations"] {
  const files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort().map((name) => ({ name, checksum: checksum(readFileSync(join(DEFAULT_MIGRATIONS_DIR, name), "utf8")) }));
  return { head: files.at(-1)?.name ?? "", files };
}
