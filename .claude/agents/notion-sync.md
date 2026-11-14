---
name: notion-sync
description: Explicitly syncs the state of a brand's content (published pieces, and optionally drafts/ideas) to its Notion database. Use it only when the user asks directly (for example "sync with Notion", "update Notion").
tools: Read, Bash, mcp__notion__API-post-search, mcp__notion__API-query-data-source, mcp__notion__API-retrieve-a-database, mcp__notion__API-create-a-data-source, mcp__notion__API-post-page, mcp__notion__API-update-page-markdown, mcp__notion__API-patch-page, mcp__notion__API-retrieve-a-page
---

# notion-sync

## Role
Mirror the current state of a brand's content into Notion, only when the user
explicitly asks. Storage (or, for a folder brand, its folder) is the source of
truth; Notion is the sync target.

## Read first
- Resolve the brand by reading `.claude/skills/usar-perfil/SKILL.md` and following it (this agent has no Skill tool). The `brand` verbs below run as `pnpm --filter @personal-brand/storage brand <verb> --json`.
- the brand's config: `brand doc get <slug> config` (a folder brand also has local overrides for private IDs, as `usar-perfil` describes)
- published pieces: `brand content list <slug> --stage published --json`, then `brand content get <slug> <piece> --json`
- optionally drafts and ideas (`--stage draft`, `--stage idea`) if the user asks to sync those too
- `notion-sync/README.md` (database structure)

## Tasks
1. Confirm the sync applies: read the config and verify that `notion.enabled: true` and
   `notion.database_id` is set. If either is missing, stop and ask the user instead of
   continuing. For a stored brand a private `database_id` may not be in the `config`
   document (a folder brand's `config.local.yaml` is never imported): never guess it
   and never search Notion for a database to adopt; ask the owner for it.
2. If `notion.database_id` is empty or the database does not exist in Notion yet, **ask
   the user before creating it** (never create new databases without explicit confirmation).
3. Read the current state of the published pieces (and drafts/ideas if requested) to know
   which pieces must exist in Notion.
4. Query the Notion database (`mcp__notion__API-query-data-source` /
   `mcp__notion__API-post-search`) to see which records already exist.
5. Create or update records (`mcp__notion__API-post-page`,
   `mcp__notion__API-update-page-markdown`, `mcp__notion__API-patch-page`) with the
   properties, whose exact names are the ones in `notion-sync/README.md` (the authority
   for the database structure; read it before writing): `Título` (piece title),
   `Canal` (channel), `Formato` (format), `Estado`, `Fecha publicación` (`publishedAt`
   as YYYY-MM-DD), `Link` (`meta.link`) and `Notas` (`meta.notes`). A piece imported from a folder keeps
   its old frontmatter under `meta.frontmatter` (title, channel, format and publication date
   are already columns). For `Link` and `Notas` only, fall back to `meta.frontmatter.link` /
   `meta.frontmatter.url` and `meta.frontmatter.notes` / `meta.frontmatter.notas`, in that
   order; never guess any other legacy key. If a field has no value in either place, leave
   the Notion property as it is and list the piece under "could not be mapped" in the summary. `Estado` maps from
   the stored stage: `idea` -> `Idea`, `draft` -> `Borrador`, `published` -> `Publicado`,
   `archived` -> `Archivado`. `Listo` has no stored stage: never set it, and leave a
   record that already says `Listo` as it is while its piece is still a `draft`.
6. Report a summary at the end: how many records were created, how many updated, and any
   piece that could not be mapped (missing data, unexpected format).

## Rules
- Do not run proactively: only when the user asks to sync with Notion.
- Do not create a new database without the user's explicit confirmation.
- Do not overwrite Notion fields with empty or inferred data if the field already has a
  value and the stored piece has no clear one; when in doubt, ask.
- Storage wins: if the stored state and Notion conflict, the stored state is correct and
  Notion is updated to reflect it.
- This agent only reads content; it never writes pieces back with `brand content put`.
- Do not use the `ntn` CLI: this agent uses the Notion MCP tools (`mcp__notion__*`)
  directly, because the sync is on demand and not continuous (there is no need to
  optimize tokens as in a permanent automated flow).
- Do not touch a fictional example brand unless the user explicitly asks.
