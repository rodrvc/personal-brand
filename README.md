# Personal Brand System

A content engine for social media — Instagram carousels (PNG) and vertical
reels (MP4) — that renders for **any** brand without knowing about a single
one of them.

The repo is split in two, and the split is the whole design:

- **the engine** — `system/`, `.claude/`, `app/`, `core/` — generic, publishable,
  and free of any real brand's literals.
- **the brands** — `profiles/<slug>/` — identity, tokens, config, recipes and
  business rules. Git-ignored; they live on disk next to the engine and travel
  as a single folder.

## Getting started

```bash
pnpm install
pnpm setup        # required — see below
```

`pnpm setup` is not optional. Cloning does not install git hooks, so a fresh
clone has **no gate running**: it installs them, creates your local watched-terms
file, checks that file is really ignored by git, and prints the boundary rules.
It is safe to run again at any time.

Then register a brand:

```bash
pnpm init:profile
```

An interactive terminal prompt. It asks for a slug, copies `profiles/example/`
as the starting point, asks which of the brand's terms must be watched, and
refuses to finish unless the new folder is genuinely outside git.

Everyday commands:

```bash
pnpm check                                          # typecheck + tests
python3 scripts/validate_commit_guardian.py --scan  # audit the whole tree
pnpm dev:editor                                      # run the carousel editor (editor/)
```

## The boundary

**A real brand's literals never go in the engine.** Not its name, city, domain,
`@handle`, hashtags or output paths — and not in a comment, an example or a
skill description either. Prose is the risky layer, because it is the part
nobody reads in a diff.

**Generic layers write those values as parameters:** `<brand>`, `<city>`,
`<slug>`, `--profile <slug>`, `profiles/<slug>/`.

**The test is mechanical:** adding a second brand, with a different palette and
a different language, must render correctly without editing one file under
`system/` or `.claude/`. If supporting a brand means touching the engine, the
value is in the wrong place.

**And it is checked, not merely agreed.** A rule written in prose is worth
whatever the review that applies it is worth. `scripts/validate_commit_guardian.py`
runs from a pre-commit hook and refuses, deterministically, any commit that puts
brand literals in a generic layer, tracks a profile other than `profiles/example*`,
or adds a `!profiles/<slug>/` negation to `.gitignore` — a negation would
silently win over every rule written above. See [`docs/commit-gate.md`](docs/commit-gate.md).

Most watched terms are **derived automatically** from the profiles present on
disk — slug, wordmark, domain, hashtags, city, `@handle`. Registering a brand is
putting its folder there; there is no list to remember to update. What derivation
cannot see goes in `scripts/brand-denylist.local.txt`, which is git-ignored:
to forbid a word you have to write it down, so a published denylist would be a
plain list of everything you meant to keep out of sight.

## Layout

```text
.
├─ system/            the engine
│  ├─ ig-carousel/    carousel render (PNG slides)
│  ├─ ig-reel/        reel render (vertical MP4)
│  ├─ recipes/        flow contracts: what the engine fixes, what a profile fills
│  ├─ templates/      shared post and script templates
│  ├─ guides/         operating guides
│  └─ config/         schemas and config conventions
├─ editor/            carousel editor (web) — one module, not the product
├─ app/               desktop module (Tauri) — deprecated, superseded by editor/
├─ core/              shared logic between modules
├─ profiles/
│  ├─ example/        fictional profile, tracked — the template init:profile copies
│  └─ example-personal/
├─ scripts/           setup, profile registration, the commit gate
└─ docs/              architecture and rules
```

## What a profile holds

```text
profiles/<slug>/
  profile.md          identity, positioning, tone
  brand.json          tokens: colours, fonts, categories, copy
  brand-spec.md       the brand decisions and where they came from
  config.yaml         operations: hashtags, output paths
  config.local.yaml   optional private overrides
  recipes/*.yaml      parameters for a flow defined in system/recipes/
  skills/*/SKILL.md   the brand's own business rules
  carousels/, reels/  render inputs
  ideas/, content/    backlog, drafts, published archive
```

That last one matters for anyone working in this repo: **the business rules are
not here.** A skill that carries a brand's judgement — what content qualifies,
its tone, its data source — belongs in `profiles/<slug>/skills/`, not in
`.claude/skills/`, which holds only generic orchestrators. So a missing profile
or recipe is usually a discovery problem, not a missing file.

`BRAND_PROFILES_DIR` can move the profiles root elsewhere; the default,
`<repo>/profiles`, is what is normally used.

## Workflow

idea → `profiles/<slug>/ideas/backlog.md` → draft in `content/drafts/` → owner
review → manual publication → archived in `content/published/`.

Full guide: [`system/guides/workflow.md`](system/guides/workflow.md).

## Where to read next

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) — the three layers and the
  boundaries between modules. Read before touching anything outside one module.
- [`docs/commit-gate.md`](docs/commit-gate.md) — how the gate works and why.
- [`docs/public-repo-rules.md`](docs/public-repo-rules.md) — what may not be published.
- [`CLAUDE.md`](CLAUDE.md) — operating guide for agents in this repo.
- [`system/config/brand.schema.md`](system/config/brand.schema.md) — the `brand.json` schema.
- [`editor/README.md`](editor/README.md) / [`editor/ESTADO.md`](editor/ESTADO.md) — the carousel editor: how to run it, decisions, known traps.
- [`app/ESTADO.md`](app/ESTADO.md) — the deprecated desktop module.
