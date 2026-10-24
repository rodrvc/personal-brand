import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The §13 slice table is the plan other documents point at: its dependency graph must stay closed.
const doc = readFileSync(join(import.meta.dirname, "..", "..", "docs", "design", "storage-foundation.md"), "utf-8");
const section = doc.slice(doc.indexOf("## 13. Slice plan"));
const end = section.indexOf("\n## ", 5);
const table = end === -1 ? section : section.slice(0, end);
const rows = new Map<string, string[]>();
for (const line of table.split("\n").filter((l) => l.startsWith("|"))) {
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  const name = cells[0].replace(/\*/g, "");
  if (!/^S\d/.test(name)) continue;
  // "S12a/b" names two rows; a bare "S12" dependency means the whole family.
  const [head, ...tail] = name.split("/");
  for (const n of [head, ...tail.map((t) => head.replace(/[a-z]+$/, "") + t)]) rows.set(n, cells[3].replace(/\*/g, "").split(/[,\s]+/).filter((d) => /^S\d/.test(d)));
}
assert.ok(rows.size > 5, "the slice table was parsed");
const exists = (d: string) => rows.has(d) || [...rows.keys()].some((k) => k.startsWith(d) && /^[a-z]/.test(k.slice(d.length)));
for (const [slice, deps] of rows) for (const d of deps) assert.ok(exists(d), `${slice} depends on ${d}, which has no row in §13`);
assert.ok(rows.has("S7b2b1") && rows.has("S7b2b2"), "S7b2b1 and S7b2b2 are rows");
assert.ok(rows.get("S8")?.includes("S7b2b2"), "S8 depends on S7b2b2");
console.log("design doc slice table: ok");
