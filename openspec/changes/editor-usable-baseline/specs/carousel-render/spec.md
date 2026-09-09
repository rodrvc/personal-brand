## MODIFIED Requirements

### Requirement: Locked zones painted by the template
The render function SHALL paint background, footer (logo chosen by contrast, pagination per slide type, and the signature when the template declares one) and margins from the resolved template and the carousel; no zone data is read from the slide. Pagination is governed by the template's `zones.footer.pagination` (`"all"` | `"steps"` | `"none"`) — a template parameter, not a fixed rule — so a profile or a single carousel's `template.params` can change whether pagination shows on every slide, only on `step` slides, or not at all.

#### Scenario: Six slides, one footer
- **WHEN** the 6 slides of a carousel are rendered
- **THEN** the footer occupies the same height and position on all of them, and pagination reads 1/6 … 6/6

#### Scenario: Signature painted on every slide
- **WHEN** a carousel is rendered with a template declaring a footer signature
- **THEN** the signature line is painted on every slide at the same position, using the font key and colour role the template declares, resolved against the brand's copy and fonts

## ADDED Requirements

### Requirement: Rendering with no template
The render function SHALL accept a document with no template reference. In that case it paints no zones and imposes no slot geometry, resolving colours and fonts from the brand alone, so that a free composition is renderable and exportable exactly like a grounded one.

#### Scenario: A free carousel exports
- **WHEN** a document with no template reference is exported
- **THEN** every slide rasterises using the brand's palette and fonts, with no footer, margins or background zone painted, and the export completes without error
