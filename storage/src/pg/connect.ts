import postgres from "postgres";

export type Sql = postgres.Sql;

/** Opens a pool from `DATABASE_URL`. Pooled hosts need `DATABASE_PREPARE=false`. */
export function connect(env: NodeJS.ProcessEnv = process.env): Sql {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, { prepare: env.DATABASE_PREPARE !== "false", onnotice: () => {} });
}
