import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/brand.ts";
import { brandTerms, domainTerms, SCHEMA_FIELDS } from "../src/cli/denylist.ts";
import { NotFoundError } from "../src/contracts/index.ts";
import { createMemoryRepositories } from "../src/memory/index.ts";

const work = mkdtempSync(join(tmpdir(), "denylist-"));
try {
  assert.deepEqual(domainTerms("https://www.fictional-co.example.test/path"), ["www.fictional-co.example.test", "example"]);
  assert.deepEqual(domainTerms("https://www.linkedin.com/in/someone"), [], "a third-party platform is not the brand's");

  // An unlisted TLD still yields the brand label; a country-code second level goes back one more label; the base is never the suffix.
  assert.deepEqual(domainTerms("https://www.example-brand.store/x"), ["www.example-brand.store", "example-brand"]);
  assert.deepEqual(domainTerms("example-brand.co.uk"), ["example-brand.co.uk", "example-brand"]);
  assert.deepEqual(domainTerms("shop.example-brand.com.au"), ["shop.example-brand.com.au", "example-brand"]);
  assert.deepEqual(domainTerms("example-brand.studio"), ["example-brand.studio", "example-brand"]);
  assert.deepEqual(domainTerms("example-brand.zz.com"), ["example-brand.zz.com", "example-brand"], "a two-letter label before a generic TLD");
  assert.deepEqual(domainTerms("example-brand.zz.net"), ["example-brand.zz.net", "example-brand"]);
  assert.deepEqual(domainTerms("github.io"), ["github.io"], "a hosting suffix alone names no brand");
  assert.deepEqual(domainTerms("example-brand.github.io"), ["example-brand.github.io", "example-brand"], "shared hosting suffix");
  assert.deepEqual(domainTerms("https://user:pw@www.example-brand.test.:8080/x"), ["www.example-brand.test", "example-brand"], "userinfo, port and FQDN dot dropped");

  // The twin list in the gate: the two must not drift.
  const gate = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "validate_commit_guardian.py"), "utf8");
  const pyFields = [...(gate.match(/SCHEMA_FIELD_NAMES = \{([^}]*)\}/)?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...SCHEMA_FIELDS].sort(), pyFields, "SCHEMA_FIELDS mirrors SCHEMA_FIELD_NAMES in the gate");

  const repos = createMemoryRepositories();
  const meta = (expectedVersion: number | null = null) => ({ expectedVersion, author: "test", source: "cli" as const, reason: "structural" as const });
  const real = await repos.brands.create({ slug: "fictional-co", displayName: "Fictional Company" }, meta());
  await repos.brands.create({ slug: "example-shop", displayName: "Example Shop" }, meta());
  await repos.documents.put(real.id, "identity", "", { text: "Find us at @fictional_handle; the @handle field is not one.", schemaVersion: 1 }, meta());

  // Parity with the folder derivation: handles (dotted too) in every stored text, any `name` key, recipe city/url, carousel city.
  await repos.documents.put(real.id, "spec", "", { text: "Contact person@host.test, font @400;600, @media rules, @first.last. @handle again.", schemaVersion: 1 }, meta());
  await repos.guidance.put(real.id, "tone", { description: "d", body: "Tag @guide_handle and @dotted.guide here." }, meta());
  await repos.recipes.put(real.id, "weekly", { params: { defaults: { city: "Fictional City" }, source: { url: "https://api.shop-fictional.test/v1", note: "ask @recipe.handle" } }, schemaVersion: 1 }, meta());
  await repos.carousels.create(real.id, { slug: "wk", title: "Wk", document: { json: { city: "Other Fictional City", slides: [{ title: "by @carousel_handle" }] }, schemaVersion: 1 } }, meta());
  await repos.documents.put(real.id, "tokens", "", { json: { copy: { wordmark: "FictionalMark", site: "https://fictional-co.example" }, sourceImageHosts: ["cdn.fictional-img.zz"], palette: { name: "Fictional Palette", note: "@token_handle" } }, schemaVersion: 1 }, meta());
  await repos.documents.put(real.id, "config", "", { json: { content: { default_hashtags: ["#plaintopic", "#Capitalized", "#Fictional_Tag"] }, profile: { name: "Fictional Person" }, other: { name: "Fictional Label", ping: "@config_handle" } }, schemaVersion: 1 }, meta());

  await repos.documents.put(real.id, "template", "card", { json: { note: "by @template_handle" }, schemaVersion: 1 }, meta());
  await repos.content.create(real.id, { slug: "post", title: "Post", bodyMd: "Thanks @content_handle", meta: { credit: "@meta_handle" } }, meta());
  await repos.guidance.put(real.id, "tooling", { description: "d", body: "npm i @scope/pkg, @apply and @tailwind rules, @config, @screen, pkg@latest, @9lives." }, meta());
  let deep: Record<string, unknown> = { leaf: "@deep_handle" };
  for (let i = 0; i < 40; i++) deep = { n: deep };
  await repos.recipes.put(real.id, "nested", { params: deep, schemaVersion: 1 }, meta());

  await repos.guidance.put(real.id, "links", { description: "d", body: "Profiles: https://social.test/@url_handle/video/1 and shop.test/@path.handle/post; tags @_lead @1lead, sizes @1080p @2160P." }, meta());

  // Handle edge cases: a dot before the at sign does not glue it; an over-long run is no handle; a `url` that is not a host is not a domain.
  await repos.guidance.put(real.id, "edges", { description: "d", body: `End.@after_dot, id @${"a".repeat(40)} and @${"b".repeat(30)}.` }, meta());
  await repos.recipes.put(real.id, "paths", { params: { a: { url: "assets/relative-path" }, b: { url: "./local/place" }, c: { url: "logo.png" }, f: { url: "//cdn.fictional-proto.test/x" }, g: { url: "https://fictional-md.md/a.md" }, d: { url: "free text here" }, e: { url: "plainword" } } , schemaVersion: 1 }, meta());

  const terms = await brandTerms(repos);
  assert.ok(terms.includes("after_dot") && terms.includes("b".repeat(30)), "a dot before the at sign, and a 30-character handle, are handles");
  assert.ok(!terms.some((t) => t.startsWith("aaaa")), "a run over 30 characters is not truncated into a term");
  for (const t of ["cdn.fictional-proto.test", "fictional-md.md"]) assert.ok(terms.includes(t), `a protocol-relative or .md-TLD host is kept: ${t}`);
  for (const t of ["assets/relative-path", "./local/place", "logo.png", "free text here", "plainword"]) assert.ok(!terms.includes(t), `a url value that is not a host stays out: ${t}`);
  for (const t of ["url_handle", "path.handle", "_lead", "1lead"]) assert.ok(terms.includes(t), `parity: missing ${t}`);
  for (const t of ["1080p", "2160P"]) assert.ok(!terms.includes(t), `parity: unexpected ${t}`);
  for (const t of ["template_handle", "content_handle", "meta_handle", "deep_handle"]) assert.ok(terms.includes(t), `parity: missing ${t}`);
  for (const t of ["scope", "apply", "tailwind", "config", "screen", "latest"]) assert.ok(!terms.includes(t), `parity: unexpected ${t}`);
  for (const t of ["first.last", "guide_handle", "dotted.guide", "recipe.handle", "carousel_handle", "token_handle", "config_handle", "Fictional Palette", "Fictional Label", "Fictional City", "Other Fictional City", "api.shop-fictional.test", "shop-fictional"]) assert.ok(terms.includes(t), `parity: missing ${t}`);
  for (const t of ["host.test", "person", "400", "media", "handle", "Capitalized", "plaintopic"]) assert.ok(!terms.includes(t), `parity: unexpected ${t}`);
  for (const t of ["fictional-co", "Fictional Company", "FictionalMark", "fictional-co.example", "Fictional_Tag", "Fictional Person", "fictional_handle", "cdn.fictional-img.zz"]) assert.ok(terms.includes(t), `missing ${t}`);
  assert.ok(!terms.includes("handle"), "a schema field name is not a handle");
  assert.ok(!terms.some((t) => /example-shop|Example Shop/.test(t)), "example brands contribute nothing");

  // Owned-domain base name; archived brands still count.
  assert.ok(terms.includes("fictional-img"), "base name of an owned image host");
  const old = await repos.brands.create({ slug: "retired-co", displayName: "Retired Company" }, meta());
  await repos.brands.archive(old.id, { ...meta(old.version), reason: "archive" as const });
  assert.ok((await brandTerms(repos)).includes("retired-co"), "an archived brand is still watched");

  // An item that vanishes between the list and its read is skipped, not fatal; any other error still fails.
  const racy = createMemoryRepositories();
  const racyCo = await racy.brands.create({ slug: "racy-co", displayName: "Racy Company" }, meta());
  await racy.guidance.put(racyCo.id, "gone", { description: "d", body: "@gone_handle" }, meta());
  await racy.guidance.put(racyCo.id, "kept", { description: "d", body: "@kept_handle" }, meta());
  const realGet = racy.guidance.get.bind(racy.guidance);
  racy.guidance.get = async (brandId: string, name: string) => (name === "gone" ? Promise.reject(new NotFoundError("guidance gone")) : realGet(brandId, name));
  const raced = await brandTerms(racy);
  assert.ok(raced.includes("kept_handle") && !raced.includes("gone_handle"), "the vanished item is skipped, the rest is read");
  racy.guidance.get = async () => Promise.reject(new Error("boom"));
  await assert.rejects(() => brandTerms(racy), /boom/, "other read errors are not swallowed");

  // Reads are bounded and concurrent, not an N+1: a few hundred content items of a fictional brand.
  const many = createMemoryRepositories();
  const loadCo = await many.brands.create({ slug: "load-co", displayName: "Load Company" }, meta());
  for (let i = 0; i < 300; i++) await many.content.create(loadCo.id, { slug: `item-${i}`, title: `Item ${i}`, bodyMd: `note @load_handle_${i}` }, meta());
  let inFlight = 0;
  let peak = 0;
  const get = many.content.get.bind(many.content);
  many.content.get = async (...args: Parameters<typeof get>) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 1));
    try { return await get(...args); } finally { inFlight--; }
  };
  const loaded = await brandTerms(many);
  assert.ok(loaded.includes("load_handle_0") && loaded.includes("load_handle_299"), "every item is read");
  assert.ok(peak > 1 && peak <= 8, `content reads are concurrent and bounded (peak ${peak})`);

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
  rmSync(file, { recursive: true });
  // A scripts/ that is a symlink to a real directory works (decision: follow it); a dangling one is refused like a missing one.
  const linked = join(work, "linked-repo");
  mkdirSync(join(work, "real-scripts"));
  mkdirSync(linked);
  symlinkSync(join(work, "real-scripts"), join(linked, "scripts"));
  assert.equal((await runCli(["denylist", "--write"], env, repos, undefined, { repoRoot: linked })).exitCode, 0);
  assert.ok(readdirSync(join(work, "real-scripts")).includes("brand-denylist.generated.txt"));
  rmSync(join(linked, "scripts"));
  symlinkSync(join(work, "nowhere"), join(linked, "scripts"));
  assert.equal((await runCli(["denylist", "--write"], env, repos, undefined, { repoRoot: linked })).exitCode, 6, "a dangling scripts/ link is refused");
  const bare = join(work, "no-scripts");
  mkdirSync(bare);
  const noScripts = await runCli(["denylist", "--write"], env, repos, undefined, { repoRoot: bare });
  assert.equal(noScripts.exitCode, 6, "a missing scripts/ folder is refused");
  assert.match(noScripts.lines[0], /scripts\//);
  assert.deepEqual(readdirSync(bare), [], "nothing was created");
  console.log("denylist.test.ts ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
