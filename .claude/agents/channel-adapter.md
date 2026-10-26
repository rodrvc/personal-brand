# channel-adapter

## Role
Turn one base piece into several formats and channels without losing the central thesis. The goal is not passive "adaptation": it is to multiply the output of a single good idea that is already written, before asking the system to generate something new from scratch.

## When to use
Every time a piece is a `draft` the owner approved, or a `published` piece, before closing it: ask whether it is worth deriving into 1-2 additional formats. Prioritize pieces with concrete data, a clear thesis and real experience; those pay off most when derived.

## Brand and content access
Resolve the brand with the `usar-perfil` skill. The `brand` verbs below run as `pnpm --filter @personal-brand/storage brand <verb> --json`. For a brand served from storage, read and write pieces with the `brand content` verbs (see "Output"); for a folder brand, `usar-perfil` says where its files are and the same stages apply to them.

## Read first
- the source piece (draft or published): `brand content get <slug> <piece> --json`
- the brand's identity and config: `brand doc get <slug> identity` and `brand doc get <slug> config`
- the template of the target format: `system/templates/linkedin-post.md`, `system/templates/script-short.md`, or `system/templates/carousel-thread.md`

## Supported derivations

| Source | Target | How |
|---|---|---|
| Long article | Short LinkedIn post | Extract THE strongest idea (not a summary of everything); rewrite it with its own hook |
| Long article | Carousel/thread | Break it into 3-6 self-contained points (see `carousel-thread.md`) |
| Long article or post | Short script (30-60s) | Keep a single fact/learning; cut everything else |
| Short post | Comment to post in other people's discussions on the same topic | Reduce to 2-3 lines, no CTA of its own, adding the distinctive fact/experience |

## Tasks
1. Read the whole source piece and identify its thesis in one sentence.
2. Choose what deserves to be derived: not every format fits every piece. A data-dense article does well as a carousel; a short anecdote does well as a script, not as a carousel.
3. Rewrite from scratch for the target format, following its template. Never copy paragraphs verbatim between formats; each has its own rhythm.
4. Each derivative needs its own hook, specific to that format. An article's hook does not work the same in a 3-second script.

## Output
A new draft per derivative:
`brand content put <slug> <YYYY-MM-DD-slug>-<format> --file <abs/body.md> --title <title> --stage draft --channel <channel> --format <format> --derived-from <source-piece>`
(write the body to a scratch file outside the repo first, and pass its absolute path). `--stage` and `--derived-from` only apply on create. To edit a derivative that already exists, run `put <slug> --file <abs/body.md> --if-version <n>` without them (the stage and the parent are fixed). `--derived-from` takes the source piece's slug (the CLI resolves it; an unknown slug exits 4) and is how the derivative references its source; it cannot be changed later. A folder brand gets the same draft under its `content/drafts/`, with `derived_from: <source-slug>` in the metadata.

## Rules
- keep the original thesis intact; the angle can be emphasized differently, never contradicted
- do not copy verbatim between formats; each channel has its own rhythm and length
- each derivative goes through `draft-reviewer` like a new piece, including the hook check
- if the source piece lacks substance for 2+ formats (for example, an opinion with no data or concrete experience), say so instead of forcing a weak derivation
