# system/ig-reel — reel engine

Renders a **vertical 1080x1920 reel** (MP4) from dated items in a profile: a cover,
N items each preceded by a camera flight over a real map to its location, and
a closing.

Generic, like `system/ig-carousel/`: **nothing here names a brand, a city
or a taxonomy**. All that comes from `profiles/<slug>/`.

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
                                           [--storyboard [path]] [--audio-only]
                                           [--voice <script.txt>] [--music]
```

Flow contract: `system/recipes/reel-week.md`.
Brand data contract: `system/config/brand.schema.md`.

---

## What it needs from a profile

| File | Contribution |
|---|---|
| `brand.json` | Colors, typefaces, categories and `copy.reel` + `gradients.cover` |
| `recipes/reel-week.yaml` | Source, curation, `map.bbox`, and optionally `voice:` and `music:` |
| `reels/week-input.json` | Already-curated items, with date, coordinate and image |
| `reels/<date>/storyboard.yaml` | Optional: narration per card (see "Storyboard: audio first") |
| `assets/fonts/*.woff2` | Optional: logo font, embedded so preview and render match |

Same `brand.json` consumed by the carousel. No separate brand file.

---

## Architecture: Node orchestrates, Remotion renders

Video output comes from a Remotion subproject (`remotion/`) where the map is
**real raster tiles moved by a MapLibre camera**, not a drawn SVG. The boundary
between both sides is the `ReelProps` contract (`remotion/src/props.ts`): everything
arrives **resolved** — colors as CSS, copy already interpolated, images at
servable paths. The composition knows nothing of `brand.json`, recipes or
profiles; `render-reel-week.ts` is the only one that reads them and flattens
them to that shape. All brand vocabulary stays on the Node side.

| File | Role |
|---|---|
| `types.ts` | Input data contract and `VerifiedReelItem` |
| `geo.ts` | Bounding-box validation and camera wide framing (`wideFraming`) |
| `osm.ts` | Nominatim: geocodes free text to coordinate, bounded by bbox |
| `osm-cache.ts` | On-disk cache of those calls |
| `verify-items.ts` | Pre-render guard |
| `recipe.ts` | Loads and validates `recipes/reel-week.yaml` |
| `voice.ts` | ElevenLabs: TTS narration and music bed, both opt-in |
| `storyboard.ts` | Loads and validates storyboard, synthesizes per card with cache, derives timeline |
| `render-reel-week.ts` | Entrypoint: geocodes, verifies, builds props, renders and muxes |
| `reel.test.ts` | Tests for guards, timeline and recipe |
| `remotion/src/timeline.ts` | Scene timing (fixed or derived from audio) and camera math — pure functions, tested |
| `remotion/src/maplibre.ts` | MapLibre under Remotion's clock, tile style and attribution |
| `remotion/src/Reel.tsx` | The composition: cover, map+item scenes, closing |

---

## Decisions that aren't obvious

### Tiles are CARTO Voyager — and cannot be anything else

This is a **legal** restriction, not a technical preference, and that's why it
lives in the engine where no profile can touch it:

- Tiles from openstreetmap.org prohibit *pre-emptive fetching*.
  Pre-rendering a video is exactly that.
- Google Maps/Earth imagery is prohibited in promotional content,
  and a brand reel is promotional.
- Mapbox requires a separate commercial license.

CARTO basemaps (Voyager raster, no API key) are usable **with
attribution**: hence the **"© OpenStreetMap contributors © CARTO"** label that
the composition prints over each map scene. It's mandatory and no profile
field disables it.

### The map is a live renderer that Remotion treats as photo per frame

MapLibre animates only if told; here **it must have no animation**.
The camera is calculated from `useCurrentFrame()` and applied with `jumpTo()`
(never `flyTo()`), and each frame blocks in `delayRender()` until that
camera's tiles have loaded. Part of the same contract is how render is invoked:

```
npx remotion render src/index.ts Reel out.mp4 --props=... --concurrency=1 --gl=swangle
```

`--gl=swangle` (SwiftShader/ANGLE) is the safe path for headless WebGL, and
`--concurrency=1` because headless Chromium cannot reliably host multiple
WebGL contexts — parallel instances fight over the tile cache without
gaining speed.

### Wide framing comes from items, not from bbox

The bbox is **filter** territory: in a coastal city its midpoint is open water.
`wideFraming()` frames based on the verified items. Since the camera can center
any coordinate within the bbox, "where the pin falls on screen" stopped being
a problem for the engine: zones and canvas coverage from the previous SVG
renderer no longer apply. (`map.zones` and `map.reference_types` are still
accepted in the recipe for backward compatibility with a warning, but ignored).

### Staging is ephemeral by design

Remotion's `staticFile()` only works from the project's own `public/`,
so profile images and fonts are copied to `remotion/public/staging/` for the
duration of the render. The folder is git-ignored and **cleaned up afterward**:
nothing bearing a brand's identity can stay under `system/` any longer than
the render requires.

### Geocoding: scoped, sequential and no guesswork

An item without `lat`/`lng` is geocoded with Nominatim, bounded by the bbox and
with an identifiable `User-Agent`. Requests are sequential, one per item, as
required by its usage policy. Items that don't geocode **are discarded with their
reason** — the system never falls back to the bbox center, because a pin in the
wrong place looks just as correct as one placed right.

Every call passes through an on-disk cache (`osm-cache.ts` → `<repo>/.cache/`):
re-running the same week costs zero requests to the free service. The
**raw response is cached using the literal request as the key** — change the
input and the cache misses on its own. It has a 180-day TTL (addresses don't
move often); expired entries are still used with a warning if the network
fails. The system always prints where the data came from, and `--no-cache`
forces fresh data. The cache lives in `<repo>/.cache/` and never in
`profiles/<slug>/`: a profile is a portable declaration; a cache is a
derived artifact with an expiration date.

### Bbox is capped at 0.5° on each side

Wider and the zoom from wide→street stops reading as "how to get there", and
geocoding scoped to that box stops narrowing anything. It fails at
load time with an explanation, not partway through the render.

### The audio track is not optional

Remotion outputs MP4 without audio, and **several macOS players freeze on the
first frame when playing silent video**: the video *looks* broken even though
it's fine. The script always muxes a track with FFmpeg — silent if nothing
was requested, narration with `--voice`, the music bed with `--music`, or both.
The video is copied without re-encoding, and at the end ffprobe verifies that
the audio track lasts as long as the video: a filter graph can emit an
almost-empty audio stream instead of failing.

Two operational gotchas around `renders/`:

- Muxing picks **the last `.mp4` in `renders/` by filename order**
  (`.sort().pop()` in `render-reel-week.ts`). Before a fresh run, clear old
  renders from that folder. Render audio is stored in a sibling folder
  (`audio/`) within the output, preventing tools that scan the folder from
  mistaking audio files for video.
- Generated music **includes its own exit fade** (it's requested ~15% longer
  than the video, and muxing trims the tail accordingly). Don't layer a second
  fade on top: the ending will fade twice.

### Narration and music are opt-in, and their voice belongs to the profile

`--voice <script.txt>` narrates a script you supply — the engine knows *how*
to speak, never what to say. It requires a `voice:` block in the profile's
recipe (`voice_id` at minimum): which voice a brand speaks in is a profile
decision. The API key comes from `ELEVENLABS_API_KEY` in the environment,
never from a profile file. `--music` composes the bed using `music.prompt`
from the recipe; when narration is on top, the bed plays at full volume during
`intro_seconds` then fades to `gain_db`, and the voice is normalized
(loudnorm) before mixing. A script longer than the video fails with a message,
not cut off mid-phrase.

### Storyboard: audio first

**The problem it solves.** With `--voice`, the script is one text → one
MP3 → laid over a video whose scenes last as long as `timeline.ts` constants
specify. Nothing ties phrase N to scene N, so the voiceover always drifts: the
narrator talks about the third location while the camera is still flying to
the second.

**The solution.** A storyboard organized by cards: each scene is a card, and
the card carries its narration. The engine synthesizes **one MP3 per card**,
measures it with ffprobe, and derives each scene's duration from its own audio:
"audio first, video second". Structure is guaranteed by construction — a scene
cannot finish before its narration ends because the scene's length matches the
narration's duration.

**Where it lives.** `profiles/<slug>/reels/<YYYY-MM-DD>/storyboard.yaml`;
the date is the Monday of the period, the same one `--date` resolves to. It's
profile data (git-ignored along with the profile); the example is at
`profiles/example/reels/<date>/storyboard.yaml`. If the file exists for that
period, render uses it; `--storyboard <path>` overrides to a different file.
`--voice` and storyboard are mutually exclusive: one pins scene durations
while the other lays a script on top of those durations; passing both is
an error.

**Contract:**

```yaml
storyboard: reel
version: 1
transitions: cut  # optional: 'cut' (default) for sharp cuts, or 'crossfade' for fades with overlap
voice:            # optional: partial override of the recipe's voice: block
  speed: 1.05
cards:
  - id: cover     # unique slug
    visual: cover # closed enum: cover | item | closing
    narration: "what the narrator says in this card"
  - id: item-1
    visual: item
    item: 0       # index in reels/week-input.json; required and unique per item
    narration: "..."
    min_seconds: 5.0   # optional: floor for the scene (never below engine minimum)
  - id: closing
    visual: closing
    narration: ""      # empty = silent card (0s of voice, scene lasts its minimum)
```

Validation fails **at load** time, naming the problematic card. It checks for:
exact `storyboard`/`version` fields, unique ids, `visual` values in the enum,
exactly one `cover` at the start and one `closing` at the end, 2–6 `item`
entries, each with a valid and distinct index, unknown keys, and missing
`narration` (empty is allowed). **The storyboard defines the scene order**,
not `week-input.json`: the reel displays items in the order specified by the
`item` cards.

**Word budget** (these are engine constants, not something a profile sets):
cover 4–15 words, item 8–30, closing 4–15. Text outside these ranges fails
with the actual count reported (`card item-2: 41 words, max 30 for visual=item`).
This ensures that a derived scene stays within the length that the format can
sustain.

You can validate without network, without an API key, and without ffmpeg —
it always prints the id / visual / word-count table:

```
npx tsx system/ig-reel/storyboard.ts --check profiles/<slug>/reels/<date>/storyboard.yaml \
                                     --items profiles/<slug>/reels/week-input.json
```

**Per-card synthesis and content-based cache.** Each card is synthesized to
`profiles/<slug>/reels/<date>/audio/<card-id>.mp3` using the effective voice
(recipe + override). A sidecar `<card-id>.json` file sits alongside it, holding
the sha256 hash of (normalized text + effective voice config + model_id) and
the measured duration. If the hash matches and the MP3 exists, **the API is not
called**: editing one card re-synthesizes only that card; changing the voice
re-synthesizes all of them.

**The derived timeline.** By card type, with `RESPIRO = 0.4s`
(`BREATH_SECONDS`, the silence after the phrase so the cut doesn't fall on the
final syllable):

| Card | Duration |
|---|---|
| cover | `max(2.2, voice + breath)` |
| item | `max(1.8 + 3.2, voice + breath, min_seconds)` — the map flight stays fixed at 1.8s (camera 1.2s); extra time goes into the item card hold, never into the flight; narration starts with the flight |
| closing | `max(2.0, voice + breath)` |

Overlapping/crossfading works as before. With `--music`, the `intro_seconds`
parameter shifts the cover's narration **into the cover itself** (so the cover
expands to contain it), ensuring each subsequent card still starts exactly when
its scene begins. The timeline is written to `profiles/<slug>/reels/<date>/timeline.json`
(per card: id, visual, item, word count, voice seconds, start, duration; plus
total) and printed in readable form to the console.

**`--audio-only`** stops there: it synthesizes, prints the table, opens the
audio folder with `open`, and skips rendering. This step lets you *hear* the
cards before committing to a full render. Without the flag, render receives
the already-resolved scenes (`ReelProps.scenes`), and the narration track is
built by concatenating MP3s with `adelay` delays positioned at each card's
start; then muxing follows the standard process (loudnorm, bed, ffprobe
verification). The "narration longer than video" guard doesn't apply with
storyboard: the video adjusts to fit the voice. It still applies for `--voice`
alone.

**Without storyboard, nothing changes.** `ReelProps.scenes` is optional; if not
provided, the composition calculates scenes with fixed times and produces output
identical to before, frame for frame.

### No map: `--no-map`

Ordinarily each item scene is a map flight (1.8s) followed by the item's
card. With `--no-map` the flight never happens: the MapLibre layer does not
mount, the scene opens straight into the card, and its floor drops from
`TIMING.map + TIMING.item` to `TIMING.item`.

This is the mode for a reel whose edit happens **outside the engine** — when
the event's poster is already the content and an establishing shot adds
nothing. The timeline derived from the storyboard accounts for this, so the
durations it prints are what actually renders; it's not a trim applied after
the fact.

Include the flag on every pass: `render-reel-week.ts`, `--card`, `--assemble`.

### Transitions: cut or crossfade

By default scenes appear at full opacity at their exact start and disappear at
their exact end — with no overlap or fade (`transitions: cut`). This is useful
when transition editing happens **outside the engine** — each card clip stands
alone, and the editor adds their own transitions in their video editing app.

With `transitions: crossfade` (in storyboard) or `--crossfade` (CLI flag),
scenes overlap by 0.35s to give the fade-in/out room it needs; the cover
extends beyond its duration and the closing begins early. Timeline frame
ranges don't change; only the fade effect is added.

---

## Per-card clips and assembly

A monolithic render outputs everything at once. **Clips** let you re-render just
one scene without re-rendering the rest. Internally, a clip **is not a separate
composition**: it's a frame range from the same `Reel` composition, rendered
with the same props. Pixel output is identical to the monolithic render, and
crossfades between scenes (an overlap of `TIMING.overlap` seconds) are
preserved for free — the frame at each scene boundary already mixes both
clips, so the
cut lands cleanly on it.

**Where clips end up.** In `<output>/clips/`, one per storyboard card.
The naming is `<index>-<card-id>.mp4` (`0-cover.mp4`, `1-item-1.mp4`, …);
the index follows scene order and is zero-padded based on card count, so files
sort nicely on disk. Clips require a storyboard: fixed timing has no card ids.

**Why the clip must be truly mute (`--muted`).** Without the flag, Remotion
writes each clip with its own silent audio track whose padding doesn't match
the video frame count (example: a 77-frame video / 2.5667s sits inside a
container whose `format=duration` reports 2.624s, because the longest stream —
the padded audio track — determines the duration). Concatenating clips where
each one drags a different amount of audio padding creates variable frame rate:
the actual frames are correct but badly distributed in time (758 frames that
should last 25.2667s end up stretched to 25.5s). `--muted` strips the clip
down to one stream, with nothing left to misalign.

**Three render modes:**

- `--clips`: renders all cards as clips and assembles them into one
  (silent) video. Assembly uses `ffmpeg -c copy` (stream copy, no re-encoding)
  and verifies with ffprobe that the result measures `totalFrames/FPS` (±1
  frame). If stream copy fails or the result doesn't match the expected
  duration — indicating a glitch at a clip boundary — it falls back to a
  second attempt with **re-encoded** concatenation (`libx264 -crf 18`), at the
  cost of a generation of quality — and only at the cuts. In practice, with
  muted clips (`--muted`), stream copy works immediately: every Remotion
  frame is already a keyframe, so there is no boundary to misalign.
- `--card <id> [--card <id2> ...]`: renders only those cards, skipping
  assembly. Use it when re-rendering a scene that didn't work — each clip
  comes out muted.
- `--assemble`: joins the already-rendered clips in `clips/`, muxes the audio
  (narration and music) over the result, and verifies it. It fails if a clip
  is missing or if its duration doesn't match the timeline.

**Audio is post-production.** Clips come out mute (`--muted` on Remotion),
with one video stream only. The narration track (built card by card with
appropriate delays) and the music bed are applied **afterward** during muxing —
the same as in monolithic render. This keeps the video file the same size even
when audio changes.

**Example workflow:** re-render the third item scene (card `item-2`)
when the result isn't satisfactory:

```
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> --date <date> --card item-2
# → renders only that clip

# Verify the clip in `outputs/…/clips/2-item-2.mp4`

# Then assemble all clips (including the new one) with audio:
npx tsx system/ig-reel/render-reel-week.ts --profile <slug> --date <date> --assemble
# → muxes voice and music tracks over the concatenation
```

---

## What ends up in the output folder

When the render finishes, all artifacts are organized in
`profiles/<slug>/outputs/reels/<date>/` — the folder you take and edit
by hand in another tool:

```
reel-<date>.mp4         final file with audio (MP4, 1080x1920)
storyboard.yaml         snapshot of the storyboard that was rendered (if exists)
timeline.json           snapshot of the timeline used (if exists)
reel-props.json         resolved props for the composition (Remotion)
clips/
  0-cover.mp4           mute clip per card (stream copy, no audio)
  1-item-1.mp4
  ... (one per storyboard card)
  concat-list.txt       ffmpeg list for assembly (generated)
audio/
  cards/                copy of each synthesized MP3 (card by card)
    cover.mp3
    item-1.mp3
    ... (without cache sidecars .json)
  narration-<date>.wav|.mp3  built narration track (if exists)
  music-<date>.mp3      music bed (if --music was used)
renders/                mute intermediates from Remotion (internal, don't carry)
  reel-<date>.mp4       monolithic render without audio
```

Per-card audio files with cache (`.mp3` + `.json`) still live in
`profiles/<slug>/reels/<date>/audio/` — that is the source and cache that
feed the engine; the `audio/cards/` folder in the output is a derived copy.

---

## Requirements

- **Node 22+** (the subproject installs its dependencies on first run only)
- **FFmpeg** (with ffprobe) — for muxing and verifying audio
- Network access during render: tiles download as rendering proceeds; Nominatim
  is called only if items lack coordinates and the cache is cold
- `ELEVENLABS_API_KEY` in the environment, only if using `--voice` or `--music`.
  The key lives in `<repo>/.env` (git-ignored; `.env.example` at the repo root
  is copied to each worktree by Orca via `.worktreeinclude`). The engine loads
  it automatically. If the key is already in your environment (e.g. exported
  in the shell), the environment takes priority over the file.

Interactive preview: `cd system/ig-reel/remotion && npm run studio`. It opens with
fictional and neutral props ("Puerto Ejemplo", coordinates near 0,0) without requiring
any real profile on disk; an actual render always passes full props via `--props`.
