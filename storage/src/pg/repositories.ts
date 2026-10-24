import type postgres from "postgres";

import {
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
  type ChatMessage,
  type ChatRepository,
  type ExportRepository,
  type BrandDocumentRepository,
  type TtsCacheRepository,
  type TtsEntry,
  type BrandRepository,
  type BrandRule,
  type BrandRuleRepository,
  type GuidanceRepository,
  type RecipeRepository,
  type RuleInput,
  type Versioned,
  type Revision,
  type RevisionRepository,
  type WriteMeta,
} from "../contracts/index.ts";
import { blobKey } from "../contracts/keys.ts";
import { DEFAULT_EXPORT_STALE_MS, assertCarousel, assertChatPage, assertJsonObject, parseInstant, stripStatus, assertAsset, assertEnvelope, assertTts, isAssetId, assertGuidance, assertParams, assertSlug, isUuid, normalizeRule, shouldAppendRevision, type DocumentBody } from "../revision-policy.ts";
import type { Sql } from "./connect.ts";

type Tx = postgres.TransactionSql;
type Row = postgres.Row;

export interface PgRepositories {
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
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const json = (tx: Pick<Tx, "json">, value: unknown) => tx.json(value as postgres.JSONValue);

const toBrand = (r: Row) => ({
  id: r.id as string,
  value: { slug: r.slug, displayName: r.display_name, status: r.status, cutoverAt: iso(r.cutover_at) } as Brand,
  version: r.version as number,
  updatedAt: iso(r.updated_at)!,
});

const toRule = (r: Row): Versioned<BrandRule> => ({
  id: r.id,
  value: { kind: r.kind, params: r.params, severity: r.severity, appliesTo: r.applies_to, message: r.message, enabled: r.enabled },
  version: r.version,
  updatedAt: iso(r.updated_at)!,
});

const toAsset = (r: Row) => ({
  id: r.id as string,
  value: {
    assetId: r.asset_id, sha256: r.sha256, blobKey: r.blob_key, kind: r.kind, mime: r.mime, width: r.width, height: r.height, bytes: Number(r.bytes),
    origin: r.origin, status: r.status, tags: r.tags, family: r.family, generation: r.generation, createdAt: iso(r.created_at)!,
  } as Asset,
  version: r.version as number,
  updatedAt: iso(r.updated_at)!,
});

const toTts = (r: Row): TtsEntry => ({ sha256: r.sha256, seconds: r.seconds, voice: r.voice, createdAt: iso(r.created_at)! });

const toHead = (r: Row): CarouselHead => ({ slug: r.slug, title: r.title, status: r.status, scheduledFor: iso(r.scheduled_for), publishedAt: iso(r.published_at) });

const toExport = (r: Row): CarouselExport => ({
  id: r.id, carouselId: r.carousel_id, versionNo: r.version_no, carouselVersion: r.carousel_version, status: r.status,
  manifest: r.manifest, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at),
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

  const rules: BrandRuleRepository = {
    async list(brandId, opts) {
      if (!isUuid(brandId)) return [];
      const rows = await sql`SELECT * FROM brand_rules WHERE brand_id = ${brandId} AND ${opts?.includeDisabled ? sql`true` : sql`enabled`}
                             ORDER BY created_at, kind COLLATE "C", message COLLATE "C", id`;
      return rows.map(toRule);
    },
    async create(brandId, input, meta) {
      const rule = normalizeRule(input);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
      return sql.begin(async (tx) => {
        const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
        if (!brand) throw new NotFoundError(`brand ${brandId}`);
        const [row] = await tx`INSERT INTO brand_rules (brand_id, kind, params, severity, applies_to, message, created_at, updated_at)
                               VALUES (${brandId}, ${rule.kind}, ${json(tx, rule.params)}, ${rule.severity}, ${rule.appliesTo}, ${rule.message}, ${now()}, ${now()}) RETURNING *`;
        const created = toRule(row);
        await appendRevision(tx, { brandId, entityType: "brand_rule", entityId: created.id, version: 1, body: created.value, bodyText: null }, meta);
        return created;
      });
    },
    update: (id, patch, meta) => writeRule(id, patch, meta),
    disable: (id, meta) => writeRule(id, {}, meta, false),
    enable: (id, meta) => writeRule(id, {}, meta, true),
  };

  async function writeRule(id: string, patch: Partial<RuleInput>, meta: WriteMeta, enabled?: boolean) {
    if (!isUuid(id)) throw new NotFoundError(`rule ${id}`);
    return sql.begin(async (tx) => {
      const [cur] = await tx`SELECT * FROM brand_rules WHERE id = ${id} FOR UPDATE`;
      if (!cur) throw new NotFoundError(`rule ${id}`);
      if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
      const { enabled: wasEnabled, ...base } = toRule(cur).value;
      const next = normalizeRule({ ...base, ...patch });
      const [row] = await tx`UPDATE brand_rules SET kind = ${next.kind}, params = ${json(tx, next.params)}, severity = ${next.severity},
                                    applies_to = ${next.appliesTo}, message = ${next.message}, enabled = ${enabled ?? wasEnabled},
                                    updated_at = ${now()}, version = version + 1 WHERE id = ${id} RETURNING *`;
      const updated = toRule(row);
      await appendRevision(tx, { brandId: cur.brand_id, entityType: "brand_rule", entityId: id, version: updated.version, body: updated.value, bodyText: null }, meta);
      return updated;
    });
  }

  /** Insert-or-update of one row keyed by (brand, key), with the same version semantics as documents. */
  async function putKeyed(
    table: "brand_guidance" | "brand_recipes",
    keyColumn: "name" | "recipe",
    entityType: string,
    brandId: string,
    key: string,
    values: Record<string, unknown>,
    revision: { body: unknown; bodyText: string | null },
    meta: WriteMeta,
  ) {
    assertSlug(key, keyColumn);
    if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
    return sql.begin(async (tx) => {
      const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
      if (!brand) throw new NotFoundError(`brand ${brandId}`);
      const [row] =
        meta.expectedVersion === null
          ? await tx`INSERT INTO ${tx(table)} ${tx({ brand_id: brandId, [keyColumn]: key, ...values, updated_at: now() })}
                     ON CONFLICT (brand_id, ${tx(keyColumn)}) DO NOTHING RETURNING id, version, updated_at`
          : await tx`UPDATE ${tx(table)} SET ${tx({ ...values, updated_at: now() })}, version = version + 1
                     WHERE brand_id = ${brandId} AND ${tx(keyColumn)} = ${key} AND version = ${meta.expectedVersion} RETURNING id, version, updated_at`;
      if (!row) {
        const [cur] = await tx`SELECT version FROM ${tx(table)} WHERE brand_id = ${brandId} AND ${tx(keyColumn)} = ${key}`;
        if (cur && meta.expectedVersion === null) throw new AlreadyExistsError(`${entityType} ${key}`, cur.version);
        throw new VersionConflictError(cur?.version ?? null);
      }
      await appendRevision(tx, { brandId, entityType, entityId: row.id, version: row.version, ...revision }, meta);
      return { id: row.id as string, version: row.version as number, updatedAt: iso(row.updated_at)! };
    });
  }

  const guidance: GuidanceRepository = {
    async list(brandId) {
      if (!isUuid(brandId)) return [];
      const rows = await sql`SELECT name, description, version, updated_at FROM brand_guidance WHERE brand_id = ${brandId} ORDER BY name COLLATE "C"`;
      return rows.map((r) => ({ name: r.name, description: r.description, version: r.version, updatedAt: iso(r.updated_at)! }));
    },
    async get(brandId, name) {
      const [r] = isUuid(brandId) ? await sql`SELECT * FROM brand_guidance WHERE brand_id = ${brandId} AND name = ${name}` : [];
      if (!r) throw new NotFoundError(`guidance ${name}`);
      return { trust: "brand-data", id: r.id, name: r.name, description: r.description, body: r.body_md, version: r.version, updatedAt: iso(r.updated_at)! };
    },
    async put(brandId, name, input, meta) {
      assertGuidance(input);
      return putKeyed("brand_guidance", "name", "brand_guidance", brandId, name, { description: input.description, body_md: input.body },
        { body: { description: input.description }, bodyText: input.body }, meta);
    },
  };

  const recipes: RecipeRepository = {
    async get(brandId, recipe, validate) {
      const [r] = isUuid(brandId) ? await sql`SELECT * FROM brand_recipes WHERE brand_id = ${brandId} AND recipe = ${recipe}` : [];
      if (!r) throw new NotFoundError(`recipe ${recipe}`);
      return { id: r.id, value: validate(r.params, r.schema_version), version: r.version, updatedAt: iso(r.updated_at)! };
    },
    async put(brandId, recipe, input, meta) {
      assertParams(input.params, input.schemaVersion);
      return putKeyed("brand_recipes", "recipe", "brand_recipe", brandId, recipe, { schema_version: input.schemaVersion, params: sql.json(input.params as postgres.JSONValue) },
        { body: input.params, bodyText: null }, meta);
    },
  };

  const assets: AssetRepository = {
    async list(brandId, filter) {
      if (!isUuid(brandId)) return [];
      const rows = await sql`SELECT * FROM assets WHERE brand_id = ${brandId}
                             ${filter?.kind ? sql`AND kind = ${filter.kind}` : sql``} ${filter?.status ? sql`AND status = ${filter.status}` : sql``}
                             ${filter?.origin ? sql`AND origin = ${filter.origin}` : sql``} ORDER BY created_at, asset_id COLLATE "C"`;
      return rows.map(toAsset);
    },
    async get(brandId, assetId) {
      const [row] = isUuid(brandId) && isAssetId(assetId) ? await sql`SELECT * FROM assets WHERE brand_id = ${brandId} AND asset_id = ${assetId}` : [];
      if (!row) throw new NotFoundError(`asset ${assetId}`);
      return toAsset(row);
    },
    async register(brandId, input, meta) {
      assertAsset(input);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
      return sql.begin(async (tx) => {
        const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
        if (!brand) throw new NotFoundError(`brand ${brandId}`);
        const [row] = await tx`INSERT INTO assets (brand_id, asset_id, sha256, blob_key, kind, mime, width, height, bytes, origin, status, tags, family, generation, created_at, updated_at)
                               VALUES (${brandId}, ${input.sha256.slice(0, 16)}, ${input.sha256}, ${blobKey(brandId, input.sha256)}, ${input.kind}, ${input.mime},
                                       ${input.width ?? null}, ${input.height ?? null}, ${input.bytes}, ${input.origin}, ${input.status}, ${input.tags ?? []},
                                       ${input.family ?? null}, ${input.generation ? json(tx, input.generation) : null}, ${now()}, ${now()})
                               ON CONFLICT DO NOTHING RETURNING *`;
        if (!row) {
          const [cur] = await tx`SELECT version, sha256 FROM assets WHERE brand_id = ${brandId} AND asset_id = ${input.sha256.slice(0, 16)}`;
          if (cur && cur.sha256 !== input.sha256) throw new InvalidInputError(`asset id ${input.sha256.slice(0, 16)} collides with a different sha256`);
          throw cur ? new AlreadyExistsError(`asset ${input.sha256.slice(0, 16)}`, cur.version) : new VersionConflictError(null);
        }
        const asset = toAsset(row);
        await appendRevision(tx, { brandId, entityType: "brand_asset", entityId: asset.id, version: 1, body: asset.value, bodyText: null }, meta);
        return asset;
      });
    },
    async update(brandId, assetId, patch, meta) {
      assertAsset(patch, false);
      if (!isUuid(brandId) || !isAssetId(assetId)) throw new NotFoundError(`asset ${assetId}`);
      return sql.begin(async (tx) => {
        const [row] = await tx`UPDATE assets SET kind = COALESCE(${patch.kind ?? null}, kind), status = COALESCE(${patch.status ?? null}, status),
                                      tags = COALESCE(${patch.tags ?? null}, tags), family = COALESCE(${patch.family ?? null}, family),
                                      updated_at = ${now()}, version = version + 1
                               WHERE brand_id = ${brandId} AND asset_id = ${assetId} AND version = ${meta.expectedVersion} RETURNING *`;
        if (!row) {
          const [cur] = await tx`SELECT version FROM assets WHERE brand_id = ${brandId} AND asset_id = ${assetId}`;
          throw cur ? new VersionConflictError(cur.version) : new NotFoundError(`asset ${assetId}`);
        }
        const asset = toAsset(row);
        await appendRevision(tx, { brandId, entityType: "brand_asset", entityId: asset.id, version: asset.version, body: asset.value, bodyText: null }, meta);
        return asset;
      });
    },
  };

  const tts: TtsCacheRepository = {
    async get(brandId, narrationHash) {
      const [row] = isUuid(brandId) ? await sql`SELECT * FROM tts_cache WHERE brand_id = ${brandId} AND narration_hash = ${narrationHash} ORDER BY seq DESC LIMIT 1` : [];
      if (!row) throw new NotFoundError(`tts ${narrationHash}`);
      return toTts(row);
    },
    async takes(brandId, narrationHash) {
      if (!isUuid(brandId)) return [];
      return (await sql`SELECT * FROM tts_cache WHERE brand_id = ${brandId} AND narration_hash = ${narrationHash} ORDER BY seq`).map(toTts);
    },
    async record(brandId, narrationHash, entry) {
      assertTts(narrationHash, entry);
      if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
      return sql.begin(async (tx) => {
        const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
        if (!brand) throw new NotFoundError(`brand ${brandId}`);
        const [row] = await tx`INSERT INTO tts_cache (brand_id, narration_hash, sha256, seconds, voice, created_at)
                               VALUES (${brandId}, ${narrationHash}, ${entry.sha256}, ${entry.seconds}, ${json(tx, entry.voice)}, ${now()})
                               ON CONFLICT (brand_id, narration_hash, sha256) DO NOTHING RETURNING *`;
        if (row) return toTts(row);
        const [cur] = await tx`SELECT * FROM tts_cache WHERE brand_id = ${brandId} AND narration_hash = ${narrationHash} AND sha256 = ${entry.sha256}`;
        return toTts(cur);
      });
    },
  };

  /** Revision body of a carousel: the head plus the stored document (which never holds `status`). */
  const carouselBody = (r: Row) => ({ ...toHead(r), document: r.document });
  const carouselVersioned = (r: Row) => ({ id: r.id as string, value: toHead(r), version: r.version as number, updatedAt: iso(r.updated_at)! });

  async function readCarousel<T>(row: Row | undefined, what: string, validate: (body: unknown, schemaVersion: number) => T) {
    if (!row) throw new NotFoundError(what);
    const value = { ...toHead(row), document: validate({ ...row.document, status: row.status }, row.document_schema_version) };
    return { id: row.id as string, value, version: row.version as number, updatedAt: iso(row.updated_at)! };
  }

  /** Locks the row, checks the version, applies `change` to its columns and appends a revision. */
  async function writeCarousel(id: string, meta: WriteMeta, change: (cur: Row) => Record<string, unknown>) {
    if (!isUuid(id)) throw new NotFoundError(`carousel ${id}`);
    return sql.begin(async (tx) => {
      const [cur] = await tx`SELECT * FROM carousels WHERE id = ${id} FOR NO KEY UPDATE`;
      if (!cur) throw new NotFoundError(`carousel ${id}`);
      if (cur.version !== meta.expectedVersion) throw new VersionConflictError(cur.version);
      const [row] = await tx`UPDATE carousels SET ${tx({ ...change(cur), updated_at: now() })}, version = version + 1 WHERE id = ${id} RETURNING *`;
      await appendRevision(tx, { brandId: row.brand_id, entityType: "carousel", entityId: id, version: row.version, body: carouselBody(row), bodyText: null }, meta);
      return carouselVersioned(row);
    });
  }

  const carousels: CarouselRepository = {
    async list(brandId, filter) {
      if (!isUuid(brandId)) return [];
      const rows = await sql`SELECT * FROM carousels WHERE brand_id = ${brandId} ${filter?.status ? sql`AND status = ${filter.status}` : sql``} ORDER BY slug COLLATE "C"`;
      return rows.map(carouselVersioned);
    },
    async get(brandId, slug, validate) {
      const [row] = isUuid(brandId) ? await sql`SELECT * FROM carousels WHERE brand_id = ${brandId} AND slug = ${slug}` : [];
      return readCarousel(row, `carousel "${slug}"`, validate);
    },
    async getById(id, validate) {
      const [row] = isUuid(id) ? await sql`SELECT * FROM carousels WHERE id = ${id}` : [];
      return readCarousel(row, `carousel ${id}`, validate);
    },
    async create(brandId, input, meta) {
      assertCarousel(input, true);
      if (meta.expectedVersion !== null) throw new VersionConflictError(null);
      if (!isUuid(brandId)) throw new NotFoundError(`brand ${brandId}`);
      return sql.begin(async (tx) => {
        const [brand] = await tx`SELECT 1 FROM brands WHERE id = ${brandId}`;
        if (!brand) throw new NotFoundError(`brand ${brandId}`);
        const at = now();
        const [row] = await tx`INSERT INTO carousels (brand_id, slug, title, status, document, document_schema_version, created_at, updated_at)
                               VALUES (${brandId}, ${input.slug}, ${input.title}, ${input.status ?? "draft"}, ${json(tx, stripStatus(input.document.json))},
                                       ${input.document.schemaVersion}, ${at}, ${at})
                               ON CONFLICT (brand_id, slug) DO NOTHING RETURNING *`;
        if (!row) {
          const [cur] = await tx`SELECT version FROM carousels WHERE brand_id = ${brandId} AND slug = ${input.slug}`;
          throw cur ? new AlreadyExistsError(`carousel "${input.slug}"`, cur.version) : new VersionConflictError(null);
        }
        await appendRevision(tx, { brandId, entityType: "carousel", entityId: row.id, version: 1, body: carouselBody(row), bodyText: null }, meta);
        return carouselVersioned(row);
      });
    },
    async save(id, input, meta) {
      assertCarousel(input);
      return writeCarousel(id, meta, (cur) => ({
        title: input.title ?? cur.title, document: json(sql, stripStatus(input.document.json)), document_schema_version: input.document.schemaVersion,
      }));
    },
    async setStatus(id, patch, meta) {
      assertCarousel({ status: patch.status });
      const scheduled = parseInstant(patch.scheduledFor, "scheduledFor");
      const published = parseInstant(patch.publishedAt, "publishedAt");
      return writeCarousel(id, meta, (cur) => ({
        status: patch.status,
        scheduled_for: patch.scheduledFor === undefined ? cur.scheduled_for : scheduled,
        published_at: patch.publishedAt === undefined ? cur.published_at : published,
      }));
    },
  };

  /**
   * Serializes writers of one carousel's counter (export versions, chat seq). An advisory lock, not a row lock, so it
   * never blocks saves; keyed by schema so schemas sharing a database do not contend.
   */
  const lockCounter = (tx: Tx, scope: string, carouselId: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':' || ${scope} || ':' || ${carouselId}, 0))`;
  const requireCarousel = async (tx: Tx, carouselId: string) => {
    const [found] = isUuid(carouselId) ? await tx`SELECT 1 FROM carousels WHERE id = ${carouselId}` : [];
    if (!found) throw new NotFoundError(`carousel ${carouselId}`);
  };

  const exports: ExportRepository = {
    async reserveNextVersion(carouselId, carouselVersion, opts) {
      if (!Number.isInteger(carouselVersion) || carouselVersion < 1) throw new InvalidInputError("invalid carouselVersion");
      return sql.begin(async (tx) => {
        await requireCarousel(tx, carouselId);
        await lockCounter(tx, "exports", carouselId);
        const at = now();
        const cutoff = new Date(at.getTime() - (opts?.staleAfterMs ?? DEFAULT_EXPORT_STALE_MS));
        await tx`UPDATE exports SET status = 'failed', finished_at = ${at} WHERE carousel_id = ${carouselId} AND status = 'running' AND started_at < ${cutoff}`;
        const [row] = await tx`INSERT INTO exports (carousel_id, version_no, carousel_version, started_at)
                               SELECT ${carouselId}, COALESCE(MAX(version_no), 0) + 1, ${carouselVersion}, ${at} FROM exports WHERE carousel_id = ${carouselId} RETURNING *`;
        return toExport(row);
      });
    },
    async complete(id, manifest) {
      assertJsonObject(manifest, "manifest");
      return finishExport(id, "done", manifest);
    },
    fail: (id) => finishExport(id, "failed"),
    async list(carouselId) {
      if (!isUuid(carouselId)) return [];
      return (await sql`SELECT * FROM exports WHERE carousel_id = ${carouselId} ORDER BY version_no`).map(toExport);
    },
  };

  async function finishExport(id: string, status: "done" | "failed", manifest?: Record<string, unknown>): Promise<CarouselExport> {
    if (!isUuid(id)) throw new NotFoundError(`export ${id}`);
    const [row] = await sql`UPDATE exports SET status = ${status}, manifest = ${manifest ? sql.json(manifest as postgres.JSONValue) : null}, finished_at = ${now()}
                            WHERE id = ${id} AND status = 'running' RETURNING *`;
    if (row) return toExport(row);
    const [cur] = await sql`SELECT * FROM exports WHERE id = ${id}`;
    if (!cur) throw new NotFoundError(`export ${id}`);
    if (status === "failed") return toExport(cur);
    throw new InvalidInputError(`export ${id} is ${cur.status}, not running`);
  }

  const chat: ChatRepository = {
    async append(carouselId, body) {
      assertJsonObject(body, "chat body");
      return sql.begin(async (tx) => {
        await requireCarousel(tx, carouselId);
        await lockCounter(tx, "chat", carouselId);
        const [row] = await tx`INSERT INTO chat_messages (carousel_id, seq, body, created_at)
                               SELECT ${carouselId}, COALESCE(MAX(seq), 0) + 1, ${json(tx, body)}, ${now()} FROM chat_messages WHERE carousel_id = ${carouselId} RETURNING seq`;
        return row.seq as number;
      });
    },
    async list(carouselId, opts) {
      assertChatPage(opts);
      if (!isUuid(carouselId)) return [];
      const rows = await sql`SELECT seq, body, created_at FROM chat_messages WHERE carousel_id = ${carouselId} AND seq > ${opts?.afterSeq ?? 0}
                             ORDER BY seq ${opts?.limit === undefined ? sql`` : sql`LIMIT ${opts.limit}`}`;
      return rows.map((r): ChatMessage => ({ seq: r.seq, body: r.body, createdAt: iso(r.created_at)! }));
    },
  };

  return { brands, documents, revisions, rules, guidance, recipes, assets, tts, carousels, exports, chat };
}
