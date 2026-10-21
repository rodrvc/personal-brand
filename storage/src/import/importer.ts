import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { AlreadyExistsError, InvalidInputError, VersionConflictError, type DocumentKind, type WriteMeta } from "../contracts/index.ts";
import { collectCarousels } from "./carousels.ts";
import { collectContent } from "./content.ts";
import { canon, found, readRegular, sha256, type ImportRepos, type Item } from "./shared.ts";

export type { ImportRepos };
type Repos = ImportRepos;

/**
 * What a pass did (or, in a dry run, would do) with one item:
 * `created` is new in storage, `updated` replaced a row the importer itself wrote last, `unchanged` has the same
 * source hash as the last import, and `conflict` was left alone because storage changed since (or a write raced).
 */
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
  /** Entries inside imported areas that were passed over, each with the reason, so nothing disappears silently. */
  skipped: string[];
  /** Rules the folder implies (e.g. a recipe's `image_hosts`). Reported, never created: rules are owner decisions. */
  proposals: Array<{ kind: string; params: Record<string, unknown>; from: string }>;
  /** Set when the pass threw part-way; the counts then cover only the items done before it. */
  aborted?: string;
}

/** Splits `---` frontmatter (YAML) from the markdown body. */
function splitFrontmatter(raw: string): { description: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const description = m ? (parseYaml(m[1]) as { description?: unknown } | null)?.description : undefined;
  return { description: typeof description === "string" ? description.trim() : "", body: m ? m[2] : raw };
}

/** Every importable item of a brand folder. Read-only on the folder. */
function collect(dir: string, repos: Repos): { items: Item[]; notImported: string[]; skipped: string[]; proposals: ImportReport["proposals"] } {
  const items: Item[] = [];
  const skipped: string[] = [];
  const proposals: ImportReport["proposals"] = [];
  const root = realpathSync(dir); // the folder itself may be a symlink; what it contains may not point out of it
  const handled = new Set<string>();
  const docs: Array<[DocumentKind, string[], "json" | "text"]> = [
    ["tokens", ["brand.json", "brand.yaml"], "json"],
    ["config", ["config.yaml"], "json"],
    ["identity", ["profile.md"], "text"],
    ["spec", ["brand-spec.md"], "text"],
  ];
  for (const [kind, files, form] of docs) {
    files.forEach((f) => handled.add(f));
    let file = "";
    let raw: Buffer | null = null;
    for (const f of files) {
      raw = readRegular(root, join(dir, f), f, skipped);
      if (raw) {
        file = f;
        break;
      }
    }
    if (!raw) continue;
    const payload = form === "text" ? raw.toString("utf-8") : file.endsWith(".json") ? JSON.parse(raw.toString("utf-8")) : parseYaml(raw.toString("utf-8"));
    const body = form === "text" ? { text: payload as string, schemaVersion: 1 } : { json: payload, schemaVersion: 1 };
    items.push({
      key: `document:${kind}`, entityType: "brand_document", hash: sha256(raw), payload,
      read: (id) => found(repos.documents.get(id, kind, "", (b) => b)),
      write: (id, expectedVersion, meta) => repos.documents.put(id, kind, "", body, { ...meta, expectedVersion }),
    });
  }
  const templatesDir = join(dir, "templates");
  for (const file of existsSync(templatesDir) ? readdirSync(templatesDir).sort() : []) {
    handled.add("templates");
    const id = basename(file, ".json");
    if (!file.endsWith(".json") || !/^[a-z0-9-]+$/.test(id)) {
      skipped.push(`templates/${file} (not a <template-id>.json file)`);
      continue;
    }
    const raw = readRegular(root, join(templatesDir, file), `templates/${file}`, skipped);
    if (!raw) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf-8"));
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      skipped.push(`templates/${file} (not valid JSON)`);
      continue;
    }
    items.push({
      key: `template:${id}`, entityType: "brand_document", hash: sha256(raw), payload,
      read: (brandId) => found(repos.documents.get(brandId, "template", id, (b) => b)),
      write: (brandId, expectedVersion, meta) => repos.documents.put(brandId, "template", id, { json: payload, schemaVersion: 1 }, { ...meta, expectedVersion }),
    });
  }
  const skillsDir = join(dir, "skills");
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir).sort() : []) {
    handled.add("skills");
    const raw = readRegular(root, join(skillsDir, name, "SKILL.md"), `skills/${name}/SKILL.md`, skipped, true);
    if (!raw) continue;
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
  for (const file of existsSync(recipesDir) ? readdirSync(recipesDir).sort() : []) {
    handled.add("recipes");
    if (!file.endsWith(".yaml")) {
      skipped.push(`recipes/${file} (not a .yaml file)`);
      continue;
    }
    const raw = readRegular(root, join(recipesDir, file), `recipes/${file}`, skipped, true);
    if (!raw) continue;
    const recipe = basename(file, ".yaml");
    const payload = parseYaml(raw.toString("utf-8"));
    const schemaVersion = Number.isInteger(payload?.version) && payload.version >= 1 ? payload.version : 1;
    const hosts = payload?.source?.image_hosts;
    if (Array.isArray(hosts) && hosts.every((h) => typeof h === "string")) proposals.push({ kind: "image_hosts", params: { hosts }, from: `recipe:${recipe}` });
    items.push({
      key: `recipe:${recipe}`, entityType: "brand_recipe", hash: sha256(raw), payload,
      read: (id) => found(repos.recipes.get(id, recipe, (b) => b)),
      write: (id, expectedVersion, meta) => repos.recipes.put(id, recipe, { params: payload, schemaVersion }, { ...meta, expectedVersion }),
    });
  }
  const ctx = { dir, root, repos, skipped, handled };
  items.push(...collectContent(ctx), ...collectCarousels(ctx));
  const notImported = readdirSync(dir).filter((f) => !handled.has(f)).sort();
  return { items, notImported, skipped, proposals };
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
 * Imports documents, templates, guidance, recipes, content and carousels of a brand folder (slug = folder name). Idempotent per item via the
 * source hash; never deletes; a dry run writes nothing at all, not even the brand or an `import_runs` row.
 * Callers must apply the owner guard (non-example brands need the owner's opt-in); only the CLI does today.
 */
export async function importBrand(repos: Repos, opts: { from: string; dryRun: boolean; author: string; now?: () => Date }): Promise<ImportReport> {
  const dir = resolve(opts.from);
  const slug = basename(dir);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let brand = await found(repos.brands.getBySlug(slug));
  if (brand?.value.cutoverAt) throw new CutOverError(slug);
  const { items, notImported, skipped, proposals } = collect(dir, repos);
  if (!items.length) throw new InvalidInputError(`Nothing to import under ${dir}`);

  if (!opts.dryRun && !brand) {
    const meta: WriteMeta = { expectedVersion: null, author: opts.author, source: "import", reason: "import" };
    // A concurrent importer may have created the brand first: continue with its row.
    brand = await repos.brands.create({ slug, displayName: slug }, meta).catch((e) => (e instanceof AlreadyExistsError ? repos.brands.getBySlug(slug) : Promise.reject(e)));
  }
  const report: ImportReport = {
    slug, dryRun: opts.dryRun, items: [], notImported, skipped, proposals,
    counts: { created: 0, updated: 0, unchanged: 0, conflict: 0 },
    sourceRootHash: sha256(items.map((i) => `${i.key}:${i.hash}`).join("\n")),
  };
  const record = (finishedAt: string) =>
    repos.importRuns.record({ brandId: brand!.id, sourceKind: "folder", sourceRootHash: report.sourceRootHash, startedAt, finishedAt, report: { ...report } });
  try {
    for (const item of items) {
      const planned = await classify(item, brand?.id ?? null, repos);
      let outcome = planned.outcome;
      if (!opts.dryRun && (outcome === "created" || outcome === "updated")) {
        try {
          await item.write(brand!.id, planned.current?.version ?? null, { expectedVersion: null, author: opts.author, source: "import", reason: "import", sourceHash: item.hash });
        } catch (error) {
          // A write landed between classify and write: report it and keep going, so the pass still leaves a report.
          // The same for a row the repository refuses to move (e.g. an idea that would jump to published).
          if (error instanceof InvalidInputError) skipped.push(`${item.key} (${error.message})`);
          else if (!(error instanceof VersionConflictError)) throw error;
          outcome = "conflict";
        }
      }
      report.items.push({ key: item.key, outcome });
      report.counts[outcome]++;
    }
  } catch (error) {
    // An unexpected failure still leaves a run row saying how far the pass got; the original error is what the caller sees.
    report.aborted = (error as Error).message;
    if (!opts.dryRun) await record(now().toISOString()).catch((e) => console.warn(`Could not record the aborted import run: ${(e as Error).message}`));
    throw error;
  }
  if (!opts.dryRun) await record(now().toISOString());
  return report;
}

/** Re-reads every item of the folder from storage and returns the keys whose stored value differs from the source. */
export async function verifyBrand(repos: Repos, from: string): Promise<string[]> {
  const dir = resolve(from);
  const brand = await repos.brands.getBySlug(basename(dir));
  const bad: string[] = [];
  for (const item of collect(dir, repos).items) {
    const stored = await item.read(brand.id);
    if (!stored || canon(stored.value) !== canon(item.payload)) bad.push(item.key);
  }
  return bad;
}
