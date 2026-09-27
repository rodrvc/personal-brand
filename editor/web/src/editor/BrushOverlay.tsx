import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { LayoutTemplate, Slide, SlideKind, SlideObject } from "../api/types";
import { imageDisplayScale, imageToScreen } from "./brush/mask";
import type { ImageFrame, Point } from "./brush/mask";
import type { useBrushMask } from "./brush/useBrushMask";
import "./BrushOverlay.css";

interface ObjectBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BrushOverlayProps {
  slide: Slide;
  template: LayoutTemplate;
  scale: number;
  /** Display px, same size as the `.stage-art` box the iframe sits in (Stage.tsx already computes this for the iframe's own `style`). */
  width: number;
  height: number;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  iframeLoadTick: number;
  brush: ReturnType<typeof useBrushMask>;
}

/** An object's own `geometry.rotation` wins; a slotted object with no geometry of its own inherits the slot's (carousel-document-resolve.ts's `resolveSlide`). Box position/size come from the measured DOM box below, not from here. */
function resolveRotation(object: SlideObject, template: LayoutTemplate, slideKind: SlideKind): number {
  if (object.geometry) return object.geometry.rotation;
  const slot = object.slot ? template.slides[slideKind]?.slots.find((s) => s.name === object.slot) : undefined;
  return slot?.geometry.rotation ?? 0;
}

/**
 * Paints a brush mask over the active slide's asset objects. Sibling of
 * `SelectionOverlay`, but mutually exclusive with it (Stage.tsx renders one
 * or the other depending on `tool`) — brush mode suppresses selection/drag
 * entirely rather than layering on top of it.
 *
 * Reads object boxes from the iframe DOM the same way `SelectionOverlay`
 * does (kept as its own small copy here: this overlay only ever needs boxes
 * to hit-test a pointer-down, not the drag/rotate/text-edit machinery
 * `SelectionOverlay` owns).
 */
export function BrushOverlay({ slide, template, scale, width, height, iframeRef, iframeLoadTick, brush }: BrushOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boxes, setBoxes] = useState<ObjectBox[]>([]);
  const activeListeners = useRef<{ onMouseMove: (ev: MouseEvent) => void; onMouseUp: () => void } | null>(null);

  const readBoxes = useCallback(() => {
    const contentDoc = iframeRef.current?.contentDocument;
    if (!contentDoc) return;
    const next: ObjectBox[] = [];
    contentDoc.querySelectorAll<HTMLElement>("[data-object-id]").forEach((el) => {
      const id = el.getAttribute("data-object-id");
      if (!id) return;
      next.push({ id, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    });
    setBoxes(next);
  }, [iframeRef]);

  useEffect(() => {
    readBoxes();
  }, [readBoxes, iframeLoadTick, slide.id]);

  useEffect(() => {
    return () => {
      const listeners = activeListeners.current;
      if (!listeners) return;
      window.removeEventListener("mousemove", listeners.onMouseMove);
      window.removeEventListener("mouseup", listeners.onMouseUp);
      activeListeners.current = null;
    };
  }, []);

  const frameFor = useCallback(
    (objectId: string): ImageFrame | null => {
      const object = slide.objects.find((o) => o.id === objectId);
      const box = boxes.find((b) => b.id === objectId);
      const contentDoc = iframeRef.current?.contentDocument;
      if (!object || object.kind !== "asset" || !box || !contentDoc) return null;
      const img = contentDoc.querySelector<HTMLImageElement>(`[data-object-id="${objectId}"] img`);
      if (!img || !img.naturalWidth || !img.naturalHeight) return null;
      return {
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        rotation: resolveRotation(object, template, slide.kind),
        fit: object.fit,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };
    },
    [slide, template, boxes, iframeRef],
  );

  function hitObjectAt(point: Point): string | null {
    for (const box of boxes) {
      const object = slide.objects.find((o) => o.id === box.id);
      if (!object || object.kind !== "asset") continue;
      if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) return box.id;
    }
    return null;
  }

  function handleMouseDown(e: React.MouseEvent) {
    const overlayEl = overlayRef.current;
    if (!overlayEl) return;
    const rect = overlayEl.getBoundingClientRect();
    const toCanvasPoint = (clientX: number, clientY: number): Point => ({
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    });

    const point = toCanvasPoint(e.clientX, e.clientY);
    const hitId = brush.target?.objectId ?? hitObjectAt(point);
    if (!hitId) return;
    const objectId: string = hitId;
    const frame = frameFor(objectId);
    if (!frame) return;
    const object = slide.objects.find((o) => o.id === objectId);
    const assetId = object?.kind === "asset" ? object.assetId : undefined;
    brush.startStroke(point, frame, objectId, assetId, scale);

    function onMouseMove(ev: MouseEvent) {
      const current = frameFor(objectId);
      if (!current) return;
      brush.continueStroke(toCanvasPoint(ev.clientX, ev.clientY), current);
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      activeListeners.current = null;
      brush.endStroke();
    }
    activeListeners.current = { onMouseMove, onMouseUp };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  // Redraws from image-space strokes every render — this is what makes the
  // painted marks survive zoom/fit/resize: only screen/canvas coordinates
  // change, the stored strokes never do.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!brush.target) return;
    const frame = frameFor(brush.target.objectId);
    if (!frame) return;

    const fillColor = getComputedStyle(canvas).getPropertyValue("--brush-fill").trim() || "rgb(41 111 152 / 0.45)";
    const dispScale = imageDisplayScale(frame);
    ctx.fillStyle = fillColor;
    for (const stroke of brush.strokes) {
      // Redraw in stroke order every time: an erase stroke drawn after a
      // paint stroke needs to actually cut into it on screen, exactly like
      // `rasterizeMask` does for the confirmed bitmap.
      ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
      const screenRadius = stroke.radius * dispScale * scale;
      for (const point of stroke.points) {
        const canvasPoint = imageToScreen(point, frame);
        ctx.beginPath();
        ctx.arc(canvasPoint.x * scale, canvasPoint.y * scale, screenRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }, [brush.strokes, brush.target, frameFor, width, height, scale]);

  return (
    <div className="brush-overlay" ref={overlayRef} onMouseDown={handleMouseDown}>
      <canvas ref={canvasRef} className="brush-canvas" />
    </div>
  );
}
