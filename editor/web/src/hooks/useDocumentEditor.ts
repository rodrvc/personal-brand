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

  const schedulePersist = useCallback(
    (next: CarouselDocument) => {
      setDirty(true);
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        putCarousel(slug, next)
          .then(() => {
            setDirty(false);
            setSaveError(null);
            setRenderVersion((v) => v + 1);
          })
          .catch((error: unknown) => {
            setSaveError(error instanceof Error ? error.message : String(error));
          });
      }, PERSIST_DEBOUNCE_MS);
    },
    [slug],
  );

  /** A user edit: pushes the previous state for undo, clears redo, persists. */
  const update = useCallback(
    (updater: (prev: CarouselDocument) => CarouselDocument) => {
      setDocState((prev) => {
        const next = updater(prev);
        if (next === prev) return prev;
        undoStack.current.push(prev);
        if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
        redoStack.current = [];
        schedulePersist(next);
        return next;
      });
    },
    [schedulePersist],
  );

  /** Server-authoritative replacement (plan apply, regenerate): not part of the undo stack. */
  const applyRemote = useCallback((next: CarouselDocument) => {
    undoStack.current = [];
    redoStack.current = [];
    setDocState(next);
    setDirty(false);
    setSaveError(null);
    setRenderVersion((v) => v + 1);
  }, []);

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

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, []);

  return { doc, update, applyRemote, undo, redo, canUndo, canRedo, dirty, saveError, renderVersion };
}
