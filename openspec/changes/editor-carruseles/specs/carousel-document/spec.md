## ADDED Requirements

### Requirement: One document per carousel inside the profile
Each carousel SHALL be persisted at `profiles/<slug>/carousels/<carousel-id>/carousel.json` with `schemaVersion`, `id`, `title`, `status` (`draft` | `exported` | `published`), `createdAt`, `updatedAt`, `canvas` (`{w:1080,h:1350}` in this version), `prompt` (`text`, `createdAt`), `template` (`id`, `params?`) and `slides[]`. The types and the validator (zod) SHALL live in `system/ig-carousel/carousel-document.ts`. An invalid document MUST be rejected, naming the field's path.

#### Scenario: Document with a nonexistent color key
- **WHEN** an object declares `colorKey: "coral"` and `brand.colors` doesn't have it
- **THEN** validation fails, pointing at `slides[2].objects[1].colorKey`

### Requirement: Slides and pieces
Each slide SHALL have `id`, `kind` (`cover` | `step` | `closing`), `background` and `objects[]` in stacking order (the last one paints on top). `background` SHALL be `{mode:'color', colorKey}` or `{mode:'asset', assetId}`; an AI-generated background is an `asset` background whose asset has `origin: ai`. Each object SHALL be `text` (`text`, `fontKey`, `fontSize`, `lineHeight`, `align`, `colorKey`) or `asset` (`assetId`, `fit`), with `slot?`, `geometry?` (`x`, `y`, `w`, `h?`, `rotation`), `pinned` and `locked`.

#### Scenario: Reorder layers
- **WHEN** the user moves a figure above the headline in the layers panel
- **THEN** the `objects` array changes order and the render paints it on top

### Requirement: Colors only by brand key
The document MUST NOT contain hex values. Every piece color SHALL be a `brand.colors` key; roles from `brand.roles` are resolved by the template for zones and defaults. An import or edit that tries to write a hex value MUST be rejected.

#### Scenario: Paste a hex value into the panel
- **WHEN** the user tries to enter `#FF0000` where a color goes
- **THEN** the UI offers no free-text entry and the API rejects the value if it arrives another way

### Requirement: Geometry in integer pixels of the canvas
`x`, `y`, `w`, `h`, `fontSize` SHALL be integers in px of the declared `canvas`; `rotation` in degrees; `lineHeight` dimensionless. The preview applies a single scale factor. The document MUST NOT mix units.

#### Scenario: Preview and export match
- **WHEN** a headline is at `x:86, y:594, w:648, fontSize:84` and gets exported
- **THEN** in the 1080×1350 PNG the headline occupies those coordinates, and in the preview at 0.31 scale it occupies the same values multiplied by 0.31

### Requirement: Per-piece pinning
Every background and every object SHALL have `pinned` (boolean, defaulting to `false` when generated, `true` when created or edited by hand). No regeneration operation MUST modify a piece with `pinned: true`.

#### Scenario: Regenerate what's not pinned
- **WHEN** the user pins a slide's background and headline and asks to "regenerate the rest"
- **THEN** only the unpinned pieces change; the background and headline stay byte-for-byte identical in the document

### Requirement: Internal document versions
Before any operation that replaces several pieces at once (redoing the prompt, changing the template, regenerating a slide) the system SHALL save a copy of the document at `carousels/<id>/versions/<ISO-timestamp>.json`. `carousel.json` is always the current version. Nothing is overwritten without a prior copy.

#### Scenario: Redo the prompt
- **WHEN** the user edits the prompt and triggers a redo
- **THEN** a version is written under `versions/`, only the unpinned pieces are regenerated, and the current document keeps the pinned ones

### Requirement: Confined writes
Every write of the document and its versions SHALL go through the `ProfileStore` adapter from `editor-api` and MUST stay inside `profiles/<slug>/`. Any `carousel-id` that isn't a slug (`[a-z0-9-]+`) is rejected.

#### Scenario: Id with a path
- **WHEN** a `carousel-id` arrives with the value `../../system/x`
- **THEN** the API responds 400 and disk is never touched

### Requirement: Listing for a future gallery
The system SHALL be able to list `carousels/*/carousel.json` for a profile, returning `id`, `title`, `status`, `updatedAt`, slide count and the first slide's thumbnail. This is the basis for the gallery, which is out of scope for this spec.

#### Scenario: Back to "Carruseles"
- **WHEN** the user presses the "Carruseles" button in the top bar
- **THEN** they see the active profile's carousel listing and can open one; there are no status cards or metrics
