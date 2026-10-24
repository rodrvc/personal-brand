import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { assertCarousel } from "../revision-policy.ts";
import { InvalidInputError, VersionConflictError, type CarouselStatus, type WriteMeta } from "../contracts/index.ts";
import { canon, found, readRegular, sha256, type CollectContext, type Item } from "./shared.ts";

const STATUSES: CarouselStatus[] = ["draft", "exported", "scheduled", "published"];
const identity = (b: unknown) => b as Record<string, unknown>;

interface Snapshot {
  hash: string;
  doc: Record<string, unknown>;
}

const parseDoc = (raw: Buffer): Record<string, unknown> | null => {
  try {
    const doc = JSON.parse(raw.toString("utf-8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) && typeof doc.title === "string" ? doc : null;
  } catch {
    return null;
  }
};

/**
 * `carousels/<id>/carousel.json` + `versions/*.json` + `chat.jsonl` become one carousel (slug = id), one revision per
 * internal snapshot (oldest first, reason `import`, so history survives), the current document last, and the chat log
 * as insert-only messages. Status is stored once, in its column. Flat `carousels/*.json` files are recipe inputs,
 * not carousels: `collectRuns` imports them.
 */
export function collectCarousels(ctx: CollectContext): Item[] {
  const { dir, root, repos, skipped, handled } = ctx;
  const base = join(dir, "carousels");
  const items: Item[] = [];
  for (const id of existsSync(base) ? readdirSync(base).sort() : []) {
    handled.add("carousels");
    const rel = `carousels/${id}`;
    const folder = join(base, id);
    if (id.endsWith(".json")) continue; // a recipe input: `collectRuns` imports it (or reports it)
    if (!/^[a-z0-9-]+$/.test(id)) {
      skipped.push(`${rel} (not a valid carousel id)`);
      continue;
    }
    const current = readRegular(root, join(folder, "carousel.json"), `${rel}/carousel.json`, skipped, true);
    const doc = current && parseDoc(current);
    if (current && !doc) skipped.push(`${rel}/carousel.json (not a carousel document)`);
    if (!current || !doc) continue;

    const snapshots: Snapshot[] = [];
    const versionsDir = join(folder, "versions");
    for (const f of existsSync(versionsDir) ? readdirSync(versionsDir).sort() : []) {
      const raw = f.endsWith(".json") ? readRegular(root, join(versionsDir, f), `${rel}/versions/${f}`, skipped) : (skipped.push(`${rel}/versions/${f} (not a .json file)`), null);
      const old = raw && parseDoc(raw);
      if (raw && !old) skipped.push(`${rel}/versions/${f} (not a carousel document)`);
      if (raw && old) snapshots.push({ hash: sha256(raw), doc: old });
    }
    const chatRaw = readRegular(root, join(folder, "chat.jsonl"), `${rel}/chat.jsonl`, skipped);
    const chat: Array<Record<string, unknown>> = [];
    (chatRaw?.toString("utf-8").split(/\r?\n/) ?? []).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const body = JSON.parse(line);
        if (body && typeof body === "object" && !Array.isArray(body)) return void chat.push(body);
      } catch {
        // reported below
      }
      skipped.push(`${rel}/chat.jsonl line ${i + 1} (not a JSON object)`);
    });

    const status = STATUSES.includes(doc.status as CarouselStatus) ? (doc.status as CarouselStatus) : "draft";
    // The document as it reads back: the status column overlaid on the source document. Written and compared in this one shape.
    const document = { ...doc, status };
    const schemaOf = (d: Record<string, unknown>) => (Number.isInteger(d.schemaVersion) && (d.schemaVersion as number) >= 1 ? (d.schemaVersion as number) : 1);
    const hash = sha256([...snapshots.map((s) => s.hash), sha256(current), chatRaw ? sha256(chatRaw) : ""].join("\n"));
    items.push({
      key: `carousel:${id}`, entityType: "carousel", hash,
      payload: { title: doc.title, status, document, chat },
      read: async (brandId) => {
        const row = await found(repos.carousels.get(brandId, id, identity));
        if (!row) return null;
        const messages = (await repos.chat.list(row.id)).map((m) => m.body);
        return { id: row.id, version: row.version, value: { title: row.value.title, status: row.value.status, document: row.value.document, chat: messages } };
      },
      write: async (brandId, expectedVersion, meta: WriteMeta) => {
        // The repository's own rule, checked before any write: a refused status leaves the row untouched.
        assertCarousel({ status });
        const existing = expectedVersion === null ? null : await repos.carousels.get(brandId, id, identity);
        // The row changed since classify judged it: report a conflict instead of writing over that edit.
        if (existing && existing.version !== expectedVersion) throw new VersionConflictError(existing.version);
        const stored = existing ? (await repos.chat.list(existing.id)).map((m) => m.body) : [];
        // The chat log is append-only: if what is stored is not a prefix of the source, the two diverged.
        if (stored.length > chat.length || stored.some((b, i) => canon(b) !== canon(chat[i]))) throw new InvalidInputError("chat log diverged from storage");
        const seen = new Set((existing ? await repos.revisions.list("carousel", existing.id) : []).filter((r) => r.source === "import").map((r) => r.sourceHash));
        // Snapshots not imported yet go first (oldest first), then the current document (`last`). Only the LAST revisioned
        // write (the current document, or the status move after it) carries the item hash, so an interrupted pass is never
        // classified `unchanged`; snapshots carry their own hash and the current document a derived one while something follows.
        const last = { doc: document, sourceHash: hash };
        const steps = [...snapshots.filter((s) => !seen.has(s.hash)).map((s) => ({ doc: s.doc, sourceHash: s.hash })), last];
        const derived = `${hash}:doc`;
        const input = (s: { doc: Record<string, unknown> }) => ({ title: s.doc.title as string, document: { json: s.doc, schemaVersion: schemaOf(s.doc) } });
        let at!: { id: string; version: number; status: CarouselStatus };
        const appendChat = async () => {
          for (const body of chat.slice(stored.length)) await repos.chat.append(at.id, body);
        };
        const setStatus = async (sourceHash: string) => void (await repos.carousels.setStatus(at.id, { status }, { ...meta, expectedVersion: at.version, sourceHash }));
        if (existing) at = { id: existing.id, version: existing.version, status: existing.value.status };
        else {
          // A new carousel starts from its first document, created in its final status when that document is the current one.
          const first = steps.shift()!;
          const alone = first === last;
          const closes = alone && chat.length === 0;
          const made = await repos.carousels.create(brandId, { slug: id, ...input(first), status: alone ? status : "draft" }, { ...meta, expectedVersion: null, sourceHash: closes ? hash : alone ? derived : first.sourceHash });
          at = { id: made.id, version: made.version, status: made.value.status };
          if (closes) return;
          if (alone) {
            // Only the chat follows the create, so a status write (a no-op move) closes the pass instead of saving the document again.
            await appendChat();
            return void (await setStatus(hash));
          }
        }
        const save = async (s: { doc: Record<string, unknown> }, sourceHash: string) => {
          const saved = await repos.carousels.save(at.id, input(s), { ...meta, expectedVersion: at.version, sourceHash });
          at = { ...at, version: saved.version };
        };
        for (const s of steps.filter((x) => x !== last)) await save(s, s.sourceHash);
        await appendChat();
        const moves = at.status !== status;
        await save(last, moves ? derived : hash);
        if (moves) await setStatus(hash);
      },
    });
  }
  return items;
}
