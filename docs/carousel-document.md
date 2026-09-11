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
- `template?` is **optional**. Its absence means "no template": a free
  composition on the brand's palette and fonts alone, no zone painted, no
  slot imposed — a deliberate, valid choice, not an error state. Do not
  confuse it with `template: null`, which the schema rejects; omit the key.
- `objects[]` is stacking order: the last entry paints on top.
- `pending?: boolean` marks a placeholder the background compose job hasn't
  filled in yet (text drafting, or a library-sourced visual still being
  placed). Cleared to `false` once the job reaches that piece.
- `awaitingImage?: boolean` and `suggestion?: string` (background and asset
  objects only): image generation is never automatic. When a visual slot
  has no library candidate, the compose job stops there instead of calling
  the AI provider — `pending` clears to `false`, `awaitingImage` is set to
  `true`, and `suggestion` carries the planner's own prompt idea for that
  slot. The UI shows a "Generar imagen…" button that opens an editable
  field prefilled with `suggestion`; only an explicit per-piece request
  (`POST .../regenerate` with a `prompt`) generates the image and clears
  `awaitingImage`.

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
result with `loadLayoutTemplate(profileDir, id, params?)`.

`params` is the carousel document's own `template.params` (see "Per-carousel
template parameters" below) and, when given, is deep-merged on top of the
profile's override — last, so a single carousel can nudge a parameter (e.g.
lower `zones.footer.height`) without touching the profile's template file or
affecting any other carousel using the same template id. The whole result
(default → profile override → carousel params) is validated as one document,
so an invalid `template.params` value fails naming the exact key, the same
way an invalid profile override does.

```json
{
  "id": "explicativo",
  "canvas": { "w": 1080, "h": 1350 },
  "zones": {
    "background": { "policy": "fill" },
    "footer": { "height": 120, "logo": "auto", "pagination": "all" },
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
  disables the footer logo entirely — and `pagination`: `"all"` shows
  "N/total" on every slide (the default), `"steps"` only on `kind: step`
  slides, `"none"` shows no pagination at all), `margins`
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

`changeTemplate(doc, from, to)` swaps a document's template reference
(layout-template spec's "Changing the reference"), applying the same
per-object rule as `changeSlideKind` above — template varying, kind fixed,
per slide:

- `slot` exists in `to`'s slots for that `kind`: keeps content and `slot`,
  drops any own `geometry` so `to`'s slot geometry applies.
- `slot` absent from `to` for that `kind`: becomes free — `slot` cleared,
  geometry (own override, or else `from`'s slot geometry) frozen explicitly.
- No `slot` (already free): untouched.

`template.params` are **dropped** on a swap — keyed to the old template's
shape, carrying them over could silently misapply them or fail validation
for a reason unrelated to the swap. `doc.template` becomes `{ id: to.id }`
with no `params`, or is omitted entirely when `to` is the built-in free
template (`freeLayoutTemplate()` / `FREE_TEMPLATE_ID`) — the same state as
an absent `template` key. `changeTemplate` also bumps `updatedAt`, since —
unlike `changeSlideKind`, which returns a `Slide` — it mutates a whole
document.

All of `resolveSlide`/`resetObjectToSlot`/`changeSlideKind`/`changeTemplate`
are pure — they return a new value and never touch disk or mutate input.

## Rendering a document

`renderFreeLayoutSlide(brand, template, doc, slideIndex, ctx)`
(`system/ig-carousel/templates/free-layout.ts`) is the one function that
turns a resolved slide into HTML — the editor's preview iframe and
Playwright's export both call it, so there is no second render to drift out
of sync (design.md D2). `ctx` supplies `assetUrl(assetId)` (an HTTP path in
the browser, a local path for Playwright), an optional `fontFaces` list for
local `@font-face` declarations, and an optional pre-picked `logo` for the
footer's automatic logo (design.md D8) — `renderFreeLayoutSlide` never picks
the logo itself, since that needs the asset index and the slide's real
background color, neither of which it touches.

`renderCarouselDocument({ brand, template, doc, ctx, outputDir, assetExists, browser? })`
(`system/ig-carousel/render-batch.ts`) validates `doc` with
`validateDocument` and renders every slide to `01.png … NN.png` under
`outputDir`, rejecting an invalid document (unknown `assetId`/`colorKey`)
before Chromium opens. It is a standalone function, not a `renderSlides`
overload — `CarouselDocument` slides are not `VerifiedSlide`s, and mixing
the two pipelines would blur the "only `verifyOrThrow` mints a
`VerifiedSlide`" guarantee `system/ig-carousel/types.ts` documents.
