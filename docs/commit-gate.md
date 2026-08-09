# Deterministic Commit Gate

## Goal

Prevent direct commits of unsafe or non-public material.

## Rule

No commit is allowed until a separate `commit-guardian` review approves the exact staged set.

## Workflow

1. Stage files normally.
2. Ask `commit-guardian` to review the staged files against:
   - `docs/public-repo-rules.md`
   - repo structure and scope
   - staged file list and staged diff
3. If approved, write `commit-guardian-approval.json` into the repository's
   git directory:
   `"$(git rev-parse --absolute-git-dir)/commit-guardian-approval.json"`.
   In a normal clone that is `.git/`; in a **linked worktree** `.git` is a file
   pointing elsewhere, so always ask git for the directory rather than assuming
   a `.git/` directory exists. Use `--absolute-git-dir`, which is what the
   validator uses — plain `--git-dir` can answer a relative `.git` that
   resolves against the current directory instead of the repository. The file
   has this shape:

```json
{
  "version": 1,
  "reviewer": "commit-guardian",
  "safe_to_commit": true,
  "staged_tree": "<git write-tree output>",
  "allowed_files": ["path/a", "path/b"],
  "forbidden_files": [],
  "notes": ["optional notes"]
}
```

4. Run `git commit`.
5. The pre-commit hook validates:
   - approval file exists
   - `safe_to_commit` is true
   - current staged tree equals approved `staged_tree`
   - staged files exactly match `allowed_files`
   - `forbidden_files` is empty
   - something is actually staged (an approval is single-use — see below)

If any check fails, commit is blocked.

## Run the checks before staging

```bash
npm run check      # tsc --noEmit + both test suites (68 tests)
```

The pre-render slide guard is a *compile-time* guarantee, and until this script
existed nothing ran `tsc`: the gate never typechecked and `package.json` had a
single `render:all` script. So the ~20 type-level assertions in
`system/ig-carousel/render-batch.types.test.ts` only existed while someone
remembered to type the command — "everyone remembers to call it" relocated one
level up, which is the failure that guard was built to remove.

The gate also refuses `as VerifiedSlide` outside `system/ig-carousel/verify-slides.ts`.
That cast compiles from anywhere (the branded type is a subtype of `Slide`, so a
downcast is legal) and is what someone writes in good faith when the compiler
complains. The compiler covers the accidental routes; this text check covers the
asserted one. Comment lines that merely mention the cast are ignored, so
documenting the limit is not punished.

## An approval is single-use

One review authorizes exactly one commit.

This needs enforcing explicitly, because `staged_tree` alone does not cover
it: right after a commit lands, the index still equals the tree that was just
committed, so the approved hash keeps matching while `git diff --cached` goes
empty. A second commit — an empty one, an `--amend`, a re-commit of the same
content — would otherwise satisfy every hash check on a review nobody
re-issued.

Two things close that:

- `post-commit` deletes the approval file as soon as the commit it authorized
  lands.
- `validate_commit_guardian.py` refuses when nothing is staged, so the gate
  holds even if `post-commit` is skipped or fails.

A merge commit is the one legitimate case with nothing staged (git supplies
the tree, there is no diff to review); `pre-commit` lets it through only when
`MERGE_HEAD` is present.

## Consequences

- changing staged files after approval invalidates the approval
- approving a smaller or different file set does not allow commit
- an approval already spent on a commit cannot authorize another
- local drafts and personal-profile artifacts stay out of public history

## The brand denylist derives itself from the profiles on disk

Three deterministic checks in `validate_commit_guardian.py` cannot be approved
by `commit-guardian`, because judgement is exactly what let the original leaks
through. One of them — brand literals under `system/` or `.claude/` — needs a
list of terms to look for, and that list used to be maintained by hand in
`scripts/brand-denylist.txt`.

That made the check protect brand #1 and **not exist** for brand #2 until
someone remembered to register it. "Add the slug, domain, handle and city to the
denylist" was a manual step nothing enforced — a remembered procedure, not a
guarantee, and the same failure mode as the prose rule that did not stop the
original leak.

So the terms are now **derived from the real profiles present on disk**. A real
profile is any `profiles/<slug>/` that is not `example*`. From each one the gate
reads:

| Term | Source |
|---|---|
| slug | the folder name |
| wordmark | `brand.json` → `copy.wordmark` |
| domain + its base name | `brand.json` → `copy.site` (`brand.cl` also yields `brand`) |
| image hosts + base names | `brand.json` → `sourceImageHosts` |
| hashtags, profile name | `config.yaml` → `content.default_hashtags`, `profile.name` |
| city, API host | `recipes/*.yaml` → `defaults.city`, `source.url` |
| city | `carousels/*.json` → `city` |
| `@handle` | any text file in the profile folder |

Consequences:

- **Registering a brand is now just putting its folder on disk.** Nothing to
  remember, nothing to edit.
- **`profiles/example*` contribute nothing.** They are fictitious, publishable
  and tracked; if they fed the denylist the gate would block commits using its
  own onboarding content.
- **`scripts/brand-denylist.txt` still works and is added on top.** It is now
  for what derivation cannot see: private repo/product names, retired aliases
  whose profile has left the disk, terms shorter than the minimum length, and
  generic words derivation deliberately drops.
- **A fresh clone with no real profile does not crash.** Derivation contributes
  zero terms and the manual file governs alone.

### False positives, and how they are contained

A derived term is matched as a plain case-insensitive substring, so a term that
is also ordinary vocabulary would block legitimate engine commits — and, worse,
push someone to disable the gate. Two guards:

- **Minimum length of 4 characters.** Below that, terms are acronyms and
  fragments (`AI`, `cl`, `Rol`) that appear in generic prose constantly and
  would also match inside longer words. Four still admits the shortest
  plausible real brand (`Nike`, `Uber`). A genuinely 2–3 character slug must be
  declared by hand, where a human can weigh the cost.
- **A generic-word list** (`GENERIC_WORDS`). Very common cities (`Santiago`,
  `Chile`, `London`) and wordmarks that are everyday words (`Studio`, `Norte`,
  `Plaza`, `Brand`) are dropped from derivation. If such a term really must be
  watched for a specific brand, it goes in the manual file, explicitly
  accepting the noise.

What remains unhandled: a brand whose wordmark is a common word gets **no**
automatic protection, and nothing warns that it was dropped. It has to be
noticed and declared manually.

### Seeing why a term is watched

`python3 scripts/validate_commit_guardian.py --scan` prints every watched term
with each place it came from, and every finding names the matching term and its
provenance. Without that, a block caused by a derived term is indistinguishable
from a bug in the gate.

## Scope

This gate protects commits.

Push remains normal once the commit already passed the gate.
