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

## Starting point: Chilean Spanish female voices

A **starting point, not a closed list.** These were returned by
`shared-voices?gender=female&language=es&search=chilean` and are recorded here
so the next agent does not repeat the search from zero — and, more to the
point, does not assert that voices for an accent do not exist without asking.

| Voice ID | Name | Age | Catalog note |
|---|---|---|---|
| `lLsDvdl6OjtZfLJPM2HA` | Olivia Pro — Strategic Business & Tech | middle_aged | professional, vibrant |
| `GJid0jgRsqjUy21Avuex` | Emma — Authoritative, Assured and Clear | middle_aged | the most formal of the set |
| `prblQcKOdF08ozhxP2mk` | Angela — Warm, Calm and Assured | middle_aged | warm and calm, but **noticeably slower** — see the note below |
| `6Gr4AVmTax1pMJO0lHRK` | Catalina — Chilean Spanish | young | "connects, does not just recite"; closer, less formal |
| `oJIuRMopN0sojGjwD6rQ` | Camila | young | customer service and sales |
| `Fd38GRHtJllY0CuguAy9` | Victoria | young | clear and confident |
| `NxmJt7aR0FMgBqiYrcc0` | Esperanza | young | relaxed |
| `JM2A9JbRp8XUJ7bdCXJc` | Fernanda Olea — Cheerful and Powerful | young | powerful, conversational |

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

### No audio samples are versioned in this repo

This was considered and deliberately rejected. Do not reintroduce it:

1. **Samples must be generated with the real script text.** A generic
   pre-recorded sample would have the owner choose on material that is not the
   project's — exactly what this skill forbids.
2. **They age badly.** A sample is only valid for that accent, that language
   and that voice configuration.
3. **They are binaries in git for no reason**, when regenerating them costs
   seconds.

Generate them outside the repo — the scratchpad, or the commission's working
directory — and hand over the comparison file.

### Generate and compare in one pass

```bash
cd "$OUT/casting"   # outside the repo

# The REAL first paragraph of the script, already normalized.
TXT='<first paragraph of the script>'

for pair in "Olivia:lLsDvdl6OjtZfLJPM2HA" \
            "Emma:GJid0jgRsqjUy21Avuex" \
            "Angela:prblQcKOdF08ozhxP2mk" \
            "Catalina:6Gr4AVmTax1pMJO0lHRK"; do
  n="${pair%%:*}"; id="${pair##*:}"
  jq -n --arg t "$TXT" '{text:$t,model_id:"eleven_multilingual_v2",
      voice_settings:{stability:0.5,similarity_boost:0.75,style:0.15}}' \
  | curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/$id" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
      -d @- -o "$n.mp3"
  echo "$n  $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$n.mp3")s"
done

ffmpeg -v error -f lavfi -t 0.9 -i anullsrc=r=44100:cl=mono -y sil.mp3
ffmpeg -v error -i Olivia.mp3 -i sil.mp3 -i Emma.mp3 -i sil.mp3 \
       -i Angela.mp3 -i sil.mp3 -i Catalina.mp3 \
  -filter_complex "[0][1][2][3][4][5][6]concat=n=7:v=0:a=1" -y comparativa-voces.mp3

open comparativa-voces.mp3; echo "file://$PWD/comparativa-voces.mp3"
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
