## ADDED Requirements

### Requirement: The AI does not draw text
Image generation MUST produce only backgrounds and figures with no text. Text and the logo are always placed by the template on top. The prompt sent to the image model SHALL include an instruction not to include letters or words, and the UI SHALL show the mockup's note explaining why.

#### Scenario: Background with a headline
- **WHEN** the user's prompt includes a headline
- **THEN** the headline is created as an editable text object and the image prompt does not contain it

### Requirement: The AI drafts basic editable copy
From the carousel's prompt, the system SHALL generate a plan with a headline and, when the slide type calls for it, a short body per slide, as `text` objects with `pinned: false`. Text MUST respect the slot's limits without mutilating words (the prompt explicitly forbids this, see the known pitfall in `app/ESTADO.md`) and MUST be editable on the canvas from the first moment.

Creating the carousel is immediate and has no mandatory plan/approval step: `POST .../carousels` writes a document right away where every text object that needs drafting starts as a `pending: true` placeholder (empty text) and a background compose job (`GET .../compose/:jobId`) fills each one in afterward, one slide's copy call at a time, persisting after every piece. The editor opens on this placeholder document immediately — the user edits while the job is still running rather than waiting on a plan screen.

#### Scenario: Initial prompt
- **WHEN** the user writes "un carrusel que explique X paso a paso, con el template explicativo, usando las fotos de los assets" ("a carousel explaining X step by step, with the explicativo template, using the photos from the assets")
- **THEN** they get N slides with a cover, steps and a closing, each starting as a `pending` placeholder that becomes an editable headline and body as the background job reaches it, and the slide count is editable afterward

### Requirement: Library first, generate later
For each visual slot in the plan (background, figure, decoration) the system SHALL search the brand's approved library first by `kind` and `tags` and propose the best candidate. Composing from the library MUST be a first-class path in the UI, not a fallback.

Library-sourced pieces are placed synchronously, at document-creation time — there is no `pending` phase for them, since no AI call and no wait is needed. Image generation MUST NEVER happen automatically, for any piece, at any point — not at document creation, not in the background compose job, and not from a bulk action. A visual slot with no library candidate becomes an `awaitingImage: true` placeholder carrying a `suggestion` (the planner's own prompt idea, derived from the carousel prompt and the slot) instead of a generated image. The UI SHALL offer a button on every such placeholder that opens an editable text field, prefilled with `suggestion` and showing the estimated cost; only submitting that field — an explicit, per-piece, user-approved request — actually calls the AI provider and attaches the resulting image. Text drafting is exempt from this: it is cheap enough to run automatically, exactly as before.

#### Scenario: Character already approved
- **WHEN** the library has approved characters with the requested tag
- **THEN** the plan places one of them and marks it "de biblioteca · 0¢" ("from the library · 0¢"), with a "generate instead" option

#### Scenario: Empty library
- **WHEN** the brand has no approved background
- **THEN** the background stays an `awaitingImage: true` placeholder (rendered as a dashed "Por generar" box) with a "Generar imagen…" button; no image is generated and no cost is spent until the user opens that field and confirms

### Requirement: Regeneration per piece
Regeneration SHALL be requestable for a single piece (this background, this character, this headline) or for "lo no fijado" ("what's not pinned") on a slide. A regeneration MUST NOT touch any piece with `pinned: true`, nor any other slide. There is no "redo" that replaces the whole carousel while ignoring pinned pieces.

Every per-piece image request — whether attaching a first image to an `awaitingImage` placeholder or regenerating one that already has one — goes through an editable prompt field the user must submit explicitly, and the request MAY override the planner's `suggestion`/the piece's last prompt with the user's own text. "Lo no fijado" ("what's not pinned") is a bulk, no-per-piece-prompt action: since it cannot show or confirm a per-piece prompt or cost, it MUST NOT generate or regenerate any image — it only redrafts unpinned text objects. An unpinned visual piece (background or asset object) is left exactly as it is by this action, whether or not it already has an image.

#### Scenario: Change only the character
- **WHEN** the user liked the background and the copy but not the character, and asks to regenerate the character
- **THEN** they get a field prefilled with the character's last prompt and its cost; only after they confirm does that object change — background and text stay the same, and the previous character remains as a candidate in the library

#### Scenario: Regenerate a headline
- **WHEN** the user asks for another wording of a slide's headline
- **THEN** the text redrafts immediately (no per-piece prompt/cost confirmation — text drafting is exempt from the explicit-request rule) and the object keeps its geometry, color and font

#### Scenario: "Regenerar lo no fijado" with an ungenerated background
- **WHEN** a slide has an unpinned `awaitingImage` background and an unpinned headline, and the user clicks "Regenerar lo no fijado"
- **THEN** the headline redrafts but the background stays exactly as it is — still `awaitingImage: true`, no image generated

### Requirement: Cost recorded and visible
Every call to the AI provider SHALL record `model`, tokens or size, `costCents` and date: in the asset's sidecar if it produced an image, and in the document's `prompt.runs[]` if it produced text. The status bar and the prompt header SHALL show the carousel's accumulated cost and how many pieces came from the library.

While the background compose job is still running, cost and piece counters are the job's own numbers (`costCentsSoFar`, `completedPieces`/`totalPieces`, and `counts.fromLibrary`/`counts.generated`/`counts.drafted` from `GET .../compose/:jobId`) rather than a recount of the document — the prompt header polls the job and shows these live as pieces land, not only once the job finishes. Since the compose job never generates an image, its counters and progress line describe text drafting only; the prompt header additionally shows a count of pieces still `awaitingImage`, with no progress bar for them (there is nothing running in the background to show progress on).

Before a per-piece image request is submitted, the UI SHALL show its estimated cost (`GET /api/ai/pricing`, a flat per-image estimate from `pricing.ts`) next to the editable prompt field; the actual `costCents` the request spent comes back in the `POST .../regenerate` response.

#### Scenario: Carousel composed with no generation
- **WHEN** every visual piece came from the library and only text was drafted
- **THEN** the cost shown is the text's cost, and the header shows "N piezas de biblioteca · 0 fondos generados" ("N pieces from the library · 0 generated backgrounds")

#### Scenario: Compose job still running
- **WHEN** the background compose job has drafted 3 of 7 pending text pieces
- **THEN** the prompt header shows "3/7 piezas" for text drafting, updating as each subsequent piece completes

#### Scenario: Cost shown before spending it
- **WHEN** the user opens the "Generar imagen…" field for an `awaitingImage` background
- **THEN** the field shows the estimated cost (e.g. "~0,4¢") before the user clicks "Generar", and the response after clicking carries the actual `costCents` spent

### Requirement: Every piece is marked with its origin
Every visual object in the document (background, figure, photo) SHALL record its origin: `source: 'ai'` if it came from a generation, or `source: 'library'` with the library's `assetId` if it was composed from an already-approved piece. The origin MUST persist in the document and be available for the UI to show per piece, not only as a carousel-level aggregate.

#### Scenario: Origin visible per piece
- **WHEN** a slide has an AI-generated background and a character taken from the library
- **THEN** the document stores `source: 'ai'` on the background and `source: 'library'` with its `assetId` on the character, and each is distinguishable in the interface

### Requirement: Library ratio with history
The system SHALL compute, for a carousel, what percentage of its visual pieces has `source: 'library'`, and SHALL be able to compare that percentage with earlier carousels of the same brand (by export date) to show the reuse trend over time.

#### Scenario: Reuse trend
- **WHEN** the current carousel has 62% library pieces and the carousel exported a month ago had 0%
- **THEN** the system exposes both percentages so the UI can show them together

### Requirement: Provider behind an interface
Generation SHALL be implemented behind a `PieceGenerator` interface with `draftCopy(plan)` and `generateImage(spec)`. The initial implementation uses OpenAI with a key in `OPENAI_API_KEY` read from the root `.env`. No provider literal MUST appear outside its implementation. With no key, the editor starts and works for composing from the library and editing; only generation is disabled, with a warning.

#### Scenario: No key configured
- **WHEN** `OPENAI_API_KEY` doesn't exist
- **THEN** the editor opens, allows composing and exporting, and the generate buttons explain which variable is missing

### Requirement: Color assignment from the palette
When the AI creates text objects, the color SHALL be assigned by the slot's role (the template's `colorRole`) resolved to a `brand.colors` key, and contrast SHALL be checked against the real background with `core/color.js`; if it fails AA, the palette key with the best contrast is chosen instead. The AI MUST NOT invent colors.

#### Scenario: Light generated background
- **WHEN** the generated background turns out light and the role called for a light ink
- **THEN** the headline takes the palette key with the best contrast, and the Contrast panel shows it measured
