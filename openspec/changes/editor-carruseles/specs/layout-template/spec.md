## ADDED Requirements

### Requirement: Layout template with an engine default and a brand override
A layout template SHALL be a JSON with `id`, `canvas`, `zones` (locked zones), `slides` (slots by slide type) and an optional `defaultSlideCount` (a positive integer). Defaults SHALL live in `system/ig-carousel/layouts/<id>.json` and MUST NOT contain hex colors, copy or names: only geometry, `brand.json` roles and copy keys. A brand SHALL be able to override any part in `profiles/<slug>/templates/<id>.json` by deep partial merge. The resolved result is validated against a schema and fails naming the invalid key.

`defaultSlideCount` is the template's own fallback for how many step slides a freshly composed carousel gets when the prompt doesn't name a count and the caller doesn't pass one explicitly (piece-generation spec's composition plan step-count resolution). A template with no `defaultSlideCount` at all falls back to the engine's own absolute default.

#### Scenario: Prompt names no slide count
- **WHEN** a carousel is created with a prompt that doesn't say how many slides, no explicit `slideCount`, and a template declaring `defaultSlideCount: 6`
- **THEN** the composed carousel gets 6 step slides (plus cover and closing)

#### Scenario: Partial override
- **WHEN** the profile declares only `zones.footer.height: 140`
- **THEN** the resolved template keeps the rest of the default and uses 140 px for the footer

#### Scenario: Default with no brand override
- **WHEN** `profiles/example` is rendered with the `explicativo` template and no override
- **THEN** the render works and `python3 scripts/validate_commit_guardian.py --scan` stays at 0

### Requirement: Locked zones
A template SHALL declare at least the following as locked zones: full-bleed background (`background`), footer with logo and pagination (`footer`), and safety margins (`margins`). Zones MUST NOT be document objects: the template paints them on every slide from the carousel's definition. The UI MUST show them with the mockup's amber dashed border and MUST NOT allow dragging them.

#### Scenario: Attempt to drag the footer
- **WHEN** the user clicks the footer zone on the canvas
- **THEN** no object gets selected and the "Lámina" panel shows the structure with the note that it changes in the template

### Requirement: Slots by slide type
For each slide type (`cover`, `step`, `closing`) the template SHALL declare slots with `name`, `type` (`text` | `asset`), default geometry in canvas px, and a default style (`fontKey`, `fontSize`, `lineHeight`, `align`, `colorRole` for text). The slide type also decides the numbering the footer paints (step N of M, cover, closing).

#### Scenario: Change a slide's type
- **WHEN** the user changes a slide from `step` to `closing`
- **THEN** objects with a `slot` that exists in both types keep their text and take the new type's geometry; slots that don't exist in `closing` remain as free objects with no slot

### Requirement: Inheritance down to slides
A slide object that declares `slot` and carries no `geometry` or own style SHALL inherit them from the resolved template at render time. Changing the template SHALL move every slide with no override. An object moved by hand carries its own `geometry` and MUST be able to be "reset" to the template by clearing that override.

#### Scenario: Template margin change
- **WHEN** the profile changes `zones.margins.left` from 86 to 100 px on a 6-slide carousel where only slide 3's headline has been moved
- **THEN** the headlines on the other 5 slides shift and slide 3's stays where the user left it

#### Scenario: Reset to the template
- **WHEN** the user presses "reset" on an object with an override
- **THEN** the object loses its own `geometry` and returns to the slot's position

### Requirement: Per-carousel template parameters
The document SHALL be able to carry `template.params` (overrides of parameters the template exposes, e.g. footer height or background policy) exactly once for the whole carousel. The system MUST NOT duplicate those parameters per slide.

#### Scenario: Footer adjustment on a carousel
- **WHEN** the user lowers the footer height from the "Lámina" panel
- **THEN** the change is saved in the document's `template.params` and affects every slide of that carousel, not the profile's template
