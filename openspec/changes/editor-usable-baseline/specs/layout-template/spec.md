## MODIFIED Requirements

### Requirement: Locked zones
A template SHALL declare at least the following as locked zones: full-bleed background (`background`), footer with logo, pagination and an optional signature (`footer`), and safety margins (`margins`). Zones MUST NOT be document objects: the template paints them on every slide from the carousel's definition. The UI MUST show them with the mockup's amber dashed border and MUST NOT allow dragging them.

Zones are the mechanism by which a template grounds a composition. What a template fixes is the frame — shape, logo, borders, typography, signature and margins. Content assets (images, icons, 3D pieces) are deliberately NOT fixed by the template: they are chosen freely per carousel.

#### Scenario: Attempt to drag the footer
- **WHEN** the user clicks the footer zone on the canvas
- **THEN** no object gets selected and the "Lámina" panel shows the structure with the note that it changes in the template

#### Scenario: A document cannot override a zone
- **WHEN** a document declares an object positioned in the footer zone's band
- **THEN** the zone is still painted by the template over the slide, and the document's object cannot replace or displace it

## ADDED Requirements

### Requirement: Footer signature
The footer zone SHALL support an optional signature: a single line of text painted by the engine, resolved from a brand copy key, with a font key and a colour role declared by the template. The signature's text, position and style come from the template and the brand — never from a document object — which makes it structurally unreachable from any composition, whether written by a person or by an AI.

A template that declares no signature paints none.

#### Scenario: A template that declares a signature
- **WHEN** a carousel is rendered with a template whose footer declares a signature
- **THEN** every slide carries the same signature line, in the same position, using the brand's copy for the declared key, and no document object can alter it

#### Scenario: The brand does not define the copy key
- **WHEN** a template declares a signature whose copy key is absent from the brand
- **THEN** validation fails naming the missing key's path, rather than rendering an empty or placeholder line

### Requirement: Template reference on the document
A carousel document SHALL carry its template as an explicit, changeable reference, and that reference SHALL be optional. A document with no template reference is valid: it renders on the brand's palette and fonts with no zones painted and no slots imposed. Changing the reference on an existing document SHALL re-resolve its zones and slot geometry without discarding content held in slots that exist in both templates.

#### Scenario: A document with no template
- **WHEN** a document carrying no template reference is validated and rendered
- **THEN** it is accepted, the brand's palette and fonts apply, and no zone is painted

#### Scenario: Changing the reference
- **WHEN** a document's template reference is changed to another template available to the brand
- **THEN** objects in slots present in both keep their content and take the new geometry, and objects in slots absent from the new template remain as free objects with no slot
