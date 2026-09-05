## Context

- The repo is a generic engine (`system/`, `core/`, `.claude/`) fed by brand profiles (`profiles/<slug>/`, git-ignored). Modules don't import each other; they communicate through the profile's files. A module can import the engine.
- There is a carousel render engine (`system/ig-carousel/`): TS templates that return HTML, `wrapDocument` wraps it to 1080×1350, Playwright captures it to PNG. Its input is a verified `Slide[]` (`VerifiedSlide`, nominal), designed for event listings, not for free layout.
- There is a Tauri editor (`app/`) that solved anchors, measured contrast (`core/color.js`) and the "AI doesn't draw text" rule, but never persisted anything. The "desktop, not web" decision from `app/ESTADO.md` is reversed by the owner: web, for portability across operating systems.
- The approved mockup lives at `docs/mockups/carrusel-editor.html`. Two previous attempts were rejected: a summary dashboard, and a carousel with a different background color per slide. A carousel is one brand, visually cohesive, and the UI carries no summary panels.
- Owner decisions this design takes as given: local-first with no deploy or login for now (but not closing the door on it); the editor only consumes the brand; the AI drafts basic editable copy; the logo is an asset; per-piece regeneration; templates with a default in the engine and a brand override; 4:5 only; fonts downloaded to the profile; assets are never deleted; the product's own palette (a single-hue 205.7° blue ramp, Inter) with light and dark theme, naming no one in the repo; module lives in `editor/`.

## Goals / Non-Goals

**Goals:**
- Prompt → carousel assembled with the brand identity → per-piece correction → versioned export, all locally on top of a single copy of `profiles/<slug>/` that agents keep seeing.
- Every approved piece enters the brand's library, classified; composing from the library is the default path and AI generation the complement. The app gets cheaper with use.
- Real WYSIWYG: what you see in the editor is the same HTML that Playwright exports.
- Zero brand literals in the repo; the gate stays at 0.
- An architecture that supports deploy (server, auth, remote storage) by swapping an adapter, without rebuilding the module or the engine.

**Non-Goals:**
- Deploy, authentication, multi-user, remote backups.
- Editing the brand (colors, typefaces) from the editor. Resolving the `brand.json`/`brand.yaml` duplication (not triggered: no one writes brand data).
- Carousel gallery and detail view (only routes and the `carousels/` listing are reserved).
- Formats other than 1080×1350; social publishing; metrics.
- Rewriting `core/` to TypeScript.

## Decisions

**D1. `editor/` module with `web` (React 19 + Vite + TS) and `server` (Node + Express 5 + TS).**
Why: the reference backoffice uses the same stack, and Express 5 reuses its deployment configuration when the time comes. No Tailwind: the chrome uses its own CSS tokens (205.7° blue ramp, cool grays, Inter), kept separate from `--brand-*`, which only exists inside the canvas. The chrome supports light and dark theme with the same token set redefined per theme (`data-theme` on the root, persisted client-side); the carousel canvas never inherits the chrome's theme. Discarded alternative: staying on Tauri (decision reversed by the owner) or a single Vite process with server plugins (mixes dev server with API and complicates deploy).

**D2. A single render function for preview and export.**
`system/ig-carousel/templates/free-layout.ts` exports `renderFreeLayoutSlide(brand, template, document, slideIndex, ctx): string`. The editor runs it on the server and shows the HTML in an `<iframe srcdoc>` scaled with `transform: scale(k)`; React draws the chrome and a transparent selection/handle layer aligned by the same geometry. Inline text editing uses a floating textarea over the overlay, never `contenteditable` inside the iframe. Discarded alternative: drawing the slide in React and "replicating" the template's CSS. They'd diverge on day one and the export would stop being what you see.

**D3. Coordinates and typography in integer pixels of the declared canvas.**
The document carries `canvas: {w: 1080, h: 1350}`; `x, y, w, h, fontSize` are px of that canvas. The preview applies a single scale factor. Discarded alternative: percentage positions with px fonts, which round differently per axis and break WYSIWYG under rotation.

**D4. Template → carousel → slide inheritance, not copying.**
A template (`system/ig-carousel/layouts/<id>.json` by default; `profiles/<slug>/templates/<id>.json` overrides it by partial merge) declares locked zones (background, footer with logo and pagination, margins) and, per slide type (`cover`, `step`, `closing`), slots with default geometry and style. The carousel references `template.id` and stores parameter overrides exactly once. Each slide object declares a `slot`; it only carries its own `geometry` or style if the user moved it. Changing the template moves every untouched slide; "reset" clears the override. Locked zones are not objects: the template paints them, which is why they can never drift out of alignment.

**D5. Colors by `brand.colors` key, never hex.**
The user picks from the palette's swatches (`brand.json` keys); the document stores the key. Roles (`roles{}`) are used by the template for locked zones and slot defaults. If `brand.json` changes, the carousel renders with the current brand; the full brand snapshot goes into each export's manifest, which must be reproducible.

**D6. Pinnable and independently regenerable pieces; library first; immediate build with a background compose job, no mandatory approval screen.**
Each piece (background, each text object, each figure) has `pinned`. Pinning a piece immediately disables its own regenerate button in the UI; the top-level button is literally "Regenerar lo no fijado" ("Regenerate what's not pinned"), not "Redo", and it never overwrites a piece with `pinned: true`. Every object persists its origin (`source: 'ai' | 'library'`) and the UI shows it per piece, not just as an aggregate.

Submitting a prompt does not stop at a plan for the user to approve: `POST /carousels` derives the slide plan (a cover, N steps, a closing — N from an explicit count in the prompt, else the template's own `defaultSlideCount`), places every library-sourced piece synchronously (type + tags + brand, same search as before), and for every slot that needs AI creates a placeholder instead — an empty-text object, an asset object with no `assetId` yet, or a `mode: 'color'` background — each carrying a new `pending: true` flag. This document is written to disk and returned immediately alongside a `jobId`; the browser navigates straight into the editor, which shows the pending pieces shimmering. A background compose job (an in-memory job map keyed by id, the same pattern as the export queue in D11) then runs `draftCopy`/`generateImage` for each pending piece one at a time, persisting the document after every single one so a later failure never loses earlier work, and the editor polls the job's status to update a progress line and clear each piece's shimmer as it completes. With no `OPENAI_API_KEY` configured the job finishes immediately as `skipped`, clearing every placeholder to empty text / no image rather than leaving it pending forever, and the header names the missing variable in Spanish.

The old plan-then-execute shape (a `CompositionPlan` returned for approval, applied later via a separate call) still exists behind an explicit preview flag on the same endpoint, for API/script callers that want a cost estimate before anything is created or written — `plan/apply` is unchanged. The web UI never uses it. Discarded alternative: a global "redo" that replaces the whole carousel; that's exactly what the owner rejected — same reasoning that ruled out a mandatory approval screen between the prompt and the editor, since the owner's own words were "I never asked for a mandatory plan of suggestions."

**D7. Generated piece → always a file; approved → library.**
Every generated image is written to `assets/generated/<hash>.<ext>` with a `<hash>.json` sidecar (prompt, model, cost, date, source carousel) in `candidate` state. Pinning it, or exporting a carousel that uses it, moves it to `approved` and it appears in the classified library. Generated text is not an asset: it lives in the document. The `assets/index.json` index is a rebuildable cache from files + sidecars; usage counts and a carousel's library/AI ratio (and its comparison against the brand's earlier carousels, to show the reuse trend) are computed on the fly by reading `carousels/*/carousel.json`. Discarded alternative: storing usage and cost in the index, which isn't rebuildable and drifts out of sync.

**D8. The logo is an asset of type `logo`.**
Tagged with ink (`dark` | `light`). The footer's locked zone requests "automatic logo": the template picks the variant with `pickLogoVariant` from `core/color.js` against that slide's real background color. No `logo{}` is added to `brand.json`; `system/config/brand.schema.md` documents this. The reel engine today doesn't stamp a logo image (it uses `copy.wordmark` with `fonts.logo`), and it already reads `profiles/<slug>/assets/fonts/`; when it wants a logo it will pull from the same index, which is why it lives in `system/assets/` and not in `editor/`.

**D9. Fonts from the profile.**
`assets/fonts/*.woff2` with inline `@font-face` in the template's HTML; the browser gets them via `/api/profiles/:slug/assets/fonts/<file>` and Playwright via local path. `googleFontsHref` remains a declared fallback with a UI warning ("export may differ"). Both sides wait for `document.fonts.ready` before painting. On-demand exact view: the server returns the active slide's PNG from its warm Chromium instance; the same endpoint measures contrast against the real background.

**D10. Typed input to the render engine.**
`render-batch.ts` gains a concrete overload for `CarouselDocument`, whose validator (`carousel-document.ts`, zod) requires every `assetId` and `colorKey` to resolve. `VerifiedSlide` and `verifyOrThrow` are untouched; the guardian still rejects `as VerifiedSlide` outside `verify-slides.ts`.

**D11. Versioned export.**
`outputs/<sub>/<carousel-id>/v<N>/01..NN.png` + `manifest.json` (engine git sha, resolved template, `brand.json` snapshot, document copy, asset and font hashes). `<sub>` comes from `resolveOutputSubfolder(profileDir, "editor")`. `N` is reserved with an atomic `mkdir`; on `EEXIST` it retries with `N+1`. Exports run in a serial queue with a warm Chromium.

**D12. Write confinement from day one.**
All server I/O goes through a `ProfileStore` adapter with two allowed roots: `profiles/<slug>/` and the resolved `outputs.base_dir`. Any path that escapes (`..`, symlink pointing outside, absolute) is rejected; covered by tests. Equivalent to the Tauri app's `resolver_dentro()`. It's also the deploy seam: a volume or a remote bucket replaces the adapter, not the module.

**D13. Local-first, server on `127.0.0.1`.**
No login. `BRAND_PROFILES_DIR` still decides where profiles live; the editor creates no copy of its own. Reserved and documented, not implemented: `EDITOR_BIND`, `EDITOR_AUTH`, and the API already being session-stateless.

**D14. `core/` as a workspace package.**
`core/package.json` (`name: @personal-brand/core`, ESM, JS with JSDoc/`.d.ts`) and the editor imports it; the `sync-core.mjs` pattern is dropped for the new module. `app/` keeps copying until it's retired.

**D15. AI provider.**
OpenAI, the same models `app/ESTADO.md` benchmarked (cheap text, low-quality image) behind a `PieceGenerator` interface with two operations (`draftCopy`, `generateImage`). Key in the root `.env` (`OPENAI_API_KEY`, already git-ignored). Cost per call is recorded in the sidecar and summed in the status bar. Switching provider means swapping the interface's implementation.

**D16. Languages.**
UI copy in Spanish; code, comments and `README.md` in English, like the rest of the engine; the module's `ESTADO.md` in Spanish, following `app/ESTADO.md`'s format.

## Risks / Trade-offs

- [Safari or Firefox wrap lines differently than Chromium] → the server's exact view (D9) shows the real PNG of the active slide; export always comes out of Chromium.
- [Index drifts out of sync because an agent copied files into `assets/` by hand] → the index is a cache: the server rebuilds it on startup and when it detects `mtime` changes; identity is the content hash.
- [A per-brand template breaks the "zero literals in `system/`" rule] → the engine's default carries no colors or copy, only roles and geometry; the brand enters via `brand.json` and its override in the profile.
- [The AI proposes irrelevant library pieces] → every piece keeps its origin visible in the UI once placed (`source: 'library'` with its `assetId`, or `source: 'ai'`), so a bad library match is always distinguishable after the fact even with no approval step up front; "generate instead" (regenerate that one piece) is one click away, and nothing gets pinned without a user action or an export.
- [Playwright and Chromium on the owner's machine] → already a repo dependency (`pnpm install` + `npx playwright install chromium` in `docs/SETUP.md`); the editor checks on startup and explains what's missing.
- [Two engines reading the same library in the future (carousel and reel)] → the index schema lives in `system/config/assets.schema.md` and the code in `system/assets/`, not in the module.
- [Future deploy forces rethinking where profiles live] → everything goes through `ProfileStore` (D12); the spec leaves it as an open, documented decision, not hidden debt.
- [Preview performance with server re-render on every drag] → during a drag the overlay moves a local proxy; the HTML is re-requested on release (debounce), and the server renders HTML without Playwright (string only), which is cheap.

## Migration Plan

1. Engine and library land (`system/`, `core/`) with tests; they don't change the behavior of `render-week.ts` or `render-brand.ts`.
2. `editor/server` lands with `ProfileStore` and confinement tests; then `editor/web`.
3. `app/ESTADO.md` marks the module as deprecated and points to `editor/ESTADO.md`; `docs/ARQUITECTURA.md` updates the module table. `app/` is not deleted.
4. Rollback: deleting `editor/` and reverting the overloads leaves the engine as it was; the new profile files (`carousels/*/carousel.json`, `assets/index.json`, sidecars) are inert to the other modules.

## Open Questions

- On deploy: do profiles stay on local disk with command-driven sync, or does remote storage become the single copy? Out of scope for this spec; it only constrains `ProfileStore`'s implementation.
- Automatic tagging of library pieces (does the AI suggest tags on approval?). Left manual with an optional suggestion; decide with usage data.
- If the library grows to thousands of pieces, the JSON index stops being enough; a local SQLite is the natural next step, always as a rebuildable derivative.
