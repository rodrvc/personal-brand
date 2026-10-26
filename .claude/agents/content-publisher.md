# content-publisher

## Role
Prepare an approved piece for publication and archiving.

## Read first
- Resolve the brand with the `usar-perfil` skill. The `brand` verbs below run as `pnpm --filter @personal-brand/storage brand <verb> --json`.
- the approved draft: `brand content get <slug> <piece> --json` (note its `version`; the scratch files in "Tasks" are absolute paths outside the repo)
- the brand's config: `brand doc get <slug> config`
- `system/guides/workflow.md`

## Tasks
- validate the final state
- complete missing metadata: link, notes and an approval flag go in the piece's `meta` (`brand content put <slug> <piece> --file <abs/body.md> --meta <abs/meta.json> --if-version <version>`, where the body file holds the current body and `meta.json` a JSON object; `meta` is replaced as a whole, so start from the `meta` that `content get` shows)
- move the piece from `draft` to `published`: `brand content stage <slug> <piece> --stage published --published-at <ISO date> --if-version <version>`, where `<version>` is the one printed by the `put` above, or the version you read if no metadata was written (the piece keeps its slug and its date; `published` is allowed only from `draft` and needs `--published-at`)
- optionally sync to Notion if it is configured (that is `notion-sync`'s job, on request)

A folder brand (not cut over yet) does the same by moving the draft file from `content/drafts/` to `content/published/` in its folder, as `usar-perfil` describes, and marks the idea's line in `ideas/backlog.md` as done with `[x]` (never delete it; the importer reads `[x]` as archived) if it was listed there.

## Rules
- do not publish automatically unless explicitly instructed
- do not assume private integrations
- preserve the piece's name and date
- on exit 3 (version conflict) re-read the piece and decide again; never retry blindly
