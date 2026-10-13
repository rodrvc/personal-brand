import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  AlreadyExistsError,
  VersionConflictError,
  type Brand,
  type BrandDocumentRepository,
  type BrandRepository,
  type BrandRule,
  type BrandRuleRepository,
  type GuidanceRepository,
  type RecipeRepository,
  type RuleInput,
  type DocumentKind,
  type Revision,
  type RevisionEntity,
  type RevisionRepository,
  type Versioned,
  type WriteMeta,
} from "../contracts/index.ts";
import { assertEnvelope, assertGuidance, assertParams, assertSlug, normalizeRule, shouldAppendRevision, type DocumentBody } from "../revision-policy.ts";

export interface MemoryRepositories {
  brands: BrandRepository;
  documents: BrandDocumentRepository;
  revisions: RevisionRepository;
  rules: BrandRuleRepository;
  guidance: GuidanceRepository;
  recipes: RecipeRepository;
}

interface DocRow {
  id: string;
  brandId: string;
  kind: DocumentKind;
  name: string;
  schemaVersion: number;
  json?: unknown;
  text?: string;
  version: number;
  updatedAt: string;
}

/** Byte order, matching `COLLATE "C"` in the Postgres queries. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Same semantics as the Postgres repositories (versions, conflicts, revision policy). `now` is injectable for tests.
 * It does not model database roles: the owner and app views are the same object, so write-permission
 * differences (rules and guidance are owner-only) are only enforced and tested against Postgres.
 */
export function createMemoryRepositories(now: () => Date = () => new Date()): MemoryRepositories {
  const brands = new Map<string, Versioned<Brand>>();
  const docs = new Map<string, DocRow>();
  const log: Revision[] = [];

  function record(r: Omit<Revision, "reason" | "author" | "source" | "sourceHash" | "createdAt">, meta: WriteMeta): void {
    const last = log.filter((x) => x.entityType === r.entityType && x.entityId === r.entityId).at(-1);
    if (!shouldAppendRevision(last, meta, now())) return;
    const { reason, author, source, sourceHash } = meta;
    log.push(structuredClone({ ...r, reason, author, source, ...(sourceHash ? { sourceHash } : {}), createdAt: now().toISOString() }));
  }

  function writeBrand(id: string, meta: WriteMeta, change: (b: Brand) => Brand): Versioned<Brand> {
    const cur = brands.get(id);
    if (!cur) throw new NotFoundError(`brand ${id}`);
    if (meta.expectedVersion !== cur.version) throw new VersionConflictError(cur.version);
    const next = { ...cur, value: change(cur.value), version: cur.version + 1, updatedAt: now().toISOString() };
    brands.set(id, next);
    record({ brandId: id, entityType: "brand", entityId: id, version: next.version, body: next.value, bodyText: null }, meta);
    return structuredClone(next);
  }

  const brandRepo: BrandRepository = {
    async list(opts) {
      return structuredClone([...brands.values()].filter((b) => opts?.includeArchived || b.value.status === "active").sort((a, b) => cmp(a.value.slug, b.value.slug)));
    },
    async getBySlug(slug) {
      const found = [...brands.values()].find((b) => b.value.slug === slug);
      if (!found) throw new NotFoundError(`brand "${slug}"`);
      return structuredClone(found);
    },
    async create(input, meta) {
      assertSlug(input.slug);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      const dup = [...brands.values()].find((b) => b.value.slug === input.slug);
      if (dup) throw new AlreadyExistsError(`brand "${input.slug}"`, dup.version);
      const id = randomUUID();
      const row = { id, value: { slug: input.slug, displayName: input.displayName, status: "active" as const, cutoverAt: null }, version: 1, updatedAt: now().toISOString() };
      brands.set(id, row);
      record({ brandId: id, entityType: "brand", entityId: id, version: 1, body: row.value, bodyText: null }, meta);
      return structuredClone(row);
    },
    async update(id, patch, meta) {
      return writeBrand(id, meta, (b) => ({ ...b, displayName: patch.displayName ?? b.displayName }));
    },
    async archive(id, meta) {
      return writeBrand(id, meta, (b) => ({ ...b, status: "archived" }));
    },
    async unarchive(id, meta) {
      return writeBrand(id, meta, (b) => ({ ...b, status: "active" }));
    },
  };

  const find = (brandId: string, kind: DocumentKind, name: string) =>
    [...docs.values()].find((d) => d.brandId === brandId && d.kind === kind && d.name === name);

  const documents: BrandDocumentRepository = {
    async get(brandId, kind, name, validate) {
      const d = find(brandId, kind, name);
      if (!d) throw new NotFoundError(`document ${kind}/${name}`);
      return { id: d.id, value: validate(structuredClone(d.text ?? d.json), d.schemaVersion), version: d.version, updatedAt: d.updatedAt };
    },
    async list(brandId, kind) {
      return [...docs.values()]
        .filter((d) => d.brandId === brandId && d.kind === kind)
        .sort((a, b) => cmp(a.name, b.name))
        .map((d) => ({ name: d.name, version: d.version, updatedAt: d.updatedAt }));
    },
    async put(brandId, kind, name, body: DocumentBody, meta) {
      assertEnvelope(body);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      const cur = find(brandId, kind, name);
      if (cur && meta.expectedVersion === null) throw new AlreadyExistsError(`document ${kind}/${name}`, cur.version);
      if (meta.expectedVersion !== (cur?.version ?? null)) throw new VersionConflictError(cur?.version ?? null);
      const content = "text" in body ? { text: body.text } : { json: structuredClone(body.json) };
      const row: DocRow = { id: cur?.id ?? randomUUID(), brandId, kind, name, schemaVersion: body.schemaVersion, ...content, version: (cur?.version ?? 0) + 1, updatedAt: now().toISOString() };
      docs.set(row.id, row);
      record({ brandId, entityType: "brand_document", entityId: row.id, version: row.version, body: content.json ?? null, bodyText: content.text ?? null }, meta);
      return { id: row.id, version: row.version, updatedAt: row.updatedAt };
    },
  };

  const revisions: RevisionRepository = {
    async list(entityType: RevisionEntity, entityId) {
      return structuredClone(log.filter((r) => r.entityType === entityType && r.entityId === entityId));
    },
    async get(entityType, entityId, version) {
      const found = log.find((r) => r.entityType === entityType && r.entityId === entityId && r.version === version);
      if (!found) throw new NotFoundError(`revision ${entityType}/${entityId}@${version}`);
      return structuredClone(found);
    },
  };

  const ruleRows = new Map<string, Versioned<BrandRule> & { brandId: string; createdAt: string }>();
  const out = (r: Versioned<BrandRule>): Versioned<BrandRule> => structuredClone({ id: r.id, value: r.value, version: r.version, updatedAt: r.updatedAt });

  function writeRule(id: string, patch: Partial<RuleInput>, meta: WriteMeta, enabled?: boolean): Versioned<BrandRule> {
    const cur = ruleRows.get(id);
    if (!cur) throw new NotFoundError(`rule ${id}`);
    if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
    const { enabled: wasEnabled, ...base } = cur.value;
    const next = { ...cur, value: { ...normalizeRule({ ...base, ...patch }), enabled: enabled ?? wasEnabled }, version: cur.version + 1, updatedAt: now().toISOString() };
    ruleRows.set(id, next);
    record({ brandId: cur.brandId, entityType: "brand_rule", entityId: id, version: next.version, body: next.value, bodyText: null }, meta);
    return out(next);
  }

  const rules: BrandRuleRepository = {
    async list(brandId, opts) {
      return [...ruleRows.values()]
        .filter((r) => r.brandId === brandId && (opts?.includeDisabled || r.value.enabled))
        .sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.value.kind, b.value.kind) || cmp(a.value.message, b.value.message) || cmp(a.id, b.id))
        .map(out);
    },
    async create(brandId, input, meta) {
      const rule = normalizeRule(input);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      const row = { id: randomUUID(), brandId, value: structuredClone({ ...rule, enabled: true }), version: 1, updatedAt: now().toISOString(), createdAt: now().toISOString() };
      ruleRows.set(row.id, row);
      record({ brandId, entityType: "brand_rule", entityId: row.id, version: 1, body: row.value, bodyText: null }, meta);
      return out(row);
    },
    async update(id, patch, meta) {
      return writeRule(id, patch, meta);
    },
    async disable(id, meta) {
      return writeRule(id, {}, meta, false);
    },
    async enable(id, meta) {
      return writeRule(id, {}, meta, true);
    },
  };

  /** Keyed rows (guidance by name, recipes by recipe) share the document version semantics. */
  interface KeyedRow { id: string; brandId: string; key: string; data: Record<string, unknown>; version: number; updatedAt: string }
  const keyed = { brand_guidance: new Map<string, KeyedRow>(), brand_recipes: new Map<string, KeyedRow>() };
  const findKeyed = (table: keyof typeof keyed, brandId: string, key: string) => [...keyed[table].values()].find((r) => r.brandId === brandId && r.key === key);

  function putKeyed(table: keyof typeof keyed, what: string, brandId: string, key: string, data: Record<string, unknown>, revision: { body: unknown; bodyText: string | null }, meta: WriteMeta) {
    assertSlug(key, what);
    if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
    const cur = findKeyed(table, brandId, key);
    if (cur && meta.expectedVersion === null) throw new AlreadyExistsError(`${table} ${key}`, cur.version);
    if (meta.expectedVersion !== (cur?.version ?? null)) throw new VersionConflictError(cur?.version ?? null);
    const row: KeyedRow = { id: cur?.id ?? randomUUID(), brandId, key, data: structuredClone(data), version: (cur?.version ?? 0) + 1, updatedAt: now().toISOString() };
    keyed[table].set(row.id, row);
    record({ brandId, entityType: table === "brand_guidance" ? "brand_guidance" : "brand_recipe", entityId: row.id, version: row.version, ...structuredClone(revision) }, meta);
    return { id: row.id, version: row.version, updatedAt: row.updatedAt };
  }

  const guidance: GuidanceRepository = {
    async list(brandId) {
      return [...keyed.brand_guidance.values()].filter((r) => r.brandId === brandId).sort((a, b) => cmp(a.key, b.key))
        .map((r) => ({ name: r.key, description: r.data.description as string, version: r.version, updatedAt: r.updatedAt }));
    },
    async get(brandId, name) {
      const r = findKeyed("brand_guidance", brandId, name);
      if (!r) throw new NotFoundError(`guidance ${name}`);
      return { trust: "brand-data", id: r.id, name, description: r.data.description as string, body: r.data.body as string, version: r.version, updatedAt: r.updatedAt };
    },
    async put(brandId, name, input, meta) {
      assertGuidance(input);
      return putKeyed("brand_guidance", "name", brandId, name, input, { body: { description: input.description }, bodyText: input.body }, meta);
    },
  };

  const recipes: RecipeRepository = {
    async get(brandId, recipe, validate) {
      const r = findKeyed("brand_recipes", brandId, recipe);
      if (!r) throw new NotFoundError(`recipe ${recipe}`);
      return { id: r.id, value: validate(structuredClone(r.data.params), r.data.schemaVersion as number), version: r.version, updatedAt: r.updatedAt };
    },
    async put(brandId, recipe, input, meta) {
      assertParams(input.params, input.schemaVersion);
      return putKeyed("brand_recipes", "recipe", brandId, recipe, input, { body: input.params, bodyText: null }, meta);
    },
  };

  return { brands: brandRepo, documents, revisions, rules, guidance, recipes };
}
