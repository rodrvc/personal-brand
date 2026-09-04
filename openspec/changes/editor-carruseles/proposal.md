## Why

Today a brand carousel is either assembled by hand on a canvas or rendered by script from a JSON: there is no way to describe what you want, see it assembled with the brand identity, and fix only what you didn't like. The approved mockup (`docs/mockups/carrusel-editor.html`) defines that experience; what's missing is the module that makes it work on top of the engine that already exists (`system/ig-carousel/`, `core/`) and on top of the brand folder (`profiles/<slug>/`).

The underlying goal is not "generate faster with AI": it's that every approved piece (background, character, logo, photo, typeface) enters a reusable library of the brand, so that with use the AI moves from generating to composing already-approved pieces and each carousel costs less than the previous one.

## What Changes

- New `editor/` module (local web: React + Vite in `editor/web`, Node server in `editor/server`) that implements the mockup with light and dark theme. `app/` (Tauri) is marked deprecated; it is not deleted.
- New carousel document format `profiles/<slug>/carousels/<id>/carousel.json`: source prompt, template, slides by type, free objects in canvas px, colors only by `brand.json` key, each piece pinnable and regenerable independently.
- New free-layout template family in `system/ig-carousel/` with locked zones (background, footer + logo, margins) and slots by slide type; generic default in the engine, brand override in `profiles/<slug>/templates/`. Slides inherit from the template and only store what the user moved.
- Bucket asset library: rebuildable index in `profiles/<slug>/assets/`, classification by type (background, character, photo, logo, decoration, font), sidecar per generated piece with prompt, model and cost, dedup by hash, derived usage count. **The logo is just another asset**, not a `brand.json` token; the `logo{}` seam noted in `brand.schema.md` dissolves rather than gets resolved.
- Generation per piece: the AI drafts basic editable copy, generates backgrounds and figures, and **never draws text**. Regenerate acts on a single piece, not on the slide or the carousel; pinned pieces are untouched. Composing from the library is the default path; generating is what happens when the library doesn't have the piece.
- WYSIWYG render: a single template function produces the HTML the editor shows (scaled iframe with a handle layer on top) and the one Playwright exports to 1080×1350 PNG. Fonts served from the profile, not from live Google Fonts.
- Versioned export in `outputs.base_dir`: a new `v<N>` on every export with a reproducible `manifest.json`. Nothing is overwritten.
- `core/` becomes a pnpm workspace package instead of being copied inside the module.
- A single `pnpm install` at the root keeps installing everything (the module joins the workspace).

Out of scope, but the architecture doesn't close the door on it: deploy, authentication, carousel gallery, editing the brand from the editor, formats other than 4:5.

## Capabilities

### New Capabilities
- `asset-library`: a brand's bucket piece library: index, types, sidecars, approval of generated pieces, usage, logo as asset, no deletion.
- `layout-template`: free-layout templates with locked zones and slots by slide type; default in the engine, brand override; inheritance down to slides.
- `carousel-document`: format and rules of the carousel document: pieces, colors by key, geometry in canvas px, per-piece pinning, internal versions, write confinement.
- `piece-generation`: AI generation and composition per piece: editable basic copy, backgrounds and figures; selective regeneration; library-first; recorded cost; the AI does not draw text.
- `carousel-render`: WYSIWYG render of the document: same function for preview and export, local fonts, measured contrast, typed input to the render engine.
- `carousel-export`: versioned PNG export in `outputs.base_dir` with a reproducible manifest.
- `editor-api`: local HTTP server on top of `profiles/`: endpoints, path confinement, secrets, ready for deploy without implementing it.
- `editor-ui`: the mockup's interface with light and dark theme: visible prompt, two slides, thumbnail strip, "Selección/Bucket/Lámina" panel, real handles, closed palette, product-own tokens, per-piece regeneration (pin/regenerate, visible origin), and a library indicator with historical trend.

### Modified Capabilities
<!-- No prior specs under openspec/specs/: this is the repo's first change. -->

## Impact

- **New**: `editor/` (web, server, `ESTADO.md`), `system/ig-carousel/templates/free-layout.ts`, `system/ig-carousel/layouts/` (template defaults), `system/ig-carousel/carousel-document.ts` (types + validator), `system/assets/` (index and sidecars, shareable with the reel), `system/config/assets.schema.md`, `core/package.json`.
- **Modified**: `system/ig-carousel/render-batch.ts` (third typed overload for the editor's document; `VerifiedSlide` unchanged), `system/ig-carousel/document.ts` (local fonts via `@font-face` in addition to `fontsHref`), `pnpm-workspace.yaml` (adds `editor/*` and `core`), `system/config/brand.schema.md` (note: the logo is not a token; `brand.yaml` becomes deprecated alongside `app/`), `docs/ARQUITECTURA.md` (per-module status), `app/ESTADO.md` (deprecation and the web decision).
- **Profile** (outside git): `carousels/<id>/carousel.json` and `versions/`, `assets/index.json`, `assets/generated/`, `assets/fonts/`, `templates/<id>.json`, `outputs/<sub>/<id>/v<N>/`.
- **New dependencies**: `react`, `react-dom`, `vite`, `express` (v5), `zod` (document and index validation). Playwright is already at the root. AI provider: OpenAI, same models and same key `app/` used, now via `OPENAI_API_KEY` in the root `.env`.
- **Repo gate**: no brand literal in `editor/`, `system/`, `core/`; the editor chrome's palette is the product's own and names no one. `python3 scripts/validate_commit_guardian.py --scan` must stay at 0.
- **Agents and skills**: keep reading and writing the same profile files. The asset index is a rebuildable derivative: an agent copying a file into `assets/` breaks nothing.
