import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads `.env` from the repo root into `process.env`, without overwriting
 * any variable already set in the real environment (so `EDITOR_PORT=1 pnpm
 * dev` still wins over a `.env` value). No dependency: the format needed
 * here is `KEY=value` per line, `#` comments, optional quotes — a tiny
 * subset of dotenv, not a general parser.
 *
 * Node's own `--env-file` flag would do this without any code at all, but
 * it requires the flag to be passed to the `node`/`tsx` invocation itself
 * (impossible to do from inside the script that needs it), so a tiny parser
 * here is what keeps `pnpm --filter editor-server dev` working with no
 * extra flags to remember.
 */
export function loadRepoRootEnv(): void {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(serverDir, "..", "..", "..");
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
