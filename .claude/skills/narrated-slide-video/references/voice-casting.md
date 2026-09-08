# Voice casting

You produce a shortlist. **The owner picks.** This reference covers finding
candidates and building the file they listen to.

Synthesis itself — models, voice settings, the API call — is the
[`text-to-speech`](../../text-to-speech/SKILL.md) skill. Nothing here
duplicates it. What this stage adds is the search, the sample construction,
and the approval gate.

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

## Build the samples with the real script text

**Do not synthesize "hola, esto es una prueba".** A greeting tells you nothing
about how a voice handles the actual material: its terminology, its numbers,
its sentence lengths, its normalized reference codes. A voice that sounds
warm on a greeting can be flat or unintelligible on the real thing.

Pick one real paragraph from `$OUT/script.md` — **already normalized**, and
ideally one of the harder blocks, with numbers or acronyms in it. Use the
**same** paragraph for every candidate; that is what makes them comparable.

Synthesize it once per candidate:

```
$OUT/casting/sample-01-<name>.mp3
$OUT/casting/sample-02-<name>.mp3
$OUT/casting/sample-03-<name>.mp3
```

Use the same model and voice settings across all of them. A candidate that
wins because it got different settings has not won anything.

## Assemble one comparison file

Three or four separate MP3s get compared badly — the owner loses track of
which is which. Concatenate them into one file with a short silence between,
so it can be judged in a single listen.

```bash
cd "$OUT/casting"

# 1s of silence, in the same format as the samples
ffmpeg -v error -f lavfi -i anullsrc=r=44100:cl=mono -t 1 -c:a libmp3lame -y gap.mp3

: > list.txt
for s in sample-*.mp3; do
  printf "file '%s'\nfile 'gap.mp3'\n" "$s" >> list.txt
done

ffmpeg -v error -f concat -safe 0 -i list.txt -c copy -y comparison.mp3
ffprobe -v error -show_entries format=duration -of csv=p=0 comparison.mp3
```

Watch what that prints. If the samples differ in sample rate or channel
layout, `-c copy` does **not** fail — it emits `non monotonically increasing
dts` warnings, writes a file that plays, and reports a duration that does not
match the inputs. Do not read "it produced a file" as success here. Re-encode
instead:

```bash
ffmpeg -v error -f concat -safe 0 -i list.txt \
  -ar 44100 -ac 1 -c:a libmp3lame -b:a 192k -y comparison.mp3
```

Hand over a numbered key alongside the file, since the audio itself does not
say which voice is which:

```
1. <name>   voice_id <id>   <accent / descriptor>
2. <name>   voice_id <id>   <accent / descriptor>
3. <name>   voice_id <id>   <accent / descriptor>
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
