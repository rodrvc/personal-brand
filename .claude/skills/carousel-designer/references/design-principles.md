# Design principles: type scale, spacing, contrast

Numbers here are calibrated for the two real render targets — **1080×1350**
(4:5, current default, hardcoded as `CANVAS_WIDTH`/`CANVAS_HEIGHT` in
`system/ig-carousel/document.ts`) and **1080×1080** (1:1). Both are portrait-ish
or square, both get viewed small on a phone feed, both get scrolled past in
under a second. That's a different job than a 1920×1080 deck slide viewed on a
projector or laptop — everything below is sized for a thumb-scroll, not a
presentation.

## Type scale

Four roles cover every template variant seen in `system/ig-carousel/templates/`.
Don't invent a fifth without a reason — more sizes than roles is how type
scales rot.

| Role | 1080×1350 (4:5) | 1080×1080 (1:1) | Used for |
|---|---|---|---|
| Title (large) | 64–72px | 56–64px | Slide 1 hook, single-focus statement slides |
| Title (medium) | 40–48px | 36–44px | Per-item titles when a slide holds multiple items (e.g. `list-format`'s 3-events-per-image layout) |
| Body | 28–32px | 26–30px | Subtitle, supporting sentence, any prose line |
| Caption / meta | 20–24px | 20–22px | Date/time/venue meta, category labels, slide numbering |

The square canvas gets a slightly smaller scale across the board because it
has ~19% less vertical room than the 4:5 canvas at the same width — same
horizontal reading width, less height to spend on line-height and margins, so
sizes step down rather than wrapping more lines.

**Hard floor: body copy never renders below ~24px in the final PNG.** This
isn't a style preference, it's a legibility fact — someone is looking at this
on a 6-inch screen at arm's length while scrolling, not reading it on a
monitor. If a layout forces body text under 24px to fit, the layout is wrong,
not the type scale.

## Spacing grid

`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64` px. Every margin, padding, and gap value
in a template should be one of these eight numbers — not because the grid is
sacred, but because mixing arbitrary values (18px here, 22px there) is what
makes a layout feel unintentional even when no single choice looks wrong.
This grid is canvas-size-agnostic — reuse it as-is for both 1080×1350 and
1080×1080, don't invent a second grid for the square variant.

Rough allocation for a full-bleed or split layout on 1080×1350:
- Outer margin: 64px
- Block-to-block gap (e.g. title to subtitle): 16–24px
- Section-to-section gap (e.g. content block to meta row): 32–48px
- Micro gaps (icon to label, pill padding): 8–12px

## Color budget

**Maximum 1–2 background colors across an entire carousel.** Not per slide —
across the whole set. If slide 3 introduces a third background color with no
system behind it, the palette stops meaning anything; color should signal
something (category, section, hierarchy), not just decorate. A single
accent color used consistently (whatever the profile maps to the `accent`
role) reads as intentional. Five colors used once each reads as random.

## Text budget

**~40 words of body copy per slide, max.** This is tighter than a deck slide
on purpose — a carousel is scroll-speed content, not sit-down reading. If a
slide needs more than 40 words to make its point, split it into two slides or
cut the point down. Titles and meta lines don't count against this budget;
it's specifically the body/subtitle prose.

## Contrast

Text over image or gradient needs a scrim, not a hope. If a template places
white title text directly over a photo (`full-bleed`-style layouts), verify
contrast at the actual crop the image will use — a scrim, gradient overlay,
or solid text-safe zone behind the type is not optional, it's the difference
between "looks like a designer built this" and "looks like white text
disappeared into a photo."
