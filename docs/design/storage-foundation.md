# Storage foundation: one storage interface, bucket + Postgres, no working copies

Issue: #135 (supersedes the mirror approach of #115; refs #114, #99).
Status: design proposal, revised after architecture review. Nothing
implemented. Owner decisions pending in §14.

## Decisions at a glance

| # | Decision |
|---|---|
| D1 | **Two stores, nothing else.** Files (images, fonts, audio, rendered clips, exported PNG/MP4) live in the S3-compatible bucket. Everything structured (brands, tokens, config, templates, rules, guidance, recipes, carousels, status, schedule, revisions) lives in Postgres. After cutover (D12) no `profiles/<slug>/` folder is read or written. |
| D2 | **New workspace package `storage/` (`@personal-brand/storage`)** is shared infrastructure, not a module. It holds the contracts (`BlobStore`, typed repositories, errors, key scheme), the adapters (S3, Postgres, in-memory fakes), migrations, the importer and the `brand` CLI. `core/` stays pure. |
| D3 | **Optimistic concurrency everywhere.** Blobs: conditional `put`. Rows: a `version` integer, `UPDATE ... WHERE version = $expected`. A lost race is a typed `VersionConflictError`, never a silent overwrite. |
| D4 | **Append-only history, no deletion in normal operation.** Revisions are append-only; brands are archived, assets hidden, exports re-versioned. The only deletion is a deliberate, owner-run `brand purge` (§8). FKs are `ON DELETE RESTRICT`. |
| D5 | **Content-addressed blobs** for inputs and intermediates (`brands/<brandId>/blobs/sha256/<hh>/<sha256>`), **named immutable keys** for deliverables (`brands/<brandId>/exports/...`). |
| D6 | **The only local copy is a read-only blob cache keyed by sha256.** Shared by every process, safe to delete at any time, never written back. There is no `syncUp`. Every scratch dir (render staging, reel clips) is rebuilt from that cache per run. |
| D7 | **Render without a mirror:** Playwright resolves assets through `page.route` backed by the blob cache. Remotion gets a per-run staging dir hardlinked from the cache. |
| D8 | **Migrations:** plain numbered `.sql` files + a small runner on a reserved connection. **Driver:** `postgres` (postgres.js). No ORM. Storage validates only the JSON envelope; domain schemas are injected by callers. |
| D9 | **Agents use a CLI, never repo paths:** `pnpm brand <noun> <verb>`. Agent sessions are read-only by default. Per-brand skills become `brand_guidance` rows, returned with an explicit `trust: "brand-data"` envelope. |
| D10 | **Per-brand rules are data:** a closed set of generic check kinds with JSON params, run by a pure function in `core/`. |
| D11 | **Migration is an idempotent importer** (folder or legacy bucket prefix -> bucket + DB), dry-run first, verification report, backup drill before any real brand. |
| D12 | **Per-brand cutover:** a real brand is cut over only after every consumer is switched (end of S11b). Cutover sets `brands.cutover_at` and writes one marker file in the folder; from then on folder readers refuse the brand and storage is its single source. |
| D13 | **Write permissions (owner decision 11, 2026-10-25).** On a real brand that is cut over (D12), agents may write *content* (ideas, drafts, carousels, content items, runs/exports) without the owner opt-in; before cutover a content write needs it too. Changing the brand's *identity* (settings and tokens, rules, tone, guidance, recipes, templates), `create` of a real slug, and `archive`/`unarchive`/`purge`/`cutover`/`import` need `BRAND_OWNER_OPT_IN` + `--owner-opt-in`. `example-*` brands are unrestricted. See §8. |

---

## 1. Problem, goals, non-goals

**Problem.** Brand data is treated as a folder. In `s3` mode the editor keeps a
mirror of that folder; the terminal sync CLI (#116) added another. Skills
Read/Write repo-literal `profiles/<slug>/` while scripts read the mirror, so
an agent's edit can silently never reach the bucket. Copies drift, and
unpushed edits in an OS temp dir can be lost.

**Goals:** order over speed (one place per fact; slower is fine, ambiguous
is not); brands as data (adding, changing or archiving a brand, its rules
and guidance changes no code, file or skill); no working copies (local files
are a read-only cache or per-run scratch rebuilt from it; writes go straight
to storage, conditionally); one interface for engine, skills/agents (via the
CLI) and editor server.

**Non-goals:** offline editing; user accounts (`author` is free text; access
is split only by DB roles and bucket keys, §4); rewriting engines, the
carousel document format or the editor UI; provisioning infrastructure (§12).

## 2. Current state (short)

| Piece | Where | Note |
|---|---|---|
| Profile folder | `profiles/<slug>/` (gitignored, often a symlink) | `brand.json`, `brand-spec.md`, `profile.md`, `config.yaml`, `config.local.yaml`, `templates/*.json`, `recipes/*.yaml`, `skills/*/SKILL.md`, `carousels/<id>/carousel.json` + `versions/` + `chat.jsonl`, `assets/` + `index.json` + sidecars, `ideas/`, `content/drafts|published/`, `reels/<date>/storyboard.yaml` + TTS cache, `outputs/` |
| Path resolution | `system/ig-carousel/profile.ts` (`BRAND_PROFILES_DIR`, `BRAND_OUTPUTS_ROOT`, `outputs.base_dir`) | every engine entry point reads plain files |
| Other folder readers/writers | `system/assets/index.ts` (index + sidecars), `fetch-fonts.ts` (writes fonts into the profile), `usage.ts`; `system/ig-carousel/verify-slides.ts`, `recipe.ts`, `layout-template.ts` (`templates/*.json`), `brand-schema.ts`, `brand-style.ts::loadBrandStyle(profileDir)` (reads `brand-spec.md`, `profile.md`, `config.yaml`, `brand.json`); `system/ig-reel/*`; `scripts/init-profile.mjs` | all assigned in §13 |
| Object store, mirror | `editor/server/src/storage/{object-store,mirror,runtime}.ts`, `ProfileStore` (`writeJsonIfRevision`/`appendLine`/`reserveOnce`) | contract reused (§3a); mirror + manifest + per-request sync removed |
| Carousel save | `PUT /api/profiles/:slug/carousels/:id` | `?base=<updatedAt>` + revision -> 409; snapshots in `versions/` |
| Render | preview: `page.route("http://editor.local/**")`; export: filesystem paths | two asset paths for the same slide |
| Reel | `system/ig-reel/render-reel-week.ts`, `storyboard.ts` | reuses `clipsDir`/`rendersDir` across runs (assemble-only, re-render one card); TTS mp3 + sidecars cached by `narrationCacheKey`; one shared `remotion/public/staging/` wiped per run |
| Agents and skills | `.claude/agents/*.md` (8 agents + README), `.claude/skills/{usar-perfil,generar-carrusel-semana,generar-reel-semana,carousel-designer,narrated-slide-video}` | read/write `profiles/<slug>/` paths |
| Desktop app | `app/` (deprecated) | writes `brand.yaml` and `content/**` into the folder |
| Commit gate | `scripts/validate_commit_guardian.py` | derives the brand denylist from profile folders on disk (S11a adds the terms generated from storage; folder derivation stays until S12) |

**The three-copies problem:** repo folder (skills edit it, never reaches the
bucket), editor mirror, #116 CLI mirror (no cross-process lock) — plus the
bucket. Mirror edits survive only if a `syncUp` runs before temp cleanup.
The reel's reused clip/TTS dirs are a fourth, unlisted working copy.

## 3. Storage interface

### 3a. `BlobStore`: files by key

Reuse the existing `ObjectStore` contract unchanged, moved into
`storage/src/contracts/blob-store.ts` and renamed `BlobStore`:

```ts
interface BlobStore {
  get(key: string): Promise<{ body: Buffer; etag: string }>;
  getStream(key: string): Promise<{ stream: AsyncIterable<Buffer>; etag: string }>;
  head(key: string): Promise<{ etag: string; size: number; metadata: Record<string, string> }>;
  put(key: string, body: Buffer, opts?: { ifMatch?: string; ifNoneMatch?: "*"; contentType?: string; metadata?: Record<string, string> }): Promise<{ etag: string }>;
  list(prefix: string): Promise<Array<{ key: string; etag: string; size: number }>>;
}
// errors: ObjectNotFoundError, PreconditionFailedError (unchanged)
```

No `delete` (and the app key lacks `s3:DeleteObject`, §4). `putBlob(store,
brandId, bytes, mime)` puts with `ifNoneMatch: "*"` + `metadata.sha256`; a
`PreconditionFailedError` counts as success once `head` shows the same hash.

**Key scheme** (one root; the legacy `S3_PREFIX`/`profiles/` tree is left
untouched and only read by the importer):

```
brands/<brandId>/blobs/sha256/<hh>/<sha256>                       content-addressed: image, font, TTS audio, rendered clip, reference
brands/<brandId>/exports/carousels/<carouselId>/v<NNN>/<nn>.png   deliverable, immutable
brands/<brandId>/exports/carousels/<carouselId>/v<NNN>/manifest.json
brands/<brandId>/exports/reels/<runId>/v<NNN>/reel.mp4
```

`<brandId>`, `<carouselId>` and `<runId>` are the rows' UUIDs, never slugs,
so renaming a slug moves no objects. `<hh>` is the first two hex chars.

### 3b. Typed repositories: structured data

All in `storage/src/contracts/repositories.ts`. Every mutable entity is read
as `Versioned<T>` and written with `WriteMeta`:

```ts
interface Versioned<T> { id: string; value: T; version: number; updatedAt: string }
interface WriteMeta {
  expectedVersion: number | null;   // null = create, must not exist
  author: string;                   // free text: "editor", "cli:<user>", "agent:<skill>"
  source: "editor" | "cli" | "agent" | "import" | "system";
  reason: RevisionReason;           // "save" | "autosave" | "structural" | "snapshot" | "status" | "import" | "archive"
}
class VersionConflictError extends Error { currentVersion: number | null }
class NotFoundError extends Error {}

/** Injected by callers; storage itself only checks the envelope (schema_version + JSON object/text). */
type BodyValidator<T> = (body: unknown, schemaVersion: number) => T;

interface BrandRepository     { list({ includeArchived? }); getBySlug(slug); create(input, meta); update(id, patch, meta); archive(id, meta); unarchive(id, meta) }
interface BrandDocumentRepository {   // kind: tokens | config | identity | spec | template (name = template id)
  get<T>(brandId, kind, name, validate: BodyValidator<T>): Promise<Versioned<T>>; list(brandId, kind); put(brandId, kind, name, body, meta) }
interface BrandRuleRepository  { list(brandId, opts?); create(...); update(...); disable(...) }
interface GuidanceRepository   { list(brandId); get(brandId, name); put(brandId, name, body, meta) }
interface RecipeRepository     { get(brandId, recipe, validate); put(brandId, recipe, params, meta) }
interface AssetRepository      { list(brandId, filter?); get(brandId, assetId); register(brandId, AssetInput, meta); update(...) }
interface TtsCacheRepository   { get(brandId, narrationHash); record(brandId, narrationHash, sha256, seconds, voice) }
interface CarouselRepository   { list(brandId, filter?); get(brandId, slug, validate); create(...); save(...); setStatus(...) }
interface ExportRepository     { reserveNextVersion(carouselId, carouselVersion): Promise<number>; complete(...); fail(...); list(carouselId) }
interface ChatRepository       { append(carouselId, message): Promise<number>; list(carouselId) }
interface RecipeRunRepository  { create(...); get(id); setStoryboard(...); addArtifact(runId, RunArtifact); latestArtifacts(runId) }
interface RevisionRepository   { list(entityType, entityId); get(entityType, entityId, version) }
// later slice: ThemeRepository (seasonal_themes)

interface Storage { blobs; blobCache; brands; documents; rules; guidance; recipes; assets; tts; carousels; exports; chat; runs; revisions; close() }
openStorage(env): Promise<Storage>   /* S3 + Postgres */      openMemoryStorage(): Storage   /* fakes, for tests */
```

### 3c. Where it lives, and the module rule

`storage/` (`@personal-brand/storage`, pnpm workspace member): `migrations/`,
`src/contracts/` (interfaces, errors, keys; no deps), `src/blob/` (S3, fake,
cache), `src/pg/` (connect, migrate, repositories), `src/memory/`,
`src/import/`, `src/cli/`, `test/`.

**Restated rule (replaces the "modules talk through `profiles/` files"
rule in `docs/ARQUITECTURA.md`; the rewrite lands in S1):**

> Modules never import each other's code; they share data only through
> `@personal-brand/storage` (BlobStore + repositories). Shared pure logic
> lives in `core/`, shared I/O in `storage/`. No module creates tables or
> keys outside `storage/migrations` and the key scheme in
> `storage/src/contracts/keys.ts`. `storage/` is shared infrastructure, not a
> module.

Not `core/` (documented as pure, zero deps); not `editor/server` (engine and
CLI would import editor code).

**Dependency direction.** `storage/` depends only on `core/` (pure: rule kinds
and `validateRuleParams`; core must never import storage) and does
not import the domain zod schemas in `system/ig-carousel` (`brand-schema.ts`,
`carousel-document.ts`): it checks only the envelope and takes a
`BodyValidator` from callers, so no schema moves. Engine library functions
keep taking data plus an injected `AssetResolver`; only entry points open
storage.

## 4. Postgres data model

Conventions: every versioned table has `id uuid primary key default
gen_random_uuid()` (natural keys become UNIQUE constraints), `timestamptz`
everywhere, `version int not null default 1`, enum-like columns as `text` +
`CHECK`, JSONB bodies with a `schema_version int`. Every FK is
`ON DELETE RESTRICT`. Each slice adds its own migration file (§13).

| Table | Columns (abridged) | Keys / constraints | Slice |
|---|---|---|---|
| `schema_migrations` | `name`, `checksum`, `applied_at` | PK `name` | S1 |
| `brands` | `id`, `slug`, `display_name`, `status` (`active`/`archived`), `cutover_at` (null until D12 cutover), `created_at`, `updated_at`, `version` | `slug` UNIQUE, CHECK `slug ~ '^[a-z0-9-]+$'` | S1 |
| `brand_documents` | `id`, `brand_id`, `kind` (`tokens`/`config`/`identity`/`spec`/`template`), `name` (`''` except templates: the template id), `schema_version`, `body_json`, `body_text`, `updated_at`, `version` | UNIQUE (`brand_id`,`kind`,`name`); CHECK exactly one body set. `tokens` = `brand.json`, `config` = `config.yaml`, `identity` = `profile.md`, `spec` = `brand-spec.md`, `template` = `templates/<id>.json` override | S1 |
| `revisions` | `id bigserial`, `brand_id`, `entity_type`, `entity_id uuid`, `version`, `reason`, `body jsonb`, `body_text`, `author`, `source`, `source_hash`, `created_at` | UNIQUE (`entity_type`,`entity_id`,`version`); index (`brand_id`,`created_at`); trigger rejects UPDATE/DELETE unless the purge flag is set (§8) | S1 |
| `brand_rules` | `id`, `brand_id`, `kind`, `params jsonb`, `severity` (`error`/`warning`), `applies_to text[]`, `message`, `enabled`, `updated_at`, `version` | CHECK `kind IN (...)` (§9) | S4 |
| `brand_guidance` | `id`, `brand_id`, `name`, `description`, `body_md`, `updated_at`, `version` | UNIQUE (`brand_id`,`name`). Former `skills/*/SKILL.md` | S4 |
| `brand_recipes` | `id`, `brand_id`, `recipe`, `schema_version`, `params jsonb`, `updated_at`, `version` | UNIQUE (`brand_id`,`recipe`) | S4 |
| `assets` | `id`, `brand_id`, `asset_id` (first 16 hex of sha256, **same id as today**), `sha256 char(64)`, `blob_key`, `kind`, `mime`, `width`, `height`, `bytes`, `origin`, `status` (`candidate`/`approved`/`hidden`), `tags text[]`, `family`, `generation jsonb` (former sidecar), `created_at`, `updated_at`, `version` | UNIQUE (`brand_id`,`asset_id`), UNIQUE (`brand_id`,`sha256`) | S5 |
| `tts_cache` | `brand_id`, `narration_hash` (today's `narrationCacheKey`), `sha256`, `seconds`, `voice jsonb`, `created_at` | PK (`brand_id`,`narration_hash`); insert-only | S5 |
| `carousels` | `id`, `brand_id`, `slug`, `title`, `status` (`draft`/`exported`/`scheduled`/`published`), `scheduled_for`, `published_at`, `document jsonb` (**without** `status`), `document_schema_version`, `created_at`, `updated_at`, `version` | UNIQUE (`brand_id`,`slug`) | S6a |
| `exports` | `id`, `carousel_id`, `version_no`, `carousel_version`, `status` (`running`/`done`/`failed`), `manifest jsonb`, `started_at`, `finished_at` | UNIQUE (`carousel_id`,`version_no`) | S6a |
| `chat_messages` | `carousel_id`, `seq`, `body jsonb`, `created_at` | PK (`carousel_id`,`seq`); insert-only, not revisioned | S6a |
| `recipe_runs` | `id`, `brand_id`, `recipe` (slug, no FK), `period_start`, `period_end`, `input jsonb`, `storyboard jsonb` (nullable), `schema_version`, `created_by`, `created_at`, `updated_at`, `version` | former `week-input.json` + `storyboard.yaml`; re-runs of a period allowed; revisioned | S6c |
| `run_artifacts` | `seq` (identity), `id`, `run_id`, `kind` (`clip`/`audio`/`timeline`), `card_index`, `card_id`, `sha256`, `inputs_hash`, `created_at` | insert-only; current = highest `seq` per (`run_id`,`kind`,`card_index`); a timeline has no card; re-rendering back to an earlier clip inserts again; a reel export has no table (`exports` reference carousels only): S9b1 numbers it as the next free `v<NNN>` under the run's export prefix | S6c |
| `import_runs` | `id`, `brand_id`, `source_kind`, `source_root_hash`, `started_at`, `finished_at`, `report jsonb` | insert-only; no `dry_run` column, since a dry run writes nothing | S7a |
| `restore_drills` | `id`, `target_db` (host/db name, no secrets), `dump_taken_at`, `restored_at`, `verified bool`, `notes` | insert-only | S8 |
| `seasonal_themes` | `id`, `brand_id`, `name`, `starts_on`, `ends_on`, `token_overrides jsonb`, `guidance_md`, `updated_at`, `version` | CHECK `ends_on >= starts_on` | S13 (scheduled, after cutover) |
| `content_items` | `id`, `brand_id`, `slug`, `title`, `stage` (`idea`/`draft`/`published`/`archived`), `channel`, `format`, `body_md`, `meta jsonb` (**without** `stage`), `meta_schema_version`, `derived_from`, `published_at`, `created_at`, `updated_at`, `version` | UNIQUE (`brand_id`,`slug`); composite FK for `derived_from`; `published_at` set iff `published` | S6b |

Notes:

- **Status is stored once.** The repository strips `status` from the
  document before writing the JSONB and overlays the column on read.
- **Exports.** `reserveNextVersion` first marks `running` rows whose
  `started_at` is older than a timeout (default 30 min) as `failed`, then
  reserves `max(version_no)+1`.
- **Revision policy (no autosave flood).** Revisions are a sparse history,
  not a write log. `save`, `structural`, `snapshot`, `status`, `import` and
  `archive` writes always append a revision. `autosave` writes append one
  only if the entity's last revision is older than 10 minutes or was written
  by another author. The row's `version` still increments on every write.
  Snapshots replace `versions/<ISO>.json`.
- **Machine-local config disappears.** `config.local.yaml` and
  `outputs.base_dir` placed files on one machine. A local copy for the owner
  is an explicit `brand export pull --out <dir>` (a delivered copy).
- Secrets never go in the DB; they stay in env.

**Credentials.** Roles are cluster-level, so they are created by
provisioning (the compose init SQL locally, documented setup steps on a
hosted DB), **never by migrations**. Migrations only `GRANT` to roles that
already exist (`DO` block guarded by a `pg_roles` lookup), so per-test
schemas never create or collide on roles. Role names are cluster-wide: on a
shared cluster the `brand_*` names must be reserved for this product at
provisioning.

| Role | Can | Used by |
|---|---|---|
| `brand_migrator` | owns the schema, DDL | `brand migrate` |
| `brand_owner` | SELECT/INSERT/UPDATE on all tables incl. `brand_rules`/`brand_guidance`; SELECT/INSERT on `revisions` | owner's CLI |
| `brand_app` | SELECT/INSERT/UPDATE except writes to `brand_rules`/`brand_guidance`; SELECT/INSERT on `revisions` | editor, render entry points, CLI content writes |
| `brand_reader` | SELECT | default for agent sessions |
| `brand_purger` | the above plus DELETE | `brand purge` only |

No role but `brand_purger` has DELETE; none has `TRUNCATE` or UPDATE on
`revisions`. The `revisions` trigger plus the `app.purge_brand` session flag
are a second guard even for the purger (§8). The app's S3 key has no
`s3:DeleteObject`. Agents write only through the CLI with `brand_app`
credentials the owner provided for that session.

**Migration runner** (`storage/src/pg/migrate.ts`), in this order on **one
reserved connection** (`sql.reserve()`; advisory locks are session-level and
postgres.js pools): `pg_advisory_lock(hashtext('migrations:' || <schema>))` ->
`CREATE SCHEMA IF NOT EXISTS <schema> AUTHORIZATION CURRENT_USER` (default
`content_platform`; tests use `test_<random>`) -> set `search_path` (files are
not schema-qualified) -> `CREATE TABLE IF
NOT EXISTS schema_migrations` (inside the lock: concurrent creators race on
`pg_type`) -> **re-read** `schema_migrations` -> run each pending file in
its own transaction on that same connection, recording name + sha256
(computed after normalizing CRLF to LF) -> unlock. A changed checksum of an
applied file stops the runner. `CREATE INDEX CONCURRENTLY` (or anything that
cannot run in a transaction) is rejected. Forward-only. Rejected tools:
`node-pg-migrate` (JS DSL for plain DDL), drizzle/kysely (schema DSL +
codegen for ~15 tables).

**Driver: `postgres` (postgres.js).** Zero dependencies, bundled types,
tagged-template parameterization, `sql.begin()`, `sql.reserve()`. Pooled
hosts need `prepare: false` (`DATABASE_PREPARE=false`). `pg` is the fallback.

## 5. Bucket vs DB

| Goes to the bucket | Goes to Postgres |
|---|---|
| Bytes a browser or encoder consumes: images, fonts, generated pieces, reference images, TTS audio, rendered reel clips (both cost money/time to regenerate), exported PNG/MP4 | Everything a program decides on: tokens, config, templates, rules, guidance, recipes, carousel documents, status, schedule, asset metadata, TTS/clip indexes, chat, revisions |

A row points at a blob by key + sha256; a blob never points at a row.

Content-addressed inputs never change under a reader and need no cache
invalidation; deliverables get named versioned keys (`ifNoneMatch: "*"`;
a carousel reserves its version in `exports` first, a reel takes the next free `v<NNN>` under the run's prefix). Both rely on
the backend honouring `If-None-Match: *`; the `sha256` metadata that `head` checks is the writer's own claim. **Ordering:** upload the blob, then
insert the row; a crash leaves an orphan blob, never a dangling row.

## 6. Cache semantics

- **One cache, blobs only:** `BLOB_CACHE_DIR` (default
  `~/.cache/personal-brand/blobs`), `sha256/<hh>/<sha256>`, shared by every
  process; content-addressed entries cannot go stale.
- **Fill:** stream to a temp name, verify sha256, `chmod 0444`, atomic
  `rename`. Concurrent fills are harmless; a hash mismatch is an error.
- **Read-only, disposable:** API is `read(sha256)` / `pathFor(sha256)`; no
  code path uploads from it; `rm -rf` is always safe. (LRU size cap: future.)
- **Scratch dirs are rebuilt per run** (Remotion staging, reel clip dir),
  hardlinked from the cache (copy fallback) and holding nothing that is not
  already a blob, so removing them deletes no data. The generic `.cache/osm`
  (brand-neutral, regenerable) stays.
- **Structured data is not cached on disk** (in-process memo by `(id, version)` only).
- **Conflicts:** `VersionConflictError` with the current version. Editor ->
  409 with current document + version (`If-Match: "<version>"` replaces
  `?base=<updatedAt>`; responses carry `ETag`). CLI -> exit 3. Agents
  re-`get`, re-apply, retry once, then stop and report. No auto-merge.

## 7. Render without a mirror

Options: (A) `page.route` interception backed by the blob cache —
**recommended** for Playwright; (B) an HTTP asset server — rejected, couples
CLI renders to a running editor; (C) cache files by path — only where a tool
demands paths (Remotion).

**Carousels (Playwright).** One render-context builder for preview and
export emits `http://render.local/assets/<assetId>`. `render-batch.ts` gains
`loadWithResolver(page, html, resolve)` (what `routes/render.ts::loadSlide`
does today): serve the HTML at `http://render.local/`, fulfil
`/assets/<assetId>` from asset row -> sha256 -> `BlobCache.read`, abort
anything else on that origin. Remote images allowed by rules keep loading.
`text-raster.ts` and `contrast.ts` move to the same loader. This removes the
filesystem-path export split.

**Reels (Remotion + ffmpeg).** Today's reel keeps state on disk between runs:
`clipsDir`/`rendersDir` are reused (assemble-only, re-render one card, the
`existing` clips in `assembleClips`), `storyboard.ts::synthesiseCards`
caches TTS mp3 + JSON sidecars by `narrationCacheKey`, and one shared
`remotion/public/staging/` is wiped with `rmSync` at each run, so two
concurrent renders collide. New shape:

1. **TTS:** before synthesis, look up `tts_cache(brand_id, narration_hash)`.
   Hit -> blob from cache. Miss -> synthesize, `putBlob`, insert the
   `tts_cache` row (insert-only; a new voice or text is a new hash, nothing
   is overwritten).
2. **Clips:** each rendered card clip is uploaded as a content-addressed
   blob and recorded in `run_artifacts(kind=clip, card_index, inputs_hash)`.
   Re-rendering one card appends a new artifact row; the old clip stays
   (owner's never-delete/version rule). Assemble-only uses the latest
   artifact per card.
3. **Scratch per run:** one work dir per run holds a per-run Remotion public
   dir (`<work>/public/staging/`, passed to both `remotion render` calls with
   `--public-dir`, since Remotion bundles and copies the whole public tree on
   every call) and the clip dir; both are built from the cache (hardlink, copy
   fallback). No run touches another run's dir, and no stored run uses
   `remotion/public/`, so a folder render's `rmSync(staging)` cannot reach it.
4. **Outputs:** the final MP4 (and storyboard/timeline) upload to
   `exports/reels/<runId>/v<NNN>/`, verified by `head` (size + sha256
   metadata) before the run's scratch dirs are removed.

## 8. Skills, agents and the CLI

**CLI:** `pnpm brand <noun> <verb>` (bin in `storage/src/cli/`). `--json`
for agents. Exit codes: 0 ok, 1 unexpected error, 2 usage or invalid input,
3 version conflict, 4 not found, 5 rule violations, 6 refused (owner guard,
cutover, remote-database backup gate, database role without permission, purge).
A write without `--if-version` is a create: over an existing row it is a
version conflict (exit 3). Import conflicts also exit 3. A malformed slug is
exit 2, checked before the owner guard. A mistyped subcommand (`doc frob ...`) is exit 2 on any brand and any
database, decided before the owner guard and the remote gate. `--file` is capped
at 1 MB (exit 2): the file is opened once, refused unless it is a regular file
(a symlink or FIFO is not followed), and read through that descriptor up to the
cap plus one byte, so a file that grows meanwhile cannot get past it.

**Write permissions (D13).** On a brand that is not an example:

- *Identity* writes always need `BRAND_OWNER_OPT_IN` + `--owner-opt-in` (exit 6
  otherwise): `create`, `archive`, `unarchive`, `purge`, `cutover`, `import`,
  `rules add|update|disable`, `guidance put`, `recipe put` and `doc put` of every
  `DocumentKind`. Every `DocumentKind` is identity: `tokens` (colours, fonts,
  categories), `config` (operational settings such as hashtags and output paths),
  `identity` and `spec` (prose), `template` (layouts). The single table is
  `IDENTITY_KINDS` in `storage/src/cli/verbs.ts`.
- *Content* writes (`carousel put|status`, `asset add`; ideas, drafts, content
  items, runs and exports when their verbs exist) need no opt-in **once the brand
  is cut over** (`cutoverAt !== null`, read after connecting and before the verb
  runs). Before cutover, or for a brand that does not exist, the same write is
  refused with exit 6 and needs the opt-in. Content verbs are listed explicitly
  in `CONTENT_WRITES`; carousels and assets are not document kinds. A content
  write never reaches an archived brand (exit 6), opt-in or not.
- `asset add` registers a manual asset as `candidate`, never `approved`:
  approving an asset (status `candidate` -> `approved`) will be an identity write
  when its verb lands, because it decides what the brand's pickers and exports use.
- The remote-database gate refuses *every* write, opt-in or not. Reads stay open.
- The guard is fail-closed: only an explicit reads allowlist (`READS`) and
  `CONTENT_WRITES` escape the identity default, so a new verb is guarded until it
  is classified. `example-*` brands are unrestricted.

Open question: `config` mixes brand settings with operational paths; it is guarded
as identity until the owner says otherwise.

```
brand list [--archived]
brand create <slug> --name <display>              replaces scripts/init-profile.mjs
brand archive <slug>                              soft removal
brand unarchive <slug>                            reverses archive
brand purge <slug> --confirm <slug>               deliberate deletion, see below
brand show <slug> [--since <iso-time>]             documents + versions, rules, guidance; --since lists guidance revision metadata after the timestamp
brand doc get|put <slug> <tokens|config|identity|spec|template> [<name>] [--if-version <n>]
brand rules list <slug>                           includes disabled rules
brand rules add <slug> --file <rule.json>         owner role; { kind, params, severity, appliesTo, message }
brand rules update|disable <slug> <ruleId> --if-version <n>   update takes --file with any subset of those fields
brand guidance list|get|put <slug> [<name>] [--if-version <n>]   put: owner role
brand recipe get|put <slug> <recipe> [--if-version <n>]
brand asset list <slug> [--kind --status --origin]
brand asset add <slug> <file> [--kind --tags a,b --family <f>]   upload + register as a manual candidate (25 MB max)
brand asset get <slug> <assetId> [--out <path>]   --out must be outside the repo, never overwrites
brand fonts fetch <slug>                          downloads the fonts of the tokens' `googleFontsHref` as candidate assets; replaces system/assets/fetch-fonts.ts (retired in S12), never writes a profile folder
brand carousel list <slug> [--status <s>] | get <slug> <carousel>
brand carousel put <slug> <carousel> --file <doc.json> [--title <t>] [--if-version <n>]   no --if-version = create (needs --title)
brand carousel status <slug> <carousel> --status <s> --if-version <n> [--scheduled-for|--published-at <iso>]
brand export pull <slug> <carousel> [--version N] --out <dir>
brand check <slug> --carousel <id>
brand import --from <dir|legacy-bucket:<slug>> [--dry-run] [--report <file>]
brand cutover <slug> --confirm <slug>             D12, see §10
brand migrate                                     migrator role
brand backup drill --target <db>                  record a verified restore in restore_drills
brand denylist [--write]                          terms for the commit gate; --write saves them to scripts/brand-denylist.generated.txt (pinned)
```

**Removal.** `archive` is the normal path (listed apart in the editor picker and
opened read-only, S10c; data intact). `purge` exists for the rare "this brand must be gone" case:
it requires an archived brand and runs as `brand_purger` (connection from `DATABASE_PURGE_URL`), writes an export bundle
(all rows as JSON + a blob key manifest) to a local path outside the repo and
verifies it, then deletes the brand's rows in FK order in one transaction
under `SET LOCAL app.purge_brand = '<brandId>'`, which the `revisions`
trigger checks as a second guard. Bucket objects
under `brands/<brandId>/` are removed afterwards by an operator with a
delete-capable key; the app key cannot. As built (S8b3b2): `--bundle` is a
folder outside the repo (created 0700 if missing; removed again if the write fails) that receives
`<slug>.<UTC timestamp>.bundle.json`, so a re-run never meets an old bundle. The file is 0600, written like `asset get --out`
(never over a file), fsynced together with its directory, and read back. It holds a header (format, the migrations this
code ships, by name and checksum: `schema_migrations` is not readable by the purger role), every row by table as
`to_jsonb`, the blob keys the database knows with their hashes, and the bucket listing when `S3_*` is set.
Order of refusals: confirmation, archived, `--bundle` present and outside the repo, `DATABASE_PURGE_URL` set,
bundle folder name allowed; then the `DATABASE_PURGE_URL` host must be local, the session `current_user` must be
`brand_purger`, and `current_database()` and `inet_server_port()` must equal those of `DATABASE_URL` (all checked on open,
before any read).
Everything else is ONE repeatable-read transaction: lock the brand `FOR UPDATE` (it must exist and be archived), lock its
carousels and recipe runs `FOR UPDATE` (the parents of chat, exports and run artifacts), read every table, write and verify
the bundle (the callback returns only once it is durable), delete in FK order, and require each table's deleted count to equal its
bundled count. Any mismatch or failure rolls everything back and deletes nothing. A concurrent writer is blocked (it needs a share
lock on the brand or on the locked parent) or fails on the RESTRICT key or with a serialization error, so nothing is deleted unbundled. Writers take the brand `FOR SHARE`
before the carousel, the same order as the purge. It never deletes from the bucket; the report prints how many objects remain
under the brand prefix. A brand that is gone exits 4.
**Archived guard (S8b3b3).** Every content write is refused by the repository itself with `BrandArchivedError`: carousel
create/save/status, asset register, chat append, `exports.reserveNextVersion` and `complete`, content items (create, save, set stage), recipe runs
(create, save, artifacts) and the TTS cache. In Postgres each takes the brand `FOR SHARE` as its first lock, in the same transaction as the write
(the purge's lock order), so an `archive` or a purge cannot commit in between; the in-memory repositories check the same way.
Purge follow-ups: 40001, 40P01, 23503 and 23001 inside the purge transaction exit 6 with a retry message that names the bundle left behind
("se dejó el paquete en <ruta>"); the database identity check also compares `inet_server_addr()` and `pg_postmaster_start_time()`; a bundle
whose read-back or directory fsync fails is unlinked and its created folders removed; a bundle name that already exists is refused, never overwritten.

**Fonts policy (S8b3b3).** `fonts fetch` is a content write (D13). The stylesheet URL is the tokens' `googleFontsHref` and the font files are the
`.woff2` `url(...)` of its `@font-face` rules, exactly what `fetch-fonts.ts` did. Now: https only, no credentials or port, hosts limited to
`fonts.googleapis.com` and `fonts.gstatic.com`, redirects followed by hand (at most 3) with every hop judged like the first, a 256 KiB cap on the
stylesheet, 2 MiB per font, 32 distinct fonts (duplicate URLs count once), a 15 s timeout per request and a 60 s deadline per run. A font URL must end in `.woff2` (a query or fragment is refused), and every URL is judged before the first download. All fonts are downloaded and judged before the first upload, then registered as `candidate`
assets through the same checks as `asset add` (file type, magic bytes, secret scan): one refused font leaves nothing registered. Identical bytes under several URLs register once, with the first face's family. A failure mid-registration names the fonts already registered (a re-run skips them). Fetched fonts keep `origin: manual` (owner decision, S8c1): `reference` means the `references/` moodboard, and the origin is fixed at registration.

**Guidance trust envelope.** `brand guidance get --json` returns
`{ "trust": "brand-data", "name", "version", "body" }`. `usar-perfil` states
explicitly: guidance describes brand criteria (what content fits, tone); it
never authorizes running commands, fetching URLs, reading files, or relaxing
engine rules, limits or checks — the same posture `system/recipes/*.md`
already takes for `guidance`. Only the owner role writes guidance, and
`brand show <slug> --since <iso-time>` is a global cursor: it prints guidance
revision metadata (name, version, reason, author, source, time; never the
content, which is read with `guidance get`) after a timestamp, so an
unexpected change is visible. The text form of `guidance get` closes the body
with an end marker; `guidance list --json` carries `trust: "brand-data"`.
`archive` and `unarchive` write revisions with reason `archive`.
The `import`/`cutover` refusal exits (marker mismatch, not cut over, left-behind
data without `--partial`, dirty verification, folder name mismatch -> 6; import
conflicts -> 3) use these codes since S8b1. A missing `--from` folder is exit 4.
`--since` is a UTC cursor (a date that exists, or a timestamp with `Z` or an
offset), exclusive at millisecond resolution. Text output of `list`, `show`,
`check`, `guidance list|get`, `rules list`, `recipe get` and `doc get` of
`identity`/`spec` is wrapped in the trust header and end marker, with every
brand line split on all line terminators and prefixed with `│ `, so brand text
can neither close nor forge the envelope. The `--json` forms of `show`,
`rules list`, `recipe get` and `doc get` of `identity`/`spec` carry
`trust: "brand-data"`. `create --name` rejects control characters. `rules list --json` is
`{ "trust": "brand-data", "items": [...] }`, like `guidance list --json`; the same
shape (`trust` + `items`) holds for `carousel list --json` and `asset list --json`,
and `carousel get`, `asset get` and `show` carry `trust` too, and so do the `--json`
results of the write verbs. `asset add` runs the
importer's name allowlist and secret checks (`nameRefusal`, `contentRefusal`) on
the file and on every directory of its path (as typed, and the real path from
`$HOME` down, so `.docker/config.json` is refused), requires binary types to start
with their own magic bytes, validates `--kind`, `--tags` and `--family`, and refuses
with exit 6 before anything is uploaded; the bytes go through the
write-once `putBlob` (identical bytes are accepted again, so after a failed register the same
command succeeds; only a registered row is exit 3). Binary files are scanned only for fixed-prefix
tokens (PEM, AKIA, `gh*_`, `sk_live`, `AIza`, `xox*`, JWT, docker `"auth"`), and a hit is `unknown`, since
a font or image may hold such bytes by chance. SVG gets a positive screen, an allowlist and not a
sanitizer: it is accepted only if every tag is a plain drawing element (no prefix, no `script`,
`style`, `foreignObject`, `set` or `animate*`), the only references are the five XML entities, no tag holds
a backslash, no attribute is an event handler, every `href` is `#id` or an inline raster `data:` image and
every `url()` is `url(#id)` and no other CSS function but colours (including `oklch`, `lab`, `hwb`, `color-mix`), `calc`, `min`/`max`/`clamp`, `var`, the transforms (including the 3d ones) and the basic shapes
appears, `xmlns` values are the SVG and xlink namespaces, `xml:base` and malformed comments are refused;
DOCTYPE, CDATA and processing instructions other than a leading `<?xml ?>` are refused. The refusal reason is
English; `asset add` adds a Spanish hint (re-export as plain SVG, no DOCTYPE or `<style>`, quoted attributes;
SVGO or Figma; or convert to PNG) and the cutover report adds the `--partial` way out.
Refusals carry a machine-readable `code` (`unknown-type`, `svg-allowlist`) that callers use instead of the English `why`.
**Intended, fail-closed change (R4-001):** the SVG allowlist also runs in the legacy importer, so a brand folder whose editor-exported SVGs
(`<style>`, editor namespaces, numeric references) imported on the base now blocks the cutover as `unknown`. The cutover report names the
SVG screen and the remedy (re-export as plain SVG, convert to PNG, or `--partial`); the screen is not loosened.
**Recorded length bounds** (every quantifier is bounded so no scan is quadratic or overflows the regex stack): a URL credential has a
user of up to 256 and a password of up to 1024 characters, a scheme of up to 32; a JWT has a header of up to 4096, a payload of up to
12000 and a signature of 8 characters (the match stops at 8); the docker `"auth"` value has 12 to 16384 characters. A binary is searched in a window of
4200 bytes before and 17000 after each literal hit. A secret longer than a bound is not matched by that pattern.
`export pull <slug> <carousel> --out <dir> [--version N]` is a read verb: it copies the files of the highest finished export (or version N) from the
bucket into `<dir>` with the safety of `asset get --out` (outside the repo, destination judged like a name, every file written through `wx` and a
hard link so nothing is overwritten, nothing it did not create is removed). One refused file name stops the whole pull before anything is written. Binaries are searched
by literal with `Buffer.indexOf` and only a window around a hit is decoded, so no string of the whole file
is built; a scan that throws is a refusal (`unknown`), never an aborted import. Serving approved SVGs to a browser should still sit behind a CSP. `asset add` looks at the file, judges its path,
reads through one descriptor, then refuses if the real path, dev/ino or a hard link count shows it
changed. `asset get --out` judges its destination like a name (any extension is fine). A `$HOME` inside a
dot-directory is judged by its full real path. The archived-brand check runs twice: early in the CLI (a clear
refusal), and in the repository, atomically with the write (`BrandArchivedError` from carousel `create`/`save`/`setStatus` and
asset `register`, in memory and in Postgres, where the brand row is read `FOR SHARE` in the same transaction so an `archive`
cannot commit in between; the CLI maps it to exit 6). There is no `rules enable` yet: a disabled
rule stays disabled until a later slice adds it.
`show` also lists recipes.

**Consumers to switch** (all in §13): `usar-perfil` (resolve with `brand
list`; load with `brand guidance`, `brand rules list`, `brand recipe get`,
`brand show`; "profile not found" means "not in `brand list`"),
`generar-carrusel-semana`, `generar-reel-semana`, `carousel-designer` (+
`references/brand-context-protocol.md`, `references/verification-checklist.md`),
`narrated-slide-video` (+ `references/voice-casting.md`), and every agent in
`.claude/agents/` (`content-strategist`, `draft-writer`, `draft-reviewer`,
`idea-capture`, `content-publisher`, `channel-adapter`, `analytics-reviewer`,
`notion-sync`, `README.md`). Rule for all: never Read/Write/`ls` under
`profiles/`; reads via `brand ... get`, writes via `brand ... put
--if-version`. Agents whose job is ideas/drafts/published markdown depend on
§14 Q5.

**`app/`** (deprecated; writes `brand.yaml` and `content/**`, though its UI
never calls those commands): **retire formally**, no migration (§14 decision 10).

## 9. Generic rule/check mechanism

A rule = `{ kind, params, severity, applies_to, message }`. The engine owns a
**closed** set of kinds; a brand only chooses kinds and params.
`runChecks(target, rules, ctx) -> Finding[]` and `validateRuleParams(kind,
params)` are pure functions in `core/src/checks.js` (hand-written
validation, no new dependency in `core/`). Params are validated on write
(repository calls `validateRuleParams`) and on load; an unknown kind is a
load error, never silently skipped.

| Kind | Params | Checks |
|---|---|---|
| `forbidden_terms` | `terms[]`, `match` (`word`/`substring`), `case_sensitive`, `fields[]`, `slides` (`cover`/`all`/`last`/indices) | text fields contain none of the terms |
| `max_length` | `field`, `max`, `slides` | text length |
| `slide_count` | `min`, `max` | number of slides |
| `image_hosts` | `hosts[]` | remote image URLs come from allowed hosts (today's recipe `image_hosts`) |
| `date_window` | `require_dates` | dated items fall inside the run period (today's `verify-slides` check) |

Future kinds, added only when a brand needs them: `required_terms`,
`asset_policy` (allowed origins / required tags per slide). A regex kind is
deliberately excluded (ReDoS risk, unreadable rules).

Examples (fictional brand `acme-coffee`):

```jsonc
{ "kind": "max_length", "severity": "error", "applies_to": ["carousel"],
  "params": { "field": "title", "max": 32, "slides": "cover" },
  "message": "Cover titles stay short enough to read in the grid." }

{ "kind": "forbidden_terms", "severity": "warning", "applies_to": ["carousel", "caption"],
  "params": { "terms": ["guaranteed", "best ever"], "match": "word",
              "case_sensitive": false, "fields": ["title", "subtitle", "body"], "slides": "all" },
  "message": "No unverifiable claims." }
```

Where it runs: editor save (findings returned), editor export and engine
render entry points (`error` blocks, like `verifyOrThrow` today), `brand
check`. Judgment that cannot be a check stays in `brand_guidance`.

## 10. Migration of existing profiles and cutover

`brand import --from <dir> | legacy-bucket:<slug> [--dry-run] [--report out.json]`.
The legacy-bucket source reads the #99 `profiles/<slug>/` prefix (`S3_PREFIX`), because a
brand edited in `s3` mode may be fresher there than in its folder (§14 Q4). It copies the
objects into a temporary brand folder (`_outputs/<path>` becomes the outputs root, replacing
`outputs.base_dir`, so no real folder is read) and runs the folder importer on it: one code
path, same allowlist, refusals, owner guard and conflict rules. Nothing is downloaded when
the listing is empty or its total size exceeds `LEGACY_BUCKET_MAX_BYTES` (default 2 GiB).
Unsafe keys, keys that differ only by case or Unicode form (every member of the group) and
names too long for the file system are reported in `skipped`; the copy is removed afterwards.
The report carries `origin: legacy-bucket:<prefix><slug>` and names the outputs root `_outputs/`.
The run is recorded with `source_kind` `folder` (a `legacy_bucket` kind needs a migration: follow-up).
`cutover --from legacy-bucket:` is refused. A brand made with `brand create` is not renderable by
today's modules until its cutover (D12; S9a1, S9a2, S10).

| Source | Destination |
|---|---|
| `brand.json` / `brand.yaml` | `brand_documents(tokens)` |
| `config.yaml` (`config.local.yaml` reported, not imported) | `brand_documents(config)` |
| `profile.md`, `brand-spec.md` | `brand_documents(identity / spec)` |
| `templates/<id>.json` | `brand_documents(template, <id>)` |
| `recipes/*.yaml` | `brand_recipes`; `image_hosts` also proposed as an `image_hosts` rule |
| `skills/*/SKILL.md` | `brand_guidance` |
| `assets/**` + `index.json` + sidecars | blobs + `assets` rows (ids preserved); `index.json` is a rebuildable cache and is not imported (S7b2a) |
| `carousels/<id>/carousel.json`, `versions/*.json`, `chat.jsonl` | `carousels` + `revisions` (oldest first, reason `import`) + `chat_messages` |
| `carousels/*.json` (flat), `reels/week-input.json`, `reels/<date>/storyboard.yaml` | `recipe_runs`; recipe and period are derived and recorded on the run (S7b2b1, §14 Q-S7b2b) |
| reel TTS cache (`reels/<date>/audio/<card>.mp3` + `.json`) | blobs + `tts_cache` takes + `audio` `run_artifacts` (S7b2b1); existing clips -> `clip` `run_artifacts` (S7b2b3a) |
| `<outputs.editor>/<slug>/v<N>/` of the resolved `outputs.base_dir` | `exports` + export keys (S7b2b3b) |
| `ideas/` backlog (S7b1b) | not interpreted: each backlog line becomes one `content_items` row with stage `idea`; lines marked checked import as stage `archived` (neutral, never deleted, no meaning inferred) |
| `content/**`, anything else | blob keyed by content (`blobKey(sha256)`), with the path -> sha256 manifest in that run's `import_runs.report` (nothing lost; S7b2b2). `content/drafts` and `content/published` become `content_items` in S7b1b |

Importer guarantees: **read-only on the source** (the cutover marker is the
only folder write, by a separate command); **idempotent** via `source_hash`
per revision (same hash -> skip; changed since import -> conflict reported,
never overwritten); **nothing deleted**; **dry-run** writes nothing, not
even `import_runs`; **verification report** (counts, then re-download every
blob and compare sha256, re-read every row and compare a canonical-JSON
hash).

- **Backup gate:** a write (non-dry-run import or cutover, and every `brand`
  write verb) against a non-localhost `DATABASE_URL` is refused unless the
  newest `restore_drills` row of that database is `verified` and finished less
  than `RECENT_DRILL_MS` ago (30 days, `storage/src/pg/drill.ts`). A later failed
  drill closes the gate again. `brand backup drill` runs `pg_dump` of the
  product schema, pipes it into `pg_restore` on a fresh scratch database
  (`DATABASE_DRILL_URL`, default the same server; dropped afterwards, and only
  a database the drill created is ever dropped), compares the row count of
  every table and records the row in the drilled database (insert-only). The
  libpq password travels in the environment, never on a command line;
  `PG_DUMP_BIN` / `PG_RESTORE_BIN` choose the binaries. A missing binary
  records nothing. Local databases are never gated. No self-reported flag.
  Dumps stream between the two processes and are never written to disk.
  The dump and the row counts read one exported snapshot, so a concurrent
  write cannot fake a mismatch; the drill's own dump leaves out the data of
  `restore_drills`, and the comparison skips that table (this protects nothing
  else). The child process gets a minimal
  environment (`PATH`, `HOME`, `LANG` and explicit `PG*` values; `?ssl=require`
  maps to `PGSSLMODE`, and a non-local host defaults to `require`). The scratch
  database lives on the source server unless `DATABASE_DRILL_URL` is set; if
  its drop fails the drill reports the exact `drill_xxx` name, exits non-zero
  and records `scratchLeaked`. The newest drill is decided by the server's
  `recorded_at`, a drill dated more than 5 minutes ahead is distrusted, and
  `latest()` reads only rows of the current database; the scratch copy has a
  different name, so it never satisfies the gate. Known limit: a provider
  backup or PITR restore that keeps the same database name inherits the
  verified row.
  This gate is a tooling guard, not a security boundary: a `localhost` tunnel
  to a remote server counts as local, and any `brand_owner` session can insert
  a `verified` row. This gate is **self-attested**: it trusts the newest row and
  never cross-checks it against a dump; column grants (0009) keep `recorded_at`
  server-set. The gate age is the store's `now() - recorded_at` (`ageMs`), never
  this machine's clock; a negative age beyond 5 minutes is distrusted. The drill
  needs a direct database URL, not a pooler (`pg_dump`, `pg_export_snapshot` and
  `CREATE DATABASE` need a session); its own connections honour
  `DATABASE_PREPARE=false`. At start it takes an advisory lock (per administration
  database) and drops, without FORCE, `drill_[0-9a-f]{12}` databases owned by the
  connected role that have no open connection (a crashed drill's leftovers; names
  in `detail.swept`). A setup failure is "no drill happened" and is not recorded; a
  recorded failure keeps a code and only the tools' own `error:` lines, quoted
  text replaced and capped, never the CONTEXT lines that quote rows.
- YAML via the `yaml` package (importer only). Local dev seeds with `brand
  import --from profiles/example` and cuts the example brands over.

**Cutover rule (D12), explicit:**

1. **Timing:** no real brand is cut over until every consumer it uses has
   been switched to storage (end of S11b). Example brands are cut over in
   dev from S7a2 on.
2. **Transition:** until a brand is cut over, switched consumers serve it
   from its folder through a single resolver,
   `resolveBrandSource(slug) -> "storage" | "folder"` (storage package,
   S7a2): `"storage"` iff `brands.cutover_at` is set. One code path decides;
   no consumer guesses.
3. **Cutover** = `brand cutover <slug> --confirm <slug>`: final import pass,
   verification report must be clean, then set `brands.cutover_at` and write
   one marker file, `profiles/<slug>/.storage-cutover` (brand id +
   timestamp). That marker is the only file the system ever writes in a
   folder.
4. **After cutover:** `resolveProfileDir` (`system/ig-carousel/profile.ts`,
   changed in S7a2 next to `resolveBrandSource`) throws for a brand whose
   folder holds `.storage-cutover` or whose `brands.cutover_at` is set,
   pointing to the `brand` CLI; every legacy reader goes through it. The
   importer refuses to re-import it. The folder is never deleted.

   *As built in S7a:* the backup gate refuses every non-dry-run against a
   non-localhost `DATABASE_URL` until `restore_drills` exists (S8), and
   `--report out.json` is deferred to S8. The cutover itself (steps 2-4) is
   S7a2.
   *As built in S7a2:* `markCutover` is idempotent (a second call keeps the
   first `cutover_at`). The marker is created with `wx` and detected with
   `lstat`, so a planted or dangling symlink is never followed. One
   exception to "every legacy reader goes through `resolveProfileDir`":
   `app/src-tauri/src/main.rs` still reads `profiles/<slug>` directly; it is
   retired with `app/` (decision 10). `--report out.json` stays deferred to
   S8. `cutover` refuses while the importer has left anything behind
   (`notImported` or `skipped`, minus files that are never imported by
   design) unless `--partial` is passed; the examples are cut over with
   `--partial` until S7b2b. A concurrent cutover that already wrote the same
   brand's marker counts as success.
   *As built in S7b1:* `cutover` re-checks the real pass report against
   `--partial`, and a marker that does not name the brand is refused, not
   trusted. `import_runs.list(brandId)` reads runs back, newest first.

   *As built in S7b1b:* `import` now also carries `templates/*.json`,
   `carousels/<id>/` (document, `versions/*.json` oldest first, then the
   current document, then a status move if the column differs, all reason
   `import`; `chat.jsonl` as insert-only messages, appended only past what is
   stored, a diverging log is a conflict) and `ideas/`, `content/drafts`,
   `content/published` as `content_items`. **Ideas mapping (owner decision):**
   legacy markers are not interpreted. A checked line (`[x]`) becomes stage
   `archived` (neutral: never deleted, no "discarded" meaning); an unchecked
   line or plain bullet becomes `idea`; the checked flag and the source file
   stay in `meta.legacy`. "Approved by the owner" is not a stage: whatever the
   file says about it stays in `meta` (a draft's whole frontmatter is kept
   verbatim in `meta.frontmatter`). Drafts become `draft` and published pieces
   `published`, the folder deciding the stage. `published_at` comes from the
   frontmatter (`publicado` / `published_at` / `fecha`), else the
   `YYYY-MM-DD-` prefix of the file name; with neither, the piece is skipped
   and reported (no date is invented). Folder readmes and non-`.md` files are
   reported in `skipped`. Slugs are slugified file names (`idea-<text>` for
   ideas), de-duplicated with `-2`, `-3`. A recipe's `source.image_hosts` is
   reported as a rule proposal and never created: rules are owner decisions.
   Flat `carousels/*.json` are recipe inputs and wait for S7b2 with the runs.
   Idea slug suffixes follow processing order (files sorted, lines top to
   bottom), so inserting an earlier duplicate renumbers later ones. Carousel
   history is "oldest first" only for the first import; snapshots that appear
   later are appended after the revisions already stored.
   A hash is written only by the last revisioned write of an item, so an
   interrupted pass re-runs as `updated`. Carousel snapshot steps carry their
   own snapshot hash; only the current-document save before a status move (or a
   fresh create) carries `<hash>:doc`.

   **Owner guard (owner decision).** `import` and `cutover` refuse any brand
   whose slug does not match `^example(-[a-z0-9-]+)?$` (the tracked
   `profiles/example*`), `--dry-run` included, before any database connection
   or folder read. The only way past it is two parts that must both name that
   exact slug: `BRAND_OWNER_OPT_IN=<slug>` in the environment and
   `--owner-opt-in <slug>` on the command line (one brand per run; a wildcard
   never matches). A folder is judged by its own name and, when it exists,
   by its real name, so a symlink called `example-x` that points at a real
   brand is refused too. Only the owner sets it, by hand, per brand, after approving
   that brand's source; agents and automation never do. This is a speed bump
   against mistakes, not a security boundary: anyone who can run the CLI can
   set an env var.

   *As built in S7b2a:* the S7b1b review follow-ups, then `assets/**`.
   A refused or raced item is reported in `ImportReport.conflicts` (one
   `<key> (<reason>)` per conflict, printed as "Conflictos:"), no longer in
   `skipped`; a row created between classify and write is a conflict, not an
   abort. A published piece's date key is `publicado`, `published_at`,
   `publishedAt` or `fecha`. Carousel writes were simplified: a new carousel
   is created straight in its status, and when only chat follows the create a
   same-status status write closes the pass instead of saving the document a
   second time. The importer takes an optional `BlobStore` (the CLI builds it
   from the editor's `S3_*` variables; tests inject a fake). **Assets mapping
   (neutral, no owner decision needed):** the folder library's own scan rules
   are replayed, because `index.json` is a cache: every non-`.json` file is
   one asset keyed by the first 16 hex of its sha256; `generated/` means
   origin `ai`, status `candidate` and the `generated/<id>.json` sidecar goes
   to `generation`; `references/` means origin `reference`, status
   `candidate`; fonts take their family from `<name>.meta.json` or the file
   name; `meta/<id>.json` (the user's choice) overrides kind, tags and status;
   mime comes from the bytes (PNG / JPEG / WebP) then the extension; width and
   height are borrowed from `index.json` when it has them, else null (the
   importer does not parse image headers). Because the cache is rewritten by
   the editor, they are best-effort: filled only when the asset is registered
   and never compared afterwards (not in the item hash, the update check or
   `verifyBrand`), so cache drift is neither a conflict nor a dirty
   verification; a malformed or wrongly-shaped `index.json` is ignored and
   reported. `origin` and `mime` are fixed at registration too: moving an
   imported file into `references/` or `generated/`, or renaming its
   extension, is a conflict by design. Same bytes at two paths are one
   asset (first path in sorted order wins, the other is reported); a stray
   `.json` is reported. Blobs go through `putBlob`, then `assets.register`;
   a changed sidecar later `update`s kind, tags, status and family. Without a
   blob store the whole `assets/` area is reported in `skipped` and nothing is
   imported. `verifyBrand` re-downloads each asset blob and compares its
   sha256 (`<key> (blob)` when missing or different), and `cutover` passes the
   store to it.

   *As built in S7b2b1:* runs. `core/narration` holds the narration hash and
   the voice merge, and `system/ig-reel/storyboard.ts` re-exports them. A run
   is one item keyed by its source path (`run:<path>`) and found again by the
   `input._imported.from` it carries, so a re-import saves the same run instead
   of creating another; its `audio` artifacts are part of what is compared, so
   verification re-reads them and re-downloads their blobs. A card's audio is
   skipped (reported, kept as a plain file) when the recipe has no voice or the
   hash recomputed from the recipe voice and the storyboard override differs
   from the sidecar's; a narration edited after synthesis therefore stops being
   imported as that card's current audio. For a card already imported that
   leaves the plan this way (or whose mp3 is removed), nothing is deleted: the
   next import drops the slot from `_imported.artifacts` and reports it, the
   old take stays in the artifact history, and the run is compared only over
   the slots it claims, so the import after that is a no-op. The audio of a folder without a blob
   store is reported like assets.

   *As built in S7b2b2:* legacy. Everything no collector used is a legacy file,
   but only known content: the `notImported` entries and the paths of `skipped`
   entries (their reason stays, and an unreadable file inside is reported too),
   written with `putBlob`. The pass is an ALLOWLIST (`allowlist.ts`): png, jpg,
   jpeg, webp, gif, svg, mp4, mov, webm, mp3, wav, m4a, pdf, ttf, otf, woff,
   woff2, json, yaml, yml, md, txt. Nothing outside it, and nothing that looks
   like a secret, is ever read into a blob, and the refusals come in two
   classes. *Proven secrets* are dotfiles and `.git` at any depth,
   `node_modules`, keys and certificates (`*.pem`, `*.key`, `*.p12`,
   `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`), a nested `config.local.*`, and text
   with a precise secret signature in its content (PEM/PGP private key,
   credentials inside a URL, AKIA..., gh*_..., sk-..., xox*...): listed in `ImportReport.refused`
   ("Rechazados, nunca importados"), deliberate like the top-level
   `config.local.yaml`, and they never count as left behind. *Guesses* are
   unknown types (html, css, csv, srt, psd, zip, scripts...) and names with
   credential, secret, password, api key or the whole word `token`
   (`deploy-token.txt`; `tokens.json` and `design-tokens/` are brand tokens and
   are not flagged), dot-directories other than `.git` (e.g. `.archive/`) and
   text with a generic `key: value` assignment (`password: ...`; a token JSON
   such as `{"accentToken": "var(--brand-accent)"}` matches it and is brand
   content): they may be real brand content, so they are listed in
   `ImportReport.unimported` ("Sin importar") and are left-behind data that
   blocks a cutover without `--partial`. The commit gate holds no secret
   patterns (it checks brand literals), so `allowlist.ts` is their one home.
   A link or other non-file is reported as `(not a regular file)` whatever its
   name, so it blocks too. "No longer in the source" is a `notices` entry, never
   blocking. The manifest is `import_runs.report.legacy`, and a re-run lists the
   paths new or different since the latest manifest. Machine-local config and the
   cutover marker are never kept. A cutover does not count an entry whose file is
   kept as left behind; unreadable data (a symlink, a path leaving the folder)
   and the guesses block it without `--partial`. `verifyBrand` re-downloads the
   legacy blobs too (`legacy:<path> (blob)`).

   *Built in S7b2b3a:* the outputs root (resolved like the engine does:
   `BRAND_OUTPUTS_ROOT/<slug>`, else `outputs.base_dir` from `config.local.yaml`
   over `config.yaml`; read as a second root, confined to its real path, with
   `@outputs/<path>` legacy paths) and clips as `clip` artifacts of the matching
   storyboard card, accepted only under the name `clipFileName` gives (shared with
   the engine; zero-padded from 11 cards), with `inputs_hash = import:sha256:<mp4 sha>`. Whatever no collector
   claims in the second root goes through the same allowlist and two-class
   refusal policy as the folder (labelled `@outputs/<path>`), and the CLI prints
   the resolved path. The content signatures also cover Stripe live keys, Google
   API keys and JWTs, and text with NUL bytes or a UTF-16 BOM is a guess
   (`unknown`), since a UTF-8 decode cannot see secrets in it.

   *Built in S7b2b3b:* editor exports (`<outputs.editor>/<slug>/v<N>/` with a
   `manifest.json`) as `exports` rows plus keys under the carousel export key,
   taken in numeric `v<N>` order (`v2` before `v10`), never rewritten (a
   different stored version is a conflict); a released run take is remembered in
   `_imported.released`, and a run written under the old `_imported.audio` key
   still claims its slots; an outputs root that is the home directory, holds it,
   holds the profiles folder or holds another brand's folder is unusable; a config file
   that cannot be read leaves the root unknown and blocks a cutover; an
   interrupted export is completed by the next pass and a changed export file is
   a conflict; the
   legacy pass and the run artifacts hold only hashes and read each file again
   when it is uploaded.

   *Built in S7b2b3c:* an export marked `done` means the allowlisted subset of
   its folder was stored; refused and unknown files stay with the legacy pass. A
   conflict on a lower version never lets a higher one take its number: a gap
   number that becomes an export in the folder stays reserved for it (a version
   without a usable manifest is not one), any other gap number is failed; an
   older reserved row below the written version that the folder lacks is failed,
   a fresh one is left alone (it may be a concurrent writer's). Before cutover the
   import is the only writer of a brand's exports to storage, so a `running` row
   at its own number counts as its own interrupted reservation and is resumed; a
   fresh row the import did not create becoming a conflict is a follow-up. An import pass never marks other reserved exports stale,
   so a resumable export is not turned into `failed` by it (a row the editor's
   30-minute sweep already failed cannot be completed again and stays a
   conflict). A reservation that lands above the wanted number is failed
   before the conflict is reported, so no `running` row is orphaned. Objects
   stored under an export's prefix that the folder does not have are reported as
   a notice, never deleted (objects under the number of a failed gap are not looked at). An outputs root inside another brand's folder (one
   holding `brand.json`, `brand.yaml` or `profile.md`) is unusable, and a config
   file that cannot be read is told apart from one that cannot be parsed.

   **S7b2 (design only; split in two).** Seam: S7b1 is everything that lands in
   Postgres rows alone; S7b2 is everything that needs blobs. S7b2a (above)
   is the follow-ups plus assets. S7b2b is the rest; its open questions were
   settled as technical decisions (§14, Q-S7b2b) and it is built as S7b2b1 (runs
   and TTS) and S7b2b2 (legacy); S7b2b3a adds the second outputs root and clips, S7b2b3b exports and hardening. Together they add flat `carousels/*.json` and
   `reels/**/week-input.json` + `storyboard.yaml` as `recipe_runs`, TTS mp3 +
   sidecars and existing clips as blobs with `tts_cache` / `run_artifacts`,
   `outputs/**` as `exports` + export keys, and every other file as a
   content-keyed blob listed in the report. Its
   verification pass re-downloads each blob and compares sha256 (the row-level
   pass already exists). After it, the examples cut over without `--partial`.
5. S12 removes the folder path and the resolver once every real brand is cut
   over.

## 11. Local dev

`docker-compose.storage.yml` gains a `postgres` service next to RustFS:

```yaml
  postgres:
    image: postgres:17
    ports: ["127.0.0.1:${POSTGRES_PORT:-5442}:5432"]   # loopback only; 5442 avoids 5432/5433/5440, which other local Postgres instances use
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: local-dev-only
      POSTGRES_DB: brands
    volumes: [postgres-data:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "postgres", "-d", "brands"], interval: 3s, retries: 20 }
```

The compose init SQL (provisioning, not a migration) creates the five roles (§4) with local passwords.

```
DATABASE_URL=postgres://brand_app:...@localhost:5442/brands
DATABASE_MIGRATOR_URL=postgres://brand_migrator:...@localhost:5442/brands
DATABASE_PREPARE=true
S3_ENDPOINT=http://localhost:9000  S3_BUCKET=brand-profiles  S3_ACCESS_KEY_ID=...  S3_SECRET_ACCESS_KEY=...
BLOB_CACHE_DIR=~/.cache/personal-brand/blobs   # optional
```

**Tests** (same `tsx` file-per-suite style):

- Unit: memory repos + `FakeBlobStore`, keys, cache, check runner, CLI via
  `runCli(argv, env)`, runner CRLF checksum and `CONCURRENTLY` rejection.
- **Contract suites** run the same assertions on memory and Postgres.
- Integration SKIPs (exit 0) without a reachable `DATABASE_URL`, like the S3
  test; each run migrates and drops its own `test_<random>` schema; two
  concurrent runners on one schema apply each file once.

## 12. Hosting Postgres (owner decides; nothing provisioned)

Hard requirement whatever the host: PITR or daily dumps stored outside the
brand bucket, proven by a recorded restore drill before the first real
import. Options: **Railway** (same platform as a Railway bucket/editor,
private networking; backups/plan on us), **Neon** (PITR, branching per
PR/test, scale-to-zero; cold starts, pooler needs `prepare: false`),
**Supabase** (PITR on paid plans; much we would not use, free tier pauses),
**self-host on the existing VPS** (cheapest; backups, upgrades, TLS on us).

## 13. Slice plan (chained PRs, each < 600 lines incl. tests)

| # | Scope | Est. | Depends on | Done when |
|---|---|---|---|---|
| **S1** | **Foundation:** `storage/` package; contracts (`BlobStore`, brand/document/revision repository interfaces, errors, `WriteMeta`, keys); runner (reserved connection, per-schema lock, re-check, CRLF, `CONCURRENTLY` rejection); `postgres` connection; `0001_foundation.sql` (`brands`, `brand_documents`, `revisions` + trigger, guarded GRANTs to existing roles); compose service + role-creating init SQL; ARQUITECTURA/CLAUDE.md module-rule rewrite (§3c); tests | ~560 | — | migrations apply twice cleanly against docker, concurrent runners apply once; tests green or SKIP; no runtime behavior changes |
| S2 | Move `ObjectStore`/S3/fake into the package as `BlobStore` (editor re-imports, unchanged); `putBlob`; `BlobCache` | ~450 | S1 | editor suite green; cache tests |
| S3 | Postgres + memory repos for brands, documents (incl. templates), revisions; revision policy; contract suite | ~550 | S1 | contract suite passes on both |
| S4 | `0002`: rules, guidance, recipes + repos; check runner and `validateRuleParams` in `core/` | ~590 | S3 | §9 examples produce expected findings; contract suite |
| S5 | `0003`: assets, `tts_cache` + repos; `system/assets/index.ts` on `AssetRepository` + blobs (no `index.json`/sidecars); `fetch-fonts.ts` uploads fonts as assets | ~580 | S2, S3 | asset library tests run on memory storage, no profile dir |
| S6a | `0004`: carousels (status stripped), exports (`started_at`, stale reclaim), chat + repos | ~580 | S4, S5 | concurrent reserve/append tests |
| S6b | `0005`: `content_items` (stage/channel/format columns, opaque `meta`) + repo with one shared stage-transition rule | ~560 | S6a | contract suite on both implementations; transitions and grants checked |
| S6c | `0006`: `recipe_runs`, `run_artifacts` + repos | ~400 | S6b | concurrent run/artifact tests |
| S6d | `system/assets/usage.ts` and `verify-slides.ts` read via storage/injected policy | ~300 | S6c | usage/verify tests on memory storage |
| S7a | CLI skeleton (bin, `runCli`, strict per-verb flag parser from #116) + `import` verb with the backup gate; importer part 1: documents, guidance, recipes, dry-run, report, `import_runs` (record only) | ~520 | S3, S4 | example brands import, re-run is a no-op, conflicts are reported and never overwritten |
| S7a2 | `cutover` verb + `.storage-cutover` marker + `markCutover`; `resolveBrandSource`; `resolveProfileDir` refusal; `verifyBrand` (re-read and compare); `--partial` guard | ~480 | S7a | cutover writes marker + `cutover_at`, legacy readers refuse it |
| S7b1 | Owner guard for non-example brands (`import`/`cutover`, dry run included); S7a2 review follow-ups (`--partial` re-check, marker validation, readability); `import_runs.list` | ~240 | S7a2 | non-example brands are refused before any DB or folder access; runs read back newest first |
| S7b1b | Importer part 2a: templates, rule proposals (reported), carousels + revisions + chat, ideas/drafts/published -> `content_items`, with tests on a temp example copy | ~460 | S7b1, S6a, S6b | examples import, read back clean and re-import as a no-op |
| S7b2a | S7b1b review follow-ups (`conflicts` reasons, create-race, simpler carousel writes, shared frontmatter split, plural refusal, deferred tests) + importer part 2b-1: `assets/**` + sidecars -> blobs + `assets` rows, `BlobStore` wiring in the CLI, blob-level verification of assets | ~560 | S7b1b, S5 | example assets import, verify re-downloads each blob, an example without reels cuts over with no `--partial` |
| S7b2b1 | Importer part 2b-2a: `narrationCacheKey` and the voice merge move into `core/` (shared with the engine, not copied); flat `carousels/*.json` and `reels/**` -> `recipe_runs` (recipe and period derived and recorded); TTS cache -> blobs + `tts_cache` + `audio` artifacts | ~560 | S7b2a, S6c | examples import their runs, read back clean, re-import as a no-op; a card whose hash cannot be recomputed is reported, not imported |
| S7b2b2 | Importer part 2b-2b: everything no collector imported -> content-keyed legacy blobs with a path -> sha256 manifest in the import report, behind an allowlist and a two-class refusal policy (proven secrets never block a cutover; unknown types and suspicious names do, without `--partial`); a card that leaves a run's plan is released, never deleted; blob verification for the legacy blobs | ~590 | S7b2b1 | verification clean on examples; a `.env` does not block a cutover, a `.html` or `deploy-token.txt` does; `tokens.json` is kept |
| S7b2b3a | Importer part 2b-2c: second root for `outputs.base_dir` (`BRAND_OUTPUTS_ROOT`, confined reads, `@outputs/` legacy paths, the outputs path in the report); reel clips -> `clip` artifacts (names from the shared `core/clips` `clipFileName`, as the engine writes them); the second root goes through the same allowlist and refusals; wider secret signatures, NUL/UTF-16 text is `unknown` | ~550 | S7b2b2 | clips import and verify; the second root is read confined, with its refusals reported and tested |
| S7b2b3b | Importer part 2b-2d: editor exports -> `exports` rows + keys (numeric `v<N>` order) and the hardening deferred from the S7b2b2 review (§14, Q-S7b2b3; prepared as a patch on top of S7b2b3a) | ~200 | S7b2b3a | exports import and verify; every item of §14 Q-S7b2b3 has a test |
| S8a | CLI verbs part 1 (`storage/src/cli/verbs.ts`): `list`, `create`, `archive`/`unarchive`, `show` (+ guidance `--since`), `doc`/`guidance`/`recipe` get and put (`--if-version`), `rules list`, `check`; guidance trust envelope; exit codes 3/4/5/6; `purge` refusals only (confirmation, archived brand, bundle outside the repo, `brand_purger` URL) | ~560 | S7b2b3b | exit codes; `purge` refuses by default and deletes nothing; `check` exits 5 on an error finding |
| S8b1 | CLI hardening: D13 write permissions (`IDENTITY_KINDS`, owner guard by write class); import/cutover exit codes (6 for refusals, 3 for import conflicts) and named exit constants; S8a follow-ups: `--since` UTC, trust headers, marker escaping, 1 MB `--file` cap, slug format before the owner guard, dangling-symlink `--bundle`, explicit `rules` dispatch | ~560 | S8a | each rule has an exit-code test; identity writes need the opt-in, and the owner check is unconditional for every write (the content exemption ships in S8b2) |
| S8b2 | D13 content exemption (`cutoverAt` lookup in `runCli`), subcommands validated before the guard, CLI verbs part 2: `asset list`/`add`/`get`, `carousel list`/`get`/`put`/`status`; `RecipeRepository.list` (so `show` lists recipes); `revisions.listSince` (avoids N+1 in `show --since`); `--file` read through one descriptor | ~600 | S8b1 | each verb has an exit-code test. Carousel and asset writes are content, tested end to end with `runCli`: on a real brand a content write succeeds without opt-in once cut over, is refused (6) before cutover, and is refused (6) on a remote `DATABASE_URL`; identity writes on a cut-over brand without opt-in exit 6 |
| S8b3a | S8b2 follow-ups: write-verb `--json` trust, `rules add`/`update`/`disable` (deferred from S8b2; disabling a disabled rule is a no-op), binary scan (fixed-prefix tokens only, over latin1, a hit is `unknown`, in `asset add` and the importer), docker `"auth"` base64 pattern, SVG allowlist-style screen, `asset add` look-judge-read-recheck (dev/ino, real path, hard links), HOME-inside-a-dot-directory, `nameRefusal` on the `--out` segments, `asset get --out` temp-file cleanup and a real `wx` collision test, `asset add` retry after a failed register, Postgres `listSince` at millisecond resolution | ~600 | S8b2 | each hardening item has a test; memory and Postgres agree on the `listSince` cursor |
| S8b3b1 | S8b3a follow-ups and `export pull`: `rules` rejects an unknown subcommand before any branch; a typed `Refusal.code` replaces the English-text comparison in `asset get --out`; one shared SVG re-export hint; the cutover report names the fail-closed SVG screen; recorded content-scan length bounds (JWT payload `{8,12000}`, `"auth"` `{12,16384}`, URL password 1024) with a wider binary window; SVG CSS function names with digits, 3d transforms, shapes and modern colours; relative-timing asserts; `export pull` | ~590 | S8b3a | each item has a test; `export pull` never overwrites and refuses unsafe names and destinations |
| S8b3b2 | S8b3b1 follow-ups (`export pull` rolls back exactly what it linked, quotes the bucket key it refuses, refuses an `--out` that is a file, fetches and writes one file at a time); the repository-level archived check (`BrandArchivedError`: carousel create/save/status and asset register, atomic in memory and Postgres); the `purge` executor as `brand_purger` (bundle written and read back, then FK-order delete under `SET LOCAL app.purge_brand`; host gate on `DATABASE_PURGE_URL` and `current_user = brand_purger`) | ~590 | S8b3b1 | purge deletes only an archived brand and leaves other brands and the bucket untouched; a content write on an archived brand is refused by the repository itself for carousel create/save/status and asset register |
| S8b3b3 | `fonts fetch` (replaces `system/assets/fetch-fonts.ts`, which S12 deletes; its own policy: the stylesheet URL is the tokens' `googleFontsHref`, an allowed-host list, no redirects off it, size caps, fonts registered as `candidate` assets) | ~300 | S8b3b2 | fonts land as assets without touching a profile folder; a stylesheet or font URL off the allowed hosts is refused. Delivered with it: `BrandArchivedError` on chat append, exports (reserve and complete), content items, recipe runs and artifacts, the TTS cache and `assets.update`, atomic in memory and Postgres (brand `FOR SHARE` first), with a contract test, before S9/S10a; purge errors 40001, 40P01, 23503 and 23001 exit 6 with a retry message that names the bundle left behind, and every failure after the link names it; a null check in `writeCarousel` for a brand row that vanished (`NotFoundError`); the purge database identity check also compares `inet_server_addr` and `pg_postmaster_start_time`; the bundle file is unlinked and its folders removed when its read-back fails, with a rollback test; a `now` hook for the bundle timestamp and a refused (never overwritten) name collision |
| S8c | `restore_drills` migration + `backup drill` (**`pg_dump` + restore drill tested**) + the import backup gate (refuses without a recent verified drill); legacy-bucket import source (`--from legacy-bucket:<slug>`); `init-profile.mjs` redirects to `brand create` | ~590 | S8b3b3 | gate refuses a remote write without a recent verified drill; a legacy bucket imports like a folder. Owner decision (S8c1): fonts fetched by `fonts fetch` keep `origin: manual`. S8c1 built the drill, the gate and the S8b3b3 follow-ups; S8c2 built the legacy-bucket source and turned `init-profile.mjs` into a pointer to `brand create` (it writes nothing). S8c1 deferred: a content hash per table in the drill, next to the row counts. S8c3 takes (deferred from S8c1 review and S8c2 review): drill clients ignore `DATABASE_PREPARE`, and the drill needs a direct URL, not a pooler (W8); an orphan sweep of `drill_[0-9a-f]{12}` databases owned by `current_user` at drill start (W9); compute the gate age server-side, `now() - recorded_at` (W10); Spanish status mapping in the leak message, and show the failure reason too (S6); the orphan sweep without FORCE, skipping databases with open connections; refuse a negative `ageMs` and grant INSERT on `restore_drills` by column in a new migration 0009 (`recorded_at` cannot be set); the S8c1 native advisories (pipe-stall kill, setup failure not recorded, outcome kept when recording fails, redacted stderr, typed code map, memory `latest()` scope, real `counts_differ`/`no_tables` tests, self-attested gate note, asset type check before the read); S8c3 review fixes: the signal handler always exits, the sweep takes only databases carrying the drill comment and the drill holds a connection to its scratch (a tiny window remains against a drill with another admin URL), a failing temp removal reports the path. S8c4 (done): the AbortError timeout line (S3), pg_dump/pg_restore resolved before the lock (S4), a rolling stderr tail (S1), the S7 test comment, the sweep binds `DRILL_COMMENT` (and the lock key has its own constant), the drill connections all go through `client()`, a documented gap (a process dying between `CREATE DATABASE` and `COMMENT ON DATABASE` leaks an unswept scratch database; drop it by hand), `finished_at` vs `recorded_at` documented as two hosts' clocks, exact scratch-drop and `age_ms` assertions, a deterministic 0009 grant test, and `legacyProfileBase` shared by the importer and the editor. S8c3 also takes the S8c2 warnings: SIGINT/SIGTERM remove the legacy-bucket temporary copy (handlers live only during the copy; exit 130/143); the size cap also counts bytes actually streamed; the importer receives the outputs label through `opts.outputsLabel` (W12) and the missing-outputs notice is suppressed by a flag to `resolveOutputs` instead of a string match (W11); a typed source (`folder | legacy`) replaces the empty-string `from`; the owner guard was checked for the bucket source (the slug is the folder/legacy name, nothing in the files can declare another, so a mismatch cannot happen; a test pins it); the temporary root is `LEGACY_BUCKET_TMPDIR` (tests scan only theirs); `S3_PREFIX` is joined exactly like the editor does (`<prefix><slug>/`, as typed), with a Spanish notice when it lacks the trailing `/`; follow-up: one shared `legacyProfileBase(prefix, slug)` in `storage/src/contracts/keys.ts`, used by both the editor and the importer; a cap under 1 MiB is shown in bytes/KB (S8); the cap refusal exits 6 (refused), not 1; `init-profile.mjs --help` exits 0 and a plain run exits 2 on purpose. S8b3b3 follow-ups (done in S8c1): a seam and a test for the 60 s run deadline of `fonts fetch`; `judged.set` keeps the first family for identical bytes; `--json` output lists the existing asset ids; a message for a partial registration (a failure mid-commit); move the file-type check of `asset add` into `judgeBytes`; unify the order of the archived check and the version check in `assets.update` (memory vs Postgres) |
| S9a1 | Carousel engine, brand data from storage: `RenderSource` (`render-source.ts`, picked by `resolveBrandSource`, one brand read; no `DATABASE_URL` = folder as before; a storage failure is an error, never the folder), `parseBrandTokens` (shared by `loadBrand`), `buildBrandStyle` + `loadStoredBrandStyle`, verify policy from the stored rules plus `source.image_hosts` of the stored recipe (no rule and no stored recipe = refused when a slide has an image, as for a folder); `render-week`/`render-brand`/`render.ts` run on a `RenderSource` (`--out` and `--input` required for a stored brand; `outputs.<key>` of the stored config is not read yet, the subfolder is the key; `render.ts` has no `--out` and writes the engine's own `output/` for a stored brand too; `@personal-brand/storage/import` is exported for tests of `system/` only, render code never imports brands) | ~540 | S6d, S7a2 | example brand renders from storage with no `profiles/` dir, to the same PNGs as its folder |
| S9a2 | Carousel engine, assets and templates from storage: `loadWithResolver(page, html, resolve)` in `render-batch.ts` (`http://render.local/assets/<assetId>` from asset row -> sha256 -> `BlobCache.read`; anything else on that origin, and any resolver failure, fails the render), the stored render context (asset URLs, font faces; a font with no family is refused; hidden assets unknown) for `renderCarouselDocument`; `resolveLayoutTemplate` + `loadStoredLayoutTemplate` (templates from `brand_documents`). `contrast.ts` already measures whatever page it is given. `text-raster.ts` is `editor/server` code and moves in S10b (only the chat write path uses it); S10a consumes `loadStoredBrandStyle`/`loadStoredLayoutTemplate` and adds the stored `listLayoutTemplates` (picker) | ~420 | S9a1, S6d | a carousel document with an image asset and a font renders from storage with no mirror and no `profiles/` dir |
| S9b1 | Reel engine, storage side (`system/ig-reel/stored-reel.ts`, not wired into the script yet): the stored `reel-week` recipe (`validateReelRecipe` split out of `loadReelRecipe`) and a run's input + storyboard from `recipe_runs` (a run of another recipe or brand is refused); narration looked up in `tts_cache` before `synthesiseCards`, new takes stored as blob + take + `audio` artifact; clips as blobs + `clip` artifacts (re-render appends, the old clip stays in history), `clipInputsHash`, the derived timeline as a `timeline` artifact; per-run scratch (`createRunScratch`: a unique dir, removes only itself) and clips staged from the blob cache by hardlink with a copy fallback, never overwriting; `exportStoredReel` writes the next free `exports/reels/<runId>/v<NNN>/reel.mp4` (`reelExportPrefix`, `putAt` exported) and verifies it by `head`. The reel export version is the next free number under the run's prefix, with no table (exports reference carousels only) | ~400 | S9a1 | two concurrent scratches never share a dir, and exports of different bytes never share a version (identical bytes may resolve to the same one); a failure on a later card keeps the earlier takes; re-render one card keeps the old clip; clips stage from the cache with no render dir |
| S9b2 | Reel script on a `ReelStorage`: `render-reel-week.ts` picks folder or storage with the one `resolveBrandSource` switch (folder brands run the unchanged path); a stored brand takes `--run <runId>`, reads recipe, input and storyboard from storage, stages item images and fonts from the asset library into a per-run Remotion public dir (`--public-dir`, inside the run's temp work dir), renders clips into that work dir (recorded as artifacts as they finish), `--assemble` and `--card` stage from the cache, and the final MP4 goes to the export key (optional `--out` copy); README | ~350 | S9b1 | assemble-only works from the cache with no output dir; a folder brand renders as before |
| S10a | Editor read path on repositories, `ETag` | ~580 | S9a2 | editor suite green on memory storage |
| S10a note | While `DATABASE_URL` is set, folder brands also depend on the database for the cut-over lookup: a storage failure answers 503 (logged), never a folder fallback (D12). An archived cut-over brand is still served as stored (and gated); its folder twin stays hidden. **Owner decision 2026-10-25 supersedes the earlier "archived brands are not listed" default:** archived cut-over brands appear in the picker, in a collapsed secondary "Archivadas" group at the end, and open read-only (writes are refused with a Spanish message). Decided in S10c: `GET /api/profiles` marks an archived cut-over brand with `archived: true` and lists the archived ones after all the others (each group sorted by slug); the picker renders them in a `<details>` group "Archivadas", collapsed by default, with a read-only hint. Opening one shows a Spanish banner ("Marca archivada: solo lectura") and, in the editor, every document write is a no-op (one `edit` wrapper over `update`: add text, add/delete slide, delete object including the Delete/Backspace shortcut, canvas drags and the properties panel), while the controls that write are disabled: add text, delete, export, the regenerate-unpinned trigger, the asset upload, "Crear carrusel" (brand home and carousel list), and in the chat the input, send, apply and discard. The UI stays editable until the lookup confirms `archived === true` (waiting would silently drop first edits on every brand; the server stays the authority with its 403 meanwhile, and a failed lookup reads as not archived). Undo/redo are left alone (nothing to undo). Not locked: asset metadata patches in the library (the server refuses them). The web learns the flag from the profile listing (`useArchivedBrand`). Follow-up: it reads the whole `/api/profiles` listing (cards included) just for one flag; a slug-scoped endpoint would be cheaper. Folder twins stay hidden and the guard still treats the brand as stored. | | | |
| S10b | Editor write path: save (`If-Match`), export, chat, compose; 409 with current version; `text-raster.ts` moves here; save takes `status` from the row column (the stored document never carries it) | ~580 | S10a | concurrent-save tests; exports land in bucket |
| S10b notes | Behaviour decided in S10b1 (save): `PUT /carousels/:id` for a stored brand requires `If-Match: "<version>"` (the ETag S10a serves); missing is 428, malformed (`*`, unquoted, list) is 400. The repository's `expectedVersion` makes the write atomic; a stale or lost race is 409 with `{error, currentVersion, document}` and the winner's `ETag`. The client's `status` is ignored (validated with the row's, never written): a `scheduled` carousel stays `scheduled` and is answered as `exported`. The folder's `base=<updatedAt>` check does not apply (the version replaces it). A save records revision reason `structural` (slide count/kinds or template changed), `snapshot` (`?snapshot=true`) or `save`. An unknown carousel is 404 (creating one arrives with compose); an archived brand is 403 with a Spanish message. `EditorStorage` is async-only; `guardStorage` passes domain errors (not found, version conflict, invalid input, archived) through and turns everything else, a throwing validator on a corrupt row included, into a `StorageFailure` (503) on every route. The 200 body carries the document as validated; the response `ETag` (the row version) is the authority for the next `If-Match`, the row `updatedAt` is not returned. Domain errors that reach `handleStoreError` map to 409 (version conflict), 400 (invalid input), 403 (archived). Decided in S10b2: `If-Match` compares strongly, so a weak `W/"n"` is malformed (400). The save refuses in this order: URL id (400), body id (400), archived brand (403), header (428/400), version (409); an archived brand is 403 whatever the header says. A `VersionConflictError` that reaches `handleStoreError` carries its version as body and `ETag` (no document: only the save route has the carousel at hand). Web: `client.ts` keeps the last `ETag` per `slug/id` (from GET and from every successful save; a 409's tag is never adopted, so a following autosave or keepalive still names the copy it edited and cannot overwrite the winner, and the reload GET brings the new tag), sends it as `If-Match` (pagehide/unmount saves too; one fired during an in-flight save can 409 silently on unload: nothing is overwritten but those last edits are lost), drops it when a response has none (folder brands send no header); a 409 or a 428 reloads the stored copy (which brings the tag) with a Spanish message. Export of a stored carousel (`stored-export.ts`): the guard lets `POST .../export`, `GET .../export/:jobId` and `GET .../outputs` through; the job joins the folder queue; it reserves `exports.reserveNextVersion(rowId, carouselVersion)`, renders from storage into a scratch dir (removed afterwards), writes the PNGs and `manifest.json` write-once at `carouselExportKey`, completes the row, then moves the `candidate` assets the document uses to `approved` and sets `draft` to `exported` conditional on the exported carousel version (a save that landed meanwhile fails the job after the export is complete, like the folder's revision check); a failed render marks the row `failed` and writes no manifest; an archived brand is 403. `outputs` lists the `done` exports. Export details: the job id is a random UUID; a post-complete step failure (an asset approval or the status flip) leaves the export `done` and reports its `version` with the error, so approvals can be partial; a flip refused only because an earlier queued export already flipped the draft is not an error; a failed export leaves its PNGs in the bucket and a version gap (keys are write-once and versions are never reused, so nothing collides; cleanup is a later ticket); the stored manifest is thinner than the folder's (`assets` are bare ids, no `fonts`, no `engine.templateHash`/`gitSha`) and carries `files` and `carouselVersion` instead. Storage failures on export and outputs answer 503. Decided in S10b3: the export job closes its reserved row as failed only if it had not completed (a failure after `complete` keeps it `done`) and logs a `fail` that does not stick; `queueExportJob` is the one place a job's error is recorded; asset approval retries once on a version conflict with a fresh read and is audited as reason `status` by author `editor:export` (the revision reasons are a closed set in a migration CHECK, so no `export` reason); the pending-pieces 409 is mapped once. `GET .../versions` lists the `snapshot` and `structural` revisions, newest first, stamped like the folder's version files (`:` and `.` as `-`); the meaning differs: a folder file is the document BEFORE the save, a revision is the document AFTER it, so the stamp marks the save that made the snapshot. `POST /carousels` for a stored brand creates a blank (or template) carousel row (create-on-save, `expectedVersion: null`, `ETag` returned and remembered by the web client for the first save); a prompt, `preview: true` or `?mode=plan` is 501 (never silently ignored as in the folder). `handleStoreError` lives in `routes/store-errors.ts`. Decided in S10b4: `RevisionRepository.listHeads(entityType, entityId, reasons?)` lists revisions without bodies (oldest first, optional reason filter) and `/versions` uses it. `AlreadyExistsError` is a `VersionConflictError`, so `guardStorage` already passes it through: a duplicate create is a 409 with the "already exists" message (now asserted); a non-string `title`, `templateId` or `id` is a 400 (folder create too). A stored save approves every `candidate` asset the saved document pins (background in `asset` mode, or an `asset` object, with `pinned`), audited as reason `status` by author `editor`; unlike the folder it considers all pinned pieces, not only newly pinned ones, because approving is idempotent and a failure after the committed save is logged (the save still answers 200) and retried by the next save. The approve helper (`stored-assets.ts`) is shared with the export; a save reads each pinned asset by id (never lists the library), and one failing asset does not stop the others: failures are collected and thrown together (a partial approval, logged on save, reported by the export). `GET .../stats` for a stored brand returns this carousel's library ratio and the other carousels' history from their raw documents (an invalid current document is 400). `POST .../regenerate` for a stored brand serves only the final-prompt preview (allowed for an archived brand too, since it writes nothing; a generating regenerate is 501 whatever the brand state) (`preview: true` or `?dryRun=true`; same prompt as the folder, from the stored style; no model call, no write); a generating regenerate is 501. Compose was not ported beyond that in S10b4: the planner took a `ProfileStore`. Decided in S10b5: the planner depends on a `PlannerSource` (`compose/planner.ts`: `assets()`, `style()`, `language()`, `storeImage()`, `costCents()`), which `folderPlannerSource(store)` and `storedPlannerSource(s)` (`stored-compose.ts`) both satisfy, so `buildCompositionPlan`, `applyCompositionPlan`, `generateForSlot` and the regenerate functions are one code path for both; the planner functions are async now. Stored `POST /carousels?mode=plan` (or `preview: true`) answers like the folder's (201, same body; checks in the same order, with type checks on `id`, `templateId` and `assetIds`) and keeps the plan in the same in-memory map; a `prompt` without a preview stays 501. `plan/apply` for a stored brand persists after the copy and after each generated slot (`persistStoredDocument`): the first write creates the row (or saves over the current version), each later write names the previous write's version, so a save that lands meanwhile fails the apply (answered 202 with the partial document, the plan stays pending). A generated image is registered through the storage asset library (blob in the bucket, then the row) as origin `ai`, status `candidate`, with the former sidecar (prompt, model, cost, carousel id, slot, reference ids) as the row's `generation`; its cost is read back from that row. A generating `regenerate` for a stored brand reads the row, refuses an archived brand (403) and pinned pieces (400), and saves at the version it read with reason `snapshot` (a revision holds the document AFTER the save, so the write is the snapshot of a multi-piece replacement), answering the new `ETag`; a non-string `prompt` is 400 for a stored brand (the folder still ignores it). `guardStorage` is method-aware for the bucket: `PreconditionFailedError` passes only from `files.put` and `ObjectNotFoundError` only from `files.head`, the two answers `putBlob` branches on (the same bytes stored twice; a key not visible yet), not outages; before this a re-registered identical image answered 503. In `plan/apply` only provider failures and version conflicts are a 202; a storage outage (503) or an archived brand (403) is the route's error and the plan stays pending. In the stats history, a sibling that vanished is skipped and a missing `updatedAt` falls back to the row's, but any other error on one sibling fails the whole request (503), because a smaller history would pass off an outage as data. Decided in S10b6: the stored copy language is the stored `config` document's `profile.primary_language` (trimmed; none when there is no config or no language), tested through what `draftCopy` receives. A pending plan is `{ plan, inFlight, resume? }`: the first write of `plan/apply` stores `{ document, token }` in `resume` (and every generated slot's write updates it), and a retry resumes from that document and token instead of rebuilding, so it skips the slots already generated (checked on the persisted document, not a fresh one; a slot whose image was paid for but whose write then failed, e.g. a storage outage, is generated again on the retry) and names the version it wrote last (stored `If-Match` semantics; folder expected revision). A save that lands meanwhile therefore fails the next write: the answer is 202 with the partial document, the user's version stays on the row (or file), and the plan is dropped because its token is stale for good (a retry is then 404; re-plan under a new id). The first write of an apply (stored and folder) is create-only (`expectedVersion: null` / `create: true`): a carousel that appeared since the preview is a 409 (`carouselExists`), is left untouched and drops the plan. Every 202 and that 409 carry `planDropped` (true when the plan can no longer be retried). Pending plans carry a creation time and any new plan sweeps those older than an hour, never one whose apply is running; the template is not reloaded on a resume. A second `plan/apply` while one is running for the same plan is 409 (`planInFlight`), set before any await so two requests cannot both pay; a re-plan under the id of a running apply is also 409, and a finished apply forgets its plan by identity so a newer plan under the same id survives. A stored generating `regenerate` is implemented: it reads the row and version, refuses an archived brand (403), a pinned piece (400), an unusable target (400), a non-string `objectId` (400, before any write or generation) and a non-string prompt (400), generates a `candidate` asset through the storage library, and saves at the version it read with reason `snapshot` (a save that landed during generation is 409 and leaves the generated image as an orphan candidate), answering the new `ETag`; the folder and stored routes share `regenerateTarget`. A vanished asset's `costCents` is 0 for a stored brand too. Decided in S10b7a: chat goes through one port, `ChatSource` (`chat/chat-source.ts`: `read`, `append`, `currency`), with a folder implementation (`chat.jsonl`, `config.yaml`) and a stored one (`chat` repository, keyed by the carousel's row id; each body is the whole record, `id` and `at` included, exactly as the importer keeps a folder's lines; the stored `config` document's `currency`, stricter than the folder's rule: exactly 3 letters and a finite positive rate, else USD). `GET .../chat` and `POST .../chat/proposals/:id/discard` are one code path for both (the guard now lets them through for a stored brand; an unknown carousel is 404, an archived brand still shows its chat and refuses a discard with 403 from the repository, a storage failure is 503, a discard of a proposal that is not the pending one is 409). `EditorStorage` gains `chat: Pick<ChatRepository, "append" | "list">` (guarded like the rest). `text-raster.ts` stays in `editor/server` (its only consumer is the chat apply, so the engine never imports it) but no longer takes a `ProfileStore`: `chromiumRasteriser(brand, fonts)` takes `RasterFonts` (`fontFaces` plus an optional `resolve`) or a thunk returning one; `folderRasterFonts(store, brand)` is the folder's, and the port lets a stored brand pass its render context's `fontFaces` with a resolver, loaded through `loadStoredSlide`/`loadWithResolver` (the late check runs after fonts settle, so a refused font fails the raster; tested with a fake resolver), and S10b7b wired the stored fonts (`storedAssetResolver`). Advisories from S10b6: the plan TTL is measured from the plan's last activity (the preview, then the end of each apply), not its creation, so a partial apply that keeps its resume is not stranded an hour after the preview; the TTL is also enforced at apply time (an expired plan is a 404 even if no new plan swept it); `setPlanClock` is marked `@internal`. A folder `plan/apply` that generates (create-only first write, a 409 `carouselExists` that leaves the file and drops the plan, resume skipping the slots done, a save landing meanwhile as a 202 with `planDropped: true`) is now covered over HTTP (`compose-folder-apply.test.ts`, an example profile copy whose library leaves slots empty). Known and accepted, not changed: an ambiguous commit (a write commits but its acknowledgement is lost, e.g. a 503 after commit) ends the apply: if it was the create, the retry rebuilds and its create-only write meets its own row (409 `carouselExists`, plan dropped); if it was a slot write, the retry names the stale token (202, plan dropped). Nothing of the user's is at risk in either case and re-planning under a new id works; the apply cannot tell its own row from a foreign one without a marker on the row, which the schema does not have. Decided in S10b7b: stored chat is complete: `POST .../chat/messages`, `.../chat/references` and `.../chat/proposals/:id/apply` pass the guard (`STORED_WRITES`) and are one code path with the folder through `ChatWorkspace` (`chat/chat-workspace.ts`, which extends `ChatSource` with the document, the asset library and the fonts); `folderChatWorkspace` and `storedChatWorkspace` are its two implementations, `chatRouter(getGenerator, { rasteriserFor?, storage? })` takes an options object, and `buildChatContext` stays the folder's. The stored `ChatContext` is built async from the validated row document (an invalid one is a 400), its template (`storedTemplate`, free when it names none), the stored brand tokens, `assetKinds` from every asset row and a library of the `approved` image assets whose origin is not `reference`; a stored asset has no file name, so the model sees the virtual `<assetId>.<ext>` the asset routes serve (the importer keeps no original name; tags still describe it). A reference is a `candidate` asset of origin `reference` registered through the storage asset library (same bytes, same asset; an unsupported type is a 400), read back through the blob cache (`readStoredAsset`; a hidden or unknown asset is not there). The image provider reads reference images through the same reader (`AssetFileResolver` may now be async; `index.ts` resolves a stored brand's assets from storage, never a folder). `runProposal` reads the document and its `base` (folder revision, stored `{ rowId, version }`) once after generating, as the folder reads its revision, and writes at it with reason `snapshot` (the revision holds the document after the multi-piece change; a stored apply has no pre-write snapshot path, so its `done` event has no `documentVersion`): a save that landed during generation is built upon, not lost (actions are re-resolved on the fresh document), and only one between that read and the write fails the proposal, recorded as a `failed` event with the Spanish conflict message and the user's version left on the row. Generated and layout images go through `PlannerSource.storeImage` (origin `ai`, `candidate`, `generation` metadata, cost read back from the row). `storedRasterFonts(s)` (`text-raster.ts`) is the brand's font assets as `@font-face` rules plus `storedAssetResolver`; `chromiumRasteriser` takes `RasterFonts` or a thunk, now also async, called on each raster (the folder's stays lazy too), and the refused-font test asserts the resolver's own refusal. The folder's `syncUpNow` moved to `settle()` of the folder workspace; a stored apply has nothing to sync. An archived brand is 403 on a message and a reference before any model call (`assertWritable`); on an apply the 403 comes from the chat repository refusing the `started` append, before any generation, and an archived brand whose proposal is no longer pending gets 409; a storage failure is 503. S10b7c remainder (not done, held back by the slice's size cap): `await ws.assertWritable?.()` after `chatOf` in the apply route (patch `odd/status/patches/s10b7c-apply-assert-writable.patch`); known follow-ups: a stored apply records the post-apply state, so `/versions` cannot revert an AI apply (the folder snapshots before); a test for a save during generation being built upon (`seen.onImage` hook); the folder `settle` log lost the proposal id; some tests are order-dependent; and: a stored chat body is still cast to `ChatRecord` unchecked (a malformed body from a bad import surfaces as an unclassified 500); the decision is to treat a body that is not a record (no string `id`/`at`, an unknown role, a user/assistant without `text`, an event without `proposalId`/`kind`/`results`, a proposal without `id`/`actions`) as a corrupt row, i.e. a `StorageFailure` thrown by the source's `read`, so the log, a message, a discard and an apply answer 503 like a corrupt document (never served as data, never skipped: a skipped record could hide a pending proposal); the code and its test are in `odd/status/patches/s10b7c-stored-chat-corrupt-bodies.patch` (applies on top of S10b7b). Known and accepted: a discard reads the log, then appends, so two concurrent discards can both append a resolving record (the folder's is the same; harmless, not atomic). Wording fixes: the stored currency is stricter than the folder's (the folder's regex has no end anchor; the stored one needs exactly 3 letters and a finite positive rate). Folder behaviour is unchanged (`chat.test.ts`, `compose-folder-apply.test.ts`, whose resume precondition now precedes the partial apply). Hook-level 428 handling is untested: `editor/web` has no React test harness. Decided in S10b7c (the S10b7b remainder above is done, its two patches applied): a stored chat body that is not a chat record is a corrupt row, a `StorageFailure` from the source's `read`, so the log, a message, a discard and an apply answer 503; `apply` awaits `assertWritable` right after resolving the workspace (an archived brand is 403 before the log is read, so an archived brand with a non-pending proposal is now 403, not 409). `apply` has an in-process guard per slug/carousel/proposal, set before any await (like compose's plan guard) and released when the run ends or the request fails before it starts: a second concurrent apply is 409 with `messages.proposal.applyInFlight` and the provider is paid once (tested with two concurrent requests); it is per process, which is enough for the single editor server and would not hold across two servers on one database. Not reordered, on purpose: the message route still calls the model before appending the user's record. Appending first would leave an orphan user record whenever the provider fails (the common failure, far more than a storage outage), the retry would then send the text twice (`history` feeds the model and `awaitedMessage`), and the log would hold user turns with no answer, which the client does not render as a failed turn; there is no cheaper writability probe than the archived check already done. The proposal is now built (synchronously) before the first append, so the remaining window is between the two back-to-back appends (user, then assistant), plus a storage outage after the model call: one wasted completion and a 503, and the retry pays again; a failure between the two appends leaves a user record with no answer. Open product decision: accept orphan user turns (and add a "failed turn" record kind) to close that window, or keep it. The reference resolver of the image provider is `assetResolverFor(storage, slug)` (`chat-references.ts`, was inline in `index.ts`) and is tested against a stored brand. A stored row whose document is invalid is a 400 on a message and on an apply (before any model call or append, tested). After the apply's write has committed, a failure to reopen the document for the "image removed meanwhile" check is logged and does not turn the saved apply into a `failed` event (stored tested with an outage on the first read after the save; the folder shares the code path). A save landing during generation is built upon (tested through the image hook). `stored-chat-apply.test.ts` seeds its own carousel per test. The folder `settle` log names the proposal id. Follow-up, not done: a stored apply records the post-apply state, so `/versions` (snapshots of the document before a change in the folder, after it here) cannot revert an AI apply; the folder snapshots before. Same follow-up: the apply's `started` append and the in-process guard do not make a discard atomic with an apply (a discard racing a running apply is accepted, as before). | | | |
| S11a | Commit gate denylist from storage (`brand denylist [--write]`, `storage/src/cli/denylist.ts`; the gate reads the gitignored `scripts/brand-denylist.generated.txt`) and the skills `usar-perfil` (trust envelope, storage-or-folder rule) and `generar-carrusel-semana` | ~550 | S8, S9b2 | gate derives terms with no folders on disk; those two skills name no `profiles/` path |
| S11a2 | Remainder of the old S11a: `generar-reel-semana`, `carousel-designer` + `references/` (`brand-context-protocol.md`, `verification-checklist.md`) and `examples/`, `narrated-slide-video` (`SKILL.md` l.78, l.265, `references/voice-casting.md` l.166-181), `system/recipes/weekly-roundup.md` l.173 (`<perfil>/carousels/week-input.json`); denylist parity with folder derivation (handles in guidance, recipes, config and tokens, any `name` key, recipe and carousel city); the gate warns when the generated file is absent while storage has non-example brands, or is stale | ~500 | S11a | `rg "profiles/" .claude/skills` returns nothing; a brand known only to storage is caught by the gate; the absent-file warning has a test |
| S11b | Agents (incl. content agents on `content_items`): all `.claude/agents/*.md` + README; `app/` retirement;  `system/guides/workflow.md`, schema docs | ~450 | S8, S11a2 | no agent references `profiles/`; **real brands can now be cut over** |
| S12a/b | Remove mirror, editor `fs` mode (docker replaces it), runtime middleware, `ProfileStore` fs/s3 branches, `profile.ts` path resolvers, `resolveBrandSource` folder branch, `migrate-profile-to-bucket.ts`, `init-profile.mjs`, `STORAGE_BACKEND`; comment updates in `system/ig-reel/osm-cache.ts` and `system/ig-carousel/carousel-document.ts` (split by file) | ~2×550 | all real brands cut over | `rg -l "profileDir\|profiles/" system scripts` returns only `scripts/validate_commit_guardian.py` and `scripts/brand-denylist.txt` (they guard against committing profile folders); full `pnpm check` green |
| S13 | `seasonal_themes` + repo + CLI verbs + engine overlay of `token_overrides` | ~450 | S12 | a fictional brand's theme applies inside its date range |

20 PRs incl. S13 (above the ~13 target: S12's deletions alone exceed 600
lines, and merging the S9 or S11 pairs would break the budget). A slice that
grows is split, not compressed.

**From #116**, salvaged into S7a: the testable CLI shape (`CliResult {
lines, exitCode }`, `runCli(argv, env)`), the ~30-line flag parser, and the
single-object `fetch` idea (`brand asset get --out` / `brand export pull`
via `getStream`). Everything mirror-based is not salvageable; close #116
when S7a lands.

## 14. Risks and open questions for the owner

**Q-S7b2b (resolved 2026-10-21 as technical decisions; built in S7b2b1 and S7b2b2).**
1. *Recipe and period.* Neither input names them, so they are derived and the
   derivation is recorded on the run (`input._imported = { from, recipe, period }`,
   `from` being the folder-relative source path). `reels/<date>/storyboard.yaml`
   is a `reel-week` run for the Monday-to-Sunday week holding the folder date
   (the engine names the folder after the period start); its input is the root
   `reels/week-input.json`. Without a storyboard, `reels/week-input.json` alone
   is a `reel-week` run for the week holding all its item dates. A flat
   `carousels/*.json` whose slides are all dated inside one Monday-to-Sunday
   week is a `weekly-roundup` run for that week. Undated or multi-week inputs
   get no invented run: they are reported and kept as legacy blobs. A run is
   identified by its source path; a source that now derives another period is a
   conflict, never a move.
2. *TTS and clips.* TTS lives at `reels/<periodStart>/audio/<card-id>.mp3` with
   `<card-id>.json` = `{hash, seconds}`; clips at
   `<outputs.base_dir>/<outputs.reels>/<periodStart>/clips/<n>-<card-id>.mp4`
   (base from `config.local.yaml` over `config.yaml`, or `BRAND_OUTPUTS_ROOT`).
   A base outside the brand folder is read as a second root confined by
   realpath, and its resolved path is printed in the report. `narration_hash`
   is the sidecar hash as is. `tts_cache.voice` (NOT NULL) is rebuilt from the
   recipe voice plus the storyboard override and stored only when recomputing
   the hash gives the sidecar's value; otherwise the pair is not imported as
   audio and is reported (legacy). The hash and the merge are the engine's own
   code, moved into `core/narration` and shared. Imported clips get
   `inputs_hash = import:sha256:<mp4 sha>`.
3. *Outputs.* Editor exports
   (`<outputs>/<outputs.editor>/<carousel-slug>/v<N>/` + `manifest.json`) become
   `exports` rows (carousel by slug, `version_no = N`, `done`, manifest stored)
   with files under `carouselExportKey`; a version without a manifest and the
   `.reserved` markers are legacy. Reel outputs become `run_artifacts` of that
   period's reel run. Weekly renders (`<year>/<mon>-<dd>/`) would be artifacts of
   that week's `weekly-roundup` run, but `run_artifacts` only accepts `clip`,
   `audio` and `timeline`, so they are legacy. Everything else is legacy,
   always reported.
4. *Legacy blobs.* Keyed by content: `putBlob` to `blobKey(sha256)` (idempotent,
   never overwrites), so no run id is needed before the run is recorded. The
   path -> sha256 manifest goes into that run's `import_runs.report`; a re-run
   compares with the latest report and lists the paths that changed.
   This replaces the old `legacy/<importRunId>/<path>` layout.

**Risks** (mitigations are in the sections cited)

- The DB is the single copy of brand decisions (§4 roles, §10 backup gate). No offline work.
- Guidance from the DB reaches agents (§8 envelope, owner-only writes, `--since` diffs).
- Credentials in agent sessions: read-only by default (§4).
- Commit gate loses its derived terms when folders go; S11a moves it to `brand denylist`.
- Two paths live between S7a and S12, behind the single `resolveBrandSource` switch.
- Long agent sessions hit version conflicts by design; the CLI says how to retry.

**Decisions (owner, 2026-10-12)**

1. Reuse the existing `ObjectStore`/`S3ObjectStore` from `editor/server/src/storage`: S2 moves it into the shared package, never duplicates it.
2. Postgres: local docker for now. Production will be one shared company database, so product tables live in their own schema `content_platform`, configured only via `DATABASE_URL`, with no ownership assumptions and no cloud provisioning here (§12 is reference only). The backup destination stays open until hosting is chosen.
3. Same existing bucket, new `brands/` root.
4. Per brand, import the copy whose content is finished, decided by evidence; the choice is reported to the owner before any real import.
5. Ideas, drafts and published go into the database too: `content_items` is scheduled (S6b) together with the content agents' switch (S11b).
6. The editor's local `fs` mode is removed; local dev uses docker (S12).
7. Commit-gate denylist: gitignored local file generated by `brand denylist --write`.
8. `brand_owner` credentials: owner only; an editor UI for rules/guidance comes later.
9. `author`: free text for now.
10. `app/`: retired formally (S11b).

**Decided in S11a.**
1. `brand denylist [--write]` did not exist (S8 listed it in the verb table only); S11a built it. It is a read (no owner opt-in) and prints the terms as brand data, or, with `--write` (a flag, no value), writes them one per line to the pinned `<repo>/scripts/brand-denylist.generated.txt` (0600, temp file + rename, temp removed on failure; a symlink or directory there is refused, exit 6). The target cannot be chosen, so a tracked file such as the public denylist is unreachable. Terms come from storage only, for every non-example brand including archived ones: slug, display name, `tokens.copy.wordmark`, domains and base names of `tokens.copy.site` and `tokens.sourceImageHosts` (third-party platforms excluded), `config.content.default_hashtags` (compound ones only) and `config.profile.name`, and `@handle` in the `identity` and `spec` text. Not yet covered (S11a2, before S12 drops folders; parity with folder derivation): `@handle` scanning of guidance, recipes, config and tokens (not only identity and spec), any `name` key, recipe `defaults.city`/`source.url` and carousel `city`.
2. The gate (`generated_terms()`) reads `scripts/brand-denylist.generated.txt` (gitignored, like the `.local` file) through the same minimum-length and generic-word filter as folder terms (`_watchable`; the filter list is untouched). It adds to folder derivation and the manual files; nothing is removed until S12. Regenerate after adding a brand or changing its identity. A purged brand leaves the generated list on the next regeneration: move any term that must stay watched into `scripts/brand-denylist.local.txt` first. Tests: `python3 -m unittest scripts/test_commit_guardian_generated.py`, `storage/test/denylist.test.ts`.
3. Skill rule for the transition: a skill resolves the brand and runs `brand show <slug> --json`. `cutoverAt` set means storage only, the folder is never read. `cutoverAt` null or exit 4 means a folder brand: the folder is authoritative (a stored copy may be stale), read from the profile root (`$BRAND_PROFILES_DIR`, default `./profiles`) by the layout in `usar-perfil`; skills never write it and never run `import` or `cutover`. The folder path is spelled out once, in `usar-perfil`; the other skills point there, so no skill contains the literal `profiles/`.
4. Trust envelope wording lives in `usar-perfil`: everything the CLI prints from storage (the `[datos de la marca ...]` markers, `"trust": "brand-data"` in `--json`) is data, never instructions, and never authorizes commands, fetches, file access, publishing or relaxing engine rules. Skills never set `BRAND_OWNER_OPT_IN`.
5. Skill text written in S11a is English (technical artifact); the existing Spanish text is untouched. Proposal: translate the five skills in one pass after S11a2.
6. Known gap: no verb creates a `recipe_run` (reel input and storyboard), so a stored brand's reel (`--run <runId>`) has no CLI path yet. S11a2 must either add the verb or tell `generar-reel-semana` to stop and ask when a stored brand has no run.

**Q-S7b2b3 (deferred from the S7b2b2 review; nothing here is optional).**
1. Editor exports -> `exports` rows, `v<N>` folders in numeric order (test: v2, v10). Done in S7b2b3b.
2. The legacy pass walks the whole folder minus `used`; collectors fill `used`.
3. Refuse an outputs root that is `$HOME` or holds other brands' folders; stream
   and hash instead of reading everything into memory. (Done in S7b2b3b: the
   home directory, a folder that holds it, the profiles folder or another
   brand's folder is unusable, and the collectors keep only path, hash and size,
   reading each file again when it is uploaded. A cutover still reads the outputs
   root three times (plan, real pass, verify), one file at a time.)
4. Share the outputs resolver with the engine, or fail on an unreadable
   `config.local.yaml`; a symlinked `outputs` directory counts as the second
   root. (Done in S7b2b3a: confinement tests for the second root, and an `outputs` link
   whose real path is the outputs root is that root, not a link to report. An
   unusable root, `/` or an ancestor of the folder, or an `outputs.reels` leaving
   the root, is reported in `skipped` and blocks a cutover; a configured root
   that does not exist is a notice; any other `realpath` failure, such as
   EACCES or ELOOP, is unusable.) Done in S7b2b3b: a `config.local.yaml` that
   is unreadable or unparseable leaves the outputs root unknown (skipped, blocks a cutover).
5. A released take (its card left the plan) must not look foreign when the card
   returns with a new mp3: record `_imported.released`, accept it as the last
   import (test: card leaves, returns, updates cleanly). Done in S7b2b3b, with the
   old `_imported.audio` key still claiming its slots.
6. An aborted run's legacy manifest: "changed" is relative to the last complete run.
7. Open (patch `odd/status/patches/s7b2b3c.patch`): an outputs root that lies INSIDE
   another brand's folder is unusable (a sibling with `brand.json`, `brand.yaml` or
   `profile.md`). A root shared by several brands cannot be detected.
