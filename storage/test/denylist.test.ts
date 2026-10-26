import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/brand.ts";
import { brandTerms, domainTerms } from "../src/cli/denylist.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

const work = mkdtempSync(join(tmpdir(), "denylist-"));
try {
  assert.deepEqual(domainTerms("https://www.fictional-co.example.cl/path"), ["www.fictional-co.example.cl", "example"]);
  assert.deepEqual(domainTerms("https://www.linkedin.com/in/someone"), [], "a third-party platform is not the brand's");

  const repos = createMemoryRepositories();
  const meta = (expectedVersion: number | null = null) => ({ expectedVersion, author: "test", source: "cli" as const, reason: "structural" as const });
  const real = await repos.brands.create({ slug: "fictional-co", displayName: "Fictional Company" }, meta());
  await repos.brands.create({ slug: "example-shop", displayName: "Example Shop" }, meta());
  await repos.documents.put(real.id, "tokens", "", { json: { copy: { wordmark: "FictionalMark", site: "https://fictional-co.example" }, sourceImageHosts: ["cdn.fictional-img.cl"] }, schemaVersion: 1 }, meta());
  await repos.documents.put(real.id, "config", "", { json: { content: { default_hashtags: ["#plaintopic", "#Fictional_Tag"] }, profile: { name: "Fictional Person" } }, schemaVersion: 1 }, meta());
  await repos.documents.put(real.id, "identity", "", { text: "Find us at @fictional_handle; the @handle field is not one.", schemaVersion: 1 }, meta());

  const terms = await brandTerms(repos);
  for (const t of ["fictional-co", "Fictional Company", "FictionalMark", "fictional-co.example", "Fictional_Tag", "Fictional Person", "fictional_handle", "cdn.fictional-img.cl"]) assert.ok(terms.includes(t), `missing ${t}`);
  assert.ok(!terms.includes("plaintopic"), "a single plain-word hashtag is topic vocabulary");
  assert.ok(!terms.includes("handle"), "a schema field name is not a handle");
  assert.ok(!terms.some((t) => /example-shop|Example Shop/.test(t)), "example brands contribute nothing");

  // Owned-domain base name; archived brands still count.
  assert.ok(terms.includes("fictional-img"), "base name of an owned image host");
  const old = await repos.brands.create({ slug: "retired-co", displayName: "Retired Company" }, meta());
  await repos.brands.archive(old.id, { ...meta(old.version), reason: "archive" as const });
  assert.ok((await brandTerms(repos)).includes("retired-co"), "an archived brand is still watched");

  // Read and write through the CLI: the repo root is a temp dir, the target is pinned.
  const root = join(work, "repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "brand-denylist.txt"), "tracked\n");
  const env = { USER: "tester", HOME: work, INIT_CWD: work };
  const run = (...argv: string[]) => runCli(argv, env, repos, undefined, { repoRoot: root });
  const printed = await run("denylist");
  assert.equal(printed.exitCode, 0);
  assert.ok(printed.lines[0].startsWith("[datos de la marca"), "printed terms are brand data");
  const file = join(root, "scripts", "brand-denylist.generated.txt");
  assert.equal((await run("denylist", "--write")).exitCode, 0);
  const all = await brandTerms(repos);
  assert.deepEqual(readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#")), all);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await run("denylist", "--write")).exitCode, 0, "regenerating replaces the file");
  assert.equal((await run("denylist", "--write", "scripts/brand-denylist.txt")).exitCode, 2, "no value: the tracked denylist cannot be targeted");
  assert.equal((await run("denylist", "--write=scripts/brand-denylist.txt")).exitCode, 2);
  assert.equal(readFileSync(join(root, "scripts", "brand-denylist.txt"), "utf8"), "tracked\n");
  assert.deepEqual(readdirSync(join(root, "scripts")).sort(), ["brand-denylist.generated.txt", "brand-denylist.txt"], "no temp file is left");

  rmSync(file);
  writeFileSync(join(work, "victim.txt"), "keep");
  symlinkSync(join(work, "victim.txt"), file);
  assert.equal((await run("denylist", "--write")).exitCode, 6, "a symlink is never written through");
  assert.equal(readFileSync(join(work, "victim.txt"), "utf8"), "keep");
  rmSync(file);
  mkdirSync(file);
  assert.equal((await run("denylist", "--write")).exitCode, 6, "a directory is refused");
  assert.ok(lstatSync(file).isDirectory());
  assert.equal((await run("denylist", "extra")).exitCode, 2, "no positionals");
  console.log("denylist.test.ts ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
