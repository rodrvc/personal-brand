import { randomUUID } from "node:crypto";

import {
  NotFoundError,
  AlreadyExistsError,
  VersionConflictError,
  type Brand,
  type BrandDocumentRepository,
  type BrandRepository,
  type DocumentKind,
  type Revision,
  type RevisionEntity,
  type RevisionRepository,
  type Versioned,
  type WriteMeta,
} from "../contracts/index.ts";
import { assertEnvelope, assertSlug, shouldAppendRevision, type DocumentBody } from "../revision-policy.ts";

export interface MemoryRepositories {
  brands: BrandRepository;
  documents: BrandDocumentRepository;
  revisions: RevisionRepository;
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

/** Same semantics as the Postgres repositories (versions, conflicts, revision policy). `now` is injectable for tests. */
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

  return { brands: brandRepo, documents, revisions };
}
