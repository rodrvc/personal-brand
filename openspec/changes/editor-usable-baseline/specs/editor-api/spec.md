## MODIFIED Requirements

### Requirement: Endpoints
The API SHALL cover: listing profiles; reading `brand.json`, listing a profile's available templates and reading a profile's resolved template; CRUD for the document and its versions; a slide's HTML; a slide's exact PNG; measured contrast; asset index, upload, reclassification and hiding; sidecars; composition plan; per-piece generation and regeneration; export with progress; listing exported versions; listing carousels. Carousel creation SHALL be inert: it creates the document and returns it, and MUST NOT enqueue any AI work. Every endpoint validates input with the engine's same zod schema and returns errors naming the field's path.

#### Scenario: Upload an asset
- **WHEN** the client sends a PNG to `/api/profiles/:slug/assets`
- **THEN** the file lands in `assets/`, its hash is computed, the index is updated, and the response returns the entry with `status: approved` and `kind: unclassified` until the user classifies it

#### Scenario: Creating a carousel starts no work
- **WHEN** the client posts to `/api/profiles/:slug/carousels`
- **THEN** the response carries the created document with empty slots, no job id is returned, and no AI provider is called

## ADDED Requirements

### Requirement: Template listing endpoint
The API SHALL expose an endpoint listing the templates available to a profile, merging the engine's defaults with the profile's own overrides, where an override with the same id replaces the default. Each entry SHALL carry at least its id, a display name and its origin (engine default or brand override), so the client can present a selection without knowing an id in advance.

#### Scenario: A brand with an override
- **WHEN** a profile's folder declares a template whose id matches an engine default
- **THEN** the listing contains that id exactly once, marked as a brand override, and reading the resolved template returns the profile's version

#### Scenario: A profile that cannot be resolved
- **WHEN** the listing is requested for a slug that does not resolve to a profile
- **THEN** the endpoint responds 404 without reading outside the profiles root
