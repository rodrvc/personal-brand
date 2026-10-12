import type postgres from "postgres";

import {
  NotFoundError,
  AlreadyExistsError,
  VersionConflictError,
  type Brand,
  type BrandDocumentRepository,
  type BrandRepository,
  type Revision,
  type RevisionRepository,
  type WriteMeta,
} from "../contracts/index.ts";
import { assertEnvelope, assertSlug, isUuid, shouldAppendRevision, type DocumentBody } from "../revision-policy.ts";
import type { Sql } from "./connect.ts";

type Tx = postgres.TransactionSql;
type Row = postgres.Row;

export interface PgRepositories {
  brands: BrandRepository;
  documents: BrandDocumentRepository;
  revisions: RevisionRepository;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const json = (tx: Tx, value: unknown) => tx.json(value as postgres.JSONValue);

const toBrand = (r: Row) => ({
  id: r.id as string,
  value: { slug: r.slug, displayName: r.display_name, status: r.status, cutoverAt: iso(r.cutover_at) } as Brand,
  version: r.version as number,
  updatedAt: iso(r.updated_at)!,
});

const toRevision = (r: Row): Revision => ({
  brandId: r.brand_id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  version: r.version,
  reason: r.reason,
  body: r.body,
  bodyText: r.body_text,
  author: r.author,
  source: r.source,
  ...(r.source_hash ? { sourceHash: r.source_hash } : {}),
  createdAt: iso(r.created_at)!,
});

/**
 * Postgres repositories. Every write is one transaction: row update (optimistic version) + revision per policy.
 * Timestamps (`updated_at`, revision `created_at`) come from the injected `now` (default: JS `Date`), not the
 * database clock, so clock skew between processes shifts the 10-minute autosave window.
 */
export function createPgRepositories(sql: Sql, now: () => Date = () => new Date()): PgRepositories {
  async function appendRevision(
    tx: Tx,
    r: { brandId: string; entityType: string; entityId: string; version: number; body: unknown; bodyText: string | null },
    meta: WriteMeta,
  ): Promise<void> {
    // The entity row is already locked by this transaction's write, so writers of one entity are serialized here.
    const [last] = await tx`SELECT author, created_at FROM revisions WHERE entity_type = ${r.entityType} AND entity_id = ${r.entityId} ORDER BY version DESC LIMIT 1`;
    const at = now();
    if (!shouldAppendRevision(last && { author: last.author, createdAt: last.created_at.toISOString() }, meta, at)) return;
    await tx`INSERT INTO revisions (brand_id, entity_type, entity_id, version, reason, body, body_text, author, source, source_hash, created_at)
             VALUES (${r.brandId}, ${r.entityType}, ${r.entityId}, ${r.version}, ${meta.reason}, ${r.body === null ? null : json(tx, r.body)},
                     ${r.bodyText}, ${meta.author}, ${meta.source}, ${meta.sourceHash ?? null}, ${at})`;
  }

  async function writeBrand(id: string, meta: WriteMeta, patch: { displayName?: string; status?: string }) {
    if (!isUuid(id)) throw new NotFoundError(`brand ${id}`);
    return sql.begin(async (tx) => {
      const [row] = await tx`UPDATE brands SET display_name = COALESCE(${patch.displayName ?? null}, display_name),
                                    status = COALESCE(${patch.status ?? null}, status), updated_at = ${now()}, version = version + 1
                             WHERE id = ${id} AND version = ${meta.expectedVersion} RETURNING *`;
      if (!row) {
        const [cur] = await tx`SELECT version FROM brands WHERE id = ${id}`;
        throw cur ? new VersionConflictError(cur.version) : new NotFoundError(`brand ${id}`);
      }
      const brand = toBrand(row);
      await appendRevision(tx, { brandId: id, entityType: "brand", entityId: id, version: brand.version, body: brand.value, bodyText: null }, meta);
      return brand;
    });
  }

  const brands: BrandRepository = {
    async list(opts) {
      const rows = await sql`SELECT * FROM brands WHERE ${opts?.includeArchived ? sql`true` : sql`status = 'active'`} ORDER BY slug COLLATE "C"`;
      return rows.map(toBrand);
    },
    async getBySlug(slug) {
      const [row] = await sql`SELECT * FROM brands WHERE slug = ${slug}`;
      if (!row) throw new NotFoundError(`brand "${slug}"`);
      return toBrand(row);
    },
    async create(input, meta) {
      assertSlug(input.slug);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      return sql.begin(async (tx) => {
        const [row] = await tx`INSERT INTO brands (slug, display_name, updated_at) VALUES (${input.slug}, ${input.displayName}, ${now()})
                               ON CONFLICT (slug) DO NOTHING RETURNING *`;
        if (!row) {
          const [cur] = await tx`SELECT version FROM brands WHERE slug = ${input.slug}`;
          throw cur ? new AlreadyExistsError(`brand "${input.slug}"`, cur.version) : new VersionConflictError(null);
        }
        const brand = toBrand(row);
        await appendRevision(tx, { brandId: brand.id, entityType: "brand", entityId: brand.id, version: 1, body: brand.value, bodyText: null }, meta);
        return brand;
      });
    },
    update: (id, patch, meta) => writeBrand(id, meta, patch),
    archive: (id, meta) => writeBrand(id, meta, { status: "archived" }),
    unarchive: (id, meta) => writeBrand(id, meta, { status: "active" }),
  };

  const documents: BrandDocumentRepository = {
    async get(brandId, kind, name, validate) {
      const [row] = isUuid(brandId)
        ? await sql`SELECT * FROM brand_documents WHERE brand_id = ${brandId} AND kind = ${kind} AND name = ${name}`
        : [];
      if (!row) throw new NotFoundError(`document ${kind}/${name}`);
      return { id: row.id, value: validate(row.body_text ?? row.body_json, row.schema_version), version: row.version, updatedAt: iso(row.updated_at)! };
    },
    async list(brandId, kind) {
      if (!isUuid(brandId)) return [];
      const rows = await sql`SELECT name, version, updated_at FROM brand_documents WHERE brand_id = ${brandId} AND kind = ${kind} ORDER BY name COLLATE "C"`;
      return rows.map((r) => ({ name: r.name, version: r.version, updatedAt: iso(r.updated_at)! }));
    },
    async put(brandId, kind, name, body: DocumentBody, meta) {
      assertEnvelope(body);
      if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
      const bodyJson = "json" in body ? body.json : null;
      const bodyText = "text" in body ? body.text : null;
      return sql.begin(async (tx) => {
        const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
        if (!brand) throw new NotFoundError(`brand ${brandId}`);
        const jsonParam = bodyJson === null ? null : json(tx, bodyJson);
        const [row] =
          meta.expectedVersion === null
            ? await tx`INSERT INTO brand_documents (brand_id, kind, name, schema_version, body_json, body_text, updated_at)
                       VALUES (${brandId}, ${kind}, ${name}, ${body.schemaVersion}, ${jsonParam}, ${bodyText}, ${now()})
                       ON CONFLICT (brand_id, kind, name) DO NOTHING RETURNING id, version, updated_at`
            : await tx`UPDATE brand_documents SET schema_version = ${body.schemaVersion}, body_json = ${jsonParam}, body_text = ${bodyText},
                              updated_at = ${now()}, version = version + 1
                       WHERE brand_id = ${brandId} AND kind = ${kind} AND name = ${name} AND version = ${meta.expectedVersion}
                       RETURNING id, version, updated_at`;
        if (!row) {
          const [cur] = await tx`SELECT version FROM brand_documents WHERE brand_id = ${brandId} AND kind = ${kind} AND name = ${name}`;
          if (cur && meta.expectedVersion === null) throw new AlreadyExistsError(`document ${kind}/${name}`, cur.version);
          throw new VersionConflictError(cur?.version ?? null);
        }
        await appendRevision(tx, { brandId, entityType: "brand_document", entityId: row.id, version: row.version, body: bodyJson, bodyText }, meta);
        return { id: row.id as string, version: row.version as number, updatedAt: iso(row.updated_at)! };
      });
    },
  };

  const revisions: RevisionRepository = {
    async list(entityType, entityId) {
      if (!isUuid(entityId)) return [];
      return (await sql`SELECT * FROM revisions WHERE entity_type = ${entityType} AND entity_id = ${entityId} ORDER BY version`).map(toRevision);
    },
    async get(entityType, entityId, version) {
      const [row] = isUuid(entityId)
        ? await sql`SELECT * FROM revisions WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND version = ${version}`
        : [];
      if (!row) throw new NotFoundError(`revision ${entityType}/${entityId}@${version}`);
      return toRevision(row);
    },
  };

  return { brands, documents, revisions };
}
