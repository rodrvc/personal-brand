import assert from "node:assert/strict";

import { assertTransactional, checksum } from "../src/pg/migrate.ts";

assert.equal(checksum("a\r\nb\r\n"), checksum("a\nb\n"), "CRLF is normalized");
assert.notEqual(checksum("a\nb\n"), checksum("a\nc\n"));
assert.match(checksum("x"), /^[0-9a-f]{64}$/);

assert.throws(() => assertTransactional("0002_x.sql", "create unique INDEX\n  concurrently i on t(a);"), /CONCURRENTLY/);
assert.throws(() => assertTransactional("0002_x.sql", "CREATE INDEX CONCURRENTLY i ON t(a);"), /CONCURRENTLY/);
assert.doesNotThrow(() => assertTransactional("0002_x.sql", "CREATE INDEX i ON t(a);"));

for (const bad of [
  "DROP INDEX CONCURRENTLY i;",
  "REINDEX INDEX CONCURRENTLY i;",
  "ALTER TABLE t DETACH PARTITION p CONCURRENTLY;",
  "VACUUM t;",
  "BEGIN;\nSELECT 1;\nCOMMIT;",
  "SELECT 1;\n  commit ;",
  "START TRANSACTION;",
]) {
  assert.throws(() => assertTransactional("0002_x.sql", bad), /cannot run inside/, bad);
}
assert.doesNotThrow(() => assertTransactional("0002_x.sql", "CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;"));

console.log("migrate-unit: ok");
