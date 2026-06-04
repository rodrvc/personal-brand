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
3. If approved, write `.git/commit-guardian-approval.json` with this shape:

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

If any check fails, commit is blocked.

## Consequences

- changing staged files after approval invalidates the approval
- approving a smaller or different file set does not allow commit
- local drafts and personal-profile artifacts stay out of public history

## Scope

This gate protects commits.

Push remains normal once the commit already passed the gate.
