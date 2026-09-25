import { useCallback, useEffect, useRef, useState } from "react";

import type { CarouselDocument, ChatProposal, ChatRecord, ChatReference, Currency } from "../api/types";
import { getCarousel, getChat, resolveProposal, sendChatMessage, uploadChatReference } from "../api/client";
import { t } from "../i18n";
import {
  defaultReferenceRole,
  describeAction,
  describeIntact,
  describeProvenance,
  formatCost,
  runningProposalId,
} from "./chat-summary";
import "./ChatPanel.css";

const COLLAPSED_STORAGE_PREFIX = "editor-chat-collapsed:";
const NARROW_QUERY = "(max-width: 1200px)";
const POLL_MS = 2500;

interface ChatPanelProps {
  slug: string;
  doc: CarouselDocument;
  activeSlideId?: string;
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

export function ChatPanel({ slug, doc, activeSlideId, dirty, onApplied, onLogChange }: ChatPanelProps) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(doc));
  const [records, setRecords] = useState<ChatRecord[]>([]);
  const [pending, setPending] = useState<ChatProposal | null>(null);
  const [currency, setCurrency] = useState<Currency | null>(null);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Finished applies (done or failed) already reflected in the editor's document; `null` until the first load.
  const seenFinished = useRef<Set<string> | null>(null);

  const load = useCallback(() => {
    getChat(slug, doc.id)
      .then(({ records: loaded, pendingProposalId, currency: profileCurrency }) => {
        setRecords((prev) => (prev.length === loaded.length ? prev : loaded));
        setCurrency(profileCurrency);
        const owner = loaded.find((r) => r.role === "assistant" && r.proposal?.id === pendingProposalId);
        setPending(owner?.role === "assistant" && owner.proposal ? owner.proposal : null);
        const finished = loaded.filter((r) => r.role === "event" && r.kind !== "started").map((r) => r.id);
        const firstLoad = seenFinished.current === null;
        const fresh = finished.some((id) => !seenFinished.current?.has(id));
        seenFinished.current = new Set(finished);
        if (!firstLoad && fresh) void getCarousel(slug, doc.id).then(onApplied);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [slug, doc.id, onApplied]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

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
    const result = await run(() => sendChatMessage(slug, doc.id, text, references, activeSlideId));
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
  };

  const attach = async (files: FileList) => {
    const images = [...files].filter((file) => file.type.startsWith("image/") || /\.hei[cf]$/i.test(file.name));
    const uploaded = await run(() => Promise.all(images.map((file) => uploadChatReference(slug, doc.id, file))));
    if (uploaded) {
      const typed = uploaded.map(({ id, name, ...meta }) => ({ id, name, role: defaultReferenceRole(meta) }));
      setReferences((prev) => [...prev, ...typed]);
    }
  };

  const runningId = runningProposalId(records);
  const running = records.flatMap((r) => (r.role === "assistant" && r.proposal?.id === runningId ? [r.proposal] : []))[0];
  const proposalReplyCost = (proposalId: string) =>
    records.reduce((sum, r) => (r.role === "assistant" && r.proposal?.id === proposalId ? sum + (r.costCents ?? 0) : sum), 0);
  const slideNumbers = (ids: string[]) =>
    ids.map((id) => doc.slides.findIndex((s) => s.id === id) + 1).filter((n) => n > 0).join(", ");

  if (collapsed) {
    return (
      <aside className="chat-panel chat-panel--collapsed">
        <button type="button" className="chat-rail" onClick={toggle} title={t("chat.expand")}>
          <span className="chat-rail-label">{t("chat.title")}</span>
          {(pending || running) && <span className="chat-rail-badge">{running ? t("chat.runningBadge") : t("chat.pendingBadge")}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="chat-panel"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
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
              {record.kind === "failed"
                ? t("chat.failedEvent", { error: record.error ?? "" })
                : record.kind === "started"
                  ? t("chat.startedEvent")
                  : t("chat.doneEvent", {
                      slides: slideNumbers(record.results.flatMap((r) => r.slideIds)) || "-",
                      amount: currency ? formatCost(record.costCents + proposalReplyCost(record.proposalId), currency) : "",
                    })}
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
      {running && (
        <section className="chat-proposal chat-proposal--running" aria-busy="true">
          <h3>{t("chat.runningHeading")}</h3>
          <ul>
            {running.actions.map((action) => (
              <li key={action.id}>
                <strong>{describeAction(doc, action)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}
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
            <span key={r.id} className="chat-ref">
              {t("chat.referenceChip", { name: r.name })}
              <select
                value={r.role}
                aria-label={t("chat.referenceRole")}
                onChange={(e) =>
                  setReferences((prev) => prev.map((x) => (x === r ? { ...x, role: e.target.value as "layout" | "content" } : x)))
                }
              >
                <option value="layout">{t("chat.referenceRole.layout")}</option>
                <option value="content">{t("chat.referenceRole.content")}</option>
              </select>
              <button type="button" onClick={() => setReferences((prev) => prev.filter((x) => x !== r))} aria-label={t("chat.referenceRemove")}>
                ✕
              </button>
            </span>
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
