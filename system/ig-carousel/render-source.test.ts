import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importBrand } from "@personal-brand/storage/import";
import { createMemoryRepositories } from "@personal-brand/storage/memory";

import { featuresOf, loadBrand } from "./brand-schema.js";
import { loadBrandStyle } from "./brand-style.js";
import { renderSlides } from "./render-batch.js";
import { resolveRenderSource } from "./render-source.js";
import { loadStoredBrandStyle } from "./stored-brand.js";
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
async function storedExample(opts: { cutover?: boolean } = {}) {
  const repos = createMemoryRepositories();
  await importBrand(repos, { from: EXAMPLE, dryRun: false, author: "test", env: {} });
  const brand = await repos.brands.getBySlug(SLUG);
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
  ["the example brand renders from storage with no profiles folder, to the same PNGs as its folder", async () => {
    const { repos } = await storedExample();
    const input = readJson(join(EXAMPLE, "carousels", "week-input.json")) as CarouselInput;
    const out = mkdtempSync(join(tmpdir(), "render-source-out-"));
    const opts = { headerLabel: "Week", city: input.city, region: input.region };
    const quiet = async (run: () => Promise<unknown>) => {
      const log = console.log;
      console.log = () => {};
      try {
        await run();
      } finally {
        console.log = log;
      }
    };
    try {
      const features = featuresOf([renderListFormat], "dates");
      const kept = await withRoot(false, async () => {
        const source = await resolveRenderSource(SLUG, repos);
        assert.equal(source.kind, "storage");
        const slides = await verify(source, "weekly-roundup", input.slides, []);
        await quiet(() => source.loadBrand(features).then((brand) => renderSlides({ items: [slides.slice(0, 2)], toHtml: (group) => renderListFormat(brand, group, opts), outputDir: join(out, "storage") })));
        return slides;
      });
      await quiet(() => renderSlides({ items: [kept.slice(0, 2)], toHtml: (group) => renderListFormat(loadBrand(EXAMPLE, features), group, opts), outputDir: join(out, "folder") }));
      assert.ok(existsSync(join(out, "storage", "slide-1.png")));
      assert.deepEqual(readFileSync(join(out, "storage", "slide-1.png")), readFileSync(join(out, "folder", "slide-1.png")));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
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
