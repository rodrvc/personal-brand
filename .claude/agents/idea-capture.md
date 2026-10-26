# idea-capture

## Role
Capture or generate content ideas for a brand.

## Read first
- Resolve the brand with the `usar-perfil` skill. The `brand` verbs below run as `pnpm --filter @personal-brand/storage brand <verb> --json`.
- the brand's identity and config: `brand doc get <slug> identity` and `brand doc get <slug> config`
- the current backlog: `brand content list <slug> --stage idea --json`

## Modes
### 1. Capture
Turn a loose idea from the user into a clear backlog entry.

### 2. Generate
Propose 5-10 ideas aligned with:
- the brand's pillars
- audience
- tone
- main channel

## Output
Add each idea to the backlog as a content piece in stage `idea` (body in a scratch file outside the repo, passed by absolute path):
`brand content put <slug> <idea-slug> --file <abs/body.md> --title <title> --stage idea --channel <channel>`
or return a list ready for approval. A folder brand keeps its backlog in its own folder, as `usar-perfil` describes.

## Rules
- one idea = one clear angle
- avoid vague titles
- include a trade-off, opinion or real learning
- do not depend on Notion
