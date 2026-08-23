/**
 * Load environment variables from a .env file without external dependencies.
 *
 * Reads <repoRoot>/.env if it exists, parses KEY=value lines (ignoring empty
 * lines and comments), and assigns only keys not already in process.env
 * (environment wins over file). Tolerates single/double quote wrappers and
 * `export` prefix.
 *
 * Returns the list of keys loaded.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDotEnv(repoRoot: string): string[] {
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return [];
  }

  const loaded: string[] = [];
  const content = readFileSync(envPath, "utf-8");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Strip `export ` prefix if present
    let pair = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;

    // Parse KEY=value
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = pair.slice(0, eqIndex).trim();
    let value = pair.slice(eqIndex + 1).trim();

    // Skip if key is already in environment
    if (process.env[key] !== undefined) {
      continue;
    }

    // Strip wrapping quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    loaded.push(key);
  }

  return loaded;
}
