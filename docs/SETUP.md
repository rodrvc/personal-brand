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
pnpm init:profile
```

An interactive terminal prompt. It copies `profiles/example/` as the starting
point, asks which of the brand's terms must be watched, appends them to the
local file, and refuses to finish unless the new folder is genuinely outside
git.

Creating a profile by hand instead skips the term registration — and a gate
with no terms to search for reports success without checking anything.

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
S3_FORCE_PATH_STYLE=true              # default; most self-hosted S3 servers need this
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

To verify the bucket enforces conditional writes, run the storage
integration test with the bucket's endpoint set:

```bash
S3_ENDPOINT=http://localhost:9000 S3_BUCKET=brand-profiles \
S3_ACCESS_KEY_ID=rustfsadmin S3_SECRET_ACCESS_KEY=rustfsadmin123 \
pnpm --filter @personal-brand/editor-server test
```

It SKIPs cleanly (exit 0) when `S3_ENDPOINT` is unset or unreachable, so
`pnpm test`/`pnpm check` never depend on a bucket being up.

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
