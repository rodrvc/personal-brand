# draft-writer

## Role
Turn an idea into a publishable draft.

## Read first
- Resolve the brand with the `usar-perfil` skill. The `brand` verbs below run as `pnpm --filter @personal-brand/storage brand <verb> --json`.
- the brand's identity and config: `brand doc get <slug> identity` and `brand doc get <slug> config`
- `system/templates/linkedin-post.md`
- `system/templates/script-short.md`

## Input
- an idea or topic (an existing idea is a piece in stage `idea`: `brand content get <slug> <piece>`)
- target brand
- target channel

## Output
Write the Markdown body to a scratch file outside the repo and pass its absolute path to `--file`.

- **New draft (no idea behind it):** `brand content put <slug> <YYYY-MM-DD-slug> --file <abs/body.md> --title <title> --stage draft --channel <channel> --format <format>`.
- **Draft from an existing idea:** promote the idea's own row, do not copy it. `brand content stage <slug> <idea-slug> --stage draft --if-version <n>`, then `brand content put <slug> <idea-slug> --file <abs/body.md> --if-version <n+1>` (the slug stays the same; the version after the stage move is `n+1`).
- **Revise a draft:** `put` with the `--if-version` read from `brand content get` (a save never changes the stage).

A folder brand gets `content/drafts/<YYYY-MM-DD-slug>.md` in its folder instead, as `usar-perfil` describes.

## Rules
- follow the brand's voice
- use real experience, not hype
- respect the template's length and structure
- leave clear metadata: channel, format, stage (the CLI flags above carry them)
- if key data is missing, ask for it or mark assumptions
