import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { edgeColor, eraseBoxes, findPill, recolourPill, remap, toPng, widenPill } from "../image-tools.js";
import { fontSizeFor, similarity, textWidth, toSlide, type PlacedText, type Registration } from "./recreate-reference.js";

/** Reads the reference where it sits on the slide: letterboxed at its own proportion, centred. */
function onSlide(aspect: number, canvas: CarouselDocument["canvas"]): Registration {
  const unit = toSlide({ x: 0, y: 0, w: 1, h: 1 }, aspect, canvas);
  return { sx: 1 / unit.w, ox: -unit.x / unit.w, sy: 1 / unit.h, oy: -unit.y / unit.h };
}

/** The fill the profile gives a category, found by its name whatever the case the chip writes it in. */
function categoryFill(brand: BrandTokens, name: string): string | undefined {
  const entry = Object.entries(brand.categories?.byName ?? {}).find(([category]) => similarity(category, name) === 1);
  return entry?.[1].solid;
}

/**
 * The layout reference itself as the poster's background, at the slide's exact size, with every text that will be
 * placed on top erased from it. A text whose new wording does not fit the pill it sits in gets a wider pill, and the text's box
 * moves to the pill's new centre; a chip naming one of the profile's categories paints its pill in that category's
 * fill. Boxes of `texts` are on the slide.
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
    const pill = findPill(image, t.box);
    if (!pill) return t;
    // Relative to the measured old text, so the estimate's own error cancels out: same length, same width.
    const size = fontSizeFor(t, t.box, canvas, brand);
    const needed = (t.box.w * canvas.w * textWidth(t.text, size, t.weight)) / textWidth(t.original ?? t.text, size, t.weight);
    const padding = pill.x1 - pill.x0 - t.box.w * canvas.w;
    const by = Math.ceil(needed + padding - (pill.x1 - pill.x0));
    if (by > 0) image = widenPill(image, pill, by);
    const fill = t.zone === "chip" ? categoryFill(brand, t.text) : undefined;
    if (fill) image = recolourPill(image, { ...pill, x1: pill.x1 + Math.max(0, by) }, fill);
    const w = Math.max(needed, t.box.w * canvas.w);
    // A chip's text is centred in its pill; any other text keeps its start, after the pill's icon.
    if (t.zone !== "chip") return { ...t, box: { ...t.box, w: w / canvas.w } };
    const centre = (pill.x0 + pill.x1 + Math.max(0, by)) / 2;
    return { ...t, box: { ...t.box, x: (centre - w / 2) / canvas.w, w: w / canvas.w } };
  });
  return { image, texts: placed };
}
