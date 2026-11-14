import { join } from "node:path";

import { resolveBrandSource } from "@personal-brand/storage";
import { NotFoundError, type BrandDocumentRepository, type BrandRepository, type BrandRuleRepository, type RecipeRepository } from "@personal-brand/storage/contracts";
import { connect, createPgRepositories, type Sql } from "@personal-brand/storage/pg";

import { classify, type RecipeImagePolicy } from "./recipe.js";
import { loadBrand, type BrandFeature, type BrandTokens } from "./brand-schema.js";
import { resolveOutputBaseDir, resolveOutputSubfolder, resolveProfileDir } from "./profile.js";
import { loadStoredBrand } from "./stored-brand.js";
import { loadStoredVerifyPolicy } from "./stored-policy.js";
import type { VerifyPolicy } from "./verify-slides.js";

/** The repositories a render reads. Tests pass the memory ones; the scripts open Postgres from `DATABASE_URL`. */
export interface RenderRepos {
  brands: Pick<BrandRepository, "getBySlug">;
  documents: Pick<BrandDocumentRepository, "get">;
  rules: Pick<BrandRuleRepository, "list">;
  recipes: Pick<RecipeRepository, "get">;
}

/** The brand-specific half of `verifyOrThrow`'s options. */
export type VerifyBinding =
  | { profileDir: string; recipe: string; policy?: never }
  | { policy: VerifyPolicy; profileDir?: never; recipe?: never };

/**
 * Where a render gets its brand from. One interface over the two live paths (D12): a folder under `profiles/` until
 * the brand is cut over, then storage. The render scripts are written once against this and never ask which it is.
 */
export interface RenderSource {
  readonly kind: "folder" | "storage";
  readonly slug: string;
  loadBrand(features?: BrandFeature[]): Promise<BrandTokens>;
  /** The options that tell `verifyOrThrow` which brand policy applies to `recipe`. Folder: lazy, read from `recipes/`. Storage: the brand's stored rules. */
  verifyBinding(recipe: string): Promise<VerifyBinding>;
  /** The input file to read: `explicit` (`--input`), else the brand's own `carousels/<name>`. A stored brand keeps none, so it requires `--input`. */
  inputPath(explicit: string | undefined, name: string): string;
  /** Root of this brand's generated output. `out` (the `--out` flag) wins; a stored brand has no configured folder, so it requires it. */
  outputRoot(out?: string): string;
  /** Subfolder of the output root for one render flavour (`outputs.<key>` in a folder's config). */
  outputSubfolder(key: string): string;
}

function folderSource(slug: string): RenderSource {
  const profileDir = resolveProfileDir(slug);
  return {
    kind: "folder",
    slug,
    loadBrand: async (features) => loadBrand(profileDir, features),
    verifyBinding: async (recipe) => ({ profileDir, recipe }),
    inputPath: (explicit, name) => explicit ?? join(profileDir, "carousels", name),
    outputRoot: (out) => out ?? resolveOutputBaseDir(profileDir),
    outputSubfolder: (key) => resolveOutputSubfolder(profileDir, key),
  };
}

/**
 * Where images may come from, for a stored brand: its enabled `image_hosts` rules, else `source.image_hosts` of the
 * stored recipe. The importer only proposes rules from a recipe, so the recipe is still the declaration. No rule and
 * no stored recipe is "nobody stated a policy" (refused when a slide has an image), as for a folder without the file.
 */
async function storedImagePolicy(repos: RenderRepos, brandId: string, recipe: string, fromRules: RecipeImagePolicy): Promise<RecipeImagePolicy> {
  if (fromRules.declaredHosts) return fromRules;
  const path = `the stored recipe "${recipe}"`;
  let stored: unknown;
  try {
    stored = (await repos.recipes.get(brandId, recipe, (body) => body)).value;
  } catch (error) {
    if (error instanceof NotFoundError) return { path, exists: false };
    throw error;
  }
  const hosts = (stored as { source?: { image_hosts?: unknown } } | null)?.source?.image_hosts;
  if (hosts === undefined) return { path, exists: true };
  const classified = Array.isArray(hosts) && hosts.every((h) => typeof h === "string") ? classify(hosts) : "malformed";
  if (classified === "malformed" || classified === "wildcard") {
    throw new Error(`Invalid ${path}: source.image_hosts must be a non-empty list of literal hosts (no wildcards).`);
  }
  return { path, exists: true, declaredHosts: classified };
}

function storageSource(repos: RenderRepos, brandId: string, slug: string): RenderSource {
  let rules: Promise<VerifyPolicy> | undefined;
  return {
    kind: "storage",
    slug,
    loadBrand: (features) => loadStoredBrand(repos.documents, brandId, slug, features),
    verifyBinding: async (recipe) => {
      const base = await (rules ??= loadStoredVerifyPolicy(repos.rules, brandId));
      return { policy: { ...base, imagePolicy: await storedImagePolicy(repos, brandId, recipe, base.imagePolicy) } };
    },
    inputPath: (explicit) => {
      if (!explicit) throw new Error(`Brand "${slug}" is served from storage and keeps no input file: pass --input <file>.`);
      return explicit;
    },
    outputRoot: (out) => {
      if (!out) throw new Error(`Brand "${slug}" is served from storage and has no output folder: pass --out <dir>.`);
      return out;
    },
    outputSubfolder: (key) => key,
  };
}

/**
 * The verify options for an engine-owned fixture (`render.ts`'s layout comparison): the brand's image policy still
 * applies, but its content rules do not, since the fixture is not brand content.
 */
export function engineFixtureBinding(binding: VerifyBinding): VerifyBinding {
  return binding.policy ? { policy: { ...binding.policy, rules: [] } } : binding;
}

/**
 * Picks the source with `resolveBrandSource`, the one switch (D12). With no repositories (and no `DATABASE_URL`) every
 * brand is a folder, which is exactly how the scripts behaved before storage. A brand storage has never heard of is a folder too.
 */
export async function resolveRenderSource(slug: string, repos?: RenderRepos): Promise<RenderSource> {
  if (!repos) return folderSource(slug);
  // One read serves both the decision and the id. A storage failure is never a reason to serve the folder instead.
  let row: ReturnType<RenderRepos["brands"]["getBySlug"]> | undefined;
  const once = { getBySlug: (s: string) => (row ??= repos.brands.getBySlug(s)) };
  let where: "storage" | "folder";
  try {
    where = await resolveBrandSource(once, slug);
  } catch (error) {
    throw new Error(`Could not read brand "${slug}" from storage (is DATABASE_URL reachable?): ${(error as Error).message}`, { cause: error });
  }
  return where === "folder" ? folderSource(slug) : storageSource(repos, (await row!).id, slug);
}

/**
 * For the scripts: opens Postgres when `DATABASE_URL` is set, resolves the source, and hands back what to close.
 * Without `DATABASE_URL` it never touches storage.
 */
interface OpenStorage<S extends { end(): Promise<void> }> {
  connect(env: NodeJS.ProcessEnv): S;
  repos(sql: S): RenderRepos;
}

export async function openRenderSource<S extends { end(): Promise<void> } = Sql>(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
  // A seam for tests: the connection and the repositories built on it. The default is Postgres.
  open: OpenStorage<S> = { connect, repos: createPgRepositories } as unknown as OpenStorage<S>,
): Promise<{ source: RenderSource; close(): Promise<void> }> {
  if (!env.DATABASE_URL) return { source: await resolveRenderSource(slug), close: async () => {} };
  const sql = open.connect(env);
  try {
    return { source: await resolveRenderSource(slug, open.repos(sql)), close: () => sql.end() };
  } catch (error) {
    await sql.end();
    throw error;
  }
}
