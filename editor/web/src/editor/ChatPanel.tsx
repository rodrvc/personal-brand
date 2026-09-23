import { useEffect, useRef, useState } from "react";

import type { CarouselDocument, ChatProposal, ChatRecord } from "../api/types";
import { getChat, resolveProposal, sendChatMessage } from "../api/client";
import { t } from "../i18n";
import { describeAction, describeIntact, describeProvenance } from "./chat-summary";
import "./ChatPanel.css";

const COLLAPSED_STORAGE_PREFIX = "editor-chat-collapsed:";
const NARROW_QUERY = "(max-width: 1200px)";

interface ChatPanelProps {
  slug: string;
  doc: CarouselDocument;
  /** Unsaved local edits would be overwritten by the server's copy, so applying waits for the save. */
  dirty: boolean;
  onApplied: (next: CarouselDocument) => void;
}

function initialCollapsed(doc: CarouselDocument): boolean {
  if (window.matchMedia(NARROW_QUERY).matches) return true;
  const stored = localStorage.getItem(COLLAPSED_STORAGE_PREFIX + doc.id);
  return stored === null ? doc.slides.length > 0 : stored === "1";
}

export function ChatPanel({ slug, doc, dirty, onApplied }: ChatPanelProps) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(doc));
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [pending, setPending] = useState<ChatProposal | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getChat(slug, doc.id)
      .then(({ records: loaded, pendingProposalId }) => {
        setRecords(loaded);
        const owner = loaded.find((r) => r.role === "assistant" && r.proposal?.id === pendingProposalId);
        setPending(owner?.role === "assistant" && owner.proposal ? owner.proposal : null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [slug, doc.id]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => query.matches && setCollapsed(true);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
    const result = await run(() => sendChatMessage(slug, doc.id, text));
    if (!result) return;
    setDraft("");
    setRecords((prev) => [...prev, ...result.records]);
    const assistant = result.records.find((r) => r.role === "assistant");
    if (assistant?.role === "assistant" && assistant.proposal) setPending(assistant.proposal);
  };

  const resolve = async (decision: "apply" | "discard") => {
    if (!pending) return;
    const result = await run(() => resolveProposal(slug, doc.id, pending.id, decision));
    if (!result) return;
    setRecords((prev) => [...prev, ...result.records]);
    setPending(null);
    if (result.document) onApplied(result.document);
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
    <aside className="chat-panel">
      <header className="chat-head">
        <span>{t("chat.title")}</span>
        <button type="button" className="chat-collapse" onClick={toggle} title={t("chat.collapse")}>
          ‹
        </button>
      </header>
      <div className="chat-log" ref={logRef}>
        {records.length === 0 && <p className="chat-hint">{t("chat.emptyHint")}</p>}
        {records.map((record) =>
          record.role === "event" ? (
            <p key={record.id} className="chat-event">
              {t("chat.appliedEvent")}
            </p>
          ) : record.text ? (
            <p key={record.id} className={`chat-msg chat-msg--${record.role}`}>
              {record.text}
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
              {dirty ? t("chat.waitSave") : t("chat.apply")}
            </button>
            <button type="button" disabled={busy} onClick={() => resolve("discard")}>
              {t("chat.discard")}
            </button>
          </div>
        </section>
      )}
      {error && <p className="chat-error">{error}</p>}
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
