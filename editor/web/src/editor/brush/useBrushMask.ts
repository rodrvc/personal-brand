import { useCallback, useRef, useState } from "react";

import {
  beginStroke,
  buildBrushMask,
  clearStrokes,
  extendStroke,
  rasterizeMask,
  screenRadiusToImageRadius,
  screenToImage,
  undoLastStroke,
} from "./mask";
import type { BrushMask, ImageFrame, Point, Stroke, StrokeMode } from "./mask";
import { rasterToPngDataUrl } from "./maskPng";

export interface BrushTarget {
  objectId: string;
  assetId?: string;
  /** The target `<img>`'s natural size, captured from the frame at the first stroke — `confirm()` rasterizes against this without needing the DOM again. */
  imageWidth: number;
  imageHeight: number;
}

const DEFAULT_SCREEN_RADIUS = 18;

/**
 * Owns brush-mode state for the active slide: the stroke list, the locked
 * target object, and the confirmed mask. Everything here lives in editor
 * state only (`odd/tasks/brush-mask.md` decision) — nothing is written to
 * the carousel document or to disk. Slice 2 consumes `confirmedMask`.
 */
export function useBrushMask() {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<StrokeMode>("paint");
  const [screenRadius, setScreenRadius] = useState(DEFAULT_SCREEN_RADIUS);
  const [target, setTarget] = useState<BrushTarget | null>(null);
  const [confirmedMask, setConfirmedMask] = useState<BrushMask | null>(null);
  const drawing = useRef(false);

  /** Exits brush mode: drops in-progress strokes and the locked target. Leaves any already-confirmed mask alone. */
  const reset = useCallback(() => {
    setStrokes(clearStrokes());
    setTarget(null);
    drawing.current = false;
  }, []);

  const clear = useCallback(() => {
    setStrokes(clearStrokes());
  }, []);

  const undoStroke = useCallback(() => {
    setStrokes((prev) => undoLastStroke(prev));
  }, []);

  /**
   * Starts a stroke at a canvas-px point. `objectId`/`assetId` identify the
   * asset object under the pointer at pointer-down. The first stroke locks
   * the target for the rest of the session: once set, a pointer-down on a
   * different object is ignored (`odd/tasks/brush-mask.md` decision) rather
   * than switching targets mid-session. A point outside the visible image
   * (off the box, or in a `contain` letterbox) is ignored too.
   */
  const startStroke = useCallback(
    (canvasPoint: Point, frame: ImageFrame, objectId: string, assetId: string | undefined, cssScale: number) => {
      if (target && target.objectId !== objectId) return;
      const imagePoint = screenToImage(canvasPoint, frame);
      if (!imagePoint) return;
      const radius = screenRadiusToImageRadius(screenRadius, cssScale, frame);
      setTarget({ objectId, assetId, imageWidth: frame.naturalWidth, imageHeight: frame.naturalHeight });
      setStrokes((prev) => beginStroke(prev, mode, radius, imagePoint));
      drawing.current = true;
    },
    [target, mode, screenRadius],
  );

  const continueStroke = useCallback((canvasPoint: Point, frame: ImageFrame) => {
    if (!drawing.current) return;
    const imagePoint = screenToImage(canvasPoint, frame);
    if (!imagePoint) return;
    setStrokes((prev) => extendStroke(prev, imagePoint));
  }, []);

  const endStroke = useCallback(() => {
    drawing.current = false;
  }, []);

  /** Rasterizes the current strokes against the target image's natural size and stores the confirmed mask. No-op with no target or an empty result. */
  const confirm = useCallback(() => {
    if (!target) return;
    const rasterized = rasterizeMask(strokes, target.imageWidth, target.imageHeight);
    if (!rasterized) return;
    const pngDataUrl = rasterToPngDataUrl(rasterized.bitmap, target.imageWidth, rasterized.bbox);
    setConfirmedMask(
      buildBrushMask(target.objectId, target.imageWidth, target.imageHeight, rasterized, pngDataUrl, target.assetId),
    );
  }, [target, strokes]);

  const clearConfirmed = useCallback(() => setConfirmedMask(null), []);

  return {
    strokes,
    mode,
    setMode,
    screenRadius,
    setScreenRadius,
    target,
    startStroke,
    continueStroke,
    endStroke,
    undoStroke,
    clear,
    reset,
    confirm,
    confirmedMask,
    clearConfirmed,
  };
}
