# Editorial workflow

## Base flow

A content piece (a row of `content_items`) moves through the stages
`idea` -> `draft` -> `published`, and can be `archived`. The stage is stored
once, in its column, and a piece keeps its slug across stages: an idea is
promoted by its own row, never copied. Ideas, drafts and published pieces of a
brand served from storage are read and written with the `brand content` verbs,
never as files (bodies are Markdown files at absolute scratch paths outside the
repo):

```text
Idea                      brand content put <slug> <piece> --file <abs/body.md> --title <t> --stage idea
  ↓
Draft (promote the idea)  brand content stage <slug> <piece> --stage draft --if-version <n>
                          brand content put <slug> <piece> --file <abs/body.md> --if-version <n+1>
  ↓
Review + owner approval   brand content get <slug> <piece>
  ↓
Manual publication on the platform
  ↓
Archive as published      brand content stage <slug> <piece> --stage published --published-at <ISO date> --if-version <n>
  ↓
Optional Notion sync
```

A piece cannot be created directly as `published`: it gets there from `draft`.
A derivative of a piece is created with `--derived-from <parent-slug>`.

A brand that is not cut over to storage yet is a folder brand: the same stages
are the files `<brand folder>/ideas/backlog.md`,
`<brand folder>/content/drafts/<YYYY-MM-DD-slug>.md` and
`<brand folder>/content/published/<YYYY-MM-DD-slug>.md`. The `usar-perfil`
skill says how to tell which one a brand is and where its folder is.

## Rules

- Keep ideas, drafts and published pieces inside the corresponding brand.
- Read the brand's config (`brand doc get <slug> config`; folder brand: `config.yaml`) before creating content, plus its local overrides for private integrations when it has them.
- Use the shared templates in `system/templates/`.
- Do not mix the author's identity with the system's guides.
- Treat Notion as an optional integration, not a required dependency.

## Minimum shape of a brand

- identity and positioning (`brand doc get <slug> identity`; folder brand: `profile.md`)
- config (`brand doc get <slug> config`; folder brand: `config.yaml`)
- content pieces (`brand content list <slug>`; folder brand: the backlog, `content/drafts/` and `content/published/`)

## Commands

The `brand` CLI is run as `pnpm --filter @personal-brand/storage brand <verb> --json`
(`DATABASE_URL` must be set). Exit codes: 0 ok, 2 usage or invalid input,
3 version conflict, 4 not found, 6 refused. A write needs `--if-version <n>`
(the `version` of the piece you read); only `content put` may omit it, which
means "create", and an existing slug answers with exit 3.
