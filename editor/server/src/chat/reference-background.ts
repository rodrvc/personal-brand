import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { edgeColor, eraseBoxes, findPill, remap, rowIcon, toPng, toRgba, widenPill, type PixelBox } from "../image-tools.js";
import { fontSizeFor, textWidth, toSlide, type PlacedText, type Registration } from "./recreate-reference.js";

/** Reads the reference where it sits on the slide: letterboxed at its own proportion, centred. */
function onSlide(aspect: number, canvas: CarouselDocument["canvas"]): Registration {
  const unit = toSlide({ x: 0, y: 0, w: 1, h: 1 }, aspect, canvas);
  return { sx: 1 / unit.w, ox: -unit.x / unit.w, sy: 1 / unit.h, oy: -unit.y / unit.h };
}

/**
 * Boxes stacked into one row block (a label over its value): starting at about the same x, one right under the
 * other. Each block is the union of its boxes.
 */
function rowBlocks(boxes: PixelBox[]): PixelBox[] {
  const blocks: PixelBox[] = [];
  for (const box of [...boxes].sort((a, b) => a.y - b.y)) {
    const block = blocks.find((b) => Math.abs(b.x - box.x) < 0.03 && box.y - (b.y + b.h) < 1.5 * Math.max(box.h, b.h / 2));
    if (!block) {
      blocks.push({ ...box });
      continue;
    }
    const [x1, y1] = [Math.max(block.x + block.w, box.x + box.w), Math.max(block.y + block.h, box.y + box.h)];
    Object.assign(block, { x: Math.min(block.x, box.x), w: x1 - Math.min(block.x, box.x), h: y1 - block.y });
  }
  return blocks;
}

/**
 * The layout reference itself as the poster's background, at the slide's exact size, with every text that will be
 * placed on top erased from it. A text whose new wording does not fit the pill it sits in gets a wider pill, and the text's box
 * moves to the pill's new centre when it is a chip. A text the event does not have (`from: "absent"`) is erased with
 * the icon of its row. Boxes of `texts` are on the slide.
 */
export function referenceBackground(
  layout: Buffer,
  texts: PlacedText[],
  aspect: number,
  canvas: CarouselDocument["canvas"],
  brand: BrandTokens,
): { image: Buffer; texts: PlacedText[] } {
  let image = eraseBoxes(remap(toPng(layout), onSlide(aspect, canvas), canvas.w, canvas.h, edgeColor(layout)), texts.map((t) => t.box));
  // A datum the event does not have goes with the icon of its row (a pin, a clock), not only with its text.
  const bare = texts.filter((t) => t.from === "absent").map((t) => t.box);
  const erased = toRgba(image);
  const icons = rowBlocks(bare).flatMap((block) => rowIcon(erased, block) ?? []);
  if (icons.length > 0) image = eraseBoxes(image, icons);
  const placed = texts.map((t) => {
    const pill = findPill(image, t.box);
    if (!pill) return t;
    // Relative to the measured old text, so the estimate's own error cancels out: same length, same width.
    const size = fontSizeFor(t, t.box, canvas, brand);
    const needed = (t.box.w * canvas.w * textWidth(t.text, size, t.weight)) / textWidth(t.original ?? t.text, size, t.weight);
    const padding = pill.x1 - pill.x0 - t.box.w * canvas.w;
    const by = Math.ceil(needed + padding - (pill.x1 - pill.x0));
    if (by > 0) image = widenPill(image, pill, by);
    const w = Math.max(needed, t.box.w * canvas.w);
    // A chip's text is centred in its pill; any other text keeps its start, after the pill's icon.
    if (t.zone !== "chip") return { ...t, box: { ...t.box, w: w / canvas.w } };
    const centre = (pill.x0 + pill.x1 + Math.max(0, by)) / 2;
    return { ...t, box: { ...t.box, x: (centre - w / 2) / canvas.w, w: w / canvas.w } };
  });
  return { image, texts: placed };
}
