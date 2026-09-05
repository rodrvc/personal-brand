import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { BrandTokens, CarouselDocument, LayoutTemplate, Slide } from "../api/types";
import type { Selection } from "./geometry";
import { moveGeometry, rotateGeometry, scaleGeometry } from "./geometry";
import { setObjectGeometryAndFontSize, setTextContent } from "./mutations";
import "./SelectionOverlay.css";

interface ResolvedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SelectionOverlayProps {
  template: LayoutTemplate;
  brand: BrandTokens;
  slide: Slide;
  scale: number;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  iframeLoadTick: number;
}

type DragMode = { kind: "move"; startX: number; startY: number } | { kind: "rotate" } | { kind: "scale"; corner: "tl" | "tr" | "bl" | "br" };

/**
 * Reads object and zone boxes straight out of the iframe's own DOM
 * (design.md D2: same-origin `srcdoc`, so `contentDocument` is reachable)
 * rather than recomputing geometry in React — this is what keeps the
 * overlay aligned with whatever the template actually painted, including
 * locked zones the client never has geometry for.
 */
export function SelectionOverlay({
  template,
  brand,
  slide,
  scale,
  selection,
  onSelectionChange,
  onDocUpdate,
  iframeRef,
  iframeLoadTick,
}: SelectionOverlayProps) {
  const [objectBoxes, setObjectBoxes] = useState<ResolvedBox[]>([]);
  const [zoneBoxes, setZoneBoxes] = useState<Array<ResolvedBox & { label: string }>>([]);
  const dragState = useRef<{ mode: DragMode; objectId: string; originGeometry: { x: number; y: number; w: number; h?: number; rotation: number }; originFontSize?: number } | null>(null);
  const [editingText, setEditingText] = useState<{ objectId: string; value: string } | null>(null);

  const readBoxes = useCallback(() => {
    const contentDoc = iframeRef.current?.contentDocument;
    if (!contentDoc) return;
    const objects: ResolvedBox[] = [];
    contentDoc.querySelectorAll<HTMLElement>("[data-object-id]").forEach((el) => {
      const id = el.getAttribute("data-object-id");
      if (!id) return;
      objects.push({ id, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    });
    setObjectBoxes(objects);

    const zones: Array<ResolvedBox & { label: string }> = [];
    contentDoc.querySelectorAll<HTMLElement>("[data-zone]").forEach((el) => {
      const label = el.getAttribute("data-zone") ?? "";
      zones.push({ id: label, label, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    });
    setZoneBoxes(zones);
  }, [iframeRef]);

  useEffect(() => {
    readBoxes();
  }, [readBoxes, iframeLoadTick, slide.id]);

  const findObject = useCallback((objectId: string) => slide.objects.find((o) => o.id === objectId), [slide]);

  const activeDragListeners = useRef<{ onMouseMove: (ev: MouseEvent) => void; onMouseUp: () => void } | null>(null);

  useEffect(() => {
    return () => {
      const listeners = activeDragListeners.current;
      if (!listeners) return;
      window.removeEventListener("mousemove", listeners.onMouseMove);
      window.removeEventListener("mouseup", listeners.onMouseUp);
      activeDragListeners.current = null;
    };
  }, []);

  const beginDrag = useCallback(
    (e: React.MouseEvent, objectId: string, mode: DragMode) => {
      e.stopPropagation();
      e.preventDefault();
      const object = findObject(objectId);
      if (!object || object.locked) return;
      // A slotted object carries no `geometry` of its own until the user
      // moves it (design.md D4): its position comes from the template slot
      // and is only observable as the box measured inside the iframe.
      // Seeding from a {0,0,100} literal instead teleported every untouched
      // object to the top-left corner on the first drag.
      const measured = objectBoxes.find((b) => b.id === objectId);
      const geometry = object.geometry ?? {
        x: measured?.x ?? 0,
        y: measured?.y ?? 0,
        w: measured?.w ?? 100,
        h: measured?.h,
        rotation: 0,
      };
      dragState.current = { mode, objectId, originGeometry: geometry, originFontSize: object.kind === "text" ? object.fontSize : undefined };

      function onMouseMove(ev: MouseEvent) {
        const state = dragState.current;
        if (!state) return;
        const dx = (ev.clientX - startClientX) / scale;
        const dy = (ev.clientY - startClientY) / scale;

        if (state.mode.kind === "move") {
          const nextGeometry = moveGeometry(state.originGeometry, dx, dy);
          setLocalProxy(objectId, nextGeometry);
        } else if (state.mode.kind === "scale") {
          const { geometry: nextGeometry, fontSize } = scaleGeometry(state.originGeometry, state.mode.corner, dx, dy, state.originFontSize);
          setLocalProxy(objectId, nextGeometry, fontSize);
        } else if (state.mode.kind === "rotate") {
          const box = objectBoxes.find((b) => b.id === objectId);
          if (!box) return;
          const centerX = box.x + box.w / 2;
          const centerY = box.y + box.h / 2;
          const angle = (Math.atan2(ev.clientY - (originRect.top + centerY * scale), ev.clientX - (originRect.left + centerX * scale)) * 180) / Math.PI + 90;
          setLocalProxy(objectId, rotateGeometry(state.originGeometry, angle));
        }
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        activeDragListeners.current = null;
        const state = dragState.current;
        dragState.current = null;
        if (!state) return;
        const proxy = proxyRef.current;
        if (proxy) {
          onDocUpdate((prev) => setObjectGeometryAndFontSize(prev, slide.id, objectId, proxy.geometry, proxy.fontSize));
        }
        proxyRef.current = null;
        setProxyTick((t) => t + 1);
      }

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const overlayEl = (e.currentTarget as HTMLElement).closest(".selection-overlay") as HTMLElement | null;
      const originRect = overlayEl?.getBoundingClientRect() ?? { top: 0, left: 0 } as DOMRect;

      activeDragListeners.current = { onMouseMove, onMouseUp };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [findObject, objectBoxes, onDocUpdate, scale, slide.id],
  );

  // Local proxy during drag: avoids a server round-trip per mousemove
  // (design.md "Preview performance" risk) — the overlay box moves purely
  // client-side and the debounced PUT + HTML refetch happens on release.
  const proxyRef = useRef<{ objectId: string; geometry: { x: number; y: number; w: number; h?: number; rotation: number }; fontSize?: number } | null>(null);
  const [, setProxyTick] = useState(0);

  function setLocalProxy(objectId: string, geometry: { x: number; y: number; w: number; h?: number; rotation: number }, fontSize?: number) {
    proxyRef.current = { objectId, geometry, fontSize };
    setProxyTick((t) => t + 1);
  }

  /**
   * Always returns a box in *canvas* px, never display px. The caller
   * multiplies by `scale` exactly once when rendering, the same way the
   * locked zones do. Returning display px here (as the proxy branch used
   * to) put the two branches in different coordinate spaces: measured
   * boxes landed unscaled outside the 330px sheet, and the rotate math
   * scaled an already-scaled centre.
   */
  function boxFor(objectId: string): ResolvedBox | undefined {
    if (proxyRef.current?.objectId === objectId) {
      const g = proxyRef.current.geometry;
      const measured = objectBoxes.find((b) => b.id === objectId);
      // Text objects carry no `geometry.h`; fall back to the last measured
      // height so the selection box keeps its size during a drag.
      return { id: objectId, x: g.x, y: g.y, w: g.w, h: g.h ?? measured?.h ?? 0 };
    }
    return objectBoxes.find((b) => b.id === objectId);
  }

  /** Resolves the object's own fontKey/fontSize, falling back to its template slot when unset (design.md D4). */
  function resolveTextStyle(objectId: string): { fontFamily?: string; fontSize?: number } {
    const object = findObject(objectId);
    if (!object || object.kind !== "text") return {};
    const slot = object.slot ? template.slides[slide.kind]?.slots.find((s) => s.name === object.slot) : undefined;
    const fontKey = object.fontKey ?? (slot?.type === "text" ? slot.fontKey : undefined);
    const fontSize = object.fontSize ?? (slot?.type === "text" ? slot.fontSize : undefined);
    const fontFamily = fontKey ? (brand.fonts as Record<string, string | undefined>)[fontKey] : undefined;
    return { fontFamily, fontSize: fontSize ? fontSize * scale : undefined };
  }

  function handleDoubleClick(objectId: string) {
    const object = findObject(objectId);
    if (!object || object.kind !== "text" || object.locked) return;
    setEditingText({ objectId, value: object.text });
  }

  function commitTextEdit() {
    if (!editingText) return;
    onDocUpdate((prev) => setTextContent(prev, slide.id, editingText.objectId, editingText.value));
    setEditingText(null);
  }

  return (
    <div className="selection-overlay" onClick={() => onSelectionChange(null)}>
      {zoneBoxes.map((zone) => (
        <div
          key={zone.id}
          className={`overlay-zone ${zone.label === "background" && slide.background.pending ? "pending" : ""}`}
          style={{ left: zone.x * scale, top: zone.y * scale, width: zone.w * scale, height: zone.h * scale }}
        >
          <span className="overlay-zone-label">{zone.label.toUpperCase()}</span>
        </div>
      ))}

      {slide.objects.map((object) => {
        const box = boxFor(object.id);
        if (!box) return null;

        if (object.locked) {
          return (
            <div
              key={object.id}
              className="overlay-object locked"
              style={{
                left: box.x * scale,
                top: box.y * scale,
                width: box.w * scale,
                height: box.h ? box.h * scale : undefined,
              }}
            >
              <span className="overlay-lock-badge" title="Bloqueado">🔒</span>
            </div>
          );
        }

        const isSelected = selection?.slideId === slide.id && selection?.objectId === object.id;
        const editing = editingText?.objectId === object.id;
        return (
          <div
            key={object.id}
            className={`overlay-object ${isSelected ? "selected" : ""} ${object.pinned ? "pinned" : ""} ${object.pending ? "pending" : ""}`}
            style={{
              left: box.x * scale,
              top: box.y * scale,
              width: box.w * scale,
              height: box.h ? box.h * scale : undefined,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelectionChange({ slideId: slide.id, objectId: object.id });
            }}
            onDoubleClick={() => handleDoubleClick(object.id)}
            onMouseDown={(e) => {
              if (editing) return;
              onSelectionChange({ slideId: slide.id, objectId: object.id });
              beginDrag(e, object.id, { kind: "move", startX: e.clientX, startY: e.clientY });
            }}
          >
            {object.pinned && <span className="overlay-pin-badge" title="Fijado">✓</span>}
            {isSelected && !editing && (
              <>
                <span className="overlay-handle tl" onMouseDown={(e) => beginDrag(e, object.id, { kind: "scale", corner: "tl" })} />
                <span className="overlay-handle tr" onMouseDown={(e) => beginDrag(e, object.id, { kind: "scale", corner: "tr" })} />
                <span className="overlay-handle bl" onMouseDown={(e) => beginDrag(e, object.id, { kind: "scale", corner: "bl" })} />
                <span className="overlay-handle br" onMouseDown={(e) => beginDrag(e, object.id, { kind: "scale", corner: "br" })} />
                <span className="overlay-rotate-handle" onMouseDown={(e) => beginDrag(e, object.id, { kind: "rotate" })} />
              </>
            )}
            {editing && (
              <textarea
                className="overlay-text-editor"
                autoFocus
                style={(() => {
                  const { fontFamily, fontSize } = resolveTextStyle(object.id);
                  return {
                    ...(fontFamily ? { fontFamily } : {}),
                    ...(fontSize ? { fontSize } : {}),
                  };
                })()}
                value={editingText!.value}
                onChange={(e) => setEditingText({ objectId: object.id, value: e.target.value })}
                onBlur={commitTextEdit}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingText(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitTextEdit();
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
