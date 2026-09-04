## ADDED Requirements

### Requirement: The AI does not draw text
Image generation MUST produce only backgrounds and figures with no text. Text and the logo are always placed by the template on top. The prompt sent to the image model SHALL include an instruction not to include letters or words, and the UI SHALL show the mockup's note explaining why.

#### Scenario: Background with a headline
- **WHEN** the user's prompt includes a headline
- **THEN** the headline is created as an editable text object and the image prompt does not contain it

### Requirement: The AI drafts basic editable copy
From the carousel's prompt, the system SHALL generate a plan with a headline and, when the slide type calls for it, a short body per slide, as `text` objects with `pinned: false`. Text MUST respect the slot's limits without mutilating words (the prompt explicitly forbids this, see the known pitfall in `app/ESTADO.md`) and MUST be editable on the canvas from the first moment.

#### Scenario: Initial prompt
- **WHEN** the user writes "un carrusel que explique X paso a paso, con el template explicativo, usando las fotos de los assets" ("a carousel explaining X step by step, with the explicativo template, using the photos from the assets")
- **THEN** they get N slides with a cover, steps and a closing, each with a basic editable headline and body, and the slide count is editable afterward

### Requirement: Library first, generate after
For each visual slot in the plan (background, figure, decoration) the system SHALL search the brand's approved library first by `kind` and `tags` and propose the best candidate. It SHALL only generate with AI if there's no candidate, if the user asks for one, or if the prompt explicitly requests it. Composing from the library MUST be a first-class path in the UI, not a fallback.

#### Scenario: Character already approved
- **WHEN** the library has approved characters with the requested tag
- **THEN** the plan places one of them and marks it "de biblioteca · 0¢" ("from the library · 0¢"), with a "generate instead" option

#### Scenario: Empty library
- **WHEN** the brand has no approved background
- **THEN** the plan generates the backgrounds, saves them as candidates, and shows their cost

### Requirement: Regeneration per piece
Regeneration SHALL be requestable for a single piece (this background, this character, this headline) or for "lo no fijado" ("what's not pinned") on a slide. A regeneration MUST NOT touch any piece with `pinned: true`, nor any other slide. There is no "redo" that replaces the whole carousel while ignoring pinned pieces.

#### Scenario: Change only the character
- **WHEN** the user liked the background and the copy but not the character, and asks to regenerate the character
- **THEN** only that object changes; background and text stay the same, and the previous character remains as a candidate in the library

#### Scenario: Regenerate a headline
- **WHEN** the user asks for another wording of a slide's headline
- **THEN** they receive up to three text alternatives to choose from, and the object keeps its geometry, color and font

### Requirement: Cost recorded and visible
Every call to the AI provider SHALL record `model`, tokens or size, `costCents` and date: in the asset's sidecar if it produced an image, and in the document's `prompt.runs[]` if it produced text. The status bar and the prompt header SHALL show the carousel's accumulated cost and how many pieces came from the library.

#### Scenario: Carousel composed with no generation
- **WHEN** every visual piece came from the library and only text was drafted
- **THEN** the cost shown is the text's cost, and the header shows "N piezas de biblioteca · 0 fondos generados" ("N pieces from the library · 0 generated backgrounds")

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
