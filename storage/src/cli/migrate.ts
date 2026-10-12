import postgres from "postgres";

import { migrate } from "../pg/migrate.ts";

// Migrations run as the schema owner (brand_migrator), not the application role.
const url = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_MIGRATOR_URL (or DATABASE_URL)");
  process.exit(1);
}
const sql = postgres(url, { onnotice: () => {} });
try {
  const applied = await migrate(sql, { schema: process.env.DATABASE_SCHEMA });
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Nothing to apply");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
