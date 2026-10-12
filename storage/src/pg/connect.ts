import postgres from "postgres";

export type Sql = postgres.Sql;

/** Every product table lives here, never in `public`: the database may be shared with other products. */
export const PRODUCT_SCHEMA = "content_platform";

/** Opens a pool from `DATABASE_URL` (or `url`). Pooled hosts need `DATABASE_PREPARE=false`. */
export function connect(env: NodeJS.ProcessEnv = process.env, url = env.DATABASE_URL): Sql {
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, { connection: { search_path: PRODUCT_SCHEMA }, prepare: env.DATABASE_PREPARE !== "false", onnotice: () => {} });
}
