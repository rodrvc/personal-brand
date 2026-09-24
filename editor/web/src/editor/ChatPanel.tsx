import { useCallback, useEffect, useRef, useState } from "react";

import type { CarouselDocument, ChatProposal, ChatRecord, ChatReference, Currency } from "../api/types";
import { addReferenceFromAsset, getChat, resolveProposal, sendChatMessage, uploadChatReference } from "../api/client";
import { t } from "../i18n";
import { describeAction, describeIntact, describeProvenance } from "./chat-summary";
import { BUCKET_ASSET_DRAG_MIME, type BucketAssetDragPayload } from "./panels/asset-grouping";
import "./ChatPanel.css";

const COLLAPSED_STORAGE_PREFIX = "editor-chat-collapsed:";
const NARROW_QUERY = "(max-width: 1200px)";

interface ChatPanelProps {
  slug: string;
  doc: CarouselDocument;
  /** Unsaved local edits would be overwritten by the server's copy, so applying waits for the save. */
  dirty: boolean;
  onApplied: (next: CarouselDocument) => void;
  onLogChange: (records: ChatRecord[], currency: Currency) => void;
}

function initialCollapsed(doc: CarouselDocument): boolean {
  if (window.matchMedia(NARROW_QUERY).matches) return true;
  const stored = localStorage.getItem(COLLAPSED_STORAGE_PREFIX + doc.id);
  return stored === null ? doc.slides.length > 0 : stored === "1";
}

export function ChatPanel({ slug, doc, dirty, onApplied, onLogChange }: ChatPanelProps) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(doc));
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [pending, setPending] = useState<ChatProposal | null>(null);
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropHighlight, setDropHighlight] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // Counts nested enter/leave pairs so a child element's dragleave (fired
  // while the pointer is still over the panel, just over a descendant)
  // doesn't flicker the highlight off before the real leave.
  const dragDepth = useRef(0);

  const load = useCallback(() => {
    getChat(slug, doc.id)
      .then(({ records: loaded, pendingProposalId, currency: profileCurrency }) => {
        setRecords(loaded);
        setCurrency(profileCurrency);
        const owner = loaded.find((r) => r.role === "assistant" && r.proposal?.id === pendingProposalId);
        setPending(owner?.role === "assistant" && owner.proposal ? owner.proposal : null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [slug, doc.id]);

  useEffect(load, [load]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => query.matches && setCollapsed(true);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (currency) onLogChange(records, currency);
  }, [records, currency, onLogChange]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [records, collapsed]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_STORAGE_PREFIX + doc.id, next ? "1" : "0");
  };

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const result = await run(() => sendChatMessage(slug, doc.id, text, references));
    if (!result) return;
    setDraft("");
    setReferences([]);
    setRecords((prev) => [...prev, ...result.records]);
    const assistant = result.records.find((r) => r.role === "assistant");
    if (assistant?.role === "assistant" && assistant.proposal) setPending(assistant.proposal);
  };

  const resolve = async (decision: "apply" | "discard") => {
    if (!pending) return;
    const result = await run(() => resolveProposal(slug, doc.id, pending.id, decision));
    if (!result) return load();
    setRecords((prev) => [...prev, ...result.records]);
    setPending(null);
    if (result.document) onApplied(result.document);
  };

  const attach = async (files: FileList) => {
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const uploaded = await run(() => Promise.all(images.map((file) => uploadChatReference(slug, doc.id, file))));
    if (uploaded) setReferences((prev) => [...prev, ...uploaded]);
  };

  const attachFromAsset = async (payload: BucketAssetDragPayload) => {
    const reference = await run(() => addReferenceFromAsset(slug, doc.id, payload.assetId, payload.name));
    if (reference) setReferences((prev) => [...prev, reference]);
  };

  if (collapsed) {
    return (
      <aside className="chat-panel chat-panel--collapsed">
        <button type="button" className="chat-rail" onClick={toggle} title={t("chat.expand")}>
          <span className="chat-rail-label">{t("chat.title")}</span>
          {pending && <span className="chat-rail-badge">{t("chat.pendingBadge")}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`chat-panel ${dropHighlight ? "chat-panel--drop" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDropHighlight(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropHighlight(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDropHighlight(false);
        const assetPayload = e.dataTransfer.getData(BUCKET_ASSET_DRAG_MIME);
        if (assetPayload) {
          void attachFromAsset(JSON.parse(assetPayload) as BucketAssetDragPayload);
          return;
        }
        void attach(e.dataTransfer.files);
      }}
    >
      <header className="chat-head">
        <span>{t("chat.title")}</span>
        <button type="button" className="chat-collapse" onClick={toggle} title={t("chat.collapse")}>
          ‹
        </button>
      </header>
      {dropHighlight && <div className="chat-drop-overlay">{t("chat.dropHint")}</div>}
      <div className="chat-log" ref={logRef}>
        {records.length === 0 && <p className="chat-hint">{t("chat.emptyHint")}</p>}
        {records.map((record) =>
          record.role === "event" ? (
            <p key={record.id} className="chat-event">
              {record.kind === "failed" ? t("chat.failedEvent", { error: record.error ?? "" }) : t("chat.appliedEvent")}
            </p>
          ) : record.text ? (
            <p key={record.id} className={`chat-msg chat-msg--${record.role}`}>
              {record.text}
              {record.role === "user" &&
                record.references?.map((r) => (
                  <span key={r.id} className="chat-ref">
                    {t("chat.referenceChip", { name: r.name })}
                  </span>
                ))}
            </p>
          ) : null,
        )}
      </div>
      {pending && (
        <section className="chat-proposal">
          <h3>{t("chat.proposalHeading")}</h3>
          <ul>
            {pending.actions.map((action) => (
              <li key={action.id}>
                <strong>{describeAction(doc, action)}</strong>
                {action.why && <span className="chat-why">{action.why}</span>}
                {action.provenance.map((p, i) => (
                  <span key={i} className="chat-source">
                    {describeProvenance(p)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <div className="chat-intact">
            {describeIntact(doc, pending.actions).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="chat-proposal-buttons">
            <button type="button" className="chat-apply" disabled={busy || dirty} onClick={() => resolve("apply")}>
              {dirty ? t("chat.waitSave") : busy ? t("chat.applying") : t("chat.apply")}
            </button>
            <button type="button" disabled={busy} onClick={() => resolve("discard")}>
              {t("chat.discard")}
            </button>
          </div>
        </section>
      )}
      {error && <p className="chat-error">{error}</p>}
      {references.length > 0 && (
        <div className="chat-refs">
          {references.map((r) => (
            <button key={r.id} type="button" className="chat-ref" onClick={() => setReferences((prev) => prev.filter((x) => x !== r))}>
              {t("chat.referenceChip", { name: r.name })} ✕
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          placeholder={t("chat.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          {busy ? t("chat.thinking") : t("chat.send")}
        </button>
      </form>
    </aside>
  );
}
