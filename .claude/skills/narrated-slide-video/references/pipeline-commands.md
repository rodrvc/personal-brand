# Pipeline commands — end to end

Substitute `<slug>`, `<deck>` and `<output-dir>`; nothing else needs editing.

## Conventions

| Name | Meaning |
|---|---|
| `<slug>` | short kebab-case id for this video, used in every filename |
| `<output-dir>` | working directory — outside the repo for a standalone commission |
| `<deck>` | the source PPTX / PDF / image folder |
| `NN` | zero-padded slide index, `01`…`NN` |

```bash
SLUG=<slug>
OUT=<output-dir>
mkdir -p "$OUT"/{slides,audio,clips}
```

Zero-padding is not cosmetic: `slide-9.png` sorts after `slide-10.png` in
every glob you will write, and the error is silent.

## 1. Extract slides

```bash
unzip -o -q <deck>.pptx -d "$OUT/tmp"
ls -l "$OUT/tmp/ppt/media/"
```

Now **look at the images** and copy them into `slides/` in slide order:

```bash
cp "$OUT/tmp/ppt/media/image7.png"  "$OUT/slides/slide-01.png"
cp "$OUT/tmp/ppt/media/image2.png"  "$OUT/slides/slide-02.png"
# … one line per slide, in the order you verified
```

`ppt/media/` order is embedding order, not slide order. See
[`deck-extraction.md`](deck-extraction.md) for PDF and flat-image decks and
for how to confirm the mapping quickly.

## 2. Script

`$OUT/script.md`, one numbered block per slide:

```markdown
## 01
Narration for the first slide, already normalized for the ear.

## 02
Narration for the second slide.
```

The block number must match the slide filename. This file is the only place
the wording lives — do not normalize inside a synthesis wrapper, or what you
read stops being what gets spoken.

## 3. Synthesize

One file per slide, via the `text-to-speech` skill:

```
$OUT/audio/$SLUG-01.mp3
$OUT/audio/$SLUG-02.mp3
…
```

## 4. Measure everything, before rendering anything

```bash
for a in "$OUT"/audio/$SLUG-*.mp3; do
  printf '%s\t%s\n' "$(basename "$a")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$a")"
done
```

Read the whole table. A 0.4s row means the TTS skipped a block; a 90s row
means two slides' text landed in one file. Both are cheap now.

## 5. Render one clip per slide

The loop measures and renders in one pass, so no duration is ever transcribed
by hand:

```bash
TAIL=0.8
for img in "$OUT"/slides/slide-*.png; do
  NN=$(basename "$img" .png); NN=${NN#slide-}
  AUD="$OUT/audio/$SLUG-$NN.mp3"
  [ -f "$AUD" ] || { echo "missing audio for slide $NN"; exit 1; }

  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUD")
  TOT=$(python3 -c "print(f'{$DUR + $TAIL:.3f}')")

  ffmpeg -loop 1 -framerate 30 -i "$img" -i "$AUD" \
    -filter_complex "[0:v]scale=1920:1080:flags=lanczos,format=yuv420p[v];[1:a]apad=pad_dur=$TAIL,aformat=sample_rates=48000:channel_layouts=stereo[a]" \
    -map "[v]" -map "[a]" \
    -c:v libx264 -preset medium -crf 18 -r 30 \
    -c:a aac -b:a 192k \
    -t "$TOT" -movflags +faststart -y "$OUT/clips/clip-$NN.mp4"

  echo "clip-$NN  audio=$DUR  clip=$TOT"
done
```

What each part is doing, since changing one of them silently breaks the
concat:

| Flag | Why |
|---|---|
| `-loop 1 -framerate 30` | turn one PNG into a 30fps stream |
| `scale=1920:1080:flags=lanczos` | fixed output size; lanczos keeps slide text crisp |
| `format=yuv420p` | the pixel format players actually accept |
| `apad=pad_dur=0.8` | the silent tail after the narration |
| `aformat=48000:stereo` | every clip must share sample rate and layout or concat breaks |
| `-crf 18 -preset medium` | visually lossless for flat slide graphics |
| `-t <measured+0.8>` | **the whole point** — the clip is as long as its own audio |
| `-movflags +faststart` | moov atom first, so it plays while downloading |

`-t` must equal the `apad` total. If you change the tail, change both.

## 6. Concat

```bash
: > "$OUT/concat.txt"
for c in "$OUT"/clips/clip-*.mp4; do
  printf "file '%s'\n" "$c" >> "$OUT/concat.txt"
done

ffmpeg -f concat -safe 0 -i "$OUT/concat.txt" -c copy \
  -movflags +faststart -y "$OUT/$SLUG-master.mp4"
```

`-safe 0` allows absolute paths in the list. `-c copy` is a stream copy —
it only works because every clip shares the flag block above.

Check the result:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$SLUG-master.mp4"
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,sample_rate \
  -of csv=p=0 "$OUT/$SLUG-master.mp4"
```

The master runs slightly longer than the sum of the clips — a few tens of
milliseconds per clip, from AAC frame padding. Expected, and it does not
accumulate into visible drift.

Then **watch it**. Confirm the slide changes where the narration changes.

## Fixing slide NN

```bash
NN=06
# 1. edit block 06 in $OUT/script.md
# 2. re-synthesize -> $OUT/audio/$SLUG-$NN.mp3   (write -v2 alongside, never overwrite)
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/audio/$SLUG-$NN.mp3")
TOT=$(python3 -c "print(f'{$DUR + 0.8:.3f}')")

ffmpeg -loop 1 -framerate 30 -i "$OUT/slides/slide-$NN.png" -i "$OUT/audio/$SLUG-$NN.mp3" \
  -filter_complex "[0:v]scale=1920:1080:flags=lanczos,format=yuv420p[v];[1:a]apad=pad_dur=0.8,aformat=sample_rates=48000:channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -r 30 \
  -c:a aac -b:a 192k -t "$TOT" -movflags +faststart -y "$OUT/clips/clip-$NN-v2.mp4"

# point concat.txt at clip-$NN-v2.mp4, then:
ffmpeg -f concat -safe 0 -i "$OUT/concat.txt" -c copy \
  -movflags +faststart -y "$OUT/$SLUG-master-v2.mp4"
```

The new master is `-v2`. **Do not overwrite the first one** — the owner may
be editing from it, or have already sent it out.

## Output

```bash
open "$OUT"
echo "file://$OUT"
```
