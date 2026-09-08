# Deck extraction

Three shapes of input, one output: `<output-dir>/slides/slide-01.png` …
`slide-NN.png`, in slide order, zero-padded.

Everything downstream trusts that ordering and never re-derives it. Getting it
wrong here produces a video that renders cleanly, plays cleanly, and is wrong —
which is why this is the stage to be slow at.

## PPTX

```bash
unzip -o -q <deck>.pptx -d "$OUT/tmp"
ls -l "$OUT/tmp/ppt/media/"
```

Slide images land in `$OUT/tmp/ppt/media/`, typically `image1.png` …
`imageN.png`.

### `ppt/media/` order is not slide order

The archive stores media in the order it was **embedded**, which is the order
the deck's author happened to paste things in. `image3.png` is routinely
slide 9. There is no rule to apply here and no filename convention to trust.

**Open the images and look.** Then write the mapping out explicitly:

```bash
cp "$OUT/tmp/ppt/media/image7.png"  "$OUT/slides/slide-01.png"
cp "$OUT/tmp/ppt/media/image2.png"  "$OUT/slides/slide-02.png"
cp "$OUT/tmp/ppt/media/image9.png"  "$OUT/slides/slide-03.png"
# … one explicit line per slide
```

Explicit lines, not a loop. The mapping is data you verified by eye; a loop
would be a rule you guessed.

Two things that help confirm the order fast:

- **The slide XML lists the real order.** `$OUT/tmp/ppt/slides/slide1.xml`,
  `slide2.xml`, … are in slide order, and each references its media by
  relationship id. `$OUT/tmp/ppt/slides/_rels/slideN.xml.rels` maps that id to
  the file in `media/`:

  ```bash
  for f in "$OUT"/tmp/ppt/slides/_rels/slide*.xml.rels; do
    echo "== $(basename "$f")"; grep -o 'media/[^"]*' "$f"
  done
  ```

  Note `slide10.xml` sorts before `slide2.xml` in a shell glob — read the
  numbers, don't trust the listing order.

- **Count first.** If `media/` holds more files than the deck has slides, some
  are logos, icons or backgrounds, not slides. Fewer, and some slides are
  vector or text-only and were never embedded as images — go to the PDF route
  below instead.

### When the deck isn't a set of full-slide images

A deck built from text boxes and shapes has no full-slide PNG to extract. Do
not try to reassemble it. Export to PDF and use the PDF route — it renders
exactly what the deck looks like, fonts included.

`soffice` (LibreOffice) does it headless **if it is installed** — check first,
because it is not present by default on macOS:

```bash
command -v soffice && soffice --headless --convert-to pdf --outdir "$OUT" <deck>.pptx
```

If it is missing, ask the owner to export the deck to PDF from PowerPoint or
Keynote and hand that over. **Do not install LibreOffice to work around this:**
it is a multi-gigabyte dependency for a one-line export the owner can do in
five seconds.

## PDF

`pdftoppm` numbers its output in page order, which for a deck **is** slide
order. This is the reliable route, and the reason to prefer PDF when both are
available.

```bash
pdftoppm -png -r 150 -f 1 <deck>.pdf "$OUT/slides/slide"
```

Gives `slide-01.png`, `slide-02.png`, … with padding matching the page count.
`-r 150` at 16:9 lands comfortably above 1920x1080; the render scales down
with lanczos, which is sharper than scaling up. Do not go below 150 for slides
with body text.

Confirm the count matches the deck:

```bash
ls "$OUT"/slides/slide-*.png | wc -l
pdfinfo <deck>.pdf | grep Pages
```

If `pdftoppm` padded to a different width than you expect (`slide-1.png` for a
9-page deck), re-pad before continuing:

```bash
cd "$OUT/slides" && for f in slide-?.png; do mv "$f" "slide-0${f#slide-}"; done
```

## A folder of flat images

Someone sends PNGs or JPGs with no deck behind them. Two things change:

- **Verify the ordering has a real source.** Filenames may be
  `Screenshot at 11.32.png` — creation time, not slide order. Ask,
  or look at the images and order them yourself. Never infer order from a
  filename you did not create.
- **There is no text layer.** The narration cannot be written by extracting
  the deck's text, because there is none — **read the text off the images**.
  This is a real reading task, not an extraction step: numbers, reference
  codes and acronyms come off the slide by eye and must be transcribed
  exactly before being normalized for the ear.

Normalize into the same shape as the other routes:

```bash
i=1
for f in <ordered list>; do
  cp "$f" "$(printf "$OUT/slides/slide-%02d.png" $i)"
  i=$((i+1))
done
```

## Before moving on

```bash
ls -l "$OUT"/slides/
```

Open the first, the last, and two from the middle. Confirm they are the slides
you expect at those positions. Mixed source sizes are fine — the render
normalizes every clip to 1920x1080 — but mixed *aspect ratios* will letterbox
inconsistently, so flag that to the owner rather than silently squeezing.
