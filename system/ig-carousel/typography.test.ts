import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrand } from "./brand-schema.js";
import { snapToScale, typeStyle } from "./typography.js";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "profiles", "example");
const brand = loadBrand(EXAMPLE);

assert.deepEqual(typeStyle(brand, "title"), { font: "handwritten", color: "onSurface" }, "declared role");
const bare = { ...brand, typography: undefined, typeScale: undefined };
assert.deepEqual(typeStyle(bare, "chip"), { font: "body", color: "surface" }, "undeclared role falls back");
assert.equal(snapToScale(brand, 83), 88);
assert.equal(snapToScale(bare, 30), 28, "the default scale when the brand declares none");

const dir = mkdtempSync(join(tmpdir(), "typography-test-"));
try {
  cpSync(EXAMPLE, dir, { recursive: true });
  const raw = JSON.parse(readFileSync(join(dir, "brand.json"), "utf-8"));
  writeFileSync(join(dir, "brand.json"), JSON.stringify({ ...raw, typography: { title: { font: "script" } } }));
  assert.throws(() => loadBrand(dir), /typography\.title\.font "script"/);
  writeFileSync(join(dir, "brand.json"), JSON.stringify({ ...raw, typography: { banner: {} } }));
  assert.throws(() => loadBrand(dir), /typography\.banner is not a text role/);
  writeFileSync(join(dir, "brand.json"), JSON.stringify({ ...raw, typeScale: [24, -1] }));
  assert.throws(() => loadBrand(dir), /typeScale/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("ok - typography");
