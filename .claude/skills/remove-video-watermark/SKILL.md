---
name: remove-video-watermark
description: >-
  Remove a fixed-position watermark or badge from slides, images or video
  frames without leaving a visible scar: classify what the watermark sits on
  top of, then derive the technique from that classification. Use whenever
  the user asks to "quitar la marca de agua", "sacar el logo de NotebookLM",
  "limpiar el watermark de estas láminas", "borrar el badge de la esquina",
  or reports that a previous attempt left a blur, a smudge or a visible
  patch. NOT for removing the BACKGROUND behind a subject (that is
  `hyperframes-cli remove-background`). NOT for producing the narrated video
  itself (that is `narrated-slide-video`, which calls this skill when its
  source slides carry a badge).
---

# Remove a fixed-position watermark

A watermark is not one problem. It is three, and which one you have is
decided by **what lies underneath it** — not by the watermark, not by the
file format, and not by which filter you happen to know.

This skill exists because that was learned the expensive way. On the
reference deck, removing one badge from 11 slides took **four failed
approaches** before the right one. Every failure had the same root cause:
a filter was chosen first and the background examined afterwards. The order
is the whole lesson.

**Classify first. The technique follows from the classification.**

## 1. The decision table

This table is the skill. Everything else supports it.

| What is under the watermark | Technique | Result |
|---|---|---|
| **Flat fill** (solid black, white, any single colour) | `drawbox` in that same colour, `t=fill` | Invisible. Genuinely undetectable. |
| **Periodic pattern** (stripes, grid, texture) | Copy a block from the same edge, offset by a whole number of periods | Invisible if the period is measured, seamed if guessed |
| **Unique geometry** (non-repeating shapes, an object crossing the box) | Crop the affected edge away and rescale to the original resolution | Clean. Costs a few pixels of frame. |

Two rules that are not optional:

- **Sample the colour, never assume it.** A background that reads as black
  is very often `#010101` or `#12151a`. `drawbox` with `#000000` over
  `#12151a` leaves a rectangle you can see.
- **Measure the period, never guess it.** A shift that is not a whole
  number of periods puts a seam through the pattern, which is more
  conspicuous than the watermark was.

## 2. Never use `delogo`

`delogo` is the filter whose name matches the task, which is why it gets
tried first, and it is **the wrong answer in every one of the three cases**.

It interpolates from the box's edges and leaves a **blurred smudge** — a
soft, obviously-wrong patch that draws the eye more than a crisp badge did.
A viewer reads a sharp watermark as branding and ignores it; they read a
blur as damage.

It was one of the four failed approaches on the reference deck. Do not
reach for it, and do not reach for it "just to see". There is no background
for which it beats the corresponding row of the table above.

## 3. Locate the box

Extract a frame, magnify the corner, and read the coordinates:

```bash
ffmpeg -v error -i <input> -vf "crop=520:70:855:709,scale=1560:210:flags=neighbor" zone.png
```

Then **open `zone.png` with the Read tool and look at it.** `scale` with
`flags=neighbor` keeps the pixels hard, so edges stay where they are
instead of being smoothed into an estimate.

### Known case: NotebookLM

NotebookLM stamps its badge in the **bottom-right corner**. On a
1376x768 slide, measured:

```
x=1247  y=726  w=126  h=36
```

At another resolution, scale proportionally — the badge keeps its relative
position and size. Verify the scaled box by looking at a magnified crop
before trusting it; a box a few pixels short leaves a bright sliver of the
badge, which is worse than not having tried.

## 4. Classify before touching a filter

```bash
python3 scripts/classify-watermark-zone.py <files>... --box <x>,<y>,<w>,<h>
```

It prints, per file, `flat` (with the sampled hex colour), `periodic` (with
the measured period and the shift to use), or `unique` — each with a
confidence — followed by the technique each verdict selects. `--json`
emits the same thing machine-readably.

The script uses **ffmpeg plus the Python standard library only**. See
`references/pixel-probing.md` for why that constraint is real.

## 5. THE FINDING: the box is constant, the technique is not

**Within a single deck, the background under the badge varies slide by
slide.** This is the trap that produced the failed attempts, because it is
invisible until you check: the badge sits in the same place every time, so
it looks like one problem with one answer.

The reference deck, 11 slides, one badge position:

| Verdict | Slides |
|---|---|
| `flat` | 7 |
| `periodic` | 3 (periods of 69, 79 and 85px — all different) |
| `unique` | 1 |

Applying the majority technique to the whole deck damages four slides.
Note also that the three periodic slides had **three different periods**:
even "it is striped" is not a single answer.

**So: classify every file, and treat each by its own verdict.** The script
takes many files at once and warns you when the verdicts are mixed.

There is a sharper version of this trap. One reference slide had solid
black to the left of the badge and a **large diagonal wedge crossing the
box from the right**. Judging from the strip beside the watermark alone,
it measured flat at full confidence — and painting it black would have cut
a rectangular bite out of the wedge. The classifier therefore also reads
thin bands above and below the box, since anything passing under the
watermark must cross them first. When applying a technique by hand, look
at the corner rather than at one side of it.

## 6. Apply the technique

Full commands, with the flags explained, are in
`references/ffmpeg-recipes.md`. In short:

```bash
# flat — colour comes from the classifier, never assumed
ffmpeg -v error -y -i in.png \
  -vf "drawbox=x=1247:y=726:w=126:h=36:color=0x000000:t=fill" out.png

# periodic — shift is a whole number of measured periods
ffmpeg -v error -y -i in.png -filter_complex \
  "[0:v]crop=126:36:1077:726[p];[0:v][p]overlay=1247:726" out.png

# unique — crop the edge, rescale back to the original size
ffmpeg -v error -y -i in.png \
  -vf "crop=1376:728:0:0,scale=1376:768:flags=lanczos" out.png
```

**Crop-and-rescale is a correct answer, not a defeat.** It costs ~40px of
the bottom edge and a rescale so slight it is invisible at playback size.
Reaching for a cleverer filter to "save" those pixels is how the failed
attempts started.

## 7. Verify by looking

**Extract the corrected frame, magnify the zone, and open it with the Read
tool.** Confirming that the output file exists, or that ffmpeg exited 0,
verifies nothing: every failed attempt on the reference deck also produced
a file, and ffmpeg exits 0 while painting a black rectangle across a yellow
stripe.

```bash
ffmpeg -v error -y -i out.png -vf "crop=520:70:855:709,scale=1560:210:flags=neighbor" check.png
# then: Read check.png and look at it
```

Check for the three things that actually go wrong:

- a **rectangle** faintly visible against the fill → the colour was assumed
  instead of sampled
- a **seam** through the pattern → the shift was not a whole period
- a **blur** → `delogo` got used after all

For video, check more than one frame: a background that is flat at 0:00
may not be at 0:12. If the source is a slideshow, classify each slide
image before it becomes video, which is cheaper and more reliable than
classifying frames afterwards.

Never overwrite the original. Write to a new file, keep the source, so a
wrong verdict costs a re-run and not the footage.

## 8. When NOT to use this skill

| Situation | Use instead |
|---|---|
| Remove the **background behind a subject** (person, product) | `hyperframes-cli remove-background` |
| Produce a **narrated video** from slides that happen to carry a badge | `narrated-slide-video` — it calls this skill for the cleanup step |
| The mark **moves**, changes position or animates | Not this skill: every technique here assumes a fixed box |
| The mark covers **most of the frame** or is a full-frame tint | Not removable without generative fill; say so plainly |
| You have access to the **source** that stamped the mark | Re-export without it. Always cheaper and always cleaner. |

That last row deserves the check it rarely gets. If the deck can be
re-exported, re-shared or re-rendered without the badge, do that instead —
no pixel surgery survives comparison with a clean source.

## 9. Rules

- **Classify before filtering.** Choosing a filter first is the single
  error behind all four failed attempts.
- **Never `delogo`.** It loses to every row of the table.
- **Sample colours, measure periods.** Assumed values are what leave scars.
- **Classify every file, not the deck.** The box is constant; the
  background is not.
- **Verify by looking at the pixels**, not by checking that a file exists.
- **Never overwrite the source.**
- Report which verdict each file got and which technique was applied. If
  some files needed crop-and-rescale, say so — the frame changed size, and
  that is the owner's call to accept.
