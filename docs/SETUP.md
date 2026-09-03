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

## Everyday commands

```bash
pnpm check                                       # typecheck + tests
python3 scripts/validate_commit_guardian.py --scan   # audit the whole tree
```
