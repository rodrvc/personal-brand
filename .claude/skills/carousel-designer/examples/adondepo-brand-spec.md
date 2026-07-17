# Brand spec: Adondepo

- **Captured on:** 2026-07-07
- **Source(s):** `city-activities-front/src/app/globals.css` (verified against production frontend, https://adondepo.cl); `public/favicon.svg`
- **Completeness:** partial — see notes below

---

## Primary assets

### Logo
- **File(s):** No dedicated logo image file exists. The "logo" is the
  literal word "Adondepo" typeset in the Pacifico Google Font.
- **Light-background variant:** Pacifico wordmark in petrol (`#1a5f7a`) or
  text-dark (`#2d3436`) over the light background (`#f8f6f3`).
- **Dark-background variant:** Not established — no verified dark-background
  wordmark treatment exists in production. Treat as a gap; if a dark
  background is needed, default to a white or gold (`#f5b742`) wordmark
  until confirmed against a real usage.
- **Permitted uses:** Pacifico reserved strictly for the word "Adondepo"
  itself.
- **Forbidden uses:** Never use Pacifico for event titles, body copy, or any
  text other than the literal brand wordmark — this is an explicit rule
  encoded in `system/ig-carousel/brand.ts`'s `fonts.logo` comment.

### Photography / product renders
- **Available:** No — not collected as part of this spec. Event thumbnail
  images used in carousels come from each event's own source image, not from
  a brand photography library.
- **Notes:** Flagged gap — see Completeness notes.

### UI screenshots
- **Available:** No — not collected as part of this spec.
- **Verified clean of third-party/demo contamination:** N/A (none collected)

The one real graphic asset that does exist: `public/favicon.svg` — a square
icon, ~100px corner radius on a 512px frame, filled with the gold→coral
gradient (`linear-gradient(135deg, #f5b742, #ff7a6b)`), with a white "A" set
in Pacifico centered on it.

---

## Auxiliary assets

### Color palette

| Color | Hex | Usage | Source |
|---|---|---|---|
| Petrol | `#1a5f7a` | Brand/logo primary | `globals.css` |
| Terracotta | `#e05a47` | Accent / CTA | `globals.css` |
| Gold | `#f5b742` | Favicon gradient stop; category "Destacados" gradient stop | `globals.css`, `public/favicon.svg` |
| Coral | `#ff7a6b` | Favicon gradient stop | `globals.css`, `public/favicon.svg` |
| Text dark | `#2d3436` | Primary text | `globals.css` |
| Text secondary | `#6b7280` | Secondary/meta text | `globals.css` |
| Background light | `#f8f6f3` | Default page/canvas background | `globals.css` |
| Música (category) | `#d93647` | Event category color | `globals.css` |
| Deporte (category) | `#0077cc` | Event category color | `globals.css` |
| Cultura (category) | `#7b3a9e` | Event category color | `globals.css` |
| Familiar (category) | `#008f5b` | Event category color | `globals.css` |
| Fiesta (category) | `#e01b1b` | Event category color | `globals.css` |
| Destacados (category) | `#e69500` → `#d4840a` gradient | Event category color, only category using a gradient | `globals.css` |
| Category fallback | `#555555` | Unrecognized/missing category | `globals.css` |

Card border-radius convention: `12px` (also verified in `globals.css`,
carried into `system/ig-carousel/brand.ts` as `radius.card`).

### Typography

| Role | Typeface | Notes |
|---|---|---|
| Display/logo | Pacifico (Google Font, cursive) | Reserved exclusively for the "Adondepo" wordmark — never for event copy |
| Body | Inter | All event titles, subtitles, meta, category labels |
| Mono | none | No monospace typeface established in the brand |

### Vibe keywords

`Warm`, `local`, `discovery-driven`, `informative-not-corporate`,
`weekend-plans`. Adondepo is a Chilean urban-events discovery product — the
tone should feel like a knowledgeable friend telling you what's on this
weekend, not a corporate listings aggregator. These keywords are a proposal
based on the verified palette/type (warm terracotta/gold rather than
corporate blue-and-white, informal Pacifico wordmark rather than a
geometric corporate logotype) — confirm with the user before treating them
as final.

---

## Completeness notes

**Partial.** What's verified: full color palette and typography, sourced
directly from production CSS — high confidence, not inferred. What's
missing:
- No real product photography or UI screenshot library exists for this
  brand yet — event thumbnails come from each event's own source, not a
  brand asset library, so there's nothing to collect here as a "brand
  photography" asset.
- No formal written brand guide exists anywhere — everything in this spec
  was reverse-engineered from the live, shipped frontend rather than a
  design document. That's treated as an acceptable source (it's literally
  what the brand looks like in production) but means there's no documented
  rationale behind the color/type choices beyond "this is what's live."
- No dark-background wordmark treatment has been verified in any real
  usage — flagged above as a gap, with a provisional fallback stated rather
  than left undefined.
