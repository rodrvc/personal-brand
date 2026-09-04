# editor

A local web editor for brand carousels: describe a piece in a prompt, get a
plan assembled from the brand's asset library and AI generation, then fix
only the pieces you didn't like — pin what's approved, regenerate what
isn't, export a versioned set of PNGs. See
[`ESTADO.md`](ESTADO.md) (Spanish, per this repo's convention for module
state docs) for decisions, what works today, what's missing, and known
pitfalls. Design rationale lives in
[`../openspec/changes/editor-carruseles/design.md`](../openspec/changes/editor-carruseles/design.md).

This module supersedes `app/` (the Tauri desktop editor), which is now
deprecated but not deleted — see `../app/ESTADO.md`.

## Folder map

```
editor/
  dev.mjs          runs server + web together (pnpm dev:editor)
  server/          Express 5 + TS API on top of profiles/
    src/index.ts          entry point: bind, env checks, Chromium check
    src/profile-store.ts  the only module that writes profile data — path confinement
    src/routes/           profiles, assets, render, compose, export
    src/ai/                PieceGenerator interface + OpenAI implementation
  web/             React 19 + Vite + TS single-page editor
    src/editor/            Stage, selection overlay, Selection/Bucket/Slide panels
    src/routes/            carousel list, profile picker, editor route
    src/styles/tokens.css  the editor's own chrome palette (not --brand-*)
```

The render engine itself (`system/ig-carousel/`) and the asset library
(`system/assets/`) live outside this module — `editor/` is a client of both,
never the other way around.

## Running it

```bash
pnpm install
pnpm dev:editor
```

Opens the server on `http://127.0.0.1:4310` and the Vite dev server (URL
printed by Vite, typically `http://localhost:5173`). See
[`../docs/SETUP.md`](../docs/SETUP.md) for the full setup, including
Playwright's Chromium and downloading a profile's fonts.

## Environment variables

Read from a `.env` at the **repo root**, not from `editor/`:

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | unset | Optional. Without it, AI-generation endpoints return 503; composing from the asset library still works. |
| `EDITOR_BIND` | `127.0.0.1` | Refuses to start if set to a non-loopback host without `EDITOR_AUTH` — auth isn't implemented yet. |
| `EDITOR_PORT` | `4310` | |
| `EDITOR_AUTH` | unset | Reserved, not implemented. |

## API summary

All routes are namespaced under `/api/profiles/:slug/...` and every
filesystem write goes through `ProfileStore`, confined to that profile's
directory and its resolved `outputs.base_dir`.

- `GET /api/profiles` — list profiles found on disk
- `GET /api/profiles/:slug/brand` — resolved `brand.json`
- `GET /api/profiles/:slug/template/:id` — resolved layout template
- `GET /api/profiles/:slug/carousels` / `:id` / `PUT :id` — carousel document CRUD
- `GET /api/profiles/:slug/carousels/:id/versions` — export history
- `GET /api/profiles/:slug/assets` / `POST` (multipart upload) / `PATCH :assetId` / `GET files/*splat` — asset library
- `GET /api/profiles/:slug/carousels/:id/slides/:n/{html,png,contrast}` — preview HTML, exact PNG, measured contrast
- `POST /api/profiles/:slug/carousels` / `.../plan/apply` / `.../regenerate` / `GET .../stats` — AI composition and regeneration
- `POST /api/profiles/:slug/carousels/:id/export` / `GET .../export/:jobId` / `GET .../outputs` — versioned export

## See also

- [`ESTADO.md`](ESTADO.md) — decisions, current state, known pitfalls (Spanish)
- [`../docs/ARQUITECTURA.md`](../docs/ARQUITECTURA.md) — module boundaries in the platform
- [`../docs/carousel-document.md`](../docs/carousel-document.md) — the carousel document and layout template format
- [`../openspec/changes/editor-carruseles/`](../openspec/changes/editor-carruseles/) — proposal, design and tasks for this module
