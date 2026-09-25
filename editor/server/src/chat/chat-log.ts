import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { assertValidCarouselId } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";
import type { ChatAction } from "./chat-actions.js";
import type { ChatReference } from "./chat-references.js";

export interface ChatProposal {
  id: string;
  actions: ChatAction[];
}

export type ChatRecord =
  | {
      id: string;
      at: string;
      role: "user";
      text: string;
      references?: ChatReference[];
      resolves?: { proposalId: string; decision: "discard" };
    }
  | {
      id: string;
      at: string;
      role: "assistant";
      text: string;
      proposal?: ChatProposal;
      costCents?: number;
      /** The event data this answer asks the owner for; the next message composes with the same references. */
      asksFor?: string[];
    }
  | {
      id: string;
      at: string;
      role: "event";
      kind: "started" | "applied" | "done" | "failed";
      proposalId: string;
      error?: string;
      documentVersion?: string;
      costCents: number;
      results: Array<{ actionId: string; slideIds: string[]; assetIds?: string[]; costCents?: number }>;
    };

type WithoutStamp<R> = R extends unknown ? Omit<R, "id" | "at"> : never;
type NewRecord = WithoutStamp<ChatRecord>;

function logRelPath(carouselId: string): string {
  assertValidCarouselId(carouselId);
  return `carousels/${carouselId}/chat.jsonl`;
}

export function newChatId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function readChatLog(store: ProfileStore, carouselId: string): ChatRecord[] {
  const abs = store.resolveInProfile(logRelPath(carouselId));
  if (!existsSync(abs)) return [];
  return readFileSync(abs, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ChatRecord);
}

/**
 * Appends one record to the chat log. Goes through `ProfileStore.appendLine`
 * (issue #99), which in `s3` mode reads the log's current content and etag
 * straight from the bucket, appends, and writes back conditioned on that
 * etag — retrying a bounded number of times, with jitter, if another
 * writer's append landed first — so two concurrent appenders never lose
 * either one's record. `fs` mode appends directly, exactly as this always
 * did before that guarantee existed.
 */
export async function appendChatRecord(store: ProfileStore, carouselId: string, record: NewRecord): Promise<ChatRecord> {
  const full = {
    id: newChatId(record.role === "event" ? "evt" : "msg"),
    at: new Date().toISOString(),
    ...record,
  } as ChatRecord;
  await store.appendLine(logRelPath(carouselId), JSON.stringify(full));
  return full;
}

/** Only the latest proposal can be pending: a newer one supersedes it, and any record naming it resolves it. */
export function pendingProposal(log: ChatRecord[]): ChatProposal | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const record = log[i]!;
    if (record.role === "assistant" && record.proposal) {
      const id = record.proposal.id;
      const resolved = log
        .slice(i + 1)
        .some((later) =>
          later.role === "event" ? later.proposalId === id : later.role === "user" && later.resolves?.proposalId === id,
        );
      return resolved ? undefined : record.proposal;
    }
  }
  return undefined;
}
