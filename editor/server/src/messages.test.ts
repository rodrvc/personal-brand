import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const SPANISH_IN_LITERAL = /(["'`])(?:(?!\1).)*[áéíóúñ¿¡«»](?:(?!\1).)*\1/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") && name !== "messages.ts" ? [path] : [];
  });
}

const offenders = sources(SRC).flatMap((path) =>
  readFileSync(path, "utf-8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), at: `${relative(SRC, path)}:${i + 1}` }))
    .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*") && SPANISH_IN_LITERAL.test(line))
    .map(({ at }) => at),
);
assert.deepEqual(offenders, [], "owner-facing strings belong in messages.ts");
console.log("ok - messages");
