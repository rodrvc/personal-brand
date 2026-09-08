## ADDED Requirements

### Requirement: The mockup's screen
`editor/web` SHALL implement the layout of `docs/mockups/carrusel-editor.html`: top bar (back to "Carruseles", brand pill, title and status, Select/Text/Asset tools, undo/redo, a light/dark theme button, "Exportar N PNG"), a header with the prompt that generated the carousel and its summary (slide count, drafted copy, library pieces, generated backgrounds and their cost, savings from reuse) with the **"Regenerar lo no fijado"** button, a stage with the active slide and the next one side by side, a thumbnail strip on the right edge, a right-hand panel with "Selección / Bucket / Lámina" tabs, and a status bar. The UI MUST NOT include summary panels, pipelines, or metrics dashboards.

#### Scenario: First time opening a carousel
- **WHEN** the user opens an existing carousel
- **THEN** they see slide 1 active with slide 2 dimmed next to it, the strip with every thumbnail, and the panel on the "Selección" tab with nothing selected

### Requirement: Light and dark theme with product-own tokens
The chrome SHALL offer a light and a dark theme via a button in the top bar. It starts in light by default; the user's choice SHALL persist locally and SHALL take precedence over the operating system's preference. Both themes use their own CSS tokens: a single-hue blue ramp (205.7°) for accents and headings — light on a white background, inverted on a dark one —, cool grays for text and lines, Inter as the typeface, soft radii and shadows. The chrome's tokens (`--ui-*`) MUST be kept separate from the brand's, which only exist inside the canvas. The repo MUST NOT name the reference product or any brand. The amber for locked zones and the green for "ya usado"/"biblioteca" ("already used"/"library") are kept, adjusted for contrast in dark mode.

#### Scenario: Switch theme
- **WHEN** the user presses the theme button in the top bar
- **THEN** the chrome toggles between light and dark with no reload, the choice is remembered on the next open, and the carousel's canvas doesn't change because its palette is the brand's, not the chrome's

#### Scenario: Switch brand
- **WHEN** the user switches the active profile
- **THEN** the chrome's colors don't change because of that; only the canvas, the panel's palette and the library change

### Requirement: Canvas with real handles
Text and asset objects SHALL be selectable, movable, scalable from the four corners, and rotatable via the top handle; text is edited in place with a double click. During a drag the UI moves a local proxy and, on release, requests the updated HTML (debounced). Locked zones SHALL be shown with an amber dashed border and a label, and MUST NOT be selectable. The status bar shows slide, object, size and position in canvas px.

#### Scenario: Scale a headline
- **WHEN** the user drags a headline's bottom-right corner
- **THEN** `w` and `fontSize` change proportionally, the "Selección" panel reflects the values, and on release the server's preview comes back identical to the proxy

### Requirement: "Selección" panel
SHALL show, for the active object: text (if it's a text object), size, line height, position, rotation, color as swatches from the brand's palette (no free picker, per the mockup's copy), and the slide's layer list ("Piezas de la lámina") with a lock icon on locked ones (no buttons, since they aren't document pieces). Every editable piece SHALL show: its origin (`IA` or `biblioteca`, styled differently by origin), a pin button and an independent regenerate button.

#### Scenario: Select a text object
- **WHEN** the user selects a slide's body text
- **THEN** the "Selección" panel shows its text, size, line height, position, rotation and the brand's color swatches, with the current one highlighted

### Requirement: Pinning a piece disables its regenerate
Pinning a piece (the pin button on its layer row) SHALL set it to `pinned: true` and immediately disable that same piece's regenerate button, with no need for a global action. Unpinning it SHALL re-enable it. The top-level "Regenerar lo no fijado" button SHALL respect the same state: no piece with `pinned: true` gets touched.

#### Scenario: Pin a piece
- **WHEN** the user presses pin on the character
- **THEN** the object becomes `pinned: true`, its regenerate button disables, the layer shows the pinned indicator, and "Regenerar lo no fijado" no longer touches it

#### Scenario: Unpin a piece
- **WHEN** the user unpins a piece
- **THEN** its regenerate button becomes enabled again, and the next "Regenerar lo no fijado" can touch it

### Requirement: "Bucket" panel
SHALL show the bucket's path and size, the library by type (backgrounds, characters, photos, logos, decorations) with a green border on pieces used in this carousel and a usage counter, the filter for generated candidates, reclassification by type and tags, hiding, file upload (drag or button), and the list of exported versions under `outputs/`. Clicking a piece places it on the active slide as a new object, or proposes it as a background depending on its type.

#### Scenario: Place a photo
- **WHEN** the user clicks a library photo with slide 3 active
- **THEN** it appears as a selected `asset` object on slide 3, with `pinned: true`, and its counter goes up by one

### Requirement: Library indicator that grows
The "Bucket" panel SHALL prominently show what percentage of the current carousel's visual pieces came from the library (composition) versus AI generation, alongside that same percentage measured at an earlier point in time (e.g. a month ago), to make visible that reuse grows with the brand's usage.

#### Scenario: Growing library
- **WHEN** 62% of the current carousel's visual pieces came from the library and a month ago that percentage was 0%
- **THEN** the "Bucket" panel shows "62% de este carrusel salió de la biblioteca, hace un mes era 0%"

### Requirement: "Lámina" panel
SHALL show the slide's type (cover, step, closing), the template's locked structure with the mockup's note, this slide's background ("Color" from the palette | "Biblioteca" asset | "IA" with prompt and estimated cost, with the note "la IA hace solo el fondo" — "the AI only makes the background"), a regenerate-background action, and the Contrast block with values measured by the server.

#### Scenario: Background by color
- **WHEN** the user picks "Color" and a swatch
- **THEN** the background becomes `{mode:'color', colorKey}`, the contrast is recalculated, and it is shown

### Requirement: "Marca" tab
The properties panel SHALL offer a fourth, read-only tab "Marca" (alongside "Selección" / "Bucket" / "Lámina") showing the brand-style guide the server folds into every generation: palette swatches with each color's key and role, fonts (rendered in their own face where the face is available), style keywords as chips, tone ("estilo"/"evitar"), positioning text, image-direction text, logo rules, and a "Fuentes:" line naming which of `brand-spec.md`/`profile.md`/`config.yaml`/`brand.json` actually contributed something, with a hint (in Spanish) that this is edited in the profile's own files — the editor only consumes the brand, never writes it. A profile with none of these files SHALL show "Esta marca no tiene guía de estilo todavía" naming the files to create, instead of an empty panel.

#### Scenario: Brand with a style guide
- **WHEN** the user opens the "Marca" tab for a profile with a `brand-spec.md` and a `tone:` block
- **THEN** they see the palette, keywords, tone and positioning read from those files, plus "Fuentes: brand-spec.md, config.yaml"

#### Scenario: Brand with no style files yet
- **WHEN** the user opens the "Marca" tab for a profile with only `brand.json`
- **THEN** they see the palette (from `brand.json`) and, for everything else, "Esta marca no tiene guía de estilo todavía" naming `brand-spec.md`/`profile.md`/`config.yaml`

### Requirement: Composition from the prompt
The new-carousel screen SHALL ask for the prompt, the brand, the template, and optionally library pieces to use, with a single "Crear" action and no mandatory plan-approval step. Submitting SHALL take the user directly into the editor at `/:slug/carousels/:id`: the carousel already exists as a document — every library-sourced piece placed, every piece that needs AI standing in as a `pending` placeholder — and composition continues in the background from there. Slide count is not a field on this screen: it is read from an explicit number in the prompt (e.g. "en 4 pasos", "6 láminas") when present, or otherwise from the template's own default. The prompt header SHALL show ongoing progress ("Generando... X/Y piezas") and the accumulated cost while the background composition runs, and SHALL surface an error or a "no AI configured" message inline, in Spanish, rather than swallowing it. A read-only plan view remains available on demand, never blocking, via a "Ver plan" control in the prompt header. "Regenerar lo no fijado" from the header SHALL respect pinned pieces and warn how many it's about to touch.

#### Scenario: Prompt to editor with no approval step
- **WHEN** the user writes a prompt and presses "Crear"
- **THEN** the browser navigates straight to `/:slug/carousels/:id` with no intermediate plan-approval screen, the carousel is visible immediately with its AI-bound pieces shimmering as pending, the prompt header shows "Generando... X/Y piezas" while the background job runs, and the shimmer clears piece by piece as each one completes

#### Scenario: Ver plan is optional and non-blocking
- **WHEN** the user presses "Ver plan" in the prompt header at any point, including while composition is still running
- **THEN** a read-only drawer shows each slide's pieces with their slot, kind, origin (library/IA) and pending state, and closing it does not affect composition or navigation

#### Scenario: Regenerar lo no fijado with pinned pieces
- **WHEN** the user presses "Regenerar lo no fijado" with 4 pieces pinned across 6 slides
- **THEN** the UI states "se regeneran N piezas, 4 fijadas se conservan" ("N pieces will be regenerated, 4 pinned ones are kept") and asks for confirmation before spending

### Requirement: Undo and redo
There SHALL be an undo/redo stack over the document on the client, persisted to the server after each confirmed change (debounced), with standard keyboard shortcuts. AI operations are not undone through this stack: they remain as document versions.

#### Scenario: Undo a move
- **WHEN** the user moves a headline and presses undo
- **THEN** the headline returns to its previous position and the saved document reflects the state after the undo

### Requirement: Planned routes
The application SHALL use the routes `/`, `/:slug/carousels`, `/:slug/carousels/:id` (the editor). The "Carruseles" button navigates to the listing. Detail view and gallery cards are out of scope; only the minimal listing to enter and exit a carousel is implemented.

#### Scenario: Reload the editor
- **WHEN** the user reloads the browser at `/:slug/carousels/:id`
- **THEN** they return to the same carousel and the same active slide
