# Verification checklist

A design system on paper isn't verified until it's been rendered at real
size and looked at the way a real viewer would look at it. Run all five
steps — skipping to "looks fine in the HTML source" is how broken renders
ship.

## 1. Render with the real engine, at real size

Run `system/ig-carousel/render.ts` (or the relevant template function
directly, passing it a brand loaded via `loadBrand(resolveProfileDir(profile))`)
through Playwright and produce an actual PNG at 1080×1350 or
1080×1080. Do not evaluate a design by reading the HTML/CSS in an editor —
`overflow: hidden` on `html, body` (see `document.ts`) means anything that
overflows the fixed canvas is silently clipped, and that's only visible in
the rendered screenshot, never in the source.

## 2. Open the PNG and check contrast/legibility slide by slide

Look at the actual output file, not a preview thumbnail in a file browser.
Confirm:
- Body text is legible at a glance, not just technically above the 24px
  floor from `references/design-principles.md`.
- Text over image/gradient has enough contrast — check the actual crop and
  actual overlay, not a hypothetical "should be fine."
- Nothing got clipped by the fixed canvas (`overflow: hidden` won't warn you
  — silence means it happened).

## 3. Simulate the real context: feed-thumbnail size

Shrink the rendered PNG down to roughly the size it'll appear at in an actual
feed scroll (a few hundred pixels wide) and look at it that way — this matters
most for slide 1, which doubles as the carousel's thumbnail/cover. A slide
that reads fine full-screen can turn into illegible mush at thumbnail size if
type is too small or contrast is too low; catching that here is cheaper than
catching it after publishing.

## 4. Walk the whole sequence, not just slide 1

Render every slide in the set, in order, and look at them as a sequence:
- Does the palette and type system hold steady slide to slide (see
  `references/carousel-format.md`'s brand-consistency rule)?
- Does the layout vary enough to stay interesting without breaking the
  system?
- Does the narrative/content order make sense read start to finish — hook,
  content, close, per `references/carousel-format.md`?

A design that was only ever checked on its best single slide will often have
a jarring slide 5 nobody looked at.

## 5. Confirm web fonts actually loaded before the screenshot

`wrapDocument` in `system/ig-carousel/document.ts` emits the font stylesheet
`<link>` from the `fontsHref` argument each template passes it — sourced from
`brand.googleFontsHref` in `profiles/<name>/brand.json`. A profile that omits
that key gets no font stylesheet at all (deliberate: a system-fonts profile
makes zero external font requests). The renderers call
`page.setContent(html, { waitUntil: "networkidle" })` and then
`page.evaluate(() => document.fonts.ready)` before screenshotting.

If a font fails to load — network hiccup, wrong font name, or a new typeface
referenced in a template but never added to that profile's
`googleFontsHref` URL — Playwright silently falls back to a system font and
the screenshot looks "off" in a way that's easy to miss if you're not
specifically checking for it. When adding or changing a typeface: add the
family to the profile's `googleFontsHref`, then open the rendered PNG and
visually confirm the actual letterforms match the intended font — don't just
trust that the family name was added to `brand.json`. A silent font-fallback
breaks brand identity without throwing any error.
