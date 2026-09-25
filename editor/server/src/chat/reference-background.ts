import type { BrandRoles, BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import { typeStyle } from "../../../../system/ig-carousel/typography.js";
import {
  blendOver,
  copyRect,
  drawRounded,
  edgeColor,
  encodePng,
  eraseBoxes,
  inkGroups,
  opaqueSpan,
  pillIn,
  pillRadius,
  remap,
  rowIcon,
  roundedDistance,
  toPng,
  toRgba,
  type InkSpan,
  type Pill,
  type PixelBox,
  type Raster,
} from "../image-tools.js";
import type { Rasterise, TextRun } from "../text-raster.js";
import { fontSizeFor, toSlide, ZONE_TYPE, type PlacedText, type Registration } from "./recreate-reference.js";

/** Reads the reference where it sits on the slide: letterboxed at its own proportion, centred. */
function onSlide(aspect: number, canvas: CarouselDocument["canvas"]): Registration {
  const unit = toSlide({ x: 0, y: 0, w: 1, h: 1 }, aspect, canvas);
  return { sx: 1 / unit.w, ox: -unit.x / unit.w, sy: 1 / unit.h, oy: -unit.y / unit.h };
}

/** A pill centred on the slide within this fraction of its width stays centred when it changes width. */
const CENTRED = 0.02;

/** How a pill of the layout is drawn: its shape, its icon if any, and where its old text's ink was. */
interface PillLayout {
  pill: Pill;
  radius: number;
  icon?: InkSpan;
  ink: InkSpan;
}

/**
 * Reads the pill on the layout (before any erasing): its corner radius and what is drawn in it. The first group of
 * ink is an icon when more follows and it starts clearly before the text's box, no wider than the pill is tall.
 */
function readPill(original: Raster, pill: Pill, textBox: PixelBox): PillLayout {
  const radius = pillRadius(original, pill);
  const groups = inkGroups(original, pill, radius);
  const height = pill.y1 - pill.y0 + 1;
  const left = textBox.x * original.width;
  const first = groups[0];
  // OCR may read the icon as a letter and start the box on it, so its shape also tells: about as wide as tall.
  const [iconW, iconH] = first ? [first.x1 - first.x0 + 1, first.y1 - first.y0 + 1] : [0, 0];
  const iconLike = first !== undefined && (first.x0 < left - 0.1 * height || (iconW >= 0.75 * iconH && iconW <= 1.3 * iconH));
  const icon = first && groups.length > 1 && iconLike && iconW < 1.2 * height ? first : undefined;
  const words = icon ? groups.slice(1) : groups;
  const ink = words.length > 0
    ? { x0: words[0]!.x0, x1: words.at(-1)!.x1, y0: Math.min(...words.map((g) => g.y0)), y1: Math.max(...words.map((g) => g.y1)) }
    : { x0: Math.round(left), x1: Math.round((textBox.x + textBox.w) * original.width), y0: Math.round(textBox.y * original.height), y1: Math.round((textBox.y + textBox.h) * original.height) };
  return { pill, radius, ink, ...(icon ? { icon } : {}) };
}

/** The text as it is rasterised: the role's font, the measured size and weight and ink, with the owner's restyle on top. */
function runFor(t: PlacedText, canvas: CarouselDocument["canvas"], brand: BrandTokens): TextRun {
  const style = typeStyle(brand, ZONE_TYPE[t.zone]);
  const size = Math.max(1, Math.round(fontSizeFor(t, t.box, canvas, brand) * (t.restyle?.scale ?? 1)));
  const family = (brand.fonts as Record<string, string | undefined>)[style.font] ?? brand.fonts.body;
  const color = t.restyle?.color ?? t.color ?? brand.colors[brand.roles[style.color as keyof BrandRoles]] ?? "#000000";
  return { text: t.text, family, size, weight: t.restyle?.weight ?? t.weight ?? 400, color };
}

/**
 * Draws the pill again at the width its new text needs: a clean rounded shape in its own colour, its icon copied
 * from the layout, and the text after the icon with the gap it had, or centred when there is no icon. A pill with an
 * icon or off the slide's centre keeps its left end; a centred one stays centred.
 */
function redrawPill(out: Raster, original: Raster, layout: PillLayout, text: Raster): void {
  const { pill, radius, icon, ink } = layout;
  const span = opaqueSpan(text);
  const width = span ? span.x1 - span.x0 + 1 : 0;
  const height = pill.y1 - pill.y0 + 1;
  let left: number;
  let right: number;
  let textLeft: number;
  if (icon) {
    left = pill.x0;
    // The text starts where the old one did, after the icon and the gap it had; the pill only grows, to the right.
    textLeft = ink.x0;
    right = Math.max(pill.x1 + 1, textLeft + width + (pill.x1 - ink.x1));
  } else {
    const pad = (ink.x0 - pill.x0 + pill.x1 - ink.x1) / 2;
    const total = Math.max(height, width + 2 * pad);
    const centre = (pill.x0 + pill.x1 + 1) / 2;
    left = Math.abs(centre - out.width / 2) < CENTRED * out.width ? centre - total / 2 : pill.x0;
    right = left + total;
    textLeft = left + (total - width) / 2;
  }
  // Kept on the slide: a pill that would run past an edge moves in, whole.
  const shift = Math.max(0, -left) - Math.max(0, right - out.width);
  [left, right, textLeft] = [left + shift, right + shift, textLeft + shift];
  drawRounded(out, { left, right, top: pill.y0, bottom: pill.y1 + 1 }, radius, pill.fill);
  if (icon) copyRect(original, out, { x0: icon.x0 - 1, x1: icon.x1 + 1, y0: icon.y0 - 1, y1: icon.y1 + 1 }, Math.round(left - pill.x0));
  if (!span) return;
  const middle = (ink.y0 + ink.y1) / 2;
  blendOver(out, text, Math.round(textLeft - span.x0), Math.round(middle - (span.y0 + span.y1) / 2));
}

/** Copies into `to` the pixels of `from` inside the pill's rounded shape, grown by its rim. */
function restoreShape(to: Raster, from: Raster, pill: Pill, radius: number): void {
  const rect = { left: pill.x0, right: pill.x1 + 1, top: pill.y0, bottom: pill.y1 + 1 };
  for (let y = Math.max(0, pill.y0 - 3); y <= Math.min(to.height - 1, pill.y1 + 3); y++) {
    for (let x = Math.max(0, pill.x0 - 3); x <= Math.min(to.width - 1, pill.x1 + 3); x++) {
      if (roundedDistance(x, y, rect, radius) < 2) to.pixels.set(from.pixels.subarray((y * to.width + x) * 4, (y * to.width + x) * 4 + 4), (y * to.width + x) * 4);
    }
  }
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

function toFractions(span: InkSpan, r: Raster, margin: number): PixelBox {
  return {
    x: (span.x0 - margin) / r.width,
    y: (span.y0 - margin) / r.height,
    w: (span.x1 - span.x0 + 1 + 2 * margin) / r.width,
    h: (span.y1 - span.y0 + 1 + 2 * margin) / r.height,
  };
}

/**
 * The layout reference itself as the poster's background, at the slide's exact size, with every text erased from
 * it. A text inside a pill becomes part of the image: the pill is erased whole and drawn again, clean, with its
 * icon and the new text rasterised in it; it is not returned as a text to place. A text the event does not have
 * (`from: "absent"`) is erased with its pill or the icon before it. Every other text is returned to be placed on top,
 * editable. Boxes of `texts` are on the slide.
 */
export async function referenceBackground(
  layout: Buffer,
  texts: PlacedText[],
  aspect: number,
  canvas: CarouselDocument["canvas"],
  brand: BrandTokens,
  rasterise: Rasterise,
): Promise<{ image: Buffer; texts: PlacedText[] }> {
  const slide = remap(toPng(layout), onSlide(aspect, canvas), canvas.w, canvas.h, edgeColor(layout));
  const original = toRgba(slide);
  const erased = eraseBoxes(slide, texts.map((t) => t.box));
  const erasedRaster = toRgba(erased);
  const found = texts.map((t) => ({ t, pill: pillIn(erasedRaster, t.box) }));
  // Two texts in one pill (a caption and its value) stay editable texts over it, as before.
  const shared = (pill: Pill) => found.filter((f) => f.pill?.x0 === pill.x0 && f.pill.y0 === pill.y0).length > 1;
  const inPill = found.flatMap(({ t, pill }) => (pill && !shared(pill) ? [{ t, pill }] : []));
  const redrawn = inPill.filter(({ t }) => t.from !== "absent");
  const layouts = redrawn.map(({ t, pill }) => readPill(original, pill, t.box));
  const rasters = (await rasterise(redrawn.map(({ t }) => runFor(t, canvas, brand)))).map((png) => toRgba(png));
  const bare = found.filter(({ t }) => t.from === "absent" && !inPill.some((p) => p.t === t)).map(({ t }) => t.box);
  const icons = rowBlocks(bare).flatMap((block) => rowIcon(erasedRaster, block) ?? []);
  const pills = inPill.map(({ pill }) => toFractions(pill, original, 2));
  const cleared = pills.length + icons.length > 0 ? toRgba(eraseBoxes(erased, [...pills, ...icons])) : erasedRaster;
  // Only the old pill's own shape (and its anti-aliased rim) takes the erased surface: whatever lies around it in its
  // bounding box (a card's border, a corner of the picture) stays as it was.
  const out = { ...erasedRaster, pixels: Uint8Array.from(erasedRaster.pixels) };
  inPill.forEach(({ pill }) => restoreShape(out, cleared, pill, pillRadius(original, pill)));
  icons.forEach((b) => copyRect(cleared, out, { x0: Math.floor(b.x * out.width), x1: Math.ceil((b.x + b.w) * out.width), y0: Math.floor(b.y * out.height), y1: Math.ceil((b.y + b.h) * out.height) }, 0));
  layouts.forEach((l, i) => redrawPill(out, original, l, rasters[i]!));
  const placed = found.filter(({ t }) => t.from !== "absent" && !inPill.some((p) => p.t === t)).map(({ t }) => t);
  return { image: layouts.length + pills.length + icons.length > 0 ? encodePng(out.width, out.height, out.pixels) : erased, texts: placed };
}
