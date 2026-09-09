## ADDED Requirements

### Requirement: Local server on top of profiles/
`editor/server` SHALL be a Node server (Express 5, TS) that listens on `127.0.0.1` by default and exposes a JSON API over the profiles resolved by `resolveProfilesRoot()` (respecting `BRAND_PROFILES_DIR`). It MUST NOT create any copy of the profiles nor a data directory of its own.

#### Scenario: Startup
- **WHEN** `pnpm --filter editor dev` runs
- **THEN** server and web both start, the server lists the existing profiles and checks Playwright/Chromium, explaining what's missing if something isn't there

### Requirement: ProfileStore adapter with confinement
All I/O SHALL go through a `ProfileStore` module with two allowed roots per profile: `profiles/<slug>/` and the resolved `outputs.base_dir`. It MUST reject paths with `..`, absolute paths, or symlinks that resolve outside the roots. Covered by tests equivalent to the Tauri app's `resolver_dentro()`, including the `system/templates/x` case that first version let through.

#### Scenario: Escape via symlink
- **WHEN** there's a symlink inside `assets/` pointing to `system/`
- **THEN** any write through it is rejected with 400 and logged

### Requirement: Endpoints
The API SHALL cover: listing profiles; reading `brand.json` and a profile's resolved template; CRUD for the document and its versions; a slide's HTML; a slide's exact PNG; measured contrast; asset index, upload, reclassification and hiding; sidecars; composition plan; per-piece generation and regeneration; the background compose job started by carousel creation (`GET /api/profiles/:slug/carousels/:id/compose/:jobId`); export with progress; listing exported versions; listing carousels. Every endpoint validates input with the engine's same zod schema and returns errors naming the field's path.

#### Scenario: Upload an asset
- **WHEN** the client sends a PNG to `/api/profiles/:slug/assets`
- **THEN** the file lands in `assets/`, its hash is computed, the index is updated, and the response returns the entry with `status: approved` and `kind: unclassified` until the user classifies it

#### Scenario: Poll a compose job
- **WHEN** the client polls `GET /api/profiles/:slug/carousels/:id/compose/:jobId` for a job that doesn't match that slug/carousel pair
- **THEN** it responds 404, the same mismatch behavior as the export job endpoint

### Requirement: Asset and font serving
The server SHALL serve files from `assets/` and `assets/fonts/` under `/api/profiles/:slug/assets/*`, read-only and confined to the profile's root, with hash-based cache headers.

#### Scenario: Path outside assets
- **WHEN** `/api/profiles/x/assets/../brand.json` is requested
- **THEN** it responds 404 without reading the file

### Requirement: Secrets
`OPENAI_API_KEY` SHALL be read from the repo root's `.env` or the environment. The server MUST NOT write it to logs nor return it via the API. With no key, per-piece regeneration (`POST .../regenerate`) responds 503 with a message naming the variable.

`POST .../carousels` with no key configured does NOT respond 503: it still returns 201 immediately, with every AI-bound piece composed from the library or left blank and the background compose job's status reported as `"skipped"` (its `message` names the missing variable) — creating and composing a carousel from the library never depends on the key; only an explicit per-piece regeneration call does.

#### Scenario: Startup log
- **WHEN** the server starts with a key configured
- **THEN** the log says "IA: configurada" ("AI: configured") without showing any character of the key

#### Scenario: Regenerate with no key
- **WHEN** `POST .../regenerate` is called and `OPENAI_API_KEY` is not configured
- **THEN** the response is 503, naming `OPENAI_API_KEY`

#### Scenario: Create a carousel with no key
- **WHEN** `POST .../carousels` is called and `OPENAI_API_KEY` is not configured
- **THEN** the response is 201 with the document and a `jobId`, and polling that job shows `status: "skipped"`

### Requirement: Ready for deploy without implementing it
The server SHALL read `EDITOR_BIND` (defaulting to `127.0.0.1`) and reserve `EDITOR_AUTH`, documented as not implemented. The API MUST be session-stateless (all state lives in the profile's files), and `ProfileStore` MUST be the only piece that knows where the disk is. `editor/ESTADO.md` documents what deploy would require (auth, where profiles live, backups) as an open decision.

#### Scenario: Bind to another interface with no auth
- **WHEN** the server is started with `EDITOR_BIND=0.0.0.0` and no `EDITOR_AUTH`
- **THEN** the server refuses to start and explains that exposing the editor with no auth isn't supported
