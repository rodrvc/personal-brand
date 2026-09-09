import type { CarouselDocument, Geometry, Slide, SlideObject } from "../api/types";

/** Selection identifies either an object on the active slide, or the slide's background (no objectId). */
export type Selection = { slideId: string; objectId: string } | null;

export function findSlide(doc: CarouselDocument, slideId: string): Slide | undefined {
  return doc.slides.find((s) => s.id === slideId);
}

export function findObject(slide: Slide, objectId: string): SlideObject | undefined {
  return slide.objects.find((o) => o.id === objectId);
}

/** Resolved geometry read from the rendered iframe's `[data-object-id]` box (design.md D2/D3: integer canvas px, scaled by the caller). */
export interface ResolvedBox {
  objectId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  isText: boolean;
  fontSize?: number;
}

/** Applies a corner-drag delta to a geometry, scaling fontSize proportionally for text (specs/editor-ui "Scale a headline"). */
export function scaleGeometry(
  geometry: Geometry,
  corner: "tl" | "tr" | "bl" | "br",
  dx: number,
  dy: number,
  fontSize: number | undefined,
): { geometry: Geometry; fontSize: number | undefined } {
  let { x, y, w, h = 0 } = geometry;
  const originalW = w;

  if (corner === "br") {
    w = Math.max(10, w + dx);
    if (h) h = Math.max(10, h + dy);
  } else if (corner === "bl") {
    const newW = Math.max(10, w - dx);
    x = x + (w - newW);
    w = newW;
    if (h) h = Math.max(10, h + dy);
  } else if (corner === "tr") {
    w = Math.max(10, w + dx);
    if (h) {
      const newH = Math.max(10, h - dy);
      y = y + (h - newH);
      h = newH;
    }
  } else {
    const newW = Math.max(10, w - dx);
    x = x + (w - newW);
    w = newW;
    if (h) {
      const newH = Math.max(10, h - dy);
      y = y + (h - newH);
      h = newH;
    }
  }

  const scale = originalW > 0 ? w / originalW : 1;
  const nextFontSize = fontSize !== undefined ? Math.max(6, Math.round(fontSize * scale)) : undefined;

  return {
    geometry: { x: Math.round(x), y: Math.round(y), w: Math.round(w), ...(geometry.h ? { h: Math.round(h) } : {}), rotation: geometry.rotation },
    fontSize: nextFontSize,
  };
}

export function moveGeometry(geometry: Geometry, dx: number, dy: number): Geometry {
  return { ...geometry, x: Math.round(geometry.x + dx), y: Math.round(geometry.y + dy) };
}

export function rotateGeometry(geometry: Geometry, degrees: number): Geometry {
  return { ...geometry, rotation: Math.round(degrees) };
}
