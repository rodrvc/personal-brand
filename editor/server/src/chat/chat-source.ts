import { NotFoundError } from "@personal-brand/storage/contracts";

import { readProfileCurrency } from "../../../../system/ig-carousel/profile.js";

import { documentExists } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";
import { storedCarouselRaw, storedConfig, type StoredBrand } from "../stored-read.js";
import { appendChatRecord, readChatLog, stampRecord, type ChatRecord, type NewRecord } from "./chat-log.js";

export interface ChatCurrency {
  code: string;
  rate: number;
}

/**
 * One carousel's chat log and its display currency, for a folder and a stored brand alike, so the routes are one code
 * path. `append` stamps (id, time) and returns the record as logged; a stored brand that is archived refuses it
 * (`BrandArchivedError`, the repository's own check).
 */
export interface ChatSource {
  read(): Promise<ChatRecord[]>;
  append(record: NewRecord): Promise<ChatRecord>;
  currency(): Promise<ChatCurrency>;
}

const DEFAULT_CURRENCY: ChatCurrency = { code: "USD", rate: 1 };

/** The folder's `chat.jsonl` and `config.yaml`; undefined when the carousel does not exist. */
export function folderChatSource(store: ProfileStore, carouselId: string): ChatSource | undefined {
  if (!documentExists(store, carouselId)) return undefined;
  return {
    read: async () => readChatLog(store, carouselId),
    append: (record) => appendChatRecord(store, carouselId, record),
    currency: async () => readProfileCurrency(store.roots.profileDir) ?? DEFAULT_CURRENCY,
  };
}

/** The stored `config` document's `currency` (the importer stores `config.yaml` parsed as JSON), stricter than the folder's: a code of exactly 3 letters (the folder's regex has no end anchor, so it accepts a longer code) and a finite positive rate, else USD. */
function currencyOf(config: unknown): ChatCurrency {
  const raw = (config as { currency?: { code?: unknown; rate?: unknown } } | null)?.currency;
  const rate = Number(raw?.rate);
  return typeof raw?.code === "string" && /^[A-Za-z]{3}$/.test(raw.code) && Number.isFinite(rate) && rate > 0 ? { code: raw.code.toUpperCase(), rate } : DEFAULT_CURRENCY;
}

/** The chat repository's log of a stored carousel (each body is the whole record, as the importer keeps it) and the stored config's currency; undefined when the carousel does not exist. */
export async function storedChatSource(s: StoredBrand, carouselId: string): Promise<ChatSource | undefined> {
  let rowId: string;
  try {
    rowId = (await storedCarouselRaw(s, carouselId)).rowId;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
  return {
    read: async () => (await s.storage.chat.list(rowId)).map((m) => m.body as unknown as ChatRecord),
    append: async (record) => {
      const full = stampRecord(record);
      await s.storage.chat.append(rowId, full as unknown as Record<string, unknown>);
      return full;
    },
    currency: async () => currencyOf(await storedConfig(s)),
  };
}
