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

### Terminal workflows against the bucket

The editor server is not the only thing that reads and writes a profile: a
terminal skill or recipe does too (issue #115). `profile-sync` (the same
mirror engine as `storageSyncMiddleware`, so conditional writes, no-clobber
and the lazy-media rule all apply identically) lets one run without starting
the Express process:

```bash
npx tsx editor/server/scripts/profile-sync.ts pull   --profile <slug>
npx tsx editor/server/scripts/profile-sync.ts push   --profile <slug>
npx tsx editor/server/scripts/profile-sync.ts status --profile <slug> [--remote]
npx tsx editor/server/scripts/profile-sync.ts fetch  --profile <slug> --path <relPath> [--area profile|outputs]
npx tsx editor/server/scripts/profile-sync.ts env
```

- **`pull`** (`syncDown`) hydrates the eager parts of a profile into the local
  mirror and leaves lazy media (`outputs/`, `reels/`, anything under a
  resolved export's `_outputs/`) alone — same rule as the editor, so a normal
  pull never downloads hundreds of MB of rendered history.
- **`push`** (`syncUp`) uploads every changed mirror file with a conditional
  write (`ifMatch`/`ifNoneMatch`), the same bucket-level guarantee described
  above. A file the bucket moved past since the last `pull` is left alone,
  reported as a conflict, and `push` exits non-zero — pull again and
  reconcile by hand; it never force-overwrites or deletes.
- **`status`** is a cheap, local-only report by default (unsynced edits,
  untracked files); `--remote` adds one `head` per manifest entry to also
  report objects the bucket moved past locally.
- **`fetch`** downloads one specific lazy file on demand, for a caller that
  needs it right now rather than waiting for the next `pull`.
- **`env`** prints `export BRAND_PROFILES_DIR=...` / `export
  BRAND_OUTPUTS_ROOT=...` for the resolved mirror roots — `eval` it before
  any command that reads/writes profile paths so those variables point at
  the mirror instead of the plain filesystem default:

  ```bash
  eval "$(npx tsx editor/server/scripts/profile-sync.ts env)"
  ```

  Environment variables do not persist between separate shell invocations —
  chain the `eval` with `&&` in the same command as whatever needs it,
  rather than assuming an earlier `eval` is still in effect.

With `STORAGE_BACKEND` unset or `fs`, every subcommand (including `env`,
whose fs-mode line is a shell comment, so `eval`-ing it is a genuine no-op)
detects the backend itself, prints that there is nothing to do, and exits 0
— a skill can call `profile-sync` unconditionally on any clone.

`profile-sync` defaults `PROFILE_CACHE_DIR` to its own OS-temp path
(`personal-brand-profile-cache-terminal`), distinct from the editor server's
default (`personal-brand-profile-cache`) — the two are never the same
directory unless you set `PROFILE_CACHE_DIR` to the same value yourself. Keep
them apart: the manifest file is a plain synchronous read-then-write with no
cross-process lock, so two processes patching it around the same time can
race and lose an entry (the bucket's own conditional writes still protect the
actual profile/output files either way).

### Starting the editor in bucket mode

```bash
pnpm run editor:bucket
```

One command for both `editor/server` and `editor/web` against a bucket,
reusing `dev:editor`'s process wiring. It fails fast, before spawning
anything, if the bucket is not configured — listing exactly which of
`STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
is missing or blank (`S3_ENDPOINT` stays optional, needed only for a
non-AWS endpoint). Set these in the repo-root `.env` or the shell
environment, same as the `s3` mode described above.

`EDITOR_PORT` (API, already read by `editor/server`) and `EDITOR_WEB_PORT`
(Vite's dev server) let this run beside a default `pnpm dev:editor` instance
on different ports — the web proxy follows `EDITOR_PORT` automatically:

```bash
STORAGE_BACKEND=s3 S3_ENDPOINT=http://localhost:9000 S3_BUCKET=brand-profiles \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... PROFILE_CACHE_DIR=/tmp/some-other-cache \
EDITOR_PORT=4330 EDITOR_WEB_PORT=5191 pnpm run editor:bucket
```

`pnpm run dev:editor`'s default behavior and ports are unchanged either way.

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
