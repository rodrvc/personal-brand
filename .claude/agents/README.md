# Personal Brand Agent Team

Agents available in `.claude/agents/`:

- `content-strategist.md`
- `idea-capture.md`
- `draft-writer.md`
- `draft-reviewer.md`
- `channel-adapter.md`
- `content-publisher.md`
- `analytics-reviewer.md`
- `commit-guardian.md`
- `memory-engineer.md`
- `notion-sync.md` (explicit sync to Notion, only when the user asks)

## Base rule

All of them must:
- resolve the brand with the `usar-perfil` skill first; they never repeat how to find it and never read or write a brand's folder on their own
- read and write ideas, drafts and published pieces through the `brand content` verbs (`list`, `get`, `put`, `stage`) for a brand served from storage; a folder brand (not cut over yet) uses its files, as `usar-perfil` describes
- read identity and config with `brand doc get <slug> identity|config`
- use `system/templates/` and `system/guides/workflow.md`
- treat Notion as optional
- keep the repo brand-agnostic

The `brand` CLI is run as `pnpm --filter @personal-brand/storage brand <verb> --json`
(`DATABASE_URL` must be set). Exit codes: 0 ok, 2 usage or invalid input,
3 version conflict, 4 not found, 6 refused. Content writes never need the
owner opt-in on a brand already cut over; never set `BRAND_OWNER_OPT_IN` or pass
`--owner-opt-in` yourself.
