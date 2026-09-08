# ffmpeg recipes, per verdict

Every command below was run against the reference deck and the result
inspected by eye. The coordinates in the examples are the measured
NotebookLM box on a 1376x768 slide (`x=1247 y=726 w=126 h=36`); substitute
your own.

Two flags appear everywhere and are not decoration:

- `-v error` — suppresses the banner so stdout carries only real problems,
  which matters when the output is a pipe or a loop over 40 slides.
- `-y` — overwrite the *output* without prompting. It never touches the
  input, and without it a batch loop stops on a hidden interactive prompt.

## Flat fill → `drawbox`

```bash
ffmpeg -v error -y -i in.png \
  -vf "drawbox=x=1247:y=726:w=126:h=36:color=0x000000:t=fill" \
  out.png
```

`t=fill` is the whole point: without it, `drawbox` draws an **outline** and
leaves the watermark sitting inside a freshly drawn rectangle. The default
thickness is 3, so forgetting `t=fill` produces a result that is
unambiguously worse than doing nothing.

`color` takes the sampled value from the classifier. `0x` prefix, six hex
digits. To paint a semi-transparent colour, append `@0.5` — but for
watermark removal you always want the fill opaque.

**Widen the box by 1–2px** past the badge's measured edge. Badges are
composited with anti-aliased borders, so the true extent is a pixel or two
beyond what the eye reads as the edge, and a leftover bright sliver is more
noticeable than the badge was.

## Periodic pattern → shifted block copy

```bash
ffmpeg -v error -y -i in.png -filter_complex \
  "[0:v]crop=126:36:1077:726[p];[0:v][p]overlay=1247:726" \
  out.png
```

Reading it: crop a patch the same size as the box from `x = 1247 - 170`
(the box x minus a whole number of periods, here 2 x 85), then overlay that
patch back at the box position.

The source x is `box_x - shift`, and **`shift` must be a whole multiple of
the measured period** — the classifier prints exactly this value. Copy from
the same edge and the same rows, so lighting, vignetting and compression
noise match; a patch taken from elsewhere in the frame lands at the wrong
brightness even when the pattern lines up.

If `box_x - shift` is negative, copy from the other side instead
(`box_x + shift`) and check that the source patch is itself clean.

Known limitation, observed on the reference deck: where the pattern is not
perfectly periodic — a stripe that changes width, or texture noise that
does not repeat — a **faint seam** can remain at the patch corner. It is
far less visible than the badge, and much less visible than a `delogo`
smudge, but check it and fall back to crop-and-rescale if it shows.

## Unique geometry → crop and rescale

```bash
ffmpeg -v error -y -i in.png \
  -vf "crop=1376:728:0:0,scale=1376:768:flags=lanczos" \
  out.png
```

Crop the bottom 40px (`768 - 728`), then scale back up to the original
1376x768 so the output matches every other slide. **The output must keep
the original dimensions**, or concatenating slides into a video fails, or
silently letterboxes.

`flags=lanczos` for the upscale: it is the sharpest of the practical
scalers, and the ratio here is about 1.05, so the softening is not visible
at playback size.

For a badge in a different corner, crop the edge it touches and keep the
origin accordingly — a top-edge badge is `crop=W:H-40:0:40`.

## Video, not stills

The same `-vf` string applies to video; only the codec settings change.

```bash
ffmpeg -v error -y -i in.mp4 \
  -vf "drawbox=x=1247:y=726:w=126:h=36:color=0x000000:t=fill" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  -c:a copy \
  out.mp4
```

- `-c:a copy` — never re-encode audio you are not changing.
- `-crf 18` — visually lossless for this purpose. The default 23 adds
  compression artefacts around the patched region, which is precisely
  where they will be looked for.
- `-pix_fmt yuv420p` — required for playback compatibility in browsers and
  most players.

A single video whose background changes under the box mid-shot cannot be
fixed with one static technique. Split it at the change, treat each segment
by its own verdict, and concat.

## Batch, with the verdict driving the command

Classify first, then dispatch on the verdict — never loop one technique
over a whole folder:

```bash
python3 scripts/classify-watermark-zone.py slides/*.png \
  --box 1247,726,126,36 --json > verdicts.json
```

Then read `verdicts.json` and, per file, run the matching command above
with that file's own sampled colour or measured shift. This is the step the
finding in SKILL.md §5 exists to force.
