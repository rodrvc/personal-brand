# Setup

What a fresh clone does not give you, and how to get it.

## One command

```bash
pnpm install
pnpm setup
```

`pnpm setup` is safe to run again at any time.

## Why it is not optional

**Cloning does not install the git hooks.** Hooks live behind
`core.hooksPath`, which is per-clone configuration rather than tracked
content, so a fresh clone, a new machine or a new worktree starts with no
gate and says nothing about it. `pnpm setup` installs them.

The gate refuses any commit that would put a brand's literals in the generic
layers, track a real profile, or negate the `profiles/` ignore rule. See
[`commit-gate.md`](commit-gate.md) for the contract and
[`../CLAUDE.md`](../CLAUDE.md) for the boundary it enforces.

`pnpm setup` also creates your local watched-terms file and verifies git
really ignores it — the terms are what the gate searches for, and they are
never published.

## pnpm, not npm

The repo is a pnpm workspace: `app/` and `system/ig-reel/remotion/` are
members, and one install at the root mounts all three projects. Installing a
member on its own builds a second, differently-shaped `node_modules` beside
the one the workspace links, and resolves a tree the lockfile never
described.

`python3` is a hard dependency of the gate, not a detail: the validator that
the hooks and CI both run is a Python script.

## Registering a brand

```bash
pnpm init:profile
```

An interactive terminal prompt. It copies `profiles/example/` as the starting
point, asks which of the brand's terms must be watched, appends them to the
local file, and refuses to finish unless the new folder is genuinely outside
git.

Creating a profile by hand instead skips the term registration — and a gate
with no terms to search for reports success without checking anything.

## Running the editor

`editor/` is the local web editor for brand carousels (see
[`../editor/ESTADO.md`](../editor/ESTADO.md) and
[`../editor/README.md`](../editor/README.md)). It needs Playwright's
Chromium, which the root `pnpm install` does not fetch on its own:

```bash
pnpm install
npx playwright install chromium
pnpm dev:editor
```

This starts `editor/server` on `http://127.0.0.1:4310` and the `editor/web`
Vite dev server (URL printed by Vite). Both read a `.env` at the repo root,
not one inside `editor/`:

```bash
OPENAI_API_KEY=sk-...   # optional — without it, AI-generation endpoints
                          # return 503; composing from the asset library
                          # still works
```

Before generating with AI, download a profile's brand fonts once so the
editor never depends on a live Google Fonts request:

```bash
tsx system/assets/fetch-fonts.ts --profile <slug>
```

## Specs (OpenSpec)

Architectural and module-design decisions are proposed and tracked as specs
under `openspec/`:

```bash
openspec list        # changes in flight or archived, and their task progress
openspec validate     # checks a change's proposal/design/tasks are well-formed
```

See `openspec/changes/editor-carruseles/` for an example: `proposal.md`,
`design.md` and `tasks.md`.

## Everyday commands

```bash
pnpm check                                       # typecheck + tests
python3 scripts/validate_commit_guardian.py --scan   # audit the whole tree
```
