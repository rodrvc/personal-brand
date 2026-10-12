import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";

import { DEFAULT_MIGRATIONS_DIR, migrate } from "../src/pg/migrate.ts";

if (!process.env.DATABASE_URL) {
  console.log("SKIP - DATABASE_URL not set; run `docker compose -f docker-compose.storage.yml up -d postgres` and set it to run this test");
  process.exit(0);
}

const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 3, onnotice: () => {} });
try {
  await sql`SELECT 1`;
} catch (error) {
  console.log(`SKIP - could not reach DATABASE_URL (${String((error as { code?: string }).code ?? error)})`);
  await sql.end({ timeout: 1 });
  process.exit(0);
}
const schema = `test_${randomBytes(6).toString("hex")}`;

/** Runs statements with the test schema as search_path, on a reserved connection. */
async function inSchema<T>(fn: (c: Awaited<ReturnType<typeof sql.reserve>>) => Promise<T>): Promise<T> {
  const c = await sql.reserve();
  try {
    await c.unsafe(`SET search_path = ${schema}`);
    return await fn(c);
  } finally {
    await c.unsafe("RESET search_path").catch(() => {});
    c.release();
  }
}

async function rejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(fn, (e: Error) => pattern.test(e.message));
}

let dir: string | undefined;
try {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);

  const first = await Promise.all([migrate(sql, { schema }), migrate(sql, { schema }), migrate(sql, { schema })]);
  assert.equal(first.flat().length, 1, "concurrent runners apply exactly once");
  assert.deepEqual(await migrate(sql, { schema }), [], "second run applies nothing");
  const count = await inSchema((c) => c`SELECT count(*)::int AS n FROM schema_migrations`);
  assert.equal(count[0].n, 1);

  await inSchema(async (c) => {
    await rejects(() => c`INSERT INTO brands (slug, display_name) VALUES ('Bad Slug', 'x')`, /brands_slug_check/);
    const [brand] = await c`INSERT INTO brands (slug, display_name) VALUES ('acme-coffee', 'Acme Coffee') RETURNING id`;

    await rejects(
      () => c`INSERT INTO brand_documents (brand_id, kind, schema_version) VALUES (${brand.id}, 'tokens', 1)`,
      /check/,
    );
    await rejects(
      () => c`INSERT INTO brand_documents (brand_id, kind, schema_version, body_json, body_text)
              VALUES (${brand.id}, 'tokens', 1, '{}', 'x')`,
      /check/,
    );
    await c`INSERT INTO brand_documents (brand_id, kind, schema_version, body_json) VALUES (${brand.id}, 'tokens', 1, '{}')`;

    await c`INSERT INTO revisions (brand_id, entity_type, entity_id, version, reason, body, author, source)
            VALUES (${brand.id}, 'brand', ${brand.id}, 1, 'save', '{}', 'test', 'system')`;
    await rejects(() => c`UPDATE revisions SET author = 'other'`, /append-only/);
    await rejects(() => c`DELETE FROM revisions`, /append-only/);

    await rejects(() => c`DELETE FROM brands WHERE id = ${brand.id}`, /foreign key/);

    const [other] = await c`INSERT INTO brands (slug, display_name) VALUES ('acme-tea', 'Acme Tea') RETURNING id`;
    await c.unsafe("BEGIN");
    await c.unsafe(`SET LOCAL app.purge_brand = '${other.id}'`);
    await rejects(() => c`DELETE FROM revisions`, /append-only/);
    await c.unsafe("ROLLBACK");

    await c.unsafe("BEGIN");
    await c.unsafe(`SET LOCAL app.purge_brand = '${brand.id}'`);
    await c`DELETE FROM revisions`;
    await c.unsafe("COMMIT");
    await c`INSERT INTO revisions (brand_id, entity_type, entity_id, version, reason, author, source)
            VALUES (${brand.id}, 'brand', ${brand.id}, 1, 'save', 'test', 'system')`;
    await rejects(() => c`DELETE FROM revisions`, /append-only/);

    // Provisioned roles (compose init SQL) get least-privilege grants; skipped when roles are absent.
    const roles = new Set((await c`SELECT rolname FROM pg_roles`).map((r) => r.rolname));
    const can = async (role: string, priv: string) =>
      (await c`SELECT has_table_privilege(${role}, ${schema + ".revisions"}, ${priv}) AS ok`)[0].ok;
    if (roles.has("brand_app")) {
      assert.equal(await can("brand_app", "INSERT"), true);
      assert.equal(await can("brand_app", "UPDATE"), false);
      assert.equal(await can("brand_app", "DELETE"), false);
    }
    if (roles.has("brand_purger")) {
      assert.equal(await can("brand_purger", "DELETE"), true);
      assert.equal(await can("brand_purger", "UPDATE"), false);
    }
  });

  // A changed applied file is refused; a CONCURRENTLY file is rejected before touching the DB.
  dir = await mkdtemp(path.join(os.tmpdir(), "migrations-"));
  const original = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, "0001_foundation.sql"), "utf8");
  await writeFile(path.join(dir, "0001_foundation.sql"), original + "\n-- edited\n");
  await rejects(() => migrate(sql, { schema, dir }), /Checksum mismatch/);
  await writeFile(path.join(dir, "0001_foundation.sql"), original.replace(/\n/g, "\r\n"));
  assert.deepEqual(await migrate(sql, { schema, dir }), [], "CRLF checkout of the same file is accepted");
  await writeFile(path.join(dir, "0002_bad.sql"), "CREATE INDEX CONCURRENTLY i ON brands (slug);");
  await rejects(() => migrate(sql, { schema, dir }), /CONCURRENTLY/);

  await rm(path.join(dir, "0002_bad.sql"));
  // An applied migration whose file vanished is reported.
  await writeFile(path.join(dir, "0001_foundation.sql"), original);
  await inSchema((c) => c`INSERT INTO schema_migrations (name, checksum) VALUES ('0099_gone.sql', 'x')`);
  await rejects(() => migrate(sql, { schema, dir }), /0099_gone\.sql has no file/);
  await rejects(() => migrate(sql, { schema: `${schema}_missing` }), /does not exist/);
  console.log("migrate.integration: ok");
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await sql.end();
}
