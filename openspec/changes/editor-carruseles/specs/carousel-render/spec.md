## ADDED Requirements

### Requirement: One render function for preview and export
`system/ig-carousel/templates/free-layout.ts` SHALL export a pure function that, given `brand`, the resolved template, the document, the slide index and an asset-path context, returns the full HTML of a slide via `wrapDocument`. The editor MUST show exactly that HTML (scaled iframe) and the export MUST capture exactly that HTML with Playwright. There is no second render of the slide in React.

#### Scenario: Same HTML through both paths
- **WHEN** slide 3's HTML is requested for preview and then exported
- **THEN** the string sent to Playwright is identical to the preview's, except for asset and font URLs (HTTP in the browser, local path in Playwright)

### Requirement: Typed input to the render engine
`render-batch.ts` SHALL gain a concrete function that accepts `CarouselDocument` slides validated by `carousel-document.ts`, whose guarantee is that every `assetId` resolves to a file in the index and every `colorKey` to `brand.colors`. A concrete parameter, not a generic overload, is what keeps that guarantee: `VerifiedSlide` is nominal and only `verifyOrThrow` can mint it, so a signature typed to a type parameter has an unresolved case for a future caller to slip through where a concrete one has none (see `render-batch.ts`'s comment on `renderSlides`/`renderDocuments` for the three attempts that leaked). `VerifiedSlide` and `verifyOrThrow` MUST NOT change, and the guardian keeps rejecting `as VerifiedSlide` outside `verify-slides.ts`.

#### Scenario: Nonexistent asset
- **WHEN** a document references an `assetId` not present in the index
- **THEN** the render is rejected before opening Playwright, naming the slide and the object

### Requirement: Local fonts and load wait
The HTML SHALL declare `@font-face` for the profile fonts present in `assets/fonts/`; `googleFontsHref` is a fallback. Both sides MUST wait for `document.fonts.ready` before considering the slide painted. Playwright captures at `deviceScaleFactor: 1` over 1080×1350.

#### Scenario: Missing font
- **WHEN** `brand.json` references a family with no woff2 in the profile
- **THEN** the render uses the declared fallback and the UI shows a warning that the export may differ from the preview

### Requirement: Exact view and measured contrast from the server
The server SHALL offer, on demand, the active slide's PNG captured with its warm Chromium, and SHALL measure the contrast of every text object against the real background color behind its box. The mockup's Contrast panel shows that measured value, not an estimated one.

#### Scenario: View the exact slide
- **WHEN** the user presses "vista exacta" ("exact view")
- **THEN** they receive the slide's real PNG in under a second with the warm browser, and can compare it against the preview

### Requirement: Locked zones painted by the template
The render function SHALL paint background, footer (logo chosen by contrast, pagination per slide type) and margins from the resolved template and the carousel; no zone data is read from the slide. Pagination is governed by the template's `zones.footer.pagination` (`"all"` | `"steps"` | `"none"`) — a template parameter, not a fixed rule — so a profile or a single carousel's `template.params` can change whether pagination shows on every slide, only on `step` slides, or not at all.

#### Scenario: Six slides, one footer
- **WHEN** the 6 slides of a carousel are rendered
- **THEN** the footer occupies the same height and position on all of them, and pagination reads 1/6 … 6/6

### Requirement: Render with no brand literals
`free-layout.ts` and `layouts/*.json` MUST NOT contain hex, copy, or names. `pnpm check` and `python3 scripts/validate_commit_guardian.py --scan` must keep passing; rendering `profiles/example` with the new template is part of the tests.

#### Scenario: A second brand with no engine changes
- **WHEN** a new profile is created with a different palette, different fonts and a different language
- **THEN** the carousel renders correctly with no edits under `system/`, `core/` or `editor/`
