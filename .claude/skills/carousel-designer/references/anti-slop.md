# Anti-slop checklist

Run this against every deliverable — new work and "improve this existing
thing" requests alike. Most "make it better" asks are really "get rid of the
generic tell" in disguise; you can't fix what you don't name.

## Banned outright

- **Purple-to-blue gradient. Sunset gradient. Rainbow gradient.** Any
  gradient whose only job is to look "modern" with no connection to the
  brand's actual palette. If a gradient appears, it should be built from the
  brand's own colors (a brand whose favicon already *is* a gold→coral
  gradient can use that gradient — it's literally the brand's asset) — not a
  generic Dribbble-purple wash.

- **The rounded card with a left-edge accent-bar stripe.** Colored/gradient
  vertical bar on the left edge of a card, rest of the card flat and neutral.
  This is arguably *the* single most over-generated container shape produced
  by AI design tools — it reads as "template," not "designed," the instant
  you've seen it twice.

  **This project used to ship this exact pattern.**
  `system/ig-carousel/templates/list-format.ts` once rendered an
  `.accent-bar` div — a 14px left-edge strip filled with the brand's
  gold→coral gradient — as its container's signature visual. It has since
  been rebuilt: the cards are now soft white panels (rounded corners + a
  subtle shadow, no color frame), and the category signal moved to a small
  label + underline above the title and a solid-color time chip over the
  photo. Keep it that way — if a future edit reintroduces a left-edge colored
  strip as the card's signature, that's a regression to the pattern this rule
  exists to prevent, not a fresh idea. See `references/style-library.md` for
  signature moves that aren't this one.

- **Emoji as default decoration.** No 🎉/✨/🔥 sprinkled in as visual filler
  because a slide "needs something" in a corner. If emoji appear, they should
  be a deliberate brand-voice choice, stated as such — not a default filler
  move.

## Watch for

- **A single default font doing all the work.** Inter, Roboto, Arial,
  system-ui — using one of these is fine, using *only* one of these across
  title and body with no second typeface for contrast is the tell. Pair a
  workhorse sans with something that has actual personality (a serif, a
  display face, a monospace accent) so type itself carries some of the
  design decision, not just the palette.

- **Decoration with no source.** A shape, icon set, or pattern that isn't
  derived from the brand's actual visual language (its real colors, its real
  category system, its real geometry) and instead looks borrowed from "generic
  tech startup" — geometric blob shapes, generic line-art icons, abstract
  particle/dot backgrounds with no connection to what the brand is about.

- **Symmetry as a substitute for hierarchy.** Every slide centered, every
  element the same size, nothing established as more important than anything
  else. Real hierarchy means something is clearly first, and something is
  clearly last.

## The one question that catches most of it

**Would this look like it came from a specific designer with a point of
view, or could literally any AI have generated it from the same three-word
prompt?**

If the honest answer is "any AI," go back to `references/style-library.md`,
pick a named direction with actual opinions attached, and rebuild from there.
Vague "make it look nice" instincts are exactly how slop happens — a named
style with a signature move and a list of things to avoid is what prevents
it.
