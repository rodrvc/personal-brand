#!/usr/bin/env python3
"""Classify what lies UNDERNEATH a watermark, so the removal technique is
derived rather than guessed.

Removing a watermark is not one problem, it is three, and the one you have
is decided by the background it sits on -- not by the watermark. Trying
filters until one looks acceptable is the expensive way to discover which
of the three you had. This script answers that question first:

    flat      a solid fill -> paint the box with the sampled colour
    periodic  a repeating pattern -> copy a block shifted by one period
    unique    non-repeating geometry -> crop the edge and rescale

Usage:
    python3 scripts/classify-watermark-zone.py <image-or-frame>...
        --box <x>,<y>,<w>,<h> [--json]

Stdlib only, on purpose. The environments this runs in have ffmpeg but
frequently have no Pillow and no working `pip`, so pixels are read by
piping a raw RGB crop out of ffmpeg. See
`.claude/skills/remove-video-watermark/references/pixel-probing.md`.
"""
import argparse
import json
import subprocess
import sys
from collections import Counter

# --- tunables, and why they are what they are ---------------------------------
#
# Every threshold below was fitted against a reference deck of 11 slides
# whose true classes were known by eye. They are deliberately expressed as
# named constants rather than inline magic numbers, because the honest
# status of each is "measured on one deck", and the next deck may move them.

# Width of the context strip, as a multiple of the watermark box width.
#
# The strip is the clean background beside the watermark -- the only place
# the background can be read WITHOUT the watermark's own pixels polluting
# the sample. Two box-widths is the compromise: narrower and a long pattern
# period does not fit twice (periodicity becomes undetectable); wider and
# the strip runs into unrelated slide content, whose edges read as noise
# and push a genuinely flat background toward `unique`.
CONTEXT_WIDTH_FACTOR = 2

# The flanks: thin bands just above and below the box, over the box's own
# columns.
#
# THIS EXISTS BECAUSE THE STRIP ALONE LIES. In the reference deck one slide
# had solid black to the left of the badge -- flat by every measure -- while
# a large diagonal wedge crossed the badge from the right. Judging on the
# left strip alone returned `flat` with full confidence, and painting that
# box black would have cut a rectangular bite out of the wedge. Any geometry
# passing UNDER the box must cross these bands first.
#
# Both numbers are small, and both had to be. A band as tall as the box
# reaches into unrelated slide content -- on one reference slide, a white
# card ending some 70px above the badge -- and reports a huge variance for
# a background that is genuinely a solid fill. Measure near the box or do
# not measure at all.
FLANK_HEIGHT = 8

# Rows skipped between the box edge and the flank, to clear the watermark's
# own soft shadow. Small for the same reason FLANK_HEIGHT is.
FLANK_GAP = 3

# Luma variance below which the strip counts as a solid fill.
#
# A true solid fill measures well under 1.0. What forces the threshold far
# above that is noise, not content: gradient banding and compression grain
# on a background that is flat to the eye lifted one reference slide to 67,
# while the nearest genuinely non-flat slide measured 1090. 150 sits in
# that gap, nearer the noise than the content, because the cost of the two
# errors is not symmetric -- calling a patterned background flat paints a
# rectangle through it, whereas calling a flat one patterned merely selects
# a slower technique that still looks right.
FLAT_VARIANCE_MAX = 150.0

# Fraction of pixels that must fall in the single most common colour bucket
# (buckets are 8 levels wide, so near-identical shades collapse together).
#
# This is the second, independent route to `flat`. It exists because a
# background can be visually solid yet carry enough dithering to fail the
# variance test: quantising first makes that dithering invisible, which is
# exactly what the human eye does too.
FLAT_DOMINANT_MIN = 0.97

# Ratio of the best lag's error to the mean error across all lags.
#
# The discriminating feature for `periodic`, and the reason a raw error
# threshold will not do: a flat background has near-zero error at EVERY
# lag, so "low error at the best lag" alone marks flat fills as periodic.
# The ratio asks the right question instead -- is this lag notably better
# than lags in general? -- and only a real repeat answers yes.
#
# THE ORDER MATTERS: flatness is tested first. On a flat strip this ratio
# is meaningless, not merely unhelpful.
PERIODIC_RATIO_MAX = 0.15

# Lag search bounds, in pixels.
#
# Below ~8 the "period" found is JPEG block structure or single-pixel
# noise, never a pattern worth copying. The upper bound is the strip width
# minus the box width: a shift larger than that would sample from outside
# the strip that was measured.
MIN_LAG = 8

# Rows are sampled every Nth row rather than all of them. A pattern that
# repeats horizontally repeats on every row, so a third of the rows carries
# the same signal at a third of the cost.
ROW_STEP = 3


def read_rgb(path, box):
    """Return the crop as a flat list of (r, g, b), via ffmpeg.

    ffmpeg is the dependency that is actually present. `-v error` keeps the
    banner off stdout; rawvideo/rgb24 gives exactly w*h*3 bytes with no
    header to skip and no stride padding to reason about.
    """
    x, y, w, h = box
    cmd = [
        'ffmpeg', '-v', 'error', '-i', str(path),
        '-vf', f'crop={w}:{h}:{x}:{y}',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode('utf-8', 'replace').strip())
    data = proc.stdout
    expected = w * h * 3
    if len(data) < expected:
        raise RuntimeError(
            f'expected {expected} bytes for a {w}x{h} crop, got {len(data)}; '
            'the box probably falls outside the image'
        )
    return [(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) for i in range(w * h)]


def frame_size(path):
    """Return (width, height) via ffprobe."""
    proc = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(path)],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode('utf-8', 'replace').strip())
    parts = proc.stdout.decode().strip().split(',')
    return int(parts[0]), int(parts[1])


def luma(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def flatness(px):
    """Return (variance, dominant_fraction, dominant_rgb)."""
    n = len(px)
    lum = [luma(p) for p in px]
    mean = sum(lum) / n
    var = sum((v - mean) ** 2 for v in lum) / n
    buckets = Counter((p[0] // 8, p[1] // 8, p[2] // 8) for p in px)
    bucket, count = buckets.most_common(1)[0]
    # Report the true modal colour inside the winning bucket, not the
    # bucket's midpoint: the value gets painted back onto the image, and a
    # midpoint would be a colour that never appeared in the source.
    exact = Counter(p for p in px if (p[0] // 8, p[1] // 8, p[2] // 8) == bucket)
    return var, count / n, exact.most_common(1)[0][0]


def periodicity(px, w, h, max_lag):
    """Find the horizontal period by self-correlation.

    Returns (best_lag, ratio, errors_by_lag). The period is MEASURED here
    precisely so that no one has to guess it; a shift that is not a whole
    number of periods leaves a visible seam.
    """
    if max_lag <= MIN_LAG:
        return None, 1.0, {}
    errors = {}
    rows = range(0, h, ROW_STEP)
    for lag in range(MIN_LAG, max_lag):
        total = 0
        samples = 0
        for r in rows:
            base = r * w
            for x in range(w - lag):
                a = px[base + x]
                b = px[base + x + lag]
                total += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
                samples += 1
        errors[lag] = total / samples if samples else 0.0
    best_lag = min(errors, key=errors.get)
    mean_err = sum(errors.values()) / len(errors)
    ratio = errors[best_lag] / mean_err if mean_err else 1.0
    return best_lag, ratio, errors


def read_flanks(path, box):
    """Read the rows just above and below the box, over the box's columns.

    This is the region the watermark does not cover but any geometry
    crossing under it must pass through. Returns [] when the box hugs the
    frame edge closely enough that neither flank fits.
    """
    x, y, w, h = box
    px = []
    above_y = y - FLANK_GAP - FLANK_HEIGHT
    if above_y >= 0:
        px += read_rgb(path, (x, above_y, w, FLANK_HEIGHT))
    try:
        px += read_rgb(path, (x, y + h + FLANK_GAP, w, FLANK_HEIGHT))
    except RuntimeError:
        # Below the box falls outside the frame; the flank above (if any)
        # still stands on its own.
        pass
    return px


def classify(path, box):
    x, y, w, h = box

    # ffmpeg's crop filter CLAMPS a box that falls outside the frame rather
    # than failing, so a typo'd box silently returns a verdict about some
    # other region entirely. Checking the byte count does not catch it --
    # the clamped crop is full-size. Check against the real dimensions.
    fw, fh = frame_size(path)
    if x + w > fw or y + h > fh:
        raise RuntimeError(
            f'box {x},{y},{w},{h} falls outside the {fw}x{fh} frame'
        )

    strip_w = w * CONTEXT_WIDTH_FACTOR
    strip_x = x - strip_w
    if strip_x < 0:
        # The watermark sits near the left edge; take the strip on the
        # other side instead. Falling back to a truncated strip would
        # silently weaken every measurement below.
        strip_x = x + w
    px = read_rgb(path, (strip_x, y, strip_w, h))

    var, dom_frac, dom_rgb = flatness(px)

    # A flat verdict must hold in the flanks too, or it is a flat strip
    # sitting next to something the box is about to damage. Only the flat
    # branch consults them: `periodic` and `unique` already decline to
    # paint over the region.
    flank_px = read_flanks(path, box)
    if flank_px:
        f_var, f_dom, f_rgb = flatness(flank_px)
        flank_flat = f_var < FLAT_VARIANCE_MAX or f_dom >= FLAT_DOMINANT_MIN
        # Matching colour matters as much as matching flatness: two
        # different solid fills meeting at the box is still not one fill.
        same_colour = sum((a - b) ** 2 for a, b in zip(f_rgb, dom_rgb)) < 3 * (12 ** 2)
        if not (flank_flat and same_colour):
            # Veto the flat branch only. The pattern tests below stay on
            # the wide strip: the flanks are too narrow to fit a period
            # twice, and a period cannot be measured in a window shorter
            # than two of them.
            flat_ok = False
        else:
            flat_ok = True
    else:
        flat_ok = True

    # Flat is tested FIRST and short-circuits. On a solid fill the
    # periodicity ratio is noise dressed as a measurement.
    if flat_ok and (var < FLAT_VARIANCE_MAX or dom_frac >= FLAT_DOMINANT_MIN):
        # Confidence rises as the strip approaches a single colour.
        conf = min(1.0, dom_frac if dom_frac >= FLAT_DOMINANT_MIN
                   else 1.0 - (var / FLAT_VARIANCE_MAX) * 0.5)
        return {
            'file': str(path),
            'verdict': 'flat',
            'confidence': round(conf, 2),
            'color': '#%02x%02x%02x' % dom_rgb,
            'rgb': list(dom_rgb),
            'variance': round(var, 2),
            'dominant_fraction': round(dom_frac, 3),
        }

    best_lag, ratio, _ = periodicity(px, strip_w, h, max_lag=strip_w - w)

    if best_lag is not None and ratio < PERIODIC_RATIO_MAX:
        return {
            'file': str(path),
            'verdict': 'periodic',
            # A sharper minimum is a more trustworthy period.
            'confidence': round(min(1.0, 1.0 - ratio / PERIODIC_RATIO_MAX), 2),
            'period': best_lag,
            # The smallest whole number of periods that clears the box, so
            # the copied block lands on the pattern's own phase.
            'shift': best_lag * (-(-w // best_lag)),
            'ratio': round(ratio, 4),
            'variance': round(var, 2),
        }

    return {
        'file': str(path),
        'verdict': 'unique',
        # Far from both thresholds means confidently unique; near either
        # means the call is marginal and deserves a human eye.
        'confidence': round(min(1.0, max(0.0, (ratio - PERIODIC_RATIO_MAX) / 0.5)), 2),
        'ratio': round(ratio, 4) if best_lag is not None else None,
        'best_lag': best_lag,
        'variance': round(var, 2),
    }


TECHNIQUE = {
    'flat': 'drawbox with the sampled colour, t=fill',
    'periodic': 'crop a block from the same edge, shifted by a whole period',
    'unique': 'crop the affected edge and rescale to the original resolution',
}


def parse_box(raw):
    parts = raw.split(',')
    if len(parts) != 4:
        raise argparse.ArgumentTypeError('--box takes exactly x,y,w,h')
    try:
        values = [int(p) for p in parts]
    except ValueError:
        raise argparse.ArgumentTypeError('--box values must be integers')
    if any(v < 0 for v in values) or values[2] <= 0 or values[3] <= 0:
        raise argparse.ArgumentTypeError('--box needs non-negative x,y and positive w,h')
    return tuple(values)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Classify the background under a watermark box.',
    )
    ap.add_argument('files', nargs='+', help='images or extracted frames')
    ap.add_argument('--box', required=True, type=parse_box,
                    help='watermark box as x,y,w,h in pixels')
    ap.add_argument('--json', action='store_true', help='emit JSON')
    args = ap.parse_args(argv)

    results = []
    failed = False
    for path in args.files:
        try:
            results.append(classify(path, args.box))
        except Exception as exc:  # noqa: BLE001 - report and keep going
            failed = True
            results.append({'file': str(path), 'verdict': 'error', 'error': str(exc)})

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            name = r['file'].rsplit('/', 1)[-1]
            if r['verdict'] == 'error':
                print(f'{name}: ERROR {r["error"]}')
                continue
            extra = ''
            if r['verdict'] == 'flat':
                extra = f' color={r["color"]}'
            elif r['verdict'] == 'periodic':
                extra = f' period={r["period"]}px shift={r["shift"]}px'
            print(f'{name}: {r["verdict"]} (conf {r["confidence"]}){extra}')
        # The verdict is only half the answer; the point of the verdict is
        # the technique it selects, so print that too.
        verdicts = {r['verdict'] for r in results if r['verdict'] != 'error'}
        if verdicts:
            print()
            for v in sorted(verdicts):
                print(f'  {v}: {TECHNIQUE[v]}')
            if len(verdicts) > 1:
                print()
                print('  Mixed verdicts: the box is constant, the technique is NOT.')
                print('  Treat each file according to its own verdict.')

    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
