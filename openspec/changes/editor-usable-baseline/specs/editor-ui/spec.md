## REMOVED Requirements

### Requirement: Composition from the prompt
**Reason**: Composing a whole carousel on entry is the opposite of the control the editor exists to provide: the user paid for a full composition before seeing anything, and correcting it meant fighting a result they never approved. Entering the editor must be inert.

**Migration**: Creating a carousel now yields an empty canvas (see "New carousel opens empty" below). Composition is requested explicitly, per piece, through the existing per-piece generation controls. The background compose job, its progress/cost header, and the "Ver plan" drawer are removed along with this requirement; `POST /api/profiles/:slug/carousels` no longer enqueues a job, and `GET .../compose/:jobId` is removed from the API surface. "Regenerar lo no fijado" is unaffected and remains available in the editor.

## ADDED Requirements

### Requirement: New carousel opens empty
Creating a carousel SHALL produce a document with its slides' structure and no generated content, and SHALL NOT start any AI work. The new-carousel screen asks only for what identifies the piece — its title, its brand, and optionally a template — and pressing the create action SHALL navigate to `/:slug/carousels/:id` showing an empty canvas. No text is drafted, no image is generated, and no cost is incurred until the user asks for it explicitly.

#### Scenario: Entering a new carousel spends nothing
- **WHEN** the user creates a carousel and lands in the editor
- **THEN** the canvas shows the template's structure with empty slots, no piece is in a `pending` state, no background job is running, and no request has been sent to any AI provider

#### Scenario: Reloading an empty carousel
- **WHEN** the user reloads the browser on a carousel they have not composed
- **THEN** the same empty canvas is shown, unchanged, and still nothing is generated

### Requirement: Template is chosen, not inherited
A carousel SHALL NOT be born with a template. The user SHALL choose one from the templates available to the resolved brand, SHALL be able to change that choice later on an existing carousel, and SHALL be able to choose none. With no template, the brand's palette and fonts still apply and no structure is imposed. The chosen template SHALL be shown in the UI so the user always knows which grounding is active.

#### Scenario: Creating with no template
- **WHEN** the user creates a carousel and picks "sin template"
- **THEN** the document carries no template reference, the canvas offers a free surface using the brand's palette and fonts, and no zones are painted

#### Scenario: Swapping the template on an existing carousel
- **WHEN** the user changes a carousel's template from one to another
- **THEN** objects whose slot exists in both templates keep their content and take the new template's geometry, the new template's zones are painted, and the change is saved on the document

### Requirement: Side panel lists the brand's assets and templates
The editor's side panel SHALL present the resolved brand's assets and its templates as browsable listings, each in its own tab alongside the existing manual design controls. The asset listing SHALL show every non-hidden asset of the profile, grouped by kind, including assets of kinds the editor does not otherwise classify. The template listing SHALL show every template available to the brand — the engine defaults and the profile's own overrides — and SHALL indicate which one the open carousel is using.

#### Scenario: A brand with assets on disk
- **WHEN** the user opens the assets tab for a brand whose profile folder contains images and fonts
- **THEN** every non-hidden asset in that profile's index is listed, grouped by kind, with unclassified ones shown rather than omitted

#### Scenario: A brand with no templates of its own
- **WHEN** the user opens the templates tab for a brand that has no template overrides in its profile folder
- **THEN** the engine's default templates are listed, and the listing states that this brand has no templates of its own rather than appearing empty

#### Scenario: A profile with no assets at all
- **WHEN** the user opens the assets tab for a profile whose folder has no assets directory
- **THEN** the tab shows an explicit empty state naming the profile, not a spinner or a silent blank
