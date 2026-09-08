---
name: narrated-slide-video
description: >-
  Turn a slide deck (PPTX, PDF, or a folder of slide images) into a narrated
  landscape explainer MP4 whose timing comes from the voiceover itself: extract
  the slides, write and normalize the script, let the owner pick the voice,
  synthesize one audio file per slide, measure each with ffprobe, render one
  MP4 per slide at that measured duration, and concat. Use whenever the user
  asks to "hacer un video de esta presentación", "narrar este PPT", "video
  explicativo con voz", "convertir estas láminas en video", or asks for
  onboarding, induction, training or reference material narrated over slides.
  NOT for vertical social reels built from a brand profile's data source (that
  is `generar-reel-semana`). NOT for animated or motion-graphic video (that is
  `hyperframes`). This skill renders still slides with ffmpeg and nothing else.
---

# Narrated slide video

A deck goes in, a landscape MP4 with a voiceover comes out. The whole skill
exists to carry one inversion, and everything else is bookkeeping around it.

## The rule that makes this work: audio first

**Generate the audio, measure it, and let the measurement fix the video.**
Never the other way around.

| | |
|---|---|
| Synthesize | one audio file per slide, `<slug>-01.mp3` … `<slug>-NN.mp3` |
| Measure | `ffprobe -v error -show_entries format=duration -of csv=p=0 <audio>` |
| Render | one MP4 per slide, `-t <measured + 0.8>` |
| Concat | stream-copy the clips into the master |

The 0.8s is a tail: silence padded after the narration so the slide does not
cut on the last syllable. It is added in two places that must agree —
`apad=pad_dur=0.8` on the audio filter and `+0.8` in the `-t` value.

Two consequences worth stating out loud, because they are the reason to work
this way at all:

- **Voice and image cannot drift.** There is no timeline to keep in sync. The
  clip is exactly as long as its own narration, by construction.
- **Fixing slide 6 costs one slide.** Re-synthesize `06`, re-measure it,
  re-render `clip-06.mp4`, re-concat. The other ten files are untouched.

A duration typed by hand — from reading the script, from counting words, from
a previous run — breaks both properties at once. If you find yourself writing
a number into `-t` that did not come out of `ffprobe`, stop.

## When NOT to use this skill

Several skills produce video, and they are easy to confuse. Check the row that
matches before reading further; being in the wrong skill makes everything
below wasted work.

| Axis | This skill | Use instead |
|---|---|---|
| **Format** | landscape 1920x1080, minutes long | vertical 1080x1920, seconds long → `generar-reel-semana` |
| **Engine** | `ffmpeg` on still images | Remotion/MapLibre → `generar-reel-semana`; HTML compositions → `hyperframes` |
| **Data source** | a deck the user hands you | a brand profile's declared feed → `generar-reel-semana`, `generar-carrusel-semana` |
| **Motion** | none — the slide is a still frame | animation, camera moves, kinetic type → `hyperframes` |
| **Output** | explainer, onboarding, induction, training, reference | social post → the two `*-semana` skills |

Also not this skill: a deck with **no narration** (just export the PPTX), and
still images with no deck behind them (`generar-carrusel-semana` renders
those).

## Step 0 — Where the material lives

Two cases, and they have different rules about the repo.

**A brand in this repo.** Invoke `usar-perfil` **first** to resolve which
profile and load its business rules — they live in `profiles/<slug>/`, not
here. Announce the resolved profile before writing or rendering anything.
Inputs and outputs go under that profile's folder.

**A standalone commission** (a deck someone sent, work for an external
organization, a one-off). **Nothing enters the repo.** Keep the deck, the
script, the audio and the MP4 in a working directory outside it. The repo is
the engine; this material is neither engine nor profile, and a client's deck
committed by accident is not recoverable by deleting it later.

Either way, pick one `<slug>` and one `<output-dir>` at the start and use them
everywhere. Close every hand-off with a clickable `file://<output-dir>` link.

## Pipeline

Six stages. The canonical command for each is here; the full copyable
end-to-end sequence, with the per-slide loop, is in
[`references/pipeline-commands.md`](references/pipeline-commands.md).

### 1. Extract the slides

```bash
unzip -o -q <deck>.pptx -d <tmp>     # images land in <tmp>/ppt/media/*.png
```

**`ppt/media/` order is not slide order.** The zip stores media in the order
it was embedded, so `image3.png` may well be slide 9. Open them and look
before mapping. Renaming to `slide-01.png` … `slide-NN.png` once, up front, is
what keeps every later stage honest.

PDF decks and folders of flat images are covered in
[`references/deck-extraction.md`](references/deck-extraction.md).

### 2. Write and normalize the script

One narration block per slide, in a plain text or Markdown file, numbered to
match the slide filenames. The block is what the viewer hears while that slide
is on screen — so its length *is* the slide's length.

Normalize before it reaches the TTS (see below). If a deck was summarized with
**NotebookLM** or similar, its output is a draft, not a script: it is written
to be read, not spoken. Rewrite for the ear.

### 3. Cast the voice — the owner decides

Query the catalog, render 3–4 samples **with the real script text**, hand them
over, and **wait**. Details and the honest failure mode in
[`references/voice-casting.md`](references/voice-casting.md).

### 4. Synthesize, one file per slide

Use the [`text-to-speech`](../text-to-speech/SKILL.md) skill for the API call
itself — model choice, voice settings, streaming. Do not duplicate it here.
What this pipeline adds is the file-per-slide discipline and the normalization
pass; the synthesis is ordinary TTS.

Write to `<output-dir>/audio/<slug>-01.mp3` … `-NN.mp3`. Zero-pad the index
so shell globs and `sort` agree with slide order.

### 5. Measure

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 <audio>
```

Record every duration before rendering anything. Seeing all of them at once
catches the failures that are cheap now and expensive later: a slide that came
back at 0.4s (the TTS skipped a block), or one at 90s (two slides' text ended
up in one file).

### 6. Render per slide, then concat

```bash
ffmpeg -loop 1 -framerate 30 -i <slide>.png -i <audio>.mp3 \
  -filter_complex "[0:v]scale=1920:1080:flags=lanczos,format=yuv420p[v];[1:a]apad=pad_dur=0.8,aformat=sample_rates=48000:channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -r 30 \
  -c:a aac -b:a 192k -t <measured+0.8> -movflags +faststart -y <out>.mp4
```

```bash
ffmpeg -f concat -safe 0 -i <output-dir>/concat.txt -c copy \
  -movflags +faststart -y <output-dir>/<slug>-master.mp4
```

`-c copy` means the concat is a stream copy: seconds, not a re-encode. That
only holds if every clip was rendered with **identical** flags — same
resolution, same fps, same pixel format, same audio sample rate and layout.
That is why the flags above are one fixed block and not per-slide choices.

Expect the master to run a few tens of milliseconds longer than the sum of the
measured clips. AAC pads the last frame of each clip. That is normal; it is
not drift, and it does not accumulate anywhere the viewer can perceive.

## Voice casting is the owner's call

Not yours. You produce the shortlist, the owner picks.

- Query `shared-voices` filtered by gender, language and accent. **Do not
  claim an accent has no voices without querying the endpoint.** "I did not
  find one" and "there are none" are different sentences; only the first one
  is ever yours to say. Widen the filters before concluding anything.
- **Render every sample with the real script text.** A voice judged on "hola,
  esto es una prueba" tells you nothing about how it handles the actual
  material — its numbers, its terminology, its sentence lengths. Use a real
  paragraph, ideally one of the harder ones.
- Concatenate the 3–4 samples into one file with a short silence between them
  so they can be compared in one listen, hand it over, and **stop**. Do not
  synthesize the full deck against a voice nobody approved.

Endpoint, filters and the comparison-file recipe:
[`references/voice-casting.md`](references/voice-casting.md).

## Normalize the text before it reaches the TTS

A TTS engine reads what it is given. Left raw, it spells out what should be
spoken, speaks what should be spelled, or silently drops a token — and the
last one is the dangerous one, because the audio still sounds fine.

Normalize in the script file itself, not in a wrapper, so what you read is
what gets spoken. Examples below are **invented**; substitute the real ones.

| Raw | Written for the ear | The shape it stands for |
|---|---|---|
| `1.500.000` | `un millón quinientos mil` | large number with thousand separators |
| `12,5 %` | `doce coma cinco por ciento` | decimal and symbol |
| `ACME` | `a ce eme e` (or the expansion, if the audience needs it) | acronym read letter by letter |
| `v2.3.1` | `versión dos punto tres punto uno` | dotted identifier |
| `ref. 1.234-A` | `referencia mil doscientos treinta y cuatro A` | reference code with a suffix |
| `2019-2024` | `entre dos mil diecinueve y dos mil veinticuatro` | range, not a subtraction |
| `24/7` | `veinticuatro siete` | slash that is not a date |
| `3 m²` | `tres metros cuadrados` | unit with a superscript |

Then **listen to the numbers specifically**. Reading the audio's transcript
back is not enough: the failure is in the pronunciation, and only ears catch
it.

## Still slides unless it's for social

Reference, onboarding, induction and training material gets **static frames**.
No Ken Burns, no slow zoom, no pan. The viewer is reading the slide; motion
under text makes it harder to read and signals "promo" for content that is
not.

That is also what keeps this pipeline small: with still slides, `ffmpeg` alone
is the whole renderer. **`hyperframes` is not invoked**, and there is no
composition to maintain.

Motion is a different deliverable, not a setting on this one. If the user
wants it, route to `hyperframes` — and note that it lives in
`~/.claude/skills/` (user-global), so **it may not be installed** on a given
machine. Check before promising it.

## Fixing one slide

The point of one-file-per-slide. To change slide N:

1. Edit block N in the script.
2. Re-synthesize `<slug>-NN.mp3`.
3. Re-measure it with `ffprobe`. **The new duration is different** — this is
   exactly where a stale hand-copied number gets baked in.
4. Re-render `clip-NN.mp4` with the new `-t`.
5. Re-concat from the same `concat.txt`.

**Never overwrite an output.** Write `<slug>-master-v2.mp4` beside the first
one, and `clip-NN-v2.mp4` beside the clip. The owner may have the previous
master open in an editor, or already sent it to someone. Versioning costs disk
space; overwriting costs work that cannot be recovered.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Voice drifts further out of sync as the video goes on | durations were set by hand or copied from an older run | re-measure every clip with `ffprobe`; never type a `-t` value |
| Last word of a slide is clipped | `-t` did not include the 0.8s tail, or `apad` is missing | both must be present, and they must agree |
| Slide changes while the voice is still talking | `-t` shorter than the audio — usually the audio was re-synthesized and the clip was not re-rendered | re-measure, re-render that clip |
| `concat` errors, or the master has a black or silent stretch, or its duration does not match the clips | clips were rendered with different flags. `-c copy` does not reliably *fail* on a mismatch — it can emit `non monotonically increasing dts` warnings and still write a playable file with the wrong timing | re-render every clip with the identical flag block; never treat "it produced a file" as success |
| A slide's audio is suspiciously short | the TTS skipped a block, usually an un-normalized number or symbol | normalize, re-synthesize, re-measure |
| Slides appear in the wrong order | `ppt/media/` order was assumed to be slide order | open the images and remap |
| Master is ~20ms per clip longer than the sum | AAC frame padding | nothing — expected, imperceptible |

## Hard rules

- **Every duration comes from `ffprobe`.** No exceptions, no estimates from
  word counts, no numbers carried over from a previous run.
- **One audio file and one MP4 per slide.** A single long narration track
  destroys the ability to fix one slide, which is the whole point.
- **The voice is chosen by the owner**, from samples read in the real script's
  words. Never synthesize a full deck against a voice nobody approved.
- **Never state that no voice exists for an accent or language without having
  queried the endpoint.** Report what the query returned.
- **Normalize numbers, reference codes and acronyms before synthesis**, and listen to
  those passages specifically afterwards.
- **Still slides.** No Ken Burns, no zoom, unless the deliverable is explicitly
  for social — and then it is a different skill.
- **Never overwrite an output.** Version `-v2` alongside; the owner may be
  working from the previous file right now.
- **Render every clip with the identical flag block**, so `concat -c copy`
  stays a stream copy.
- **Verify by watching, not by listing files.** Play the master, or at minimum
  pull frames at each slide boundary and check the audio lands where the slide
  changes. A file that exists is not a video that works.
- **Nothing from a standalone commission enters the repo** — not the deck, not
  the script, not the audio, not the MP4.
- **Publishing is always manual.** This flow leaves files ready; it never
  uploads anywhere.
- Close with the output folder as a clickable `file://` link.
