import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { AlreadyExistsError, InvalidInputError, NotFoundError, VersionConflictError, type DocumentKind, type RevisionEntity, type WriteMeta } from "../contracts/index.ts";
import type { MemoryRepositories } from "../memory/index.ts";

/** The Postgres and memory repository sets are structurally identical. */
export type ImportRepos = MemoryRepositories;
type Repos = ImportRepos;

export type Outcome = "created" | "updated" | "unchanged" | "conflict";

/** The brand was cut over: its folder is no longer a valid import source. */
export class CutOverError extends Error {
  constructor(readonly slug: string) {
    super(`Brand "${slug}" is cut over; its folder is no longer imported`);
    this.name = "CutOverError";
  }
}

export interface ImportReport {
  slug: string;
  dryRun: boolean;
  /** sha256 over the sorted per-item source hashes: equal roots mean an unchanged source. */
  sourceRootHash: string;
  items: Array<{ key: string; outcome: Outcome }>;
  counts: Record<Outcome, number>;
  /** Present in the folder but outside this importer's scope (or deliberately not imported); nothing is lost, nothing is deleted. */
  notImported: string[];
}

interface Item {
  key: string;
  entityType: RevisionEntity;
  /** sha256 of the source file bytes. */
  hash: string;
  /** What the stored row must read back as. */
  payload: unknown;
  read(brandId: string): Promise<{ id: string; version: number; value: unknown } | null>;
  write(brandId: string, expectedVersion: number | null, meta: WriteMeta): Promise<unknown>;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const found = async <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
const readIf = (file: string) => (existsSync(file) ? readFileSync(file) : null);

/** Splits `---` frontmatter (YAML) from the markdown body. */
function splitFrontmatter(raw: string): { description: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const description = m ? (parseYaml(m[1]) as { description?: unknown } | null)?.description : undefined;
  return { description: typeof description === "string" ? description.trim() : "", body: m ? m[2] : raw };
}

/** Every importable item of a brand folder. Read-only on the folder. */
function collect(dir: string, repos: Repos): { items: Item[]; notImported: string[] } {
  const items: Item[] = [];
  const handled = new Set<string>();
  const docs: Array<[DocumentKind, string[], "json" | "text"]> = [
    ["tokens", ["brand.json", "brand.yaml"], "json"],
    ["config", ["config.yaml"], "json"],
    ["identity", ["profile.md"], "text"],
    ["spec", ["brand-spec.md"], "text"],
  ];
  for (const [kind, files, form] of docs) {
    const file = files.find((f) => existsSync(join(dir, f)));
    if (!file) continue;
    files.forEach((f) => handled.add(f));
    const raw = readFileSync(join(dir, file));
    const payload = form === "text" ? raw.toString("utf-8") : file.endsWith(".json") ? JSON.parse(raw.toString("utf-8")) : parseYaml(raw.toString("utf-8"));
    const body = form === "text" ? { text: payload as string, schemaVersion: 1 } : { json: payload, schemaVersion: 1 };
    items.push({
      key: `document:${kind}`, entityType: "brand_document", hash: sha256(raw), payload,
      read: (id) => found(repos.documents.get(id, kind, "", (b) => b)),
      write: (id, expectedVersion, meta) => repos.documents.put(id, kind, "", body, { ...meta, expectedVersion }),
    });
  }
  const skillsDir = join(dir, "skills");
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []) {
    const raw = readIf(join(skillsDir, name, "SKILL.md"));
    if (!raw) continue;
    handled.add("skills");
    const payload = splitFrontmatter(raw.toString("utf-8"));
    items.push({
      key: `guidance:${name}`, entityType: "brand_guidance", hash: sha256(raw), payload,
      read: async (id) => {
        const g = await found(repos.guidance.get(id, name));
        return g && { id: g.id, version: g.version, value: { description: g.description, body: g.body } };
      },
      write: (id, expectedVersion, meta) => repos.guidance.put(id, name, payload, { ...meta, expectedVersion }),
    });
  }
  const recipesDir = join(dir, "recipes");
  for (const file of existsSync(recipesDir) ? readdirSync(recipesDir).filter((f) => f.endsWith(".yaml")).sort() : []) {
    handled.add("recipes");
    const raw = readFileSync(join(recipesDir, file));
    const recipe = basename(file, ".yaml");
    const payload = parseYaml(raw.toString("utf-8"));
    const schemaVersion = Number.isInteger(payload?.version) && payload.version >= 1 ? payload.version : 1;
    items.push({
      key: `recipe:${recipe}`, entityType: "brand_recipe", hash: sha256(raw), payload,
      read: (id) => found(repos.recipes.get(id, recipe, (b) => b)),
      write: (id, expectedVersion, meta) => repos.recipes.put(id, recipe, { params: payload, schemaVersion }, { ...meta, expectedVersion }),
    });
  }
  const notImported = readdirSync(dir).filter((f) => !handled.has(f)).sort();
  return { items, notImported };
}

/**
 * What a pass would do for one item. Only a row whose version is the one the last import wrote can be judged by
 * `source_hash`; any other version means storage was edited since (or the row never came from an import), which is a
 * conflict whatever the hash says, so a stored edit is never reported as unchanged or overwritten.
 */
async function classify(item: Item, brandId: string | null, repos: Repos): Promise<{ outcome: Outcome; current: { version: number } | null }> {
  const current = brandId ? await item.read(brandId) : null;
  if (!current) return { outcome: "created", current: null };
  const lastImport = (await repos.revisions.list(item.entityType, current.id)).filter((r) => r.source === "import").at(-1);
  if (lastImport?.version !== current.version) return { outcome: "conflict", current };
  return { outcome: lastImport.sourceHash === item.hash ? "unchanged" : "updated", current };
}

/**
 * Imports documents, guidance and recipes of a brand folder (slug = folder name). Idempotent per item via the
 * source hash; never deletes; a dry run writes nothing at all, not even the brand or an `import_runs` row.
 */
export async function importBrand(repos: Repos, opts: { from: string; dryRun: boolean; author: string; now?: () => Date }): Promise<ImportReport> {
  const dir = resolve(opts.from);
  const slug = basename(dir);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let brand = await found(repos.brands.getBySlug(slug));
  if (brand?.value.cutoverAt) throw new CutOverError(slug);
  const { items, notImported } = collect(dir, repos);
  if (!items.length) throw new InvalidInputError(`Nothing to import under ${dir}`);

  if (!opts.dryRun && !brand) {
    const meta: WriteMeta = { expectedVersion: null, author: opts.author, source: "import", reason: "import" };
    // A concurrent importer may have created the brand first: continue with its row.
    brand = await repos.brands.create({ slug, displayName: slug }, meta).catch((e) => (e instanceof AlreadyExistsError ? repos.brands.getBySlug(slug) : Promise.reject(e)));
  }
  const report: ImportReport = {
    slug, dryRun: opts.dryRun, items: [], notImported,
    counts: { created: 0, updated: 0, unchanged: 0, conflict: 0 },
    sourceRootHash: sha256(items.map((i) => `${i.key}:${i.hash}`).join("\n")),
  };
  for (const item of items) {
    const { current, ...classified } = await classify(item, brand?.id ?? null, repos);
    let outcome = classified.outcome;
    if (!opts.dryRun && (outcome === "created" || outcome === "updated")) {
      try {
        await item.write(brand!.id, current?.version ?? null, { expectedVersion: null, author: opts.author, source: "import", reason: "import", sourceHash: item.hash });
      } catch (error) {
        // A write landed between classify and write: report it and keep going, so the pass still leaves a report.
        if (!(error instanceof VersionConflictError)) throw error;
        outcome = "conflict";
      }
    }
    report.items.push({ key: item.key, outcome });
    report.counts[outcome]++;
  }
  if (!opts.dryRun) {
    await repos.importRuns.record({ brandId: brand!.id, sourceKind: "folder", sourceRootHash: report.sourceRootHash, startedAt, finishedAt: now().toISOString(), report: { ...report } });
  }
  return report;
}
