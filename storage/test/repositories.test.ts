import { randomBytes } from "node:crypto";

import postgres from "postgres";

import { createMemoryRepositories } from "../src/memory/index.ts";
import { createPgRepositories } from "../src/pg/index.ts";
import { migrate } from "../src/pg/migrate.ts";
import { runRepositoryContract } from "./repositories.contract.ts";

await runRepositoryContract("memory", async (now) => ({ repos: createMemoryRepositories(now), cleanup: async () => {} }));

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

let logged = false;
try {
  await runRepositoryContract("postgres", async (now) => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    await migrate(admin, { schema });
    // Run as the least-privilege app role when provisioned, so the migration's grants are proven sufficient.
    const [role] = await admin`SELECT 1 FROM pg_roles WHERE rolname = 'brand_app'`;
    const appUrl = new URL(url);
    appUrl.username = "brand_app";
    appUrl.password = "local-dev-only";
    const sql = postgres(role ? appUrl.toString() : url, { connection: { search_path: schema }, onnotice: () => {} });
    if (!logged) console.log(role ? "postgres contract runs as brand_app" : "role brand_app missing; postgres contract runs as the superuser");
    logged = true;
    return {
      repos: createPgRepositories(sql, now),
      cleanup: async () => {
        await sql.end({ timeout: 1 });
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      },
    };
  });
} finally {
  await admin.end();
}
console.log("repositories: ok");
