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

export type RevisionEntity = "brand" | "brand_document" | "brand_rule" | "brand_guidance" | "brand_recipe";

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
