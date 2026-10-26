import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `./import` is exported for tests of system/ only: render code must never import brands.
import { importBrand } from "@personal-brand/storage/import";
import { NotFoundError } from "@personal-brand/storage/contracts";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { featuresOf, loadBrand } from "./brand-schema.js";
import { loadBrandStyle } from "./brand-style.js";
import { loadLayoutTemplate } from "./layout-template.js";
import { renderSlides } from "./render-batch.js";
import { engineFixtureBinding, openRenderSource, resolveRenderSource } from "./render-source.js";
import { loadStoredBrandStyle, loadStoredLayoutTemplate } from "./stored-brand.js";
import { renderListFormat } from "./templates/list-format.js";
import type { CarouselInput, Slide } from "./types.js";
import { verifyOrThrow } from "./verify-slides.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(__dirname, "..", "..", "profiles", "example");
const SLUG = "example";
const meta = { expectedVersion: null, author: "test", source: "system" as const, reason: "import" as const };
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));


/** Runs `fn` with `BRAND_PROFILES_DIR` set to `root`, restoring whatever it was. */
async function withProfilesRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.BRAND_PROFILES_DIR;
  process.env.BRAND_PROFILES_DIR = root;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BRAND_PROFILES_DIR;
    else process.env.BRAND_PROFILES_DIR = previous;
  }
}

/** A profiles root holding a copy of the fictional example (empty when `copy` is false). */
async function withRoot<T>(copy: boolean, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "render-source-"));
  if (copy) cpSync(EXAMPLE, join(root, SLUG), { recursive: true });
  try {
    return await withProfilesRoot(root, () => fn(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The example brand as the importer stores it (documents, parsed config, recipes), then optionally cut over. */
async function storedExample(opts: { cutover?: boolean; template?: unknown } = {}) {
  const repos = createMemoryRepositories();
  await importBrand(repos, { from: EXAMPLE, dryRun: false, author: "test", env: {} });
  const brand = await repos.brands.getBySlug(SLUG);
  if (opts.template) await repos.documents.put(brand.id, "template", "explicativo", { json: opts.template, schemaVersion: 1 }, meta);
  if (opts.cutover !== false) await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: brand.version });
  return { repos, brandId: brand.id };
}

const slide = (over: Partial<Slide> = {}): Slide => ({ title: "Event", subtitle: "Detail", meta: "Sat", image: "https://images.example.com/a.jpg", ...over });
const verify = (source: Awaited<ReturnType<typeof resolveRenderSource>>, recipe: string, slides: Slide[], hosts: string[]) =>
  source.verifyBinding(recipe).then((binding) => verifyOrThrow({ slides, input: { ...(hosts.length ? { sourceImageHosts: hosts } : {}), slides }, inputPath: "in.json", ...binding, onWarning: () => {} }));

const tests: Array<[string, () => Promise<void>]> = [
  ["a folder brand (no repositories, not cut over, or unknown to storage) is served from its folder, as before storage", async () => {
    await withRoot(true, async (root) => {
      const source = await resolveRenderSource(SLUG);
      assert.equal(source.kind, "folder");
      assert.deepEqual(await source.loadBrand(), loadBrand(EXAMPLE));
      assert.equal(source.inputPath(undefined, "week-input.json"), join(root, SLUG, "carousels", "week-input.json"));
      assert.equal(source.inputPath("mine.json", "week-input.json"), "mine.json");
      assert.equal((await resolveRenderSource(SLUG, (await storedExample({ cutover: false })).repos)).kind, "folder");
      assert.equal((await resolveRenderSource(SLUG, createMemoryRepositories())).kind, "folder");
    });
  }],
  ["a storage failure is reported naming the brand and DATABASE_URL, and never falls back to the folder", async () => {
    await withRoot(true, async () => {
      const repos = { ...createMemoryRepositories(), brands: { getBySlug: async () => { throw new Error("connection refused"); } } };
      await assert.rejects(resolveRenderSource(SLUG, repos), /Could not read brand "example" from storage \(is DATABASE_URL reachable\?\): connection refused/);
    });
  }],
  ["a cut-over brand loads tokens and the whole style from storage, equal to the folder's", async () => {
    const { repos, brandId } = await storedExample();
    await withRoot(false, async () => {
      const source = await resolveRenderSource(SLUG, repos);
      assert.equal(source.kind, "storage");
      const features = featuresOf([renderListFormat], "dates");
      assert.deepEqual(await source.loadBrand(features), loadBrand(EXAMPLE, features));
      const stored = await loadStoredBrandStyle(repos.documents, brandId);
      assert.deepEqual({ ...stored, sources: [] }, { ...loadBrandStyle(EXAMPLE), sources: [] });
      assert.ok(stored.tone.style.length > 0 && stored.sources.includes("config.yaml"));
    });
  }],
  ["a stored brand without tokens, or with invalid ones, fails naming the stored brand", async () => {
    const repos = createMemoryRepositories();
    const brand = await repos.brands.create({ slug: SLUG, displayName: "Example" }, meta);
    await repos.brands.markCutover(brand.id, { ...meta, expectedVersion: 1 });
    const source = await resolveRenderSource(SLUG, repos);
    await assert.rejects(source.loadBrand(), /Brand "example" has no stored tokens document/);
    await repos.documents.put(brand.id, "tokens", "", { json: { colors: {} }, schemaVersion: 1 }, meta);
    await assert.rejects(source.loadBrand(), /Invalid brand\.json in storage:example: roles must be an object/);
  }],
  ["a stored template merges onto the engine default exactly as a folder override does", async () => {
    const override = { zones: { footer: { height: 140 } } };
    const { repos, brandId } = await storedExample({ template: override });
    const brand = loadBrand(EXAMPLE);
    const dir = mkdtempSync(join(tmpdir(), "render-source-tpl-"));
    try {
      mkdirSync(join(dir, "templates"));
      writeFileSync(join(dir, "templates", "explicativo.json"), JSON.stringify(override));
      const params = { zones: { margins: { top: 10 } } };
      assert.deepEqual(await loadStoredLayoutTemplate(repos.documents, brandId, "explicativo", brand, params), loadLayoutTemplate(dir, "explicativo", brand, params));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await assert.rejects(loadStoredLayoutTemplate(repos.documents, brandId, "no-such-template", brand), /No layout template found for id "no-such-template"/);
  }],
  ["a stored brand applies its rules, and needs --input and --out", async () => {
    const { repos, brandId } = await storedExample();
    await repos.rules.create(brandId, { kind: "forbidden_terms", params: { terms: ["bargain"], fields: ["title"], slides: "all" }, severity: "error", appliesTo: ["carousel"], message: "no bargains" }, meta);
    const source = await resolveRenderSource(SLUG, repos);
    await assert.rejects(verify(source, "reel-week", [slide({ title: "Big bargain" })], ["images.example.com"]), /no bargains/);
    assert.throws(() => source.inputPath(undefined, "week-input.json"), /pass --input <file>/);
    assert.throws(() => source.outputRoot(), /pass --out <dir>/);
    assert.equal(source.outputRoot("/some/where"), "/some/where");
  }],
  ["a stored brand takes its image hosts from the stored recipe: an undeclared host or a missing recipe is refused", async () => {
    const { repos } = await storedExample();
    const source = await resolveRenderSource(SLUG, repos);
    assert.equal((await verify(source, "reel-week", [slide()], ["images.example.com"])).length, 1);
    await assert.rejects(verify(source, "reel-week", [slide()], ["images.example.com", "evil.example.net"]), /never declared: evil\.example\.net/);
    await assert.rejects(verify(source, "reel-week", [slide({ image: "https://evil.example.net/a.jpg" })], ["images.example.com"]));
    await assert.rejects(verify(source, "weekly-roundup", [slide()], ["images.example.com"]), /no recipe at the stored recipe "weekly-roundup"/);
  }],
  ["the example brand renders from storage with no profiles folder: same HTML as its folder, and a PNG", async () => {
    const { repos } = await storedExample();
    const input = readJson(join(EXAMPLE, "carousels", "week-input.json")) as CarouselInput;
    const out = mkdtempSync(join(tmpdir(), "render-source-out-"));
    const opts = { headerLabel: "Week", city: input.city, region: input.region };
    const features = featuresOf([renderListFormat], "dates");
    const log = console.log;
    try {
      await withRoot(false, async () => {
        const source = await resolveRenderSource(SLUG, repos);
        assert.equal(source.kind, "storage");
        const slides = (await verify(source, "weekly-roundup", input.slides, [])).slice(0, 2);
        const brand = await source.loadBrand(features);
        // The example uses system fonts and carries no images: the HTML is the whole input, so no network is involved.
        assert.equal(renderListFormat(brand, slides, opts), renderListFormat(loadBrand(EXAMPLE, features), slides, opts));
        console.log = () => {};
        await renderSlides({ items: [slides], toHtml: (group) => renderListFormat(brand, group, opts), outputDir: out });
      });
      assert.ok(existsSync(join(out, "slide-1.png")));
    } finally {
      console.log = log;
      rmSync(out, { recursive: true, force: true });
    }
  }],
  ["render.ts on a stored brand: its content rules are not applied to the engine fixture, its image policy still is", async () => {
    const { repos, brandId } = await storedExample();
    await repos.rules.create(brandId, { kind: "forbidden_terms", params: { terms: ["bargain"], fields: ["title"], slides: "all" }, severity: "error", appliesTo: ["carousel"], message: "no bargains" }, meta);
    const source = await resolveRenderSource(SLUG, repos);
    const binding = await source.verifyBinding("layout-comparison");
    const fixture = join(__dirname, "example-input.json");
    const run = (slides: Slide[], hosts: string[] | undefined, b: typeof binding) =>
      verifyOrThrow({ slides, input: { ...(hosts ? { sourceImageHosts: hosts } : {}), slides }, inputPath: fixture, selfDeclaredProvenance: true, ...b, onWarning: () => {} });
    const bargain = [slide({ title: "Big bargain", image: "https://img.example.com/a.jpg" })];
    assert.throws(() => run(bargain, ["img.example.com"], binding), /no bargains/);
    assert.equal(run(bargain, ["img.example.com"], engineFixtureBinding(binding)).length, 1);
    // No declared hosts in the fixture: the stored policy (no recipe "layout-comparison") refuses the image.
    assert.throws(() => run(bargain, undefined, engineFixtureBinding(binding)), /no recipe at the stored recipe "layout-comparison"/);
  }],
  ["openRenderSource never connects without DATABASE_URL, and closes the connection when resolving fails", async () => {
    await withRoot(true, async () => {
      let opened = 0;
      let ended = 0;
      const open = (getBySlug: () => Promise<never>) => ({
        connect: () => (opened++, { end: async () => void ended++ }),
        repos: () => ({ ...createMemoryRepositories(), brands: { getBySlug } }),
      });
      const down = open(async () => { throw new Error("connection refused"); });
      assert.equal((await openRenderSource(SLUG, {}, down)).source.kind, "folder");
      assert.equal(opened, 0);
      await assert.rejects(openRenderSource(SLUG, { DATABASE_URL: "postgres://x" }, down), /connection refused/);
      assert.deepEqual([opened, ended], [1, 1]);
      const missing = open(async () => { throw new NotFoundError("brand"); });
      const { source, close } = await openRenderSource(SLUG, { DATABASE_URL: "postgres://x" }, missing);
      assert.equal(source.kind, "folder");
      assert.equal(ended, 1);
      await close();
      assert.equal(ended, 2);
    });
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n`, error);
  }
}
if (failed) process.exit(1);
console.log(`render-source: ${tests.length} ok`);
