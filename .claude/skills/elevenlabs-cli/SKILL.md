---
name: elevenlabs-cli
description: >-
  Default route for any ElevenLabs work in this repo: the official `elevenlabs`
  CLI, authenticated once with browser OAuth (token in the OS keychain), so no
  API key is ever needed. Use FIRST — before the vendored ElevenLabs skills and
  before asking anyone for an API key — whenever a task needs a voiceover, TTS,
  timestamps or captions, speech-to-text, music, sound effects, audio isolation,
  dialogue, or a voice search. Falls back to `setup-api-key` only for CI or
  headless runs.
---

# ElevenLabs via the official CLI

The vendored ElevenLabs skills (`text-to-speech`, `music`, `speech-to-text`...,
locked in `skills-lock.json`) explain the API and its parameters. **Do not edit
them.** This skill only decides *how to call it*: through the `elevenlabs` CLI,
which carries its own OAuth login. Use those skills for model and parameter
knowledge, and this one for execution.

## 1. Check auth first

```bash
elevenlabs auth status --format json
```

- `"logged_in": true` → go on. Nothing to export, no `.env`, no key.
- `"logged_in": false` or command not found → stop and ask the owner to run
  `! elevenlabs auth login` (browser OAuth) or install the CLI
  (`brew install elevenlabs/tap/elevenlabs`). Wait for them. Do not ask for an
  API key as a workaround.

Never print, copy, log or store a token or key. Never pass `--xi-api-key`.

## 2. Never guess flags

Every command is self-describing. Before using one you have not run in this
session:

```bash
elevenlabs <group> <command> --help     # human flags
elevenlabs <group> <command> --schema   # machine-readable JSON schema
elevenlabs <group> <command> ... --dry-run   # validate locally, no API call
```

Agent-friendly output on every command: `--format json|raw|jsonl`,
`--query '<JMESPath>'`, `-q` (quiet on success).

## 3. Main commands

| Need | Command |
| --- | --- |
| Voiceover to a file | `elevenlabs text-to-speech convert` |
| Voiceover plus character timings | `elevenlabs text-to-speech convert_with_timestamps` |
| Find a voice | `elevenlabs voices search` |
| Word/char timings from audio + transcript (captions) | `elevenlabs forced-alignment create` |
| Transcribe audio | `elevenlabs speech-to-text` |
| Music | `elevenlabs music` |
| Clean a voice track | `elevenlabs audio-isolation` |
| Multi-speaker dialogue | `elevenlabs text-to-dialogue` |
| Quick listen, no file | `elevenlabs say` (defaults in `say config`) |

For anything not listed, `elevenlabs --help` lists the groups.

## 4. Output-to-file pattern (verify it yourself)

Binary responses go to a file with `-o <path>`. The CLI prints a small JSON
receipt (`status`, `saved_file`, `bytes`, `mimeType`). Do not trust the
receipt alone — check the file:

```bash
elevenlabs text-to-speech convert \
  --voice-id <voice_id> \
  --model-id eleven_multilingual_v2 \
  --text "<one sentence>" \
  --output-format mp3_44100_128 \
  -o <out_dir>/<name>.mp3

file <out_dir>/<name>.mp3        # expect: MPEG ADTS, layer III
ffprobe -v error -show_entries format=duration -of csv=p=0 <out_dir>/<name>.mp3
```

Rules for outputs:

- Write into the profile's output folder or a scratch dir — never into
  `system/` or `.claude/`.
- Never overwrite an existing audio file; write `<name>-v2.mp3` next to it.
- Report the measured duration; downstream video timing is derived from it.

## 5. Recipes that worked

Verified on 2026-10-13 with `elevenlabs` 1.5.0 and OAuth login:

```bash
# Voice search — compact list of id/name/category
elevenlabs voices search --page-size 3 --format json \
  --query 'voices[].{id: voice_id, name: name, category: category}'

# One-sentence TTS to a file (Spanish text, multilingual model)
elevenlabs text-to-speech convert \
  --voice-id NGYAv6uk8AhPMVNpqTUg \
  --model-id eleven_multilingual_v2 \
  --text "Prueba rápida de la CLI de ElevenLabs." \
  --output-format mp3_44100_128 \
  -o "$SCRATCH/smoke.mp3"
# → status success, 43511 bytes, MPEG layer III 44.1 kHz mono, 2.65 s
```

Gotcha: `voices search --search <term>` matches voice names and metadata, not
free-text intent; a generic term like `narrator` can return `[]`. Filter with
`--language`, `--gender`, `--accent`, `--use-cases` instead, or list and pick.

For livelier delivery when `voice-settings.*` are not enough, switch to
`--model-id eleven_v3` and put audio tags such as `[excited]` in the text.

## 6. Fallback: API key (CI / headless only)

Only when OAuth is impossible (CI runner, remote box with no browser), use the
vendored `setup-api-key` skill to provide `ELEVENLABS_API_KEY`. That is the
exception, not the default: in an interactive session on the owner's machine,
always go back to step 1.
