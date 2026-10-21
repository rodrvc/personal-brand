import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { ContentStage } from "../contracts/index.ts";
import { resolvePublishedAt } from "../revision-policy.ts";
import { found, readRegular, sha256, slugify, type CollectContext, type Item } from "./shared.ts";

/** What a content item must read back as (everything but the slug, which is its key). */
interface ContentPayload {
  title: string;
  stage: ContentStage;
  channel: string | null;
  format: string | null;
  bodyMd: string;
  meta: Record<string, unknown>;
  publishedAt: string | null;
}

const IDEA_LINE = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:-|$)/;

const first = (data: Record<string, unknown>, ...keys: string[]) => keys.map((k) => data[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;

/** `YYYY-MM-DD[...]` as an ISO instant, or null when it is not a date. */
function instant(value: string | undefined): string | null {
  const at = value && /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? new Date(value.trim().length === 10 ? `${value.trim()}T00:00:00Z` : value.trim()) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
}

/**
 * Ideas backlog, drafts and published pieces as `content_items`. The legacy markers are not interpreted: a checked
 * backlog line (`[x]`) becomes stage `archived` (neutral; nothing is discarded or deleted) and an unchecked or plain
 * bullet becomes `idea`. Anything else a file carries (its frontmatter, the checked flag) is kept verbatim in `meta`,
 * so "approved by the owner" lives there and is not a stage of its own. The folder a piece sits in decides its stage.
 */
export function collectContent(ctx: CollectContext): Item[] {
  const { dir, root, repos, skipped, handled } = ctx;
  const items: Item[] = [];
  const slugs = new Set<string>();
  const unique = (base: string) => {
    let slug = base;
    for (let n = 2; slugs.has(slug); n++) slug = `${base}-${n}`;
    slugs.add(slug);
    return slug;
  };
  const add = (slug: string, rawHash: string, payload: ContentPayload) =>
    items.push({
      key: `content:${slug}`, entityType: "content_item", hash: rawHash, payload,
      read: async (id) => {
        const row = await found(repos.content.get(id, slug));
        if (!row) return null;
        const { stage: _stage, ...meta } = row.value.meta;
        const v = row.value;
        return { id: row.id, version: row.version, value: { title: v.title, stage: v.stage, channel: v.channel, format: v.format, bodyMd: v.bodyMd, meta, publishedAt: v.publishedAt } };
      },
      write: async (id, expectedVersion, meta) => {
        const { stage, publishedAt, ...fields } = payload;
        if (expectedVersion === null) return repos.content.create(id, { slug, stage, ...fields, ...(publishedAt ? { publishedAt } : {}) }, meta);
        const cur = await repos.content.get(id, slug);
        // A stage move, or a new publication date of a piece that stays published, is a second write (`save` drops both).
        const moves = cur.value.stage !== stage || (stage === "published" && Date.parse(cur.value.publishedAt ?? "") !== Date.parse(publishedAt ?? ""));
        // The repository's own rule, checked first: a refused move must not leave the row already overwritten by `save`.
        if (moves) resolvePublishedAt(cur.value.stage, stage, publishedAt ?? undefined, cur.value.publishedAt);
        // Only the last revisioned write carries the item hash, so an interrupted pass is never classified `unchanged`.
        const saved = await repos.content.save(cur.id, fields, { ...meta, expectedVersion, ...(moves ? { sourceHash: `${meta.sourceHash}:doc` } : {}) });
        if (moves) await repos.content.setStage(cur.id, { stage, ...(publishedAt ? { publishedAt } : {}) }, { ...meta, expectedVersion: saved.version });
      },
    });

  const ideasDir = join(dir, "ideas");
  for (const file of existsSync(ideasDir) ? readdirSync(ideasDir).sort() : []) {
    handled.add("ideas");
    const rel = `ideas/${file}`;
    const raw = file.endsWith(".md") ? readRegular(root, join(ideasDir, file), rel, skipped) : (skipped.push(`${rel} (not a .md file)`), null);
    let other = 0;
    for (const line of raw ? raw.toString("utf-8").split(/\r?\n/) : []) {
      const m = IDEA_LINE.exec(line);
      if (!m) {
        if (line.trim() && !line.startsWith("#")) other++;
        continue;
      }
      const checked = m[1] !== undefined && m[1] !== " ";
      add(unique(`idea-${slugify(m[2]) || sha256(m[2]).slice(0, 8)}`), sha256(`${rel}\n${checked}\n${m[2]}`), {
        title: m[2], stage: checked ? "archived" : "idea", channel: null, format: null, bodyMd: "", meta: { legacy: { file: rel, checked } }, publishedAt: null,
      });
    }
    if (other) skipped.push(`${rel} (${other} line(s) outside the checklist stay only in the folder)`);
  }

  for (const [stage, sub] of [["draft", "drafts"], ["published", "published"]] as const) {
    const folder = join(dir, "content", sub);
    for (const file of existsSync(folder) ? readdirSync(folder).sort() : []) {
      handled.add("content");
      const rel = `content/${sub}/${file}`;
      if (file === "README.md") skipped.push(`${rel} (folder readme, stays only in the folder)`);
      else if (!file.endsWith(".md")) skipped.push(`${rel} (not a .md file)`);
      else {
        const raw = readRegular(root, join(folder, file), rel, skipped);
        if (!raw) continue;
        const text = raw.toString("utf-8");
        let data: Record<string, unknown> = {};
        let body = text;
        const m = FRONTMATTER.exec(text);
        try {
          const parsed = m ? parseYaml(m[1]) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
          if (m) body = m[2];
        } catch {
          skipped.push(`${rel} (unreadable frontmatter)`);
          continue;
        }
        const stem = basename(file, ".md");
        // A published piece needs a date: its frontmatter, else the `YYYY-MM-DD-` prefix of its name. No guessing beyond that.
        const publishedAt = stage === "published" ? instant(first(data, "publicado", "published_at", "publishedAt", "fecha")) ?? instant(DATE_PREFIX.exec(stem)?.[1]) : null;
        if (stage === "published" && !publishedAt) {
          skipped.push(`${rel} (no publication date: add \`publicado: YYYY-MM-DD\` to its frontmatter)`);
          continue;
        }
        add(unique(slugify(stem) || sha256(stem).slice(0, 8)), sha256(raw), {
          title: first(data, "titulo", "title") ?? stem, stage, channel: slugify(first(data, "canal", "channel") ?? "") || null, format: slugify(first(data, "formato", "format") ?? "") || null,
          bodyMd: body, meta: { frontmatter: data, legacy: { file: rel } }, publishedAt,
        });
      }
    }
  }
  if (existsSync(join(dir, "content"))) {
    handled.add("content");
    for (const entry of readdirSync(join(dir, "content")).sort()) if (!["drafts", "published"].includes(entry)) skipped.push(`content/${entry} (not imported yet)`);
  }
  return items;
}
