# Carousel document and layout template

Reference for agents and skills that read or write a carousel's files
directly. The authoritative types and validators live in
`system/ig-carousel/carousel-document.ts` and
`system/ig-carousel/layout-template.ts` — this is a summary, not a
substitute for reading them.

## Carousel document

Persisted at `profiles/<slug>/carousels/<carousel-id>/carousel.json`.
`carousel-id` must be a slug (`^[a-z0-9-]+$`).

```json
{
  "schemaVersion": 1,
  "id": "week-34-launch",
  "title": "Launch week",
  "status": "draft",
  "createdAt": "2026-08-17T10:00:00.000Z",
  "updatedAt": "2026-08-17T10:00:00.000Z",
  "canvas": { "w": 1080, "h": 1350 },
  "prompt": { "text": "Explain the launch in 3 steps", "createdAt": "2026-08-17T10:00:00.000Z" },
  "template": { "id": "explicativo" },
  "slides": [
    {
      "id": "slide-1",
      "kind": "cover",
      "background": { "mode": "color", "colorKey": "paper", "pinned": false, "source": "manual" },
      "objects": [
        {
          "id": "obj-title",
          "kind": "text",
          "slot": "title",
          "pinned": false,
          "locked": false,
          "source": "manual",
          "text": "We shipped it",
          "fontKey": "logo",
          "fontSize": 84,
          "lineHeight": 1.1,
          "align": "left",
          "colorKey": "ink"
        }
      ]
    }
  ]
}
```

Key rules:

- **No hex, ever.** `colorKey` and `background.colorKey` are keys into
  `brand.colors` (e.g. `"ink"`, `"paper"`), never a hex literal. Validation
  rejects any `#rgb`/`#rrggbb`/`#rrggbbaa` string anywhere in the document,
  not only in color fields.
- `fontKey` is a key into `brand.fonts` (`logo` | `body` | `handwritten`).
- Geometry (`x`, `y`, `w`, `h?`, `fontSize`) is integer pixels of the
  declared `canvas`; `rotation` is degrees; `lineHeight` is dimensionless.
- `slides[].kind` is `cover` | `step` | `closing`.
- `background` is `{mode:'color', colorKey, pinned, source}` or
  `{mode:'asset', assetId, pinned, source}`.
- An object is `text` (`text`, and optionally `fontKey`, `fontSize`,
  `lineHeight`, `align`, `colorKey`) or `asset` (`assetId`, `fit`). Both
  carry `slot?`, `geometry?`, `pinned`, `locked`, `source`. A text object's
  style fields are optional exactly like `geometry`: a slotted object that
  omits one inherits it from the template slot at resolve time (see
  "Inheritance" below); `colorKey`, if present, pins a specific
  `brand.colors` key on that object regardless of the slot's `colorRole`.
- `source` is `'ai' | 'library' | 'manual'` — where the piece came from,
  shown per-piece in the UI (see `specs/piece-generation`).
- `objects[]` is stacking order: the last entry paints on top.

Validate with `validateDocument(doc, { brand, assetExists })` from
`system/ig-carousel/carousel-document.ts`. `assetExists` is an injected
`(assetId: string) => boolean` — pass the asset index's lookup once it
exists (`system/assets/`); the validator does not import that module
itself. A failure reports `{ path, message }[]` with paths like
`slides[2].objects[1].colorKey`, naming exactly the invalid field.

## Layout template

A layout template declares zones and slots for a carousel. The default for
an id lives at `system/ig-carousel/layouts/<id>.json` (generic — no brand
literals) and a profile may override any part at
`profiles/<slug>/templates/<id>.json` (deep partial merge: plain objects
merge key by key, arrays replace wholesale). Load the resolved, validated
result with `loadLayoutTemplate(profileDir, id)`.

```json
{
  "id": "explicativo",
  "canvas": { "w": 1080, "h": 1350 },
  "zones": {
    "background": { "policy": "fill" },
    "footer": { "height": 120, "logo": "auto", "pagination": true },
    "margins": { "top": 96, "right": 86, "bottom": 96, "left": 86 }
  },
  "slides": {
    "cover": {
      "slots": [
        {
          "name": "title",
          "type": "text",
          "geometry": { "x": 86, "y": 594, "w": 908, "rotation": 0 },
          "fontKey": "logo",
          "fontSize": 84,
          "lineHeight": 1.1,
          "align": "left",
          "colorRole": "onSurface"
        }
      ]
    },
    "step": { "slots": [] },
    "closing": { "slots": [] }
  }
}
```

Key rules:

- `zones` are locked: `background` (paint policy), `footer` (height,
  `logo` — `"auto"` picks a variant from the library by contrast, `"none"`
  disables the footer logo entirely — and `pagination`), `margins`
  (top/right/bottom/left). Zones are painted by the template on every slide
  — they are never document objects.
- `colorRole` and `zones.background.policy` are role/policy **names**, not
  values: a `#rgb`/`#rrggbb`/`#rrggbbaa` literal in either is rejected at
  load time (`LayoutTemplateError`, naming the offending field) — the same
  "no hex outside `brand.json`" rule the document schema enforces.
- `slides` has one entry per slide kind (`cover`, `step`, `closing`), each
  with a `slots[]` array. A slot has `name`, `type` (`text` | `asset`),
  default `geometry`, and for `text` also `fontKey`, `fontSize`,
  `lineHeight`, `align`, `colorRole`.
- `colorRole` names a **brand role** (`brand.roles` key, e.g.
  `onSurface`, `accent`, `highlight`) — resolved to a color at render time
  via `color(brand, role)`. Never a `colorKey` or a hex value. This is what
  keeps `system/ig-carousel/layouts/*.json` free of brand literals: only
  geometry, role names and copy keys are allowed there.

## Inheritance (template → carousel → slide)

`resolveSlide(doc, slide, template)` in
`system/ig-carousel/carousel-document-resolve.ts` merges each slide object
against its template slot:

- An object with `slot` and **no own `geometry`** inherits the slot's
  geometry. Changing the template (e.g. a margin) moves every such object.
- An object with its **own `geometry`** always keeps it, regardless of what
  the template says.
- Text style is resolved field by field, independently of geometry:
  `fontKey`, `fontSize`, `lineHeight`, `align` each come from the object if
  it declares one, otherwise from the slot. Changing a slot's `fontSize`
  (or any other style field) in the template therefore moves every object
  that left that field unset, the same way a margin change moves untouched
  geometry — an object that pins its own value for that field is
  unaffected.
- `colorRole` always comes from the slot (a slot names a brand *role*, a
  document object never does). `colorKey`, if the object declares one, is
  kept as-is; it pins a specific `brand.colors` key regardless of the
  slot's `colorRole`.
- `resetObjectToSlot(object)` implements "reset to template": it deletes
  the object's own `geometry`, restoring inheritance. Throws if the object
  has no `slot` (nothing to reset to).

`changeSlideKind(slide, newKind, template)` implements changing a slide's
`kind`:

- An object whose `slot` exists under both the old and new kind keeps its
  text/asset content and its `slot`, and drops any own `geometry` override
  so it takes the new kind's slot geometry.
- An object whose `slot` does not exist under the new kind becomes a free
  object: `slot` is cleared and its last-known geometry (own override, or
  the old kind's slot geometry) is frozen as an explicit `geometry`, so it
  does not collapse to the canvas origin.

Both functions are pure — they return a new value and never touch disk or
mutate their input.
