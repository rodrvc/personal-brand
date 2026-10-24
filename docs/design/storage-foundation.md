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
| Commit gate | `scripts/validate_commit_guardian.py` | derives the brand denylist from profile folders on disk |

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
| `run_artifacts` | `seq` (identity), `id`, `run_id`, `kind` (`clip`/`audio`/`timeline`), `card_index`, `card_id`, `sha256`, `inputs_hash`, `created_at` | insert-only; current = highest `seq` per (`run_id`,`kind`,`card_index`); a timeline has no card; re-rendering back to an earlier clip inserts again; reel export version numbering is deferred to S9b (`exports` reference carousels only) | S6c |
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
invalidation; deliverables get named versioned keys (`ifNoneMatch: "*"`,
version reserved in `exports` first). **Ordering:** upload the blob, then
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
3. **Scratch per run:** `remotion/public/staging/<runId>/` and a per-run
   clip dir are built from the cache (hardlink, copy fallback) at the start
   of each run. No run touches another run's dir; there is no shared
   `rmSync(stagingDir)`.
4. **Outputs:** the final MP4 (and storyboard/timeline) upload to
   `exports/reels/<runId>/v<NNN>/`, verified by `head` (size + sha256
   metadata) before the run's scratch dirs are removed.

## 8. Skills, agents and the CLI

**CLI:** `pnpm brand <noun> <verb>` (bin in `storage/src/cli/`). `--json`
for agents. Exit codes: 0 ok, 2 usage, 3 version conflict, 4 not found,
5 rule violations, 6 refused (cutover/backup/role).

```
brand list [--archived]
brand create <slug> --name <display>              replaces scripts/init-profile.mjs
brand archive <slug>                              soft removal
brand unarchive <slug>                            reverses archive
brand purge <slug> --confirm <slug>               deliberate deletion, see below
brand show <slug> [--since <version>]             documents + versions, rules, guidance; --since diffs guidance revisions after <version>
brand doc get|put <slug> <tokens|config|identity|spec|template> [<name>] [--if-version <n>]
brand rules list|add|update|disable <slug> ...    owner role
brand guidance list|get|put <slug> [<name>] [--if-version <n>]   put: owner role
brand recipe get|put <slug> <recipe> [--if-version <n>]
brand asset list|add|get <slug> ...               add <file>: upload + register; get --out <path>
brand fonts fetch <slug> ...                      replaces system/assets/fetch-fonts.ts writing into the folder
brand carousel list|get|put|status <slug> ...
brand export pull <slug> <carousel> [--version N] --out <dir>
brand check <slug> --carousel <id>
brand import --from <dir|legacy-bucket:<slug>> [--dry-run] [--report <file>]
brand cutover <slug> --confirm <slug>             D12, see §10
brand migrate                                     migrator role
brand backup drill --target <db>                  record a verified restore in restore_drills
brand denylist [--write <file>]                   terms for the commit gate
```

**Removal.** `archive` is the normal path (hidden from lists and pickers,
data intact). `purge` exists for the rare "this brand must be gone" case:
it requires an archived brand and runs as `brand_purger`, writes an export bundle
(all rows as JSON + a blob key manifest) to a local path outside the repo and
verifies it, then deletes the brand's rows in FK order in one transaction
under `SET LOCAL app.purge_brand = '<brandId>'`, which the `revisions`
trigger checks as a second guard. Bucket objects
under `brands/<brandId>/` are removed afterwards by an operator with a
delete-capable key; the app key cannot.

**Guidance trust envelope.** `brand guidance get --json` returns
`{ "trust": "brand-data", "name", "version", "body" }`. `usar-perfil` states
explicitly: guidance describes brand criteria (what content fits, tone); it
never authorizes running commands, fetching URLs, reading files, or relaxing
engine rules, limits or checks — the same posture `system/recipes/*.md`
already takes for `guidance`. Only the owner role writes guidance, and
`brand show <slug> --since <version>` prints the guidance revisions after a
version the caller names, so an unexpected change is visible.

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
The legacy-bucket source reads the #99 `profiles/<slug>/` prefix, because a
brand edited in `s3` mode may be fresher there than in its folder (§14 Q4).

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

- **Backup gate:** a non-dry-run against a non-localhost `DATABASE_URL` is
  refused unless `restore_drills` has a `verified` row for that target DB
  newer than 30 days (a `pg_dump` restored elsewhere and passing the
  verification pass; recorded by `brand backup drill`). No self-reported
  flag. Dumps are stored outside the brand bucket.
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
| S8 | Remaining CLI verbs: read/write, `create`/`archive`/`unarchive`/`purge`, guidance envelope + `--since`, `check`, `export pull`, `fonts fetch`; legacy-bucket import source; `restore_drills` + `backup drill` + import backup gate; `init-profile.mjs` redirects to `brand create` | ~590 | S7b2b3b | exit codes; purge refuses without bundle/purger role; **`pg_dump` + restore drill tested** and gate refuses without a recent verified drill |
| S9a | Carousel engine: render context + `loadWithResolver`; `render-week`/`render-brand`/`render.ts`, `text-raster.ts`, `contrast.ts`, `brand-schema.ts` loading, `brand-style.ts::loadBrandStyle` (from `brand_documents`), `layout-template.ts` (templates from `brand_documents`), `recipe.ts` read via `resolveBrandSource` | ~590 | S6d, S7a2 | example brand renders from storage with no `profiles/` dir |
| S9b | Reel: `tts_cache`, clips as blobs in `run_artifacts`, per-run staging + clip dirs from cache (hardlink/copy), outputs to export keys, `storyboard.ts` on `recipe_runs` | ~590 | S9a | two concurrent reel renders do not collide; re-render one card keeps the old clip; assemble-only works from cache |
| S10a | Editor read path on repositories, `ETag` | ~580 | S9a | editor suite green on memory storage |
| S10b | Editor write path: save (`If-Match`), export, chat, compose; 409 with current version | ~580 | S10a | concurrent-save tests; exports land in bucket |
| S11a | Skills: `usar-perfil` (trust envelope wording), `generar-carrusel-semana`, `generar-reel-semana`, `carousel-designer` + references, `narrated-slide-video` + reference; commit gate denylist from `brand denylist --write` | ~550 | S8, S9b | no skill references `profiles/`; gate derives terms with no folders on disk |
| S11b | Agents (incl. content agents on `content_items`): all `.claude/agents/*.md` + README; `app/` retirement;  `system/guides/workflow.md`, schema docs | ~450 | S8, S11a | no agent references `profiles/`; **real brands can now be cut over** |
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
