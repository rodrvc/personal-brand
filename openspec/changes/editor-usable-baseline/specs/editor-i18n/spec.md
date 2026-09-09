## ADDED Requirements

### Requirement: UI copy resolved from a locale resource
Every user-facing string in the editor SHALL be resolved from a locale resource keyed by a stable identifier, rather than written inline in a component. The default locale ships with the product and covers the whole interface. Adding a language SHALL require adding a locale file and nothing else — no component may need editing to change or translate what it displays.

#### Scenario: A string has no entry for the active locale
- **WHEN** the interface asks for a key the active locale does not define
- **THEN** the default locale's text is used, and the missing key is reported to the developer console rather than rendering the raw key or an empty element

#### Scenario: Adding a language
- **WHEN** a new locale file is added with translations for every key
- **THEN** the interface renders entirely in that language with no component changes

### Requirement: Product copy and technical prose are separate concerns
Locale resources SHALL hold only product copy — what a user of the interface reads. Technical prose in the codebase (code, comments, commit messages, documentation and specifications) SHALL be written in English and MUST NOT be routed through the locale mechanism.

#### Scenario: An error surfaced to the user
- **WHEN** the server returns a validation error and the interface displays it
- **THEN** the message the user reads comes from the locale resource, while the underlying field path and any developer-facing detail remain untranslated
