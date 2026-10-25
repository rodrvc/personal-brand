import { randomUUID } from "node:crypto";

import {
  BrandArchivedError,
  NotFoundError,
  AlreadyExistsError,
  InvalidInputError,
  VersionConflictError,
  type Brand,
  type Asset,
  type AssetRepository,
  type CarouselExport,
  type CarouselHead,
  type CarouselRepository,
  type ContentItemHead,
  type ContentItemRepository,
  type ChatMessage,
  type ChatRepository,
  type RecipeRunHead,
  type RecipeRunRepository,
  type RunArtifact,
  type RunArtifactRepository,
  type ExportRepository,
  type ImportRun,
  type ImportRunRepository,
  type BrandDocumentRepository,
  type TtsCacheRepository,
  type TtsEntry,
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
import { blobKey } from "../contracts/keys.ts";
import { DEFAULT_EXPORT_STALE_MS, assertCarousel, assertChatPage, assertContentItem, assertNotAutosave, assertRecipeRun, assertRunArtifact, assertArtifactKind, assertDate, assertJsonObject, resolvePublishedAt, stripStage, parseInstant, stripStatus, assertAsset, assertEnvelope, assertTts, isAssetId, assertGuidance, assertParams, assertSlug, normalizeRule, shouldAppendRevision, type DocumentBody } from "../revision-policy.ts";

export interface MemoryRepositories {
  brands: BrandRepository;
  documents: BrandDocumentRepository;
  revisions: RevisionRepository;
  rules: BrandRuleRepository;
  guidance: GuidanceRepository;
  recipes: RecipeRepository;
  assets: AssetRepository;
  tts: TtsCacheRepository;
  carousels: CarouselRepository;
  exports: ExportRepository;
  chat: ChatRepository;
  content: ContentItemRepository;
  runs: RecipeRunRepository;
  runArtifacts: RunArtifactRepository;
  importRuns: ImportRunRepository;
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
    async markCutover(id, meta) {
      return writeBrand(id, meta, (b) => ({ ...b, cutoverAt: b.cutoverAt ?? now().toISOString() }));
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
    async listSince(brandId, entityType, since) {
      const after = Date.parse(since);
      return structuredClone(log.filter((r) => r.brandId === brandId && r.entityType === entityType && Date.parse(r.createdAt) > after)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || cmp(a.entityId, b.entityId) || a.version - b.version));
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
        .map((r) => ({ id: r.id, name: r.key, description: r.data.description as string, version: r.version, updatedAt: r.updatedAt }));
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
    async list(brandId) {
      return [...keyed.brand_recipes.values()].filter((r) => r.brandId === brandId).sort((a, b) => cmp(a.key, b.key))
        .map((r) => ({ recipe: r.key, version: r.version, updatedAt: r.updatedAt }));
    },
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

  const assetRows = new Map<string, Versioned<Asset> & { brandId: string }>();
  const findAsset = (brandId: string, assetId: string) => [...assetRows.values()].find((a) => a.brandId === brandId && a.value.assetId === assetId);
  const assetOut = (a: Versioned<Asset>): Versioned<Asset> => structuredClone({ id: a.id, value: a.value, version: a.version, updatedAt: a.updatedAt });

  const assets: AssetRepository = {
    async list(brandId, filter) {
      return [...assetRows.values()]
        .filter((a) => a.brandId === brandId && (!filter?.kind || a.value.kind === filter.kind) && (!filter?.status || a.value.status === filter.status) && (!filter?.origin || a.value.origin === filter.origin))
        .sort((a, b) => cmp(a.value.createdAt, b.value.createdAt) || cmp(a.value.assetId, b.value.assetId))
        .map(assetOut);
    },
    async get(brandId, assetId) {
      const found = isAssetId(assetId) ? findAsset(brandId, assetId) : undefined;
      if (!found) throw new NotFoundError(`asset ${assetId}`);
      return assetOut(found);
    },
    async register(brandId, input, meta) {
      assertAsset(input);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      if (brands.get(brandId)!.value.status === "archived") throw new BrandArchivedError(brandId);
      const assetId = input.sha256.slice(0, 16);
      const dup = findAsset(brandId, assetId);
      if (dup && dup.value.sha256 !== input.sha256) throw new InvalidInputError(`asset id ${assetId} collides with a different sha256`);
      if (dup) throw new AlreadyExistsError(`asset ${assetId}`, dup.version);
      const at = now().toISOString();
      const row = {
        id: randomUUID(), brandId, version: 1, updatedAt: at,
        value: structuredClone({
          assetId, sha256: input.sha256, blobKey: blobKey(brandId, input.sha256), kind: input.kind, mime: input.mime, width: input.width ?? null, height: input.height ?? null,
          bytes: input.bytes, origin: input.origin, status: input.status, tags: input.tags ?? [], family: input.family ?? null, generation: input.generation ?? null, createdAt: at,
        }),
      };
      assetRows.set(row.id, row);
      record({ brandId, entityType: "brand_asset", entityId: row.id, version: 1, body: row.value, bodyText: null }, meta);
      return assetOut(row);
    },
    async update(brandId, assetId, patch, meta) {
      assertAsset(patch, false);
      const cur = isAssetId(assetId) ? findAsset(brandId, assetId) : undefined;
      if (!cur) throw new NotFoundError(`asset ${assetId}`);
      if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = { ...cur, value: structuredClone({ ...cur.value, ...defined }), version: cur.version + 1, updatedAt: now().toISOString() };
      assetRows.set(cur.id, next);
      record({ brandId, entityType: "brand_asset", entityId: cur.id, version: next.version, body: next.value, bodyText: null }, meta);
      return assetOut(next);
    },
  };

  const ttsRows = new Map<string, TtsEntry[]>();
  const tts: TtsCacheRepository = {
    async get(brandId, narrationHash) {
      const found = ttsRows.get(`${brandId}/${narrationHash}`)?.at(-1);
      if (!found) throw new NotFoundError(`tts ${narrationHash}`);
      return structuredClone(found);
    },
    async takes(brandId, narrationHash) {
      return structuredClone(ttsRows.get(`${brandId}/${narrationHash}`) ?? []);
    },
    async record(brandId, narrationHash, entry) {
      assertTts(narrationHash, entry);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      const list = ttsRows.get(`${brandId}/${narrationHash}`) ?? [];
      const cur = list.find((t) => t.sha256 === entry.sha256);
      if (cur) return structuredClone(cur);
      const row: TtsEntry = structuredClone({ ...entry, createdAt: now().toISOString() });
      ttsRows.set(`${brandId}/${narrationHash}`, [...list, row]);
      return structuredClone(row);
    },
  };

  interface CarouselRow { id: string; brandId: string; head: CarouselHead; document: Record<string, unknown>; schemaVersion: number; version: number; updatedAt: string }
  const carouselRows = new Map<string, CarouselRow>();
  const carouselBody = (c: CarouselRow) => structuredClone({ ...c.head, document: c.document });
  const carouselVersioned = (c: CarouselRow): Versioned<CarouselHead> => structuredClone({ id: c.id, value: c.head, version: c.version, updatedAt: c.updatedAt });
  const readCarousel = <T,>(c: CarouselRow | undefined, what: string, validate: (body: unknown, schemaVersion: number) => T) => {
    if (!c) throw new NotFoundError(what);
    const value = { ...structuredClone(c.head), document: validate({ ...structuredClone(c.document), status: c.head.status }, c.schemaVersion) };
    return { id: c.id, value, version: c.version, updatedAt: c.updatedAt };
  };

  function writeCarousel(id: string, meta: WriteMeta, change: (cur: CarouselRow) => Partial<CarouselRow>): Versioned<CarouselHead> {
    const cur = carouselRows.get(id);
    if (!cur) throw new NotFoundError(`carousel ${id}`);
    if (brands.get(cur.brandId)?.value.status === "archived") throw new BrandArchivedError(`of carousel ${id}`);
    if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
    const next = { ...cur, ...change(cur), version: cur.version + 1, updatedAt: now().toISOString() };
    carouselRows.set(id, next);
    record({ brandId: cur.brandId, entityType: "carousel", entityId: id, version: next.version, body: carouselBody(next), bodyText: null }, meta);
    return carouselVersioned(next);
  }

  const carousels: CarouselRepository = {
    async list(brandId, filter) {
      return [...carouselRows.values()].filter((c) => c.brandId === brandId && (!filter?.status || c.head.status === filter.status))
        .sort((a, b) => cmp(a.head.slug, b.head.slug)).map(carouselVersioned);
    },
    async get(brandId, slug, validate) {
      return readCarousel([...carouselRows.values()].find((c) => c.brandId === brandId && c.head.slug === slug), `carousel "${slug}"`, validate);
    },
    async getById(id, validate) {
      return readCarousel(carouselRows.get(id), `carousel ${id}`, validate);
    },
    async create(brandId, input, meta) {
      assertCarousel(input, true);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      if (brands.get(brandId)!.value.status === "archived") throw new BrandArchivedError(brandId);
      const dup = [...carouselRows.values()].find((c) => c.brandId === brandId && c.head.slug === input.slug);
      if (dup) throw new AlreadyExistsError(`carousel "${input.slug}"`, dup.version);
      const row: CarouselRow = {
        id: randomUUID(), brandId, head: { slug: input.slug, title: input.title, status: input.status ?? "draft", scheduledFor: null, publishedAt: null },
        document: structuredClone(stripStatus(input.document.json)), schemaVersion: input.document.schemaVersion, version: 1, updatedAt: now().toISOString(),
      };
      carouselRows.set(row.id, row);
      record({ brandId, entityType: "carousel", entityId: row.id, version: 1, body: carouselBody(row), bodyText: null }, meta);
      return carouselVersioned(row);
    },
    async save(id, input, meta) {
      assertCarousel(input);
      return writeCarousel(id, meta, (cur) => ({
        head: { ...cur.head, title: input.title ?? cur.head.title }, document: structuredClone(stripStatus(input.document.json)), schemaVersion: input.document.schemaVersion,
      }));
    },
    async setStatus(id, patch, meta) {
      assertNotAutosave(meta);
      assertCarousel({ status: patch.status });
      const iso = (v: string | null | undefined, what: string) => (v === undefined ? undefined : (parseInstant(v, what)?.toISOString() ?? null));
      const scheduledFor = iso(patch.scheduledFor, "scheduledFor");
      const publishedAt = iso(patch.publishedAt, "publishedAt");
      return writeCarousel(id, meta, (cur) => ({
        head: { ...cur.head, status: patch.status, scheduledFor: scheduledFor === undefined ? cur.head.scheduledFor : scheduledFor, publishedAt: publishedAt === undefined ? cur.head.publishedAt : publishedAt },
      }));
    },
  };

  interface ContentRow { id: string; brandId: string; head: ContentItemHead; bodyMd: string; meta: Record<string, unknown>; metaSchemaVersion: number; version: number; updatedAt: string }
  const contentRows = new Map<string, ContentRow>();
  const contentBody = (c: ContentRow) => structuredClone({ ...c.head, meta: c.meta });
  const contentVersioned = (c: ContentRow): Versioned<ContentItemHead> => structuredClone({ id: c.id, value: c.head, version: c.version, updatedAt: c.updatedAt });
  const readContent = (c: ContentRow | undefined, what: string) => {
    if (!c) throw new NotFoundError(what);
    return { ...contentVersioned(c), value: structuredClone({ ...c.head, bodyMd: c.bodyMd, meta: { ...c.meta, stage: c.head.stage }, metaSchemaVersion: c.metaSchemaVersion }) };
  };

  function writeContent(id: string, meta: WriteMeta, change: (cur: ContentRow) => Partial<ContentRow>): Versioned<ContentItemHead> {
    const cur = contentRows.get(id);
    if (!cur) throw new NotFoundError(`content item ${id}`);
    if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
    const next = { ...cur, ...change(cur), version: cur.version + 1, updatedAt: now().toISOString() };
    contentRows.set(id, next);
    record({ brandId: cur.brandId, entityType: "content_item", entityId: id, version: next.version, body: contentBody(next), bodyText: next.bodyMd }, meta);
    return contentVersioned(next);
  }

  const content: ContentItemRepository = {
    async list(brandId, filter) {
      return [...contentRows.values()].filter((c) => c.brandId === brandId && (!filter?.stage || c.head.stage === filter.stage)
        && (!filter?.channel || c.head.channel === filter.channel) && (!filter?.derivedFrom || c.head.derivedFrom === filter.derivedFrom))
        .sort((a, b) => cmp(a.head.slug, b.head.slug)).map(contentVersioned);
    },
    async get(brandId, slug) {
      return readContent([...contentRows.values()].find((c) => c.brandId === brandId && c.head.slug === slug), `content item "${slug}"`);
    },
    async getById(id) {
      return readContent(contentRows.get(id), `content item ${id}`);
    },
    async create(brandId, input, meta) {
      assertContentItem(input, true);
      const stage = input.stage ?? "idea";
      const publishedAt = resolvePublishedAt(null, stage, input.publishedAt, null);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      if (input.derivedFrom && contentRows.get(input.derivedFrom)?.brandId !== brandId) throw new InvalidInputError("derivedFrom must be an item of the same brand");
      const dup = [...contentRows.values()].find((c) => c.brandId === brandId && c.head.slug === input.slug);
      if (dup) throw new AlreadyExistsError(`content item "${input.slug}"`, dup.version);
      const at = now().toISOString();
      const row: ContentRow = {
        id: randomUUID(), brandId, bodyMd: input.bodyMd ?? "", meta: structuredClone(stripStage(input.meta ?? {})), metaSchemaVersion: input.metaSchemaVersion ?? 1, version: 1, updatedAt: at,
        head: {
          slug: input.slug, title: input.title, stage, channel: input.channel ?? null, format: input.format ?? null,
          derivedFrom: input.derivedFrom ?? null, publishedAt: publishedAt?.toISOString() ?? null, createdAt: at,
        },
      };
      contentRows.set(row.id, row);
      record({ brandId, entityType: "content_item", entityId: row.id, version: 1, body: contentBody(row), bodyText: row.bodyMd }, meta);
      return contentVersioned(row);
    },
    async save(id, patch, meta) {
      assertContentItem(patch);
      return writeContent(id, meta, (cur) => ({
        head: {
          ...cur.head, title: patch.title ?? cur.head.title,
          channel: patch.channel === undefined ? cur.head.channel : patch.channel, format: patch.format === undefined ? cur.head.format : patch.format,
        },
        bodyMd: patch.bodyMd ?? cur.bodyMd, metaSchemaVersion: patch.metaSchemaVersion ?? cur.metaSchemaVersion, meta: patch.meta === undefined ? cur.meta : structuredClone(stripStage(patch.meta)),
      }));
    },
    async setStage(id, patch, meta) {
      assertNotAutosave(meta);
      assertContentItem({ stage: patch.stage });
      return writeContent(id, meta, (cur) => ({
        head: { ...cur.head, stage: patch.stage, publishedAt: resolvePublishedAt(cur.head.stage, patch.stage, patch.publishedAt, cur.head.publishedAt)?.toISOString() ?? null },
      }));
    },
  };

  const exportRows = new Map<string, CarouselExport>();
  const exportsOf = (carouselId: string) => [...exportRows.values()].filter((e) => e.carouselId === carouselId);
  const finishExport = (id: string, status: "done" | "failed", manifest?: Record<string, unknown>): CarouselExport => {
    const cur = exportRows.get(id);
    if (!cur) throw new NotFoundError(`export ${id}`);
    if (cur.status !== "running") {
      if (status === "failed") return structuredClone(cur);
      throw new InvalidInputError(`export ${id} is ${cur.status}, not running`);
    }
    const next: CarouselExport = { ...cur, status, manifest: manifest ? structuredClone(manifest) : null, finishedAt: now().toISOString() };
    exportRows.set(id, next);
    return structuredClone(next);
  };

  const exports: ExportRepository = {
    async reserveNextVersion(carouselId, carouselVersion, opts) {
      if (!Number.isInteger(carouselVersion) || carouselVersion < 1) throw new InvalidInputError("invalid carouselVersion");
      if (!carouselRows.has(carouselId)) throw new NotFoundError(`carousel ${carouselId}`);
      const at = now();
      const cutoff = at.getTime() - (opts?.staleAfterMs ?? DEFAULT_EXPORT_STALE_MS);
      const existing = exportsOf(carouselId);
      for (const e of existing) if (e.status === "running" && Date.parse(e.startedAt) < cutoff) exportRows.set(e.id, { ...e, status: "failed", finishedAt: at.toISOString() });
      const row: CarouselExport = {
        id: randomUUID(), carouselId, versionNo: Math.max(0, ...existing.map((e) => e.versionNo)) + 1, carouselVersion,
        status: "running", manifest: null, startedAt: at.toISOString(), finishedAt: null,
      };
      exportRows.set(row.id, row);
      return structuredClone(row);
    },
    async complete(id, manifest) {
      assertJsonObject(manifest, "manifest");
      return finishExport(id, "done", manifest);
    },
    async fail(id) {
      return finishExport(id, "failed");
    },
    async list(carouselId) {
      return structuredClone(exportsOf(carouselId).sort((a, b) => a.versionNo - b.versionNo));
    },
  };

  const chatRows = new Map<string, ChatMessage[]>();
  const chat: ChatRepository = {
    async append(carouselId, body) {
      assertJsonObject(body, "chat body");
      if (!carouselRows.has(carouselId)) throw new NotFoundError(`carousel ${carouselId}`);
      const list = chatRows.get(carouselId) ?? [];
      const seq = list.length + 1;
      chatRows.set(carouselId, [...list, { seq, body: structuredClone(body), createdAt: now().toISOString() }]);
      return seq;
    },
    async list(carouselId, opts) {
      assertChatPage(opts);
      return structuredClone((chatRows.get(carouselId) ?? []).filter((m) => m.seq > (opts?.afterSeq ?? 0)).slice(0, opts?.limit));
    },
  };

  interface RunRow { id: string; brandId: string; head: RecipeRunHead; input: Record<string, unknown>; storyboard: Record<string, unknown> | null; version: number; updatedAt: string }
  const runRows = new Map<string, RunRow>();
  const runBody = (r: RunRow) => structuredClone({ ...r.head, input: r.input, storyboard: r.storyboard });
  const runVersioned = (r: RunRow): Versioned<RecipeRunHead> => structuredClone({ id: r.id, value: r.head, version: r.version, updatedAt: r.updatedAt });

  const runs: RecipeRunRepository = {
    async create(brandId, input, meta) {
      assertRecipeRun(input, true);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!brands.has(brandId)) throw new NotFoundError(`brand ${brandId}`);
      const at = now().toISOString();
      const row: RunRow = {
        id: randomUUID(), brandId, version: 1, updatedAt: at, input: structuredClone(input.input.json), storyboard: structuredClone(input.storyboard ?? null),
        head: { recipe: input.recipe, periodStart: input.periodStart, periodEnd: input.periodEnd, schemaVersion: input.input.schemaVersion, createdBy: meta.author, createdAt: at },
      };
      runRows.set(row.id, row);
      record({ brandId, entityType: "recipe_run", entityId: row.id, version: 1, body: runBody(row), bodyText: null }, meta);
      return runVersioned(row);
    },
    async get(id, validate) {
      const r = runRows.get(id);
      if (!r) throw new NotFoundError(`recipe run ${id}`);
      return { ...runVersioned(r), value: structuredClone({ ...r.head, input: validate(structuredClone(r.input), r.head.schemaVersion), storyboard: r.storyboard }) };
    },
    async list(brandId, filter) {
      if (filter?.periodStart !== undefined) assertDate(filter.periodStart, "periodStart");
      return [...runRows.values()].filter((r) => r.brandId === brandId && (!filter?.recipe || r.head.recipe === filter.recipe) && (!filter?.periodStart || r.head.periodStart === filter.periodStart))
        .sort((a, b) => cmp(b.head.periodStart, a.head.periodStart) || cmp(b.head.createdAt, a.head.createdAt) || cmp(a.id, b.id)).map(runVersioned);
    },
    async save(id, patch, meta) {
      assertRecipeRun(patch);
      const cur = runRows.get(id);
      if (!cur) throw new NotFoundError(`recipe run ${id}`);
      if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
      const next: RunRow = {
        ...cur, version: cur.version + 1, updatedAt: now().toISOString(),
        input: patch.input ? structuredClone(patch.input.json) : cur.input,
        storyboard: patch.storyboard === undefined ? cur.storyboard : structuredClone(patch.storyboard),
        head: { ...cur.head, schemaVersion: patch.input?.schemaVersion ?? cur.head.schemaVersion },
      };
      runRows.set(id, next);
      record({ brandId: cur.brandId, entityType: "recipe_run", entityId: id, version: next.version, body: runBody(next), bodyText: null }, meta);
      return runVersioned(next);
    },
  };

  const artifactRows: RunArtifact[] = [];
  const requireRun = (runId: string) => {
    if (!runRows.has(runId)) throw new NotFoundError(`recipe run ${runId}`);
  };
  const slotOf = (runId: string, kind: string, cardIndex: number | null) => artifactRows.filter((a) => a.runId === runId && a.kind === kind && a.cardIndex === cardIndex);

  const runArtifacts: RunArtifactRepository = {
    async record(runId, input) {
      assertRunArtifact(input);
      requireRun(runId);
      const last = slotOf(runId, input.kind, input.cardIndex).at(-1);
      if (last && last.sha256 === input.sha256 && last.inputsHash === input.inputsHash) return structuredClone(last);
      const row: RunArtifact = { ...input, id: randomUUID(), runId, seq: artifactRows.length + 1, createdAt: now().toISOString() };
      artifactRows.push(row);
      return structuredClone(row);
    },
    async current(runId, filter) {
      if (filter?.kind) assertArtifactKind(filter.kind);
      requireRun(runId);
      const latest = new Map<string, RunArtifact>();
      for (const a of artifactRows) if (a.runId === runId && (!filter?.kind || a.kind === filter.kind)) latest.set(`${a.kind}:${a.cardIndex}`, a);
      return structuredClone([...latest.values()].sort((a, b) => cmp(a.kind, b.kind) || (a.cardIndex ?? Infinity) - (b.cardIndex ?? Infinity)));
    },
    async history(runId, kind, cardIndex) {
      assertRunArtifact({ kind, cardIndex }, false);
      requireRun(runId);
      return structuredClone(slotOf(runId, kind, cardIndex));
    },
  };

  const importRunRows: ImportRun[] = [];
  const importRuns: ImportRunRepository = {
    async record(input) {
      if (!brands.has(input.brandId)) throw new NotFoundError(`brand ${input.brandId}`);
      const row = { ...structuredClone(input), startedAt: parseInstant(input.startedAt, "startedAt")!.toISOString(), finishedAt: parseInstant(input.finishedAt, "finishedAt")!.toISOString(), id: randomUUID() };
      importRunRows.push(row);
      return structuredClone(row);
    },
    async list(brandId) {
      return structuredClone(importRunRows.filter((r) => r.brandId === brandId).sort((a, b) => cmp(b.startedAt, a.startedAt) || cmp(b.finishedAt, a.finishedAt) || cmp(a.id, b.id)));
    },
  };

  return { brands: brandRepo, documents, revisions, rules, guidance, recipes, assets, tts, carousels, exports, chat, content, runs, runArtifacts, importRuns };
}
