## 1. Workspace foundations

- [x] 1.1 `core/package.json` as an ESM workspace package (`@personal-brand/core`) with JSDoc/`.d.ts` types; `node core/test/run.mjs` still at 54 tests
- [x] 1.2 Add `editor/*` and `core` to `pnpm-workspace.yaml`; a single `pnpm install` at the root installs everything
- [x] 1.3 Add `zod` to the engine and `openspec/config.yaml` with the repo's context (stack, agnostic rules, breve)
- [x] 1.4 Check that `python3 scripts/validate_commit_guardian.py --scan` exits 0 after the scaffold

## 2. Asset library (system/assets/)

- [x] 2.1 Index and sidecar schema in `system/config/assets.schema.md` (types, states, `ink:*` tags, `family` for fonts)
- [x] 2.2 `system/assets/index.ts`: scan `assets/`, sha256 hash, dimensions, sidecars, full rebuild, dedup by hash
- [x] 2.3 `system/assets/usage.ts`: usage derived by reading `carousels/*/carousel.json`
- [x] 2.4 `system/assets/logo.ts`: logo selection by `kind: logo` + `ink:*` with `pickLogoVariant`; fallback to `copy.wordmark`
- [x] 2.5 `fetch-fonts` command that downloads the `googleFontsHref` families to the profile as woff2 and indexes them as `kind: font`
- [x] 2.6 Test with `profiles/example`: full index rebuild and dedup by hash (a file copied by hand, the same file twice)
- [x] 2.7 Test for `logo.ts`: `pickLogoVariant` picks the correct `ink:*` variant against the real background color, and falls back to `copy.wordmark` with no logo asset
- [x] 2.8 Note in `system/config/brand.schema.md`: the logo is not a token; `brand.yaml` is deprecated alongside `app/`

## 3. Document and template (system/ig-carousel/)

- [x] 3.1 `carousel-document.ts`: types + zod validator (color keys, asset ids, id slug, integer px, `pinned`)
- [x] 3.2 Validator test: rejects a `colorKey` outside `brand.colors` and a nonexistent `assetId`; accepts a valid document from `profiles/example`
- [x] 3.3 `layouts/explicativo.json` generic default (zones: background, footer, margins; slots by cover/step/closing) and `layout-template.ts` with partial merge of the profile override plus validation
- [x] 3.4 Inheritance resolution: an object with `slot` and no `geometry` takes the template's; "reset" documented in the model
- [x] 3.5 Copy the summarized schema to `docs/` (document and template format) for agents and skills

## 4. WYSIWYG render

- [ ] 4.1 `templates/free-layout.ts`: pure render of one slide (zones from the template, objects, colors by key, local `@font-face`, rotation) with no brand literals
- [ ] 4.2 `document.ts`: accept inline `@font-face` in addition to `fontsHref`; wait for `document.fonts.ready` in `render-batch.ts`
- [ ] 4.3 Typed overload in `render-batch.ts` for `CarouselDocument`; `VerifiedSlide` untouched
- [ ] 4.4 Per-object contrast measurement against the real background (sampling the PNG behind the box) using `core/color.js`; `pnpm check` green

## 5. Server (editor/server)

- [ ] 5.1 Express 5 + TS scaffold, bind to `127.0.0.1`, `EDITOR_BIND`/`EDITOR_AUTH` (refuses to expose without auth), Playwright check on startup
- [ ] 5.2 `ProfileStore`: allowed roots, rejects `..`, absolute paths and symlinks pointing outside. Confinement test: every escape case (including `system/templates/x`) is rejected and none writes outside `profiles/` or `outputs.base_dir`
- [ ] 5.3 Endpoints for profiles, brand, resolved template, document (CRUD + versions), carousel listing
- [ ] 5.4 Asset endpoints: index, upload (multipart), reclassify, hide, confined static serving with hash-based cache
- [ ] 5.5 Render endpoints: slide HTML, exact PNG, measured contrast; shared warm Chromium
- [ ] 5.6 `PieceGenerator` (interface) + OpenAI implementation (`draftCopy`, `generateImage`) with per-call cost; 503 with no key
- [ ] 5.7 Composition planner: plan per slide and slot, library first, generation only where missing or requested; per-piece regeneration respecting `pinned`; document version before batch operations
- [ ] 5.8 Export: serial queue, atomic-`mkdir` `v<N>`, `manifest.json`, per-slide progress, used pieces move to `approved`
- [ ] 5.9 Versioning test: two consecutive exports of the same carousel produce `v1` and `v2` without overwriting; atomic `mkdir` under `EEXIST` retries with `N+1` instead of clobbering

## 6. Interface (editor/web)

- [ ] 6.1 React 19 + Vite + TS scaffold, light/dark product tokens (`--ui-*`, Inter, 205.7° blue ramp, cool grays) with a theme button and local persistence, routes `/`, `/:slug/carousels`, `/:slug/carousels/:id`
- [ ] 6.2 Top bar, prompt header with summary and the "Regenerar lo no fijado" button, status bar
- [ ] 6.3 Stage: scaled iframe with server HTML, dimmed next slide, thumbnail strip, add slide
- [ ] 6.4 Selection overlay: corner handles, rotation, local proxy during drag, text editing via floating textarea, locked zones non-selectable
- [ ] 6.5 "Selección" panel: properties, closed-palette swatches, layers with an origin badge (AI/library) per piece, independent pin/regenerate (pinning disables regenerate), reset
- [ ] 6.6 "Bucket" panel: library by type, used-in-carousel with counter, candidates, reclassify, hide, upload, exported versions with "open folder", indicator of the carousel's library % with historical comparison
- [ ] 6.7 "Lámina" panel: type, locked structure, background (color | asset | AI), regenerate background, measured contrast
- [ ] 6.8 New carousel: prompt, brand, template, pieces; preview plan with per-piece origin; cost confirmation; "Regenerar lo no fijado" with a pinned-pieces warning
- [ ] 6.9 Client-side undo/redo with debounced persistence; standard keyboard shortcuts
- [ ] 6.10 Minimal carousel listing to enter and exit (no full gallery)

## 7. Documentation and closeout

- [ ] 7.1 `editor/ESTADO.md` (what it does, decisions and their reasons, what's missing, known pitfalls, what deploy would require) and `editor/README.md` in English
- [ ] 7.2 `app/ESTADO.md`: mark deprecated, record the web decision and point to `editor/`
- [ ] 7.3 `docs/ARQUITECTURA.md`: module table and boundaries (the editor writes only to `profiles/` and `outputs.base_dir`)
- [ ] 7.4 `docs/SETUP.md`: how to start the editor, `.env` with `OPENAI_API_KEY`, `fetch-fonts`
- [ ] 7.5 Smoke test with `profiles/example`: prompt → plan → export `v1` and `v2`; guardian at 0; PR with no `Co-Authored-By`
