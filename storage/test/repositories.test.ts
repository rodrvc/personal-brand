import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { RULE_KINDS } from "@personal-brand/core/checks";

import postgres from "postgres";

import { createMemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories } from "../src/pg/index.ts";
import { migrate } from "../src/pg/migrate.ts";
import { runRepositoryContract } from "./repositories.contract.ts";

await runRepositoryContract("memory", async (now) => ({ repos: createMemoryRepositories(now), get owner() { return this.repos; }, cleanup: async () => {} }));

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("SKIP postgres repositories - DATABASE_URL not set");
  process.exit(0);
}
const admin = postgres(url, { connect_timeout: 3, onnotice: () => {} });
try {
  await admin`SELECT 1`;
} catch (error) {
  // Only an unreachable server skips; bad credentials or a missing database must fail loudly.
  const code = (error as { code?: string }).code;
  if (!["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "CONNECT_TIMEOUT"].includes(code ?? "")) throw error;
  console.log(`SKIP postgres repositories - could not reach DATABASE_URL (${code})`);
  await admin.end({ timeout: 1 });
  process.exit(0);
}

// The kind CHECK in 0002 must list exactly the kinds the engine implements.
{
  const schema = `test_${randomBytes(6).toString("hex")}`;
  await migrate(admin, { schema });
  const [def] = await admin`SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                            WHERE n.nspname = ${schema} AND t.relname = 'brand_rules' AND pg_get_constraintdef(c.oid) LIKE '%forbidden_terms%'`;
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  assert.deepEqual([...def.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort(), [...RULE_KINDS].sort(), "0002 kind CHECK matches core RULE_KINDS");
}

let logged = false;
try {
  await runRepositoryContract("postgres", async (now) => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    await migrate(admin, { schema });
    // Run as the least-privilege app role when provisioned, so the migration's grants are proven sufficient.
    const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_app'`;
    const open = (username: string) => {
      const u = new URL(url);
      u.username = username;
      u.password = "local-dev-only";
      return postgres(role ? u.toString() : url, { connection: { search_path: schema }, onnotice: () => {} });
    };
    const sql = open("brand_app");
    const ownerSql = open("brand_owner");
    if (!logged) console.log(role ? "postgres contract runs as brand_app" : "role brand_app missing; postgres contract runs as the superuser");
    logged = true;
    return {
      repos: createPgRepositories(sql, now),
      owner: createPgRepositories(ownerSql, now),
      restricted: Boolean(role),
      rawSql: sql,
      setRevisionTime: async (entityId: string, version: number, iso: string) => {
        // The table is append-only by trigger; the superuser lifts it for this one fixture update.
        await admin.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role = replica");
          await tx.unsafe(`UPDATE ${schema}.revisions SET created_at = $1::text::timestamptz WHERE entity_id = $2 AND version = $3`, [iso, entityId, version]);
        });
      },
      rawCarouselDocument: async (id: string) => (await sql`SELECT document FROM carousels WHERE id = ${id}`)[0].document,
      cleanup: async () => {
        await sql.end({ timeout: 1 });
        await ownerSql.end({ timeout: 1 });
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      },
    };
  });
} finally {
  await admin.end();
}
console.log("repositories: ok");
