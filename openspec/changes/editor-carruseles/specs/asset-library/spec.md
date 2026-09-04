## ADDED Requirements

### Requirement: The library lives in the brand folder
A brand's piece library SHALL be the folder `profiles/<slug>/assets/` resolved by `resolveProfileDir`, with subfolders `generated/` (AI-created pieces) and `fonts/` (woff2 files). The system MUST NOT create a parallel store outside the profile, nor a database that isn't rebuildable from those files.

#### Scenario: An agent copies a file by hand
- **WHEN** an image file appears in `profiles/<slug>/assets/` without going through the editor
- **THEN** the next read of the index picks it up with `kind: unclassified`, without error and without moving it

### Requirement: Rebuildable index with hash identity
The system SHALL keep `profiles/<slug>/assets/index.json` as a cache derived from the files and their sidecars. Each entry MUST have `id` (first 16 hex chars of the content's sha256), `path` relative to the profile, `kind`, `mime`, `w`, `h`, `bytes`, `origin` (`manual` | `ai`), `status` (`candidate` | `approved` | `hidden`), `tags[]`, `createdAt`. Deleting `index.json` MUST NOT lose information: it is fully rebuilt. The schema is documented in `system/config/assets.schema.md`.

#### Scenario: Rebuild after deleting the index
- **WHEN** `index.json` doesn't exist and the library is opened
- **THEN** the system walks `assets/`, reads the sidecars, and writes an index equivalent to the previous one

#### Scenario: Re-upload of the same file
- **WHEN** a file is uploaded whose hash already exists in the index
- **THEN** no new entry is created and the existing `id` is returned

### Requirement: Classification by piece type
Every asset SHALL have a `kind` of: `background`, `character`, `photo`, `logo`, `decoration`, `font`, `unclassified`. The UI and the API MUST allow changing an entry's `kind` and `tags` without moving the file. The composition planner (`piece-generation`) MUST be able to query the library by `kind` and `tags`.

#### Scenario: Reclassify a piece
- **WHEN** the user changes a piece's type from `unclassified` to `character`
- **THEN** the index reflects it and the piece shows up when requesting characters for composition

### Requirement: Generated piece → always a file, approved → library
Every AI-generated image SHALL be written to `assets/generated/<hash>.<ext>` with a `<hash>.json` sidecar containing `prompt`, `model`, `costCents`, `createdAt`, `carouselId`, `slot`, and it enters the index with `status: candidate`. When the user pins the piece in a carousel, or exports a carousel that uses it, the state SHALL move to `approved`. Candidates MUST be visible in the library under their own filter and MUST NOT mix by default with approved pieces.

#### Scenario: Background generated and then pinned
- **WHEN** the AI generates a background and the user pins it on the slide
- **THEN** the file already existed from generation and its state moves from `candidate` to `approved` without re-writing the image

#### Scenario: Background generated and discarded
- **WHEN** the AI generates a background and the user replaces it without pinning it
- **THEN** the file stays in `generated/` as `candidate`, with its prompt and cost, and it isn't paid for again if picked again later

### Requirement: Usage derived, not stored
A piece's usage count (the ↻ in the mockup) SHALL be computed by reading `profiles/<slug>/carousels/*/carousel.json`. The index MUST NOT persist the count as the source of truth; if it caches it, it MUST mark it as derived with the computation date.

#### Scenario: A carousel stops using a piece
- **WHEN** a piece is removed from the last slide that used it
- **THEN** the displayed count drops to zero with no manual action on the index

### Requirement: The logo is an asset
The brand's logo SHALL be one or more pieces with `kind: logo` and an ink tag `ink:dark` or `ink:light`. The system MUST NOT introduce a `logo{}` block into `brand.json`. A template that stamps a logo SHALL request it from the library and pick the variant by measured contrast (`pickLogoVariant` from `core/color.js`) against the slide's real background color. The index schema SHALL live in `system/` so the reel engine can read it from the same place.

#### Scenario: Variant choice per slide
- **WHEN** one slide has a dark background and another a light one, and both logo variants exist
- **THEN** the first slide's footer uses the `ink:light` variant and the second's uses `ink:dark`

#### Scenario: No logo in the library
- **WHEN** the brand has no `kind: logo` piece
- **THEN** the footer uses `brand.json`'s `copy.wordmark` with `fonts.logo`, as the engine does today, and the UI indicates this

### Requirement: Nothing gets deleted
The API and the UI MUST NOT delete files from `assets/`. A piece can move to `status: hidden`, which hides it from the default library view but keeps the file and its references from existing carousels.

#### Scenario: Hide a piece in use
- **WHEN** the user hides a piece referenced by a carousel
- **THEN** the carousel keeps rendering the same and the piece stops showing in the "Bucket" panel except under the "hidden" filter

### Requirement: Fonts as profile pieces
Files in `assets/fonts/*.woff2` SHALL be indexed with `kind: font` and a `family` declared in the sidecar or inferred from the file name. The system SHALL offer a command to download, once, to the profile the families that `brand.json` references via `googleFontsHref`.

#### Scenario: Font present in the profile
- **WHEN** `brand.json` references a family and its woff2 exists in `assets/fonts/`
- **THEN** preview and export load it from the file and make no network request for fonts
