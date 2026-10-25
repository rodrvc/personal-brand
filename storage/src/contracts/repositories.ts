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
  /** Sets `cutoverAt` (the D12 cutover); idempotent, a later call keeps the first timestamp. Not reversible through this interface. */
  markCutover(id: string, meta: WriteMeta): Promise<Versioned<Brand>>;
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

export type RevisionEntity = "brand" | "brand_document" | "brand_rule" | "brand_guidance" | "brand_recipe" | "brand_asset" | "carousel" | "content_item" | "recipe_run";

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
  /** One brand's revisions of one entity type created strictly after `since` (an ISO instant), oldest first (then entity id, then version). One query, however many entities changed. */
  listSince(brandId: string, entityType: RevisionEntity, since: string): Promise<Revision[]>;
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
  list(brandId: string): Promise<Array<{ id: string; name: string; description: string; version: number; updatedAt: string }>>;
  get(brandId: string, name: string): Promise<GuidanceEnvelope>;
  put(brandId: string, name: string, input: { description: string; body: string }, meta: WriteMeta): Promise<{ id: string; version: number; updatedAt: string }>;
}

export interface RecipeRepository {
  /** Ordered by recipe name. */
  list(brandId: string): Promise<Array<{ recipe: string; version: number; updatedAt: string }>>;
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

export type ContentStage = "idea" | "draft" | "published" | "archived";

export interface ContentItemHead {
  slug: string;
  title: string;
  stage: ContentStage;
  channel: string | null;
  format: string | null;
  derivedFrom: string | null;
  publishedAt: string | null;
  createdAt: string;
}
export interface ContentItem extends ContentItemHead {
  bodyMd: string;
  /** The rest of the frontmatter, opaque to storage. `get` overlays the column's `stage` on it. */
  meta: Record<string, unknown>;
  metaSchemaVersion: number;
}
export interface ContentItemInput {
  title: string;
  channel?: string | null;
  format?: string | null;
  bodyMd?: string;
  meta?: Record<string, unknown>;
  /** Version of the `meta` shape; default 1. */
  metaSchemaVersion?: number;
}

/**
 * Stage is stored once, in its column: any `stage` key in written `meta` is dropped. A slug never changes across
 * stages. Entering `published` is allowed only from `draft` (or at create, for importers) and needs `publishedAt`;
 * every other move is allowed, including restoring from `archived`; leaving `published` clears `publishedAt`.
 * Items are never deleted. Every write appends a revision whose body is the head plus `meta` and whose text is `bodyMd`.
 */
export interface ContentItemRepository {
  /** Ordered by slug. */
  list(brandId: string, filter?: { stage?: ContentStage; channel?: string; derivedFrom?: string }): Promise<Array<Versioned<ContentItemHead>>>;
  get(brandId: string, slug: string): Promise<Versioned<ContentItem>>;
  getById(id: string): Promise<Versioned<ContentItem>>;
  /** `derivedFrom` must be an item of the same brand. */
  create(brandId: string, input: ContentItemInput & { slug: string; stage?: ContentStage; derivedFrom?: string; publishedAt?: string }, meta: WriteMeta): Promise<Versioned<ContentItemHead>>;
  /** Patch semantics: `undefined` keeps the stored value, `null` clears `channel`/`format`. Never changes the stage. */
  save(id: string, patch: Partial<ContentItemInput>, meta: WriteMeta): Promise<Versioned<ContentItemHead>>;
  /** `publishedAt` is an ISO string. */
  setStage(id: string, patch: { stage: ContentStage; publishedAt?: string }, meta: WriteMeta): Promise<Versioned<ContentItemHead>>;
}

export interface RecipeRunHead {
  recipe: string;
  /** Calendar dates, `YYYY-MM-DD`. */
  periodStart: string;
  periodEnd: string;
  schemaVersion: number;
  createdBy: string;
  createdAt: string;
}
export interface RecipeRunInput {
  recipe: string;
  periodStart: string;
  periodEnd: string;
  input: { json: Record<string, unknown>; schemaVersion: number };
  storyboard?: Record<string, unknown>;
}

/**
 * One run of a recipe for a period. Re-running a period creates another run. `input` and `storyboard` share one
 * `schemaVersion`, and `created_by` is the author of the creating write. Every write appends a revision whose body is
 * the head plus `input` and `storyboard`. Writes need `expectedVersion` except `create` (null).
 */
export interface RecipeRunRepository {
  create(brandId: string, input: RecipeRunInput, meta: WriteMeta): Promise<Versioned<RecipeRunHead>>;
  /** `validate` receives the stored input and its schema version. */
  get<T>(id: string, validate: BodyValidator<T>): Promise<Versioned<RecipeRunHead & { input: T; storyboard: Record<string, unknown> | null }>>;
  /** Heads newest first: `periodStart`, then creation, descending. */
  list(brandId: string, filter?: { recipe?: string; periodStart?: string }): Promise<Array<Versioned<RecipeRunHead>>>;
  /** `undefined` keeps a field; `storyboard: null` clears it. A given `input` replaces the stored one and its schema version. */
  save(id: string, patch: { input?: RecipeRunInput["input"]; storyboard?: Record<string, unknown> | null }, meta: WriteMeta): Promise<Versioned<RecipeRunHead>>;
}

export type RunArtifactKind = "clip" | "audio" | "timeline";

export interface RunArtifact {
  id: string;
  runId: string;
  /** Global insert order; the artifact with the highest `seq` for its (kind, cardIndex) is current. */
  seq: number;
  kind: RunArtifactKind;
  /** Null exactly for a `timeline`, which belongs to the run. */
  cardIndex: number | null;
  cardId: string | null;
  sha256: string;
  inputsHash: string;
  createdAt: string;
}
export type RunArtifactInput = Pick<RunArtifact, "kind" | "cardIndex" | "cardId" | "sha256" | "inputsHash">;

/** Insert-only, not revisioned. The blob key of an artifact derives from the run's brand and `sha256`. */
export interface RunArtifactRepository {
  /**
   * Returns the current artifact of its (kind, cardIndex) when it has the same `sha256` and `inputsHash`; otherwise
   * inserts a new one. This deliberately differs from `tts.record`: re-rendering back to an earlier clip inserts again
   * so that clip becomes current. Two identical concurrent calls are serialized per slot in Postgres. The returned row is current as of the call.
   */
  record(runId: string, input: RunArtifactInput): Promise<RunArtifact>;
  /** The latest artifact per (kind, cardIndex), ordered by kind then cardIndex. */
  current(runId: string, filter?: { kind?: RunArtifactKind }): Promise<RunArtifact[]>;
  /** Every artifact of one slot, oldest first. */
  history(runId: string, kind: RunArtifactKind, cardIndex: number | null): Promise<RunArtifact[]>;
}

export interface ImportRun {
  id: string;
  brandId: string;
  sourceKind: "folder";
  /** sha256 over the sorted per-item source hashes: equal roots mean an unchanged source. */
  sourceRootHash: string;
  startedAt: string;
  finishedAt: string;
  report: Record<string, unknown>;
}

/** Insert-only log of real (non dry-run) import passes; written by the owner role, readable by the app and reader roles. */
export interface ImportRunRepository {
  record(input: Omit<ImportRun, "id">): Promise<ImportRun>;
  /** A brand's runs, newest first: `startedAt` DESC, then `finishedAt` DESC, then `id` ASC; empty for a brand with none. */
  list(brandId: string): Promise<ImportRun[]>;
}

export interface RestoreDrill {
  id: string;
  /** `current_database()` of the drilled database. */
  databaseName: string;
  status: "verified" | "failed";
  startedAt: string;
  finishedAt: string;
  /** The store's clock at insert (server `now()`); the newest drill is decided by this, not by the client-supplied times. */
  recordedAt: string;
  /** Per-table row counts when verified; the failure text when failed. Never data. */
  detail: Record<string, unknown>;
}

/** Insert-only log of backup restore drills; the import backup gate reads the newest one. */
export interface RestoreDrillRepository {
  record(input: Omit<RestoreDrill, "id" | "recordedAt">): Promise<RestoreDrill>;
  /** The newest drill by `recordedAt` of the current database, or null when none was ever run. */
  latest(): Promise<RestoreDrill | null>;
}
