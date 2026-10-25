# Setup

What a fresh clone does not give you, and how to get it.

## One command

```bash
pnpm install
pnpm setup
```

`pnpm setup` is safe to run again at any time.

## Why it is not optional

**Cloning does not install the git hooks.** Hooks live behind
`core.hooksPath`, which is per-clone configuration rather than tracked
content, so a fresh clone, a new machine or a new worktree starts with no
gate and says nothing about it. `pnpm setup` installs them.

The gate refuses any commit that would put a brand's literals in the generic
layers, track a real profile, or negate the `profiles/` ignore rule. See
[`commit-gate.md`](commit-gate.md) for the contract and
[`../CLAUDE.md`](../CLAUDE.md) for the boundary it enforces.

`pnpm setup` also creates your local watched-terms file and verifies git
really ignores it — the terms are what the gate searches for, and they are
never published.

## pnpm, not npm

The repo is a pnpm workspace: `app/` and `system/ig-reel/remotion/` are
members, and one install at the root mounts all three projects. Installing a
member on its own builds a second, differently-shaped `node_modules` beside
the one the workspace links, and resolves a tree the lockfile never
described.

`python3` is a hard dependency of the gate, not a detail: the validator that
the hooks and CI both run is a Python script.

## Registering a brand

```bash
BRAND_OWNER_OPT_IN=<slug> pnpm --filter @personal-brand/storage brand create <slug> --name "<display name>" --owner-opt-in <slug>
```

A brand lives in storage (`brand create`, owner opt-in required). `pnpm
init:profile` only prints this pointer and writes nothing. Then add the
brand's terms (slug, domain, handle, city) to `scripts/brand-denylist.local.txt`
by hand (git-ignored). A brand made with `brand create` is not renderable by
today's modules until its cutover (D12; S9a/S10).

Skipping the term registration is the risk: a gate with no terms to search
for reports success without checking anything.

## Backup drill

A write to a remote database needs a recent verified restore drill (`brand backup drill`).
Point `DATABASE_URL` at a direct connection, not a pooler: `pg_dump`, the exported
snapshot and `CREATE DATABASE` need a real session.

## Running the editor

`editor/` is the local web editor for brand carousels (see
[`../editor/ESTADO.md`](../editor/ESTADO.md) and
[`../editor/README.md`](../editor/README.md)). It needs Playwright's
Chromium, which the root `pnpm install` does not fetch on its own:

```bash
pnpm install
npx playwright install chromium
pnpm dev:editor
```

This starts `editor/server` on `http://127.0.0.1:4310` and the `editor/web`
Vite dev server (URL printed by Vite). Both read a `.env` at the repo root,
not one inside `editor/`:

```bash
OPENAI_API_KEY=sk-...   # optional — without it, AI-generation endpoints
                          # return 503; composing from the asset library
                          # still works
```

Before generating with AI, download a profile's brand fonts once so the
editor never depends on a live Google Fonts request:

```bash
tsx system/assets/fetch-fonts.ts --profile <slug>
```

## Running the editor against an S3-compatible bucket

By default the editor reads and writes profiles on the local filesystem
(`STORAGE_BACKEND=fs`, the implicit default — nothing to configure). To run
it against an S3-compatible bucket instead (issue #99: preparing the editor
to run online), set `STORAGE_BACKEND=s3` in the repo-root `.env` alongside:

```bash
STORAGE_BACKEND=s3
S3_ENDPOINT=http://localhost:9000     # omit for AWS S3 itself
S3_BUCKET=brand-profiles
S3_REGION=us-east-1                   # default
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=profiles/                   # default; every key is <prefix><slug>/...
LEGACY_BUCKET_TMPDIR=               # where `brand import --from legacy-bucket:<marca>` puts its temporary copy (default: the OS temp folder)
S3_FORCE_PATH_STYLE=true              # default; MinIO/most self-hosted S3 need this
PROFILE_CACHE_DIR=/tmp/personal-brand-profile-cache   # default; local mirror root
```

For local development, bring up a bucket with:

```bash
docker compose -f docker-compose.storage.yml up -d
```

See that file's header for why it runs RustFS (`rustfs/rustfs`, Apache-2.0)
rather than MinIO's own image (MinIO's Docker Hub/quay.io images require an
account as of this writing, and its direct binary download returns 410
Gone) — verified directly against this repo's `ObjectStore` before being
adopted: pulls anonymously, persists data on its named volume across
`docker compose down && up`, and enforces `If-Match`/`If-None-Match` on
`PutObject`. The same `S3_*` variables point at a real MinIO deployment,
Railway bucket, Cloudflare R2 or AWS S3 without any code change.

The shared `@personal-brand/storage` package also keeps a read-only blob
cache (content-addressed files fetched from the bucket by sha256) under
`BLOB_CACHE_DIR`, default `~/.cache/personal-brand/blobs`. It is shared by
every process and brand, never uploads anything, and is always safe to
`rm -rf` (which also clears `*.tmp` files left by a crashed fill). There is
no size cap yet.

In `s3` mode the server keeps a local mirror under `PROFILE_CACHE_DIR`
(`BRAND_PROFILES_DIR`/`BRAND_OUTPUTS_ROOT` are pointed at it automatically)
and syncs it against the bucket around each `/api/profiles/:slug/...`
request: hydrating before the handler runs (at most every few seconds per
profile), and uploading whatever the handler — or a filesystem-level writer
like Playwright's export or the asset index — changed, once the response
finishes. Every path-based reader in the repo keeps working unmodified
against that mirror.

### Eager vs. lazy hydration

`syncDown` does not pull every object into the local mirror on first
open — a profile can carry hundreds of MB of rendered media (a resolved
export's `_outputs/` PNGs, a profile's own `outputs/`/`reels/` trees), and
downloading all of it before the editor can show a carousel list makes
"open a profile" unusably slow. Instead:

- **Always eager** (`assets/`, `carousels/` under the profile area): the
  editor reads these back synchronously on every request — brand assets,
  references, generated images, fonts, and carousel documents — so they
  must already be on disk.
- **Always lazy, whatever the extension** (`outputs/`, `reels/` under the
  profile area; everything under the resolved-output `_outputs/` area that
  matches a lazy extension): large rendered media the editor writes but
  does not read back over HTTP.
- **Lazy by extension everywhere else** in the profile area (png/jpg/jpeg/
  webp/gif/mp4/mov/m4v by default) — a stray image or video outside both
  lists above (an `ideas/` reference, a `tests/` fixture).

A lazy object is fetched on demand instead, streamed straight to disk
(`fetchObjectOnDemand` — never buffered whole in memory), the first time
something actually needs it. All three lists are generic (no brand
literal) and overridable:

```bash
S3_MIRROR_LAZY_MEDIA_EXTENSIONS=.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.m4v
S3_MIRROR_LAZY_PROFILE_PREFIXES=outputs/,reels/
S3_MIRROR_EAGER_PROFILE_PREFIXES=assets/,carousels/
```

A caller that still needs a lazily-excluded file right now — rather than
waiting for `syncDown`'s TTL to run again — reads it through
`ProfileStore.readFileAsync`/`existsAsync`/`absPathAsync` instead of the
plain sync `readFile`/`exists`/`absPath`: they fetch it on demand first if
it's missing locally, then behave exactly like the sync method. The assets
`files/*splat` route and the render engine's asset interception both go
through `readFileAsync` for this reason, even though `assets/` is eager by
default (so the on-demand fetch is normally a same-tick no-op) — a profile
that overrides `S3_MIRROR_EAGER_PROFILE_PREFIXES` still gets a correct,
lazy-safe read.

The carousel PUT stale-revision check, the chat-log append, and the export
version reservation all enforce their guarantees at the **bucket** level in
`s3` mode — real conditional `PutObject`s (`ifMatch`/`ifNoneMatch`) via
`ProfileStore.writeJsonIfRevision`/`appendLine`/`reserveOnce`, not just the
local mirror — so two server instances racing on the same carousel, chat
log, or export version are safe, the same as `fs` mode already was for a
single instance. Verified against a real bucket (concurrent appenders,
stale-revision rejection) by
`profile-store-bucket-guarantees.integration.test.ts`.

To verify the bucket enforces conditional writes, run the storage
integration tests with the bucket's endpoint set:

```bash
S3_ENDPOINT=http://localhost:9000 S3_BUCKET=brand-profiles \
S3_ACCESS_KEY_ID=rustfsadmin S3_SECRET_ACCESS_KEY=rustfsadmin123 \
pnpm --filter @personal-brand/editor-server test
```

They SKIP cleanly (exit 0) when `S3_ENDPOINT` is unset or unreachable, so
`pnpm test`/`pnpm check` never depend on a bucket being up.

### Migrating an existing local profile into the bucket

```bash
pnpm --filter @personal-brand/editor-server run migrate:profile -- --profile <slug> [--dry-run]
```

Copies a profile's own directory and its resolved `outputs.base_dir` into
the bucket configured by the `S3_*` vars above (independently of
`STORAGE_BACKEND` — the script always targets a bucket). Never deletes
anything, locally or remotely: a file already present with the same
content is skipped, a remote file with *different* content is reported as
a conflict and left untouched, and it's safe to re-run at any time. Run it
with `BRAND_OUTPUTS_ROOT` unset — that variable is the editor's own
s3-mode mirror redirect, and the migration needs to read the real local
output tree, not a mirror.

## Postgres and migrations (`storage/`)

Structured data lives in Postgres (design: `docs/design/storage-foundation.md`).
Start the local database (Postgres 17 on host port 5442; override with
`POSTGRES_PORT`), then apply the migrations:

```bash
docker compose -f docker-compose.storage.yml up -d postgres
export DATABASE_MIGRATOR_URL=postgres://brand_migrator:local-dev-only@localhost:5442/brands
pnpm --filter @personal-brand/storage migrate      # idempotent; safe to run concurrently
```

`migrate` reads `DATABASE_MIGRATOR_URL` and falls back to `DATABASE_URL`;
run it as `brand_migrator`, which creates and owns the product schema. The port is bound to
127.0.0.1 only. The container's init SQL creates the roles
(`brand_migrator`, `brand_owner`, `brand_app`, `brand_reader`,
`brand_purger`) with local-only placeholder passwords; migrations never
create roles and only `GRANT` to those that exist. All tables live in
the Postgres schema `content_platform` (created by the runner; nothing in
`public`), so the database can be shared with other products: configuration
is only `DATABASE_URL` / `DATABASE_MIGRATOR_URL` (+ `DATABASE_PREPARE`), and
`connect()` sets the `search_path`. Behind a transaction-mode pooler, which
may drop that startup parameter, provision `ALTER ROLE <role> SET search_path
= content_platform` instead. The storage integration
tests need a superuser `DATABASE_URL`
(`postgres://postgres:local-dev-only@localhost:5442/brands`), SKIP when it
is unset or unreachable, and use a throwaway `test_<random>` schema.

### The `brand` CLI

```bash
pnpm --filter @personal-brand/storage brand import --from profiles/example --dry-run
pnpm --filter @personal-brand/storage brand import --from profiles/example
pnpm --filter @personal-brand/storage brand cutover example --confirm example --partial
```

`assets/**` are uploaded to the bucket, so a real import needs the same `S3_*`
variables as the editor (`S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT`, `S3_REGION`,
`S3_FORCE_PATH_STYLE`). Without them the assets are not imported: they are
listed under "Omitidos" and a cutover refuses until they are.

These commands only accept the fictional example brands (slug `example` or
`example-*`). Any other brand is refused, `--dry-run` included, before the
database or the folder is touched. Only the owner can lift that, by hand and
for one brand at a time, after approving that brand's source: set
`BRAND_OWNER_OPT_IN=<slug>` **and** pass `--owner-opt-in <slug>` (same slug,
never a wildcard). Agents and automation must never set either. This is a
speed bump against mistakes, not a security boundary.

Run these from the repo root, with `DATABASE_URL` set to a `brand_owner`
connection (the importer writes guidance and import runs, which are
owner-only).

- `--from` is the brand's folder; its name is the brand slug. A relative path
  resolves against where you ran the command (pnpm sets `INIT_CWD`), and a
  leading `~` is expanded.
- `--dry-run` reads the folder and the database, prints what would change and
  writes nothing.
- Without it, `import` is idempotent: an unchanged source is a no-op, a
  changed source updates only rows the importer itself wrote last, and anything
  edited in storage since is reported as a conflict (exit 1) and left alone.
  The folder is never modified or deleted.
- Real writes to a non-localhost database are refused until the backup drill
  exists (S8).
- `cutover <slug> --confirm <slug>` runs a final import, verifies it and then
  marks the brand cut over and writes `.storage-cutover` in its folder (the
  folder is not deleted). It refuses while anything the importer does not carry
  yet (assets, reels, outputs, flat carousel inputs...) is left in the folder, so
  nothing is stranded; `--partial` acknowledges that. Until S7b2 lands, the
  example brands are cut over with `--partial`. Without `--from`, the folder is
  `$BRAND_PROFILES_DIR/<slug>` (default `<repo>/profiles/<slug>`).

## Specs (OpenSpec)

Architectural and module-design decisions are proposed and tracked as specs
under `openspec/`:

```bash
openspec list        # changes in flight or archived, and their task progress
openspec validate     # checks a change's proposal/design/tasks are well-formed
```

See `openspec/changes/editor-carruseles/` for an example: `proposal.md`,
`design.md` and `tasks.md`.

## Everyday commands

```bash
pnpm check                                       # typecheck + tests
python3 scripts/validate_commit_guardian.py --scan   # audit the whole tree
```
