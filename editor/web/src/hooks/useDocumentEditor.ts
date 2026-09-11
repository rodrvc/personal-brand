import { useCallback, useEffect, useRef, useState } from "react";

import { putCarousel } from "../api/client";
import type { CarouselDocument } from "../api/types";

const PERSIST_DEBOUNCE_MS = 600;
const UNDO_LIMIT = 50;

/**
 * Client-side undo/redo stack over the carousel document, persisted to the
 * server after each confirmed change (debounced). AI operations (plan
 * apply, regenerate) go through `applyRemote`, which replaces the document
 * and clears the stacks instead of pushing an undo entry — per
 * specs/editor-ui "Undo and redo": "AI operations are not undone through
 * this stack: they remain as document versions."
 */
export function useDocumentEditor(slug: string, initial: CarouselDocument) {
  const [doc, setDocState] = useState<CarouselDocument>(initial);
  const undoStack = useRef<CarouselDocument[]>([]);
  const redoStack = useRef<CarouselDocument[]>([]);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;

  /**
   * Bumped only after a document version is confirmed by the server (a
   * successful PUT, or a server-authoritative replacement from applyRemote)
   * — never on every local mutation. The Stage iframe keys its reload off
   * this, not `doc.updatedAt` (which mutations.ts stamps on every keystroke),
   * so typing no longer tears down and refetches the preview mid-edit.
   */
  const [renderVersion, setRenderVersion] = useState(0);

  // `dirtyRef` mirrors `dirty` so `persist` and the unload listeners below
  // (registered once, deps `[slug]`) read the latest value without closing
  // over stale state. `docRef` (above) is the single source of truth for
  // "what to save" — no separate pending-doc mirror to drift out of sync.
  const dirtyRef = useRef(false);
  const setDirtyBoth = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);
  const inFlight = useRef(false);
  // Bumped by schedulePersist and applyRemote. A PUT captures this before
  // sending; if it moved by the time the PUT resolves, that result is
  // stale (a newer edit or a server replacement arrived meanwhile), so
  // `dirty` isn't cleared. Replaces the old saveInFlight/flushRequested
  // pair — one counter instead of two booleans kept in sync by hand.
  const generation = useRef(0);
  // False once this hook unmounts (carousel A → B navigation): every
  // `.then`/`.catch` below checks it first, so a PUT started for A can
  // never touch B's state after EditorRoute.tsx remounts with a new `key`.
  const alive = useRef(true);
  const abortController = useRef<AbortController | null>(null);

  /**
   * The single save path: debounce timer, `pagehide`, `visibilitychange:
   * hidden`, unmount flush. `unloading` means the page/hook may disappear
   * before a normal response arrives. Not dirty → no-op. Already in flight
   * and not unloading → the route replaces the whole document, so a second
   * overlapping PUT would race; let the in-flight `.then()` notice
   * `generation` moved and re-run `persist` itself. In flight AND
   * unloading → abort the in-flight debounced PUT and fire a second,
   * fire-and-forget `keepalive` one (two concurrent PUTs are not
   * protocol-guaranteed to land in order; a write already committed can't
   * be unwound, but aborting narrows the window — the route is
   * last-write-wins by design regardless). Otherwise → send
   * `docRef.current`, clearing `dirty` only if `generation` didn't move.
   */
  const persist = useCallback(
    (unloading: boolean) => {
      if (!dirtyRef.current) return;
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }

      if (inFlight.current) {
        if (unloading) {
          abortController.current?.abort();
          putCarousel(slug, docRef.current, { keepalive: true }).catch(() => {});
        }
        return;
      }

      const sent = docRef.current;
      const myGeneration = generation.current;
      inFlight.current = true;
      abortController.current = unloading ? null : new AbortController();
      putCarousel(slug, sent, unloading ? { keepalive: true } : { signal: abortController.current!.signal })
        .then(() => {
          inFlight.current = false;
          abortController.current = null;
          if (!alive.current) return;
          setSaveError(null);
          setRenderVersion((v) => v + 1);
          const stale = generation.current !== myGeneration;
          setDirtyBoth(stale);
          if (stale) persist(false);
        })
        .catch((error: unknown) => {
          inFlight.current = false;
          abortController.current = null;
          if (!alive.current) return; // no one left to show saveError to
          // Aborted on purpose by the pagehide keepalive PUT that superseded
          // this one: not a failure. `dirty` stays as that path left it and
          // `pageshow` re-runs persist if the page comes back from bfcache.
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (unloading) return;
          setSaveError(error instanceof Error ? error.message : String(error));
        });
    },
    [setDirtyBoth, slug],
  );

  const schedulePersist = useCallback(
    (next: CarouselDocument) => {
      // Set synchronously: an unload can happen before the next render
      // flows `doc` back into `docRef` (line 25), and `persist` must
      // always see the just-written doc, not a stale one.
      docRef.current = next;
      generation.current += 1;
      setDirtyBoth(true);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        persist(false);
      }, PERSIST_DEBOUNCE_MS);
    },
    [persist, setDirtyBoth],
  );

  /** A user edit: pushes the previous state for undo, clears redo, persists. */
  const update = useCallback(
    (updater: (prev: CarouselDocument) => CarouselDocument) => {
      // Compute from `docRef` outside the state updater: React StrictMode
      // double-invokes updaters, so side effects inside one (undo push,
      // dirty flag) ran twice and a stale `setDirty(true)` landed after the
      // PUT cleared it, leaving "Guardando…" on screen forever.
      const prev = docRef.current;
      const next = updater(prev);
      if (next === prev) return;
      undoStack.current.push(prev);
      if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      schedulePersist(next);
      setDocState(next);
    },
    [schedulePersist],
  );

  /**
   * Server-authoritative replacement (plan apply, regenerate): not part of
   * the undo stack. Bumps `generation` too, so a debounced PUT for the
   * pre-replacement doc still in flight sees it moved and won't clobber
   * this replacement with a stale write or clear `dirty` on its behalf.
   */
  const applyRemote = useCallback(
    (next: CarouselDocument) => {
      undoStack.current = [];
      redoStack.current = [];
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      generation.current += 1;
      docRef.current = next;
      setDocState(next);
      setDirtyBoth(false);
      setSaveError(null);
      setRenderVersion((v) => v + 1);
    },
    [setDirtyBoth],
  );

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    setDocState((current) => {
      redoStack.current.push(current);
      schedulePersist(previous);
      return previous;
    });
  }, [schedulePersist]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    setDocState((current) => {
      undoStack.current.push(current);
      schedulePersist(next);
      return next;
    });
  }, [schedulePersist]);

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  /**
   * Unmount (EditorRoute.tsx keys `EditorLoaded` off `slug/id`, so a
   * carousel switch remounts this hook): flush a pending edit, don't
   * discard it, and mark `alive` false so any `.then`/`.catch` still in
   * flight can't touch state after this point.
   */
  useEffect(() => {
    return () => {
      alive.current = false;
      if (persistTimer.current) clearTimeout(persistTimer.current);
      if (dirtyRef.current) putCarousel(slug, docRef.current, { keepalive: true }).catch(() => {});
    };
  }, [slug]);

  /**
   * QA finding: reloading during "Guardando…" silently loses the in-flight
   * edit. `beforeunload` confirms navigation while dirty or saving.
   * `pagehide` → `persist(true)`: the page may vanish before a response
   * lands, so `keepalive: true`, fire-and-forget. `visibilitychange:
   * hidden` → `persist(false)`: a tab switch never unloads, so the normal
   * awaited path resolves `dirty`/`inFlight`/`renderVersion` — `persist(true)`
   * here would leave "Guardando…" stuck.
   */
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current && !inFlight.current) return;
      e.preventDefault();
      e.returnValue = "";
    }

    function handlePageHide() {
      persist(true);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") persist(false);
    }

    // pagehide is not a guarantee of unload (bfcache restore, mobile tab
    // switch): if the page comes back still dirty, resume the awaited path
    // so dirty/renderVersion resolve instead of waiting for the next edit.
    function handlePageShow() {
      if (dirtyRef.current) persist(false);
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [persist, slug]);

  return { doc, update, applyRemote, undo, redo, canUndo, canRedo, dirty, saveError, renderVersion };
}
