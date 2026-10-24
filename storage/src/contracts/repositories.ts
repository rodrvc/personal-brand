import type { RuleKind, RuleSeverity, RuleTarget } from "@personal-brand/core/checks";

export interface Versioned<T> {
  id: string;
  value: T;
  version: number;
  updatedAt: string;
}

export type RevisionReason = "save" | "autosave" | "structural" | "snapshot" | "status" | "import" | "archive";
export type WriteSource = "editor" | "cli" | "agent" | "import" | "system";

export interface WriteMeta {
  /** null = create; the row must not exist yet. */
  expectedVersion: number | null;
  /** Free text: "editor", "cli:<user>", "agent:<skill>". */
  author: string;
  source: WriteSource;
  reason: RevisionReason;
  /** Hash of the import source, when the write comes from an importer. */
  sourceHash?: string;
}

/**
 * Injected by callers. Storage itself validates only the envelope
 * (schema_version + a JSON object or text); domain schemas stay with callers.
 */
export type BodyValidator<T> = (body: unknown, schemaVersion: number) => T;

export type BrandStatus = "active" | "archived";

export interface Brand {
  slug: string;
  displayName: string;
  status: BrandStatus;
  cutoverAt: string | null;
}

export interface BrandRepository {
  list(opts?: { includeArchived?: boolean }): Promise<Array<Versioned<Brand>>>;
  getBySlug(slug: string): Promise<Versioned<Brand>>;
  create(input: { slug: string; displayName: string }, meta: WriteMeta): Promise<Versioned<Brand>>;
  update(id: string, patch: { displayName?: string }, meta: WriteMeta): Promise<Versioned<Brand>>;
  archive(id: string, meta: WriteMeta): Promise<Versioned<Brand>>;
  unarchive(id: string, meta: WriteMeta): Promise<Versioned<Brand>>;
}

export type DocumentKind = "tokens" | "config" | "identity" | "spec" | "template";

/** `name` is "" except for templates, where it is the template id. */
export interface BrandDocumentRepository {
  get<T>(brandId: string, kind: DocumentKind, name: string, validate: BodyValidator<T>): Promise<Versioned<T>>;
  list(brandId: string, kind: DocumentKind): Promise<Array<{ name: string; version: number; updatedAt: string }>>;
  put(
    brandId: string,
    kind: DocumentKind,
    name: string,
    body: { json: unknown; schemaVersion: number } | { text: string; schemaVersion: number },
    meta: WriteMeta,
  ): Promise<{ id: string; version: number; updatedAt: string }>;
}

export type RevisionEntity = "brand" | "brand_document" | "brand_rule" | "brand_guidance" | "brand_recipe" | "brand_asset" | "carousel";

export interface Revision {
  brandId?: string;
  entityType: RevisionEntity;
  entityId: string;
  version: number;
  reason: RevisionReason;
  body: unknown | null;
  bodyText: string | null;
  author: string;
  source: WriteSource;
  sourceHash?: string;
  createdAt: string;
}

export interface RevisionRepository {
  list(entityType: RevisionEntity, entityId: string): Promise<Revision[]>;
  get(entityType: RevisionEntity, entityId: string, version: number): Promise<Revision>;
}

export interface RuleInput {
  kind: RuleKind;
  params: Record<string, unknown>;
  severity: RuleSeverity;
  appliesTo: RuleTarget[];
  message: string;
}
export interface BrandRule extends RuleInput {
  enabled: boolean;
}

/** Writes need the owner role. Kind and params are validated with `@personal-brand/core/checks`; params are stored with defaults applied. */
export interface BrandRuleRepository {
  /** Enabled rules only, unless `includeDisabled`. Ordered by creation, then kind and message. */
  list(brandId: string, opts?: { includeDisabled?: boolean }): Promise<Array<Versioned<BrandRule>>>;
  create(brandId: string, input: RuleInput, meta: WriteMeta): Promise<Versioned<BrandRule>>;
  update(id: string, patch: Partial<RuleInput>, meta: WriteMeta): Promise<Versioned<BrandRule>>;
  disable(id: string, meta: WriteMeta): Promise<Versioned<BrandRule>>;
  enable(id: string, meta: WriteMeta): Promise<Versioned<BrandRule>>;
}

/** Brand criteria as data. Consumers must treat it as untrusted: it never authorizes commands, fetches or relaxing checks. */
export interface GuidanceEnvelope {
  trust: "brand-data";
  id: string;
  name: string;
  description: string;
  body: string;
  version: number;
  updatedAt: string;
}

/** Writes need the owner role. Names match `^[a-z0-9-]+$`. */
export interface GuidanceRepository {
  list(brandId: string): Promise<Array<{ name: string; description: string; version: number; updatedAt: string }>>;
  get(brandId: string, name: string): Promise<GuidanceEnvelope>;
  put(brandId: string, name: string, input: { description: string; body: string }, meta: WriteMeta): Promise<{ id: string; version: number; updatedAt: string }>;
}

export interface RecipeRepository {
  get<T>(brandId: string, recipe: string, validate: BodyValidator<T>): Promise<Versioned<T>>;
  put(brandId: string, recipe: string, input: { params: unknown; schemaVersion: number }, meta: WriteMeta): Promise<{ id: string; version: number; updatedAt: string }>;
}

export type AssetKind = "background" | "character" | "photo" | "logo" | "decoration" | "font" | "unclassified";
export type AssetOrigin = "manual" | "ai" | "reference";
export type AssetStatus = "candidate" | "approved" | "hidden";

export interface AssetInput {
  sha256: string;
  kind: AssetKind;
  mime: string;
  bytes: number;
  origin: AssetOrigin;
  status: AssetStatus;
  tags?: string[];
  width?: number;
  height?: number;
  family?: string;
  /** Former generated-piece sidecar (prompt, model, cost, ...). */
  generation?: Record<string, unknown>;
}
export interface Asset extends Required<Pick<AssetInput, "sha256" | "kind" | "mime" | "bytes" | "origin" | "status" | "tags">> {
  assetId: string;
  blobKey: string;
  width: number | null;
  height: number | null;
  family: string | null;
  generation: Record<string, unknown> | null;
  createdAt: string;
}
export type AssetPatch = Partial<Pick<AssetInput, "kind" | "tags" | "status" | "family">>;

export interface AssetRepository {
  /** Ordered by creation, then asset id. */
  list(brandId: string, filter?: { kind?: AssetKind; status?: AssetStatus; origin?: AssetOrigin }): Promise<Array<Versioned<Asset>>>;
  get(brandId: string, assetId: string): Promise<Versioned<Asset>>;
  /** Create only (`expectedVersion` null). The same bytes twice is `AlreadyExistsError`; a different sha256 with the same 16-hex id is `InvalidInputError`. The blob must already be stored. */
  register(brandId: string, input: AssetInput, meta: WriteMeta): Promise<Versioned<Asset>>;
  update(brandId: string, assetId: string, patch: AssetPatch, meta: WriteMeta): Promise<Versioned<Asset>>;
}

export interface TtsEntry {
  sha256: string;
  seconds: number;
  voice: Record<string, unknown>;
  createdAt: string;
}

/** Insert-only cache of synthesized narration. A re-take (new audio for the same narration hash) never replaces the old one. */
export interface TtsCacheRepository {
  /** The latest recorded take. */
  get(brandId: string, narrationHash: string): Promise<TtsEntry>;
  /** Every take, oldest first. */
  takes(brandId: string, narrationHash: string): Promise<TtsEntry[]>;
  /** A new (hash, sha256) becomes the current take (latest recorded wins). Recording an existing take returns it and never changes which take is current. */
  record(brandId: string, narrationHash: string, entry: Omit<TtsEntry, "createdAt">): Promise<TtsEntry>;
}

export type CarouselStatus = "draft" | "exported" | "scheduled" | "published";

export interface CarouselHead {
  slug: string;
  title: string;
  status: CarouselStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
}
export interface CarouselDocumentInput {
  json: Record<string, unknown>;
  schemaVersion: number;
}

/**
 * Status is stored once, in its column: any `status` key in a written document is dropped, and `get` hands the
 * validator the stored document with the column's status overlaid. Every write appends a revision (per the revision
 * policy) whose body is the head plus the stored document. Writes need `expectedVersion` except `create` (null).
 */
export interface CarouselRepository {
  /** Ordered by slug. */
  list(brandId: string, filter?: { status?: CarouselStatus }): Promise<Array<Versioned<CarouselHead>>>;
  get<T>(brandId: string, slug: string, validate: BodyValidator<T>): Promise<Versioned<CarouselHead & { document: T }>>;
  getById<T>(id: string, validate: BodyValidator<T>): Promise<Versioned<CarouselHead & { document: T }>>;
  create(brandId: string, input: { slug: string; title: string; document: CarouselDocumentInput; status?: CarouselStatus }, meta: WriteMeta): Promise<Versioned<CarouselHead>>;
  save(id: string, input: { title?: string; document: CarouselDocumentInput }, meta: WriteMeta): Promise<Versioned<CarouselHead>>;
  /** Dates are ISO strings; `undefined` keeps the stored value. */
  setStatus(id: string, patch: { status: CarouselStatus; scheduledFor?: string | null; publishedAt?: string | null }, meta: WriteMeta): Promise<Versioned<CarouselHead>>;
}

export type ExportStatus = "running" | "done" | "failed";

export interface CarouselExport {
  id: string;
  carouselId: string;
  versionNo: number;
  carouselVersion: number;
  status: ExportStatus;
  manifest: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Export attempts are never rewritten: only the outcome (status, manifest, finish time) changes. */
export interface ExportRepository {
  /**
   * Marks this carousel's `running` exports older than `staleAfterMs` (default 30 minutes) as `failed`, then reserves
   * the next `versionNo` as a new `running` export. Safe under concurrency: callers get distinct, consecutive numbers.
   * `carouselVersion` is trusted from the caller and not checked against the carousel.
   */
  reserveNextVersion(carouselId: string, carouselVersion: number, opts?: { staleAfterMs?: number }): Promise<CarouselExport>;
  /** Only a `running` export can complete; a reclaimed one is `InvalidInputError`. */
  complete(id: string, manifest: Record<string, unknown>): Promise<CarouselExport>;
  /** Idempotent: a finished export is returned unchanged. */
  fail(id: string): Promise<CarouselExport>;
  /** Ordered by `versionNo`. */
  list(carouselId: string): Promise<CarouselExport[]>;
}

export interface ChatMessage {
  seq: number;
  body: Record<string, unknown>;
  createdAt: string;
}

/** Insert-only editor chat log, not revisioned. */
export interface ChatRepository {
  /** Returns the assigned `seq`: 1, 2, 3, ... per carousel, gap-free even under concurrency. */
  append(carouselId: string, body: Record<string, unknown>): Promise<number>;
  /** Ordered by `seq`. */
  list(carouselId: string, opts?: { afterSeq?: number; limit?: number }): Promise<ChatMessage[]>;
}
