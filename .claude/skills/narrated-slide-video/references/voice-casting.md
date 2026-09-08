# Voice casting

You produce a shortlist. **The owner picks.** This reference covers finding
candidates and building the file they listen to.

Synthesis itself — models, voice settings, the API call — is the
[`text-to-speech`](../../text-to-speech/SKILL.md) skill. Nothing here
duplicates it. What this stage adds is the search, the sample construction,
and the approval gate.

## Prerequisites

**`ELEVENLABS_API_KEY` must be in the environment.** Every command on this page
fails with an opaque API error without it.

```bash
[ -n "$ELEVENLABS_API_KEY" ] && echo ok
```

If the key lives in an `.env`, load it with `set -a; . <path>/.env; set +a` — a
bare `source` will not export it into the environment the `curl` subprocess
sees. See [`setup-api-key`](../../setup-api-key/SKILL.md).

The snippets also assume `jq` (to build the JSON bodies), `ffmpeg`/`ffprobe`
(to concatenate and measure), and a player — `afplay` on macOS, otherwise
`ffplay -autoexit -nodisp`.

## Query the catalog

The shared voice library, filtered:

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  "https://api.elevenlabs.io/v1/shared-voices?page_size=30&gender=female&language=es&search=<accent>"
```

| Parameter | Notes |
|---|---|
| `page_size` | 30 is a workable shortlist; paginate if the filters are broad |
| `gender` | `female` / `male` |
| `language` | ISO code — `es`, `en`, `pt` … |
| `search` | free text; the practical way to reach an **accent** (e.g. a country or region name), since accent is not a first-class filter |
| `use_cases` | optional — `narrative_story`, `informative_educational` fit explainer material |

Inspect the response before relying on any field name; the shape of the
catalog changes over time. Pull `voice_id`, `name`, and whatever descriptive
fields come back:

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  "https://api.elevenlabs.io/v1/shared-voices?page_size=30&gender=female&language=es&search=<accent>" \
  | python3 -m json.tool | head -60
```

Widen the query before concluding anything: drop `search`, then drop `gender`,
then paginate. A narrow filter returning nothing is a fact about the filter.

### Report what you queried, not what you assume

**Never state that no voice exists for an accent or language without having
queried the endpoint.** This is the failure mode this section exists to
prevent: an inference presented as a finding. The catalog is large and
changes; a voice you expect to be missing usually is not, and asserting its
absence quietly removes a real option from the owner.

Two different sentences:

- "The query returned nothing for `search=<accent>` with `gender=female`,
  `language=es`. I widened it and found N; here they are." — a report.
- "There are no voices with that accent." — a claim you almost certainly
  cannot support.

Only the first is ever yours to say.

## Starting point: Chilean Spanish female voices

A **starting point, not a closed list.** These were returned by
`shared-voices?gender=female&language=es&search=chilean` and are recorded here
so the next agent does not repeat the search from zero — and, more to the
point, does not assert that voices for an accent do not exist without asking.

| Voice ID | Name | Age | Character | Model verified with | Verified |
|---|---|---|---|---|---|
| `lLsDvdl6OjtZfLJPM2HA` | Olivia Pro — Strategic Business & Tech | middle_aged | professional, vibrant | `eleven_multilingual_v2` | 2026-09-08 |
| `GJid0jgRsqjUy21Avuex` | Emma — Authoritative, Assured and Clear | middle_aged | the most formal of the set | `eleven_multilingual_v2` | 2026-09-08 |
| `prblQcKOdF08ozhxP2mk` | Angela — Warm, Calm and Assured | middle_aged | warm and calm, but **noticeably slower** — see the note below | `eleven_multilingual_v2` | 2026-09-08 |
| `6Gr4AVmTax1pMJO0lHRK` | Catalina — Chilean Spanish | young | "connects, does not just recite"; closer, less formal | `eleven_multilingual_v2` | 2026-09-08 |
| `oJIuRMopN0sojGjwD6rQ` | Camila | young | customer service and sales | `eleven_multilingual_v2` | 2026-09-08 |
| `Fd38GRHtJllY0CuguAy9` | Victoria | young | clear and confident | `eleven_multilingual_v2` | 2026-09-08 |
| `NxmJt7aR0FMgBqiYrcc0` | Esperanza | young | relaxed | `eleven_multilingual_v2` | 2026-09-08 |
| `JM2A9JbRp8XUJ7bdCXJc` | Fernanda Olea — Cheerful and Powerful | young | powerful, conversational | `eleven_multilingual_v2` | 2026-09-08 |

**The last two columns are the point of the table, not decoration.** A
`voice_id` can leave the catalog or change hands, and the model it was judged
with can be superseded. Without a date, a silently stale row looks exactly
like a fresh one. When a row stops resolving, fix the row and move its date —
do not delete the column.

**Pace is a casting criterion, not just tone.** On the same sentence, Angela
ran 2.6s longer than Emma. In this pipeline every clip is as long as its own
narration, so a slower voice does not desynchronize anything — it makes the
whole video longer. On a multi-minute deck that difference compounds into
minutes. Judge candidates on pace as well as warmth.

**For any other accent or language, query the endpoint** — change `search=`
and `language=`. This table covers one accent because that is what has been
looked up so far; it is not a statement about what the catalog contains.
Extend it when useful voices for other accents turn up.

### A known-good settings baseline

For institutional/reference material, with `eleven_multilingual_v2`:

```json
{"stability": 0.5, "similarity_boost": 0.75, "style": 0.15}
```

A starting point, not a mandate — a different register may want different
values. Keep them identical across candidates while casting, or the comparison
is not a comparison.

### No audio file is ever committed

What goes in version control is the table above — the ids, the character
notes, the settings. That is the expensive knowledge: the hard part was never
generating audio, it was deciding which voices are worth listening to.

**No audio file belongs anywhere under `.claude/`, in any folder.** This was
raised, reviewed and rejected on three grounds. They are written down so it is
not retried as though it had been an oversight:

1. **Licensing.** `shared-voices` entries belong to third-party creators with
   their own terms; some restrict commercial use or require attribution. Using
   the audio in a video is *use* — committing the MP3s is *redistribution*.
   This engine is meant to be publishable, and
   `scripts/validate_commit_guardian.py` cannot catch the problem: it searches
   for brand literals, and a licensing violation is not a literal.
2. **A cache that cannot detect its own staleness.** A `voice_id` can vanish
   from the catalog or change owner. A committed MP3 would keep sounding
   perfect while the id behind it points at nothing — the owner listens,
   chooses, and synthesis then fails or silently uses a different voice. A
   cache that cannot tell it is out of date is a trap, not an optimization.
3. **It would hardcode a language assumption into the engine.** An
   `es-cl-*.mp3` under `.claude/` is a production literal, sibling to the
   brand literal `CLAUDE.md` forbids. Which voices to cast is a production
   decision, not an engine capability. This skill is transportable precisely
   because it carries no catalog of one language and one vendor.

**Why a table of one accent is allowed here and an MP3 is not.** Both look like
production data. The difference is that a `voice_id` and a character note are
cheap to re-derive and safe to be wrong about — a stale row costs one query —
whereas an MP3 is licensed third-party audio and a cache that cannot detect its
own staleness. This table is a bookmark into a public catalog, not a copy of
it. Keep it that way: ids, notes and dates, never audio, and add rows for other
accents as they come up rather than treating this one as the catalog.

### Cache the samples locally instead, ignored by git

The benefit that motivated committing them — not paying for the same audio
twice — is available without any of the cost. Synthesize only when the file is
missing; replay it when it is there. The first run costs a few cents of
credit, every later one costs nothing.

| Case | Where the cache lives |
|---|---|
| Casting for a brand in this repo | `profiles/<slug>/voice-samples/` — already ignored by `profiles/*` |
| A standalone commission | the commission's working directory, outside the repo |
| Never | anywhere under `.claude/` or `system/` |

Verify rather than assume the path is ignored, because `profiles/example*` is
un-ignored and would track anything placed under it:

```bash
git check-ignore -v profiles/<slug>/voice-samples/probe.mp3   # must print a rule
```

```bash
# The REAL paragraph the samples are judged on, already normalized.
TXT='<first paragraph of the script>'

CACHE="profiles/<slug>/voice-samples"        # or the commission's dir
mkdir -p "$CACHE"
f="$CACHE/<voice-name>-$(printf '%s' "$TXT" | shasum | cut -c1-8).mp3"

if [ -s "$f" ]; then
  echo "cached: $f"
else
  jq -n --arg t "$TXT" '{text:$t,model_id:"eleven_multilingual_v2",
      voice_settings:{stability:0.5,similarity_boost:0.75,style:0.15}}' \
  | curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/<voice-id>" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
      -d @- -o "$f"
fi
afplay "$f"        # macOS; ffplay -autoexit -nodisp "$f" elsewhere
```

**Key the filename on the text, not just the voice.** Same voice, different
script means a different sample — a cache keyed on the voice alone would
replay audio of the wrong material, which is the one thing this section is
trying to prevent. The `shasum` in the filename above is what keys it; eight
characters is plenty.

**The test is `-s`, not `-f`.** `curl -o` creates the file even when the
request fails, so a failed synthesis leaves a zero-byte MP3 behind. `-f` would
treat that as a hit and replay silence forever; `-s` (non-empty) treats it as
a miss and retries.

**The cache never changes what the owner compares.** The final samples are
still generated from the **real script text**; caching only avoids paying
twice for the same voice on the same words. Pace and tone shift with the
material, so a generic phrase would have the owner judging something they are
not buying.

### Generate and compare in one pass

```bash
cd "$OUT/casting"   # outside the repo

# The REAL first paragraph of the script, already normalized.
TXT='<first paragraph of the script>'

# The four your query returned — ids and dates live in the table above.
for pair in "<name>:<voice-id>" \
            "<name>:<voice-id>" \
            "<name>:<voice-id>" \
            "<name>:<voice-id>"; do
  n="${pair%%:*}"; id="${pair##*:}"
  jq -n --arg t "$TXT" '{text:$t,model_id:"eleven_multilingual_v2",
      voice_settings:{stability:0.5,similarity_boost:0.75,style:0.15}}' \
  | curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/$id" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
      -d @- -o "$n.mp3"
  echo "$n  $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$n.mp3")s"
done

ffmpeg -v error -f lavfi -t 0.9 -i anullsrc=r=44100:cl=mono -y sil.mp3
# Four samples interleaved with three silences: seven inputs, n=7.
ffmpeg -v error -i "<name-1>.mp3" -i sil.mp3 -i "<name-2>.mp3" -i sil.mp3 \
       -i "<name-3>.mp3" -i sil.mp3 -i "<name-4>.mp3" \
  -filter_complex "[0][1][2][3][4][5][6]concat=n=7:v=0:a=1" -y comparison.mp3

open comparison.mp3; echo "file://$PWD/comparison.mp3"
```

**Build the JSON with `jq`, not by interpolating into a quoted string.** A
narration paragraph containing a double quote — ordinary in reported speech —
produces malformed JSON when pasted straight into `-d "{\"text\":\"$TXT\"…}"`,
and the failure looks like an API error rather than a quoting bug. `jq -n
--arg` escapes quotes, accents and currency symbols correctly.

The per-voice `ffprobe` line prints each candidate's duration on the same
sentence. That is the pace comparison, for free.

The `concat` **filter** used here re-encodes, so it handles candidates that
come back at different sample rates or channel layouts. Do not swap it for a
`-f concat -c copy` stream copy: on mismatched inputs that does not fail, it
writes a playable file with a wrong duration.

## What makes a sample worth judging

**Do not synthesize "hola, esto es una prueba".** A greeting tells you nothing
about how a voice handles the actual material: its terminology, its numbers,
its sentence lengths, its normalized reference codes. A voice that sounds
warm on a greeting can be flat or unintelligible on the real thing.

Pick one real paragraph from `$OUT/script.md` — **already normalized**, and
ideally one of the harder blocks, with numbers or acronyms in it. That is the
`TXT` value in the snippet above.

Three rules make the comparison mean something:

- **The same paragraph for every candidate.** Different text is not a
  comparison.
- **The same model and voice settings for every candidate.** A candidate that
  wins because it got different settings has not won anything.
- **One file, not four.** Separate MP3s get compared badly — the owner loses
  track of which is which. The snippet interleaves them with silence so the
  set can be judged in a single listen.

Hand over a numbered key alongside the file, since the audio itself does not
say which voice is which, in the order the snippet concatenated them:

```
1. <name>   voice_id <id>   <descriptor>
2. <name>   voice_id <id>   <descriptor>
3. <name>   voice_id <id>   <descriptor>
```

Deliver as a clickable `file://` link, with the key in the message.

## Then stop

**Wait for the owner's choice.** Do not synthesize the full deck against a
voice nobody approved — that is minutes of audio, an API bill, and a full
render, all of which get thrown away if the answer is "the second one".

If the owner rejects all of them, that is information about the filter, not a
dead end: change accent, gender or `use_cases`, paginate further, and produce
a second shortlist. Ask what was wrong with the first set before guessing.

Once a voice is chosen, record its `voice_id` in the working directory next to
the script. Re-synthesizing a single slide weeks later has to use the same
voice, and "the one that sounded good" is not recoverable.
