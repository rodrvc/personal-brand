# Public Repo Rules

## Default policy

This repository is public.

If a file is not clearly safe for public publication, it MUST NOT be committed.

## Allowed to commit

- system architecture and workflow specs
- generic templates
- generic agent contracts
- generic guides and documentation
- anonymized examples with no real person attached
- implementation code for reusable tooling

## Forbidden to commit

- real drafts for a specific person
- personal brand data tied to a real person
- local working cards
- Notion exports or live content snapshots
- profile-specific private examples
- unpublished content tied to a real identity
- approval artifacts under `.git/`
- secrets, tokens, IDs, private links

## Sensitive patterns

Treat as high risk and block by default:

- filenames containing a real person name
- files under local/mock card paths
- content describing a real person's audience, objectives, voice, CTA, or positioning
- raw pipeline test artifacts using real profile data

## Commit rule

Every commit MUST be reviewed by `commit-guardian` before `git commit`.

A commit is allowed only if:

1. `commit-guardian` marks it `safe_to_commit: true`
2. approved files exactly match staged files
3. no forbidden files remain staged

## Decision rule

When in doubt:

- prefer blocking the commit
- require anonymization or file removal
- commit only reusable/generic artifacts
