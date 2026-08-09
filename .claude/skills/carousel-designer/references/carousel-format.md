# Carousel format: structure that's specific to carousels, not decks

A carousel isn't a deck with a different aspect ratio. It's consumed by swipe,
on a phone, competing with an infinite feed for a fraction of a second of
attention per slide. The structural rules below come from that consumption
pattern, not from slide-design conventions in general.

## Slide count

**5-10 slides for Instagram, sweet spot around 7.** Below 5, it barely
qualifies as a carousel and might as well be a single post. Above 10, swipe
fatigue sets in — most viewers won't make it to slide 11 even if slide 1
hooked them. LinkedIn tolerates more slides than IG, especially for
educational/text-carousel content, because the LinkedIn audience is already
in a slower, more read-y mode — but "tolerates more" isn't "should default to
more." Start from 7 and adjust for how much real content there is, not the
other way around.

## Slide 1 = the hook, and only the hook

Slide 1 is the only slide guaranteed to be seen before a swipe decision gets
made — it functions as a thumbnail as much as a slide. That means:

- Maximum clarity of value proposition. Someone should understand what
  they're about to get from this carousel within a glance, not after
  reading a paragraph.
- Don't open with dense content, a stat, or a sub-point — that's slide 2+
  material. Slide 1's only job is "convince the swipe."
- It should still work legibly at feed-thumbnail size, not just full-screen
  — see `references/verification-checklist.md` step 3 for how to check this.

## Middle slides = content, with variation inside a system

Each middle slide needs its own visual hierarchy — don't repeat the exact
same layout seven times in a row, that reads as a template being filled in
rather than content being presented. But "vary the layout" doesn't mean
"abandon the system" — same type scale, same palette, same signature move,
just applied to different content shapes (a single stat slide looks
different from a two-column-comparison slide, even sharing the same fonts and
colors).

For this project specifically, `system/ig-carousel/templates/list-format.ts`
is a *group* template — it renders up to 3 events per image rather than one
event per slide (see `SlideGroupTemplate` in `system/ig-carousel/types.ts`,
which takes `(brand, slides, options?)` where the single-slide
`SlideTemplate` takes `(brand, slide, options?)`).
That's a deliberate density choice for a "digest of the week's events" format,
different from the other three variants (`full-bleed`, `split-card`,
`decorative-frame`) which are one-event-per-slide. Match the template variant
to the content shape — a single standout event probably wants a one-per-slide
variant, a weekly roundup probably wants `list-format`'s density.

## Last slide = close, not necessarily hard-sell

Classic carousel advice says "always end with a CTA" (follow, save, link in
bio). That's the right default for a personal-brand growth carousel. For a
recurring digest of dated items — a weekly events roundup, say — a simpler
closing slide (branding, maybe a pointer to the brand's own site, no
aggressive conversion push) fits the content better: it's a useful digest,
not a lead
magnet, and treating it like one would clash with the "this is genuinely
useful info" tone the rest of the carousel earns.

## Aspect ratios

- **1080×1350 (4:5)** — the current default (hardcoded in
  `system/ig-carousel/document.ts` as `CANVAS_WIDTH`/`CANVAS_HEIGHT`).
  Recommended: occupies more vertical feed real estate than a square post,
  which is a real advantage in a scroll-based feed.
- **1080×1080 (1:1)** — more universal/repost-compatible (some placements
  and cross-posts still expect square). Use when a slide set needs to travel
  outside its native IG placement.

Don't design for a third ratio without checking it's actually a target — the
render engine only knows about these two canvas sizes today.

## Mobile legibility, restated for format specifically

The viewer sees this on a ~6-inch screen, at arm's length, mid-scroll. That
means: no paragraphs (see the ~40-word budget in
`references/design-principles.md`), every slide's main point graspable in
under a second, and type sizes that hold up at that real physical size — not
just look fine zoomed in on an editor screen while building it.

## Brand consistency across slides in one carousel

Same typographic system and palette across every slide in a single carousel,
even as layout varies slide to slide. A carousel where slide 4 suddenly uses
a different font or introduces an unrelated color reads as broken, not
varied — variation happens in layout and content shape, not in the underlying
system.

## Slide numbering (optional)

"1/7", "2/7" style numbering communicates length upfront and gives a sense of
progress — useful for educational/listicle carousels where the count itself
is part of the pitch ("7 ways to..."). Less necessary for catalog-style
carousels (a weekly events digest, for instance) where the content is
browsable rather than sequential — nobody needs to know they're on "3 of 7"
events, they're scanning for the one that interests them. Add numbering when
it serves the format, skip it when it's just noise.
