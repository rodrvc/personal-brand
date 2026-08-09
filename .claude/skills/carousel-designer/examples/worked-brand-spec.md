# Brand spec: Ferigo (marca ficticia de ejemplo)

> **This is a teaching example built on an invented brand.** Nothing here
> describes a real product. It exists to show the *shape* of a finished
> brand-spec: how to record provenance, how to state a rule, and how to
> declare a gap instead of inventing an answer.
>
> The authoritative spec for any real brand is that profile's own
> `brand-spec.md`, outside this repo (see `BRAND_PROFILES_DIR` in CLAUDE.md).
> A real spec is never copied into this skill — it would drift, and it would
> put brand data in the generic layer.

- **Captured on:** 2026-01-15
- **Source(s):** `<frontend-repo>/src/app/globals.css` (verified against the
  production site, `https://<domain>`); `public/favicon.svg`
- **Completeness:** partial — see notes below

The source line is the most important part of a real spec. "Verified against
production CSS" and "proposed, unconfirmed" are different confidence levels,
and a designer downstream needs to know which one they are reading.

---

## Primary assets

### Logo
- **File(s):** No dedicated logo image file exists. The "logo" is the literal
  wordmark typeset in a display font.
- **Light-background variant:** wordmark in the brand primary or text-dark
  color over the light background.
- **Dark-background variant:** Not established — no verified dark-background
  treatment exists in production. Treat as a gap; if a dark background is
  needed, default to a white wordmark until confirmed against real usage.
- **Permitted uses:** the display font is reserved strictly for the wordmark.
- **Forbidden uses:** never use the display font for content titles, body
  copy, or any text other than the wordmark — this kind of rule belongs in
  `brand.json` as a font *role*, so the engine enforces it instead of relying
  on a designer remembering.

### Photography / product renders
- **Available:** No — not collected as part of this spec. Content thumbnails
  come from each item's own source image, not from a brand photography
  library.
- **Notes:** Flagged gap — see Completeness notes.

### UI screenshots
- **Available:** No — not collected as part of this spec.
- **Verified clean of third-party/demo contamination:** N/A (none collected)

Example of the one real graphic asset a small brand often does have:
`public/favicon.svg` — a square icon, ~100px corner radius on a 512px frame,
filled with a two-stop warm gradient, with a white initial centered on it.

---

## Auxiliary assets

### Color palette

Hex values below are invented. What matters is the **shape**: every color has
a single named usage and a verifiable source.

| Color | Hex | Usage | Source |
|---|---|---|---|
| Primary | `#1f6f8b` | Brand/logo primary | `globals.css` |
| Accent | `#e0603f` | Accent / CTA | `globals.css` |
| Highlight A | `#f2b13c` | Favicon gradient stop; featured-category stop | `globals.css`, `favicon.svg` |
| Highlight B | `#ff7f6d` | Favicon gradient stop | `globals.css`, `favicon.svg` |
| Text dark | `#2d3436` | Primary text | `globals.css` |
| Text secondary | `#6b7280` | Secondary/meta text | `globals.css` |
| Background light | `#f8f6f3` | Default page/canvas background | `globals.css` |
| Category 1…N | varies | One color per content category | `globals.css` |
| Category fallback | `#555555` | Unrecognized/missing category | `globals.css` |

Two conventions worth copying from this example:

- **A fallback color is not optional.** Without it, an unmapped category
  renders as `undefined` inside a published image.
- **Only one category uses a gradient** in the brand this was modeled on.
  Record that kind of asymmetry — a designer who doesn't know it will
  "helpfully" make the rest match and flatten the hierarchy.

Card border-radius convention: `12px` (also verified in `globals.css`,
carried into `brand.json` as `radius.card`).

### Typography

| Role | Typeface | Notes |
|---|---|---|
| Display/logo | a cursive/display face | Reserved exclusively for the wordmark — never for content copy |
| Body | a neutral sans (e.g. Inter) | All titles, subtitles, meta, category labels |
| Mono | none | No monospace face established in the brand |

Note the *roles*, not the names. `brand.json` maps roles → families, so the
engine never needs to know which font a given brand chose.

A trap worth recording here when it applies: a display font that ships in a
single weight cannot take `font-weight: 900`, and often needs a looser
`line-height` or its ascenders clip.

### Vibe keywords

`Warm`, `local`, `discovery-driven`, `informative-not-corporate`. Written as
a *proposal* derived from the verified palette and type (warm accents rather
than corporate blue, an informal wordmark rather than a geometric logotype) —
and explicitly marked as needing confirmation before being treated as final.

That distinction is the point: palette and type were *verified*; the vibe was
*inferred*. Say which is which.

---

## Completeness notes

**Partial.** What's verified: full color palette and typography, sourced
directly from production CSS — high confidence, not inferred. What's missing:

- No real product photography or UI screenshot library exists yet — content
  thumbnails come from each item's own source, so there is nothing to collect
  as a "brand photography" asset.
- No formal written brand guide exists — everything was reverse-engineered
  from the shipped frontend rather than a design document. That is an
  acceptable source (it is literally what the brand looks like in
  production), but it means there is no documented rationale behind the
  choices beyond "this is what's live."
- No dark-background wordmark treatment has been verified in any real usage —
  flagged above with a provisional fallback rather than left undefined.

**Declaring a gap is a deliverable.** An honest "not established" stops the
next designer from inventing an answer and shipping it as if it were brand.
