# Reading pixels without Pillow

## The constraint is real

There is **no PIL/Pillow, and `pip` does not exist** in this environment.

```
>>> import PIL
ModuleNotFoundError: No module named 'PIL'
```

This is not a missing setup step to fix. Do not try to install it, do not
add a `requirements.txt`, and do not write code that imports it behind a
`try/except` — a fallback path that never runs is a path nobody has tested.

What *is* available: **ffmpeg**, and the **Python 3 standard library**.
That combination is enough to read every pixel of any image or frame, and
it is what `scripts/classify-watermark-zone.py` uses.

## The technique

Ask ffmpeg for a raw RGB crop on stdout, and read the bytes:

```bash
ffmpeg -v error -i <image> -vf "crop=<w>:<h>:<x>:<y>" \
  -f rawvideo -pix_fmt rgb24 -
```

```python
import subprocess

def read_rgb(path, x, y, w, h):
    cmd = ['ffmpeg', '-v', 'error', '-i', str(path),
           '-vf', f'crop={w}:{h}:{x}:{y}',
           '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    return [(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) for i in range(w * h)]
```

Why each piece:

- **`-f rawvideo -pix_fmt rgb24`** — exactly `w * h * 3` bytes, no header to
  skip, no palette, no stride padding. Byte `i*3` is the red channel of
  pixel `i`; the pixel at `(col, row)` is at index `row * w + col`.
- **`-v error`** — keeps ffmpeg's banner off stdout, which would otherwise
  corrupt the pixel stream.
- **`-`** as the output — write to stdout instead of a temp file.
- **`crop` in the filter, not in Python** — decoding a 4K frame to slice
  126x36 out of it wastes most of the work.

Always check the byte count. A short read means the crop fell partly
outside the frame, and ffmpeg will happily return fewer bytes than asked:

```python
expected = w * h * 3
if len(data) < expected:
    raise RuntimeError(f'expected {expected} bytes, got {len(data)}; box is out of frame')
```

## Frames out of a video

Identical, with a seek. `-ss` before `-i` seeks fast (keyframe-accurate);
after `-i` it is exact and slower.

```bash
ffmpeg -v error -ss 00:00:05 -i in.mp4 -frames:v 1 \
  -vf "crop=126:36:1247:726" -f rawvideo -pix_fmt rgb24 -
```

Sample several timestamps, not one. A background that is flat at 0:00 may
be striped at 0:12, and the whole point of classifying is that this varies.

## Measurements worth making

**Dominant colour** — quantise before counting, or compression noise splits
one visual colour across hundreds of near-identical values:

```python
from collections import Counter
buckets = Counter((r // 8, g // 8, b // 8) for r, g, b in px)
```

Then report the true modal colour *within* the winning bucket, not the
bucket's midpoint — the value gets painted back into the image, and a
midpoint is a colour that never appeared in the source.

**Flatness** — luma variance:

```python
lum = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in px]
mean = sum(lum) / len(lum)
var = sum((v - mean) ** 2 for v in lum) / len(lum)
```

A true solid fill measures well under 1.0. Grain and gradient banding on a
background that is flat to the eye reach into the tens; real content
reaches the thousands.

**Period** — self-correlation across candidate lags:

```python
def error_at(lag, px, w, h):
    total = samples = 0
    for r in range(0, h, 3):                 # every 3rd row: same signal, 1/3 cost
        for x in range(w - lag):
            a, b = px[r * w + x], px[r * w + x + lag]
            total += sum((a[k] - b[k]) ** 2 for k in range(3))
            samples += 1
    return total / samples
```

**The trap:** on a flat background the error is near zero at *every* lag,
so a low error at the best lag marks solid fills as periodic. Compare the
best lag's error against the *mean* error across all lags — only a real
repeat is notably better than lags in general — and test flatness first,
short-circuiting before periodicity is consulted at all.

Start the lag search around 8px. Below that, the "period" found is JPEG
block structure or single-pixel noise, never a pattern worth copying.

## Where to measure

Never inside the watermark box: those pixels are the watermark. Measure

- a **strip beside the box**, a couple of box-widths wide — wide enough to
  fit a period twice, narrow enough not to run into unrelated content; and
- **thin bands just above and below the box**, over the box's own columns,
  which is the only way to see geometry passing *underneath* it.

Both, not either. On the reference deck a slide with solid black to the
left of the badge measured flat at full confidence while a diagonal wedge
crossed the box from the right — the strip alone would have authorised
painting a rectangle through it.

Keep those bands thin (~8px, a few px clear of the box edge). A band as
tall as the box reaches into unrelated slide content — on one slide, a
white card ending ~70px above the badge — and reports huge variance for a
background that is genuinely a solid fill.

## Look at it

Numbers narrow the possibilities; they do not confirm the result. Magnify
the zone with nearest-neighbour so pixels stay hard, and open it with the
Read tool:

```bash
ffmpeg -v error -y -i out.png \
  -vf "crop=520:70:855:709,scale=1560:210:flags=neighbor" check.png
```

Every failed attempt on the reference deck produced a file, and ffmpeg
exits 0 while painting a black rectangle across a yellow stripe.
