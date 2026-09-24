import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { edgeColor, eraseBoxes, findPill, remap, toPng, widenPill } from "../image-tools.js";
import { fontSizeFor, textWidth, toSlide, type PlacedText, type Registration } from "./recreate-reference.js";

/** Reads the reference where it sits on the slide: letterboxed at its own proportion, centred. */
function onSlide(aspect: number, canvas: CarouselDocument["canvas"]): Registration {
  const unit = toSlide({ x: 0, y: 0, w: 1, h: 1 }, aspect, canvas);
  return { sx: 1 / unit.w, ox: -unit.x / unit.w, sy: 1 / unit.h, oy: -unit.y / unit.h };
}

/**
 * The layout reference itself as the poster's background, at the slide's exact size, with every text that will be
 * placed on top erased from it. A chip whose new text does not fit its pill gets a wider pill, and the text's box
 * moves to the pill's new centre. Boxes of `texts` are on the slide.
 */
export function referenceBackground(
  layout: Buffer,
  texts: PlacedText[],
  aspect: number,
  canvas: CarouselDocument["canvas"],
  brand: BrandTokens,
): { image: Buffer; texts: PlacedText[] } {
  let image = eraseBoxes(remap(toPng(layout), onSlide(aspect, canvas), canvas.w, canvas.h, edgeColor(layout)), texts.map((t) => t.box));
  const placed = texts.map((t) => {
    if (t.zone !== "chip") return t;
    const pill = findPill(image, t.box);
    if (!pill) return t;
    const needed = textWidth(t.text, fontSizeFor(t, t.box, canvas, brand));
    const padding = pill.x1 - pill.x0 - t.box.w * canvas.w;
    const by = Math.ceil(needed + padding - (pill.x1 - pill.x0));
    if (by > 0) image = widenPill(image, pill, by);
    const centre = (pill.x0 + pill.x1 + Math.max(0, by)) / 2;
    const w = Math.max(needed, t.box.w * canvas.w);
    return { ...t, box: { ...t.box, x: (centre - w / 2) / canvas.w, w: w / canvas.w } };
  });
  return { image, texts: placed };
}
