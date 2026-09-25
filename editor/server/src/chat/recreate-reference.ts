import { contrast } from "@personal-brand/core/color";
import { z } from "zod";

import type { BrandRoles, BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument, Slide, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { snapToScale, typeStyle, type TypeRole } from "../../../../system/ig-carousel/typography.js";
import { bestContrastColorKey } from "../compose/planner.js";
import type { TextLine } from "../text-boxes.js";
import { newChatId } from "./chat-log.js";

export const TEXT_ZONES = ["chip", "title", "subtitle", "date", "time", "place", "entry", "price", "label", "footer", "body"] as const;
type Zone = (typeof TEXT_ZONES)[number];
/** Lines the poster keeps as they are: the brand logo and the texts printed inside the framed picture. */
export const KEPT_ZONES = ["logo", "picture"] as const;

/** Zones that carry the event's own data: never taken from the layout reference. */
export const DATA_ZONES = ["title", "date", "time", "place", "entry", "price"] as const;

const ZONE_TYPE: Record<Zone, TypeRole> = {
  chip: "chip",
  title: "title",
  subtitle: "subtitle",
  date: "data",
  time: "data",
  place: "data",
  entry: "data",
  price: "data",
  body: "data",
  label: "label",
  footer: "footer",
};

const fraction = z.number().min(0).max(1);
const boxSchema = z.object({ x: fraction, y: fraction, w: fraction, h: fraction });
export type Box = z.infer<typeof boxSchema>;

export const posterTextSchema = z.object({
  line: z.number().int().nonnegative().optional(),
  zone: z.enum([...TEXT_ZONES, ...KEPT_ZONES]),
  text: z.string().default(""),
  /**
   * Where the text comes from: the content reference, what the owner said (this message or earlier), the layout
   * reference (labels and the brand's own texts only), "missing" when nobody gave that datum yet, or "absent" when
   * the owner said the event has no such datum, so the element is removed.
   */
  from: z.enum(["content", "owner", "layout", "missing", "absent"]).default("content"),
  original: z.string().optional(),
  box: boxSchema.optional(),
  /** The day a date text stands for, YYYY-MM-DD: its weekday is written from it, not by the model. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** CSS weight measured on the layout's line. */
  weight: z.number().int().min(100).max(900).optional(),
  /** The ink colour measured on the layout's line, #rrggbb. */
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  /** What the owner's message asks to change in this text's style; it wins over what the layout says. */
  restyle: z
    .object({
      scale: z.number().positive().max(4).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      weight: z.number().int().min(100).max(900).optional(),
    })
    .optional()
    .catch(undefined),
});
export type PosterText = z.infer<typeof posterTextSchema>;
export type PlacedText = PosterText & { zone: Zone; box: Box };

const posterTexts = z
  .array(z.unknown())
  .default([])
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = posterTextSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  );

export const recreateActionFields = {
  slideId: z.string().optional(),
  texts: posterTexts,
};

/**
 * Takes each text's box from the measured line it names; a text with neither a line nor its own box, an empty text
 * and a line the poster keeps (logo, picture) are dropped.
 */
export function measureTexts(texts: PosterText[], lines: TextLine[] | undefined): PlacedText[] {
  return texts.flatMap((t): PlacedText[] => {
    if (!isPlaceable(t) || (t.text.trim() === "" && !unwritten(t))) return [];
    const line = t.line !== undefined ? lines?.[t.line] : undefined;
    if (line) return [{ ...t, text: withoutIcon(t.text), ...withoutLeadingIcon(line) }];
    return t.box ? [{ ...t, box: t.box }] : [];
  });
}

const LEADING_ICON = /^[•·*◦○●]\s*/;

function withoutIcon(text: string): string {
  return text.replace(LEADING_ICON, "");
}

/**
 * OCR reads an icon right before a text (a pin, a clock) as a bullet. The icon belongs to the background: the
 * line's box is narrowed past it, about two characters, so it is neither erased nor drawn again as text.
 */
function withoutLeadingIcon(line: TextLine): { box: Box; original: string } {
  const icon = LEADING_ICON.exec(line.text)?.[0];
  if (!icon) return { box: line.box, original: line.text };
  const cut = Math.min(0.5, (icon.trim().length + 1) / line.text.length) * line.box.w;
  return { box: { ...line.box, x: line.box.x + cut, w: line.box.w - cut }, original: withoutIcon(line.text) };
}

/** A text with no wording on purpose: a datum still to be asked for, or one the event does not have. */
function unwritten(t: PosterText): boolean {
  return t.from === "missing" || t.from === "absent";
}

function isData(t: PosterText): boolean {
  return (DATA_ZONES as readonly string[]).includes(t.zone);
}

/**
 * The zones of every datum the poster cannot be made without, in order and once each: marked missing, or an event
 * datum the model took from the layout reference or left empty. Nothing of the event is inherited from the layout.
 */
export function missingData(texts: PosterText[]): Array<{ zone: Zone; replaces?: string }> {
  const missing = texts.filter(
    (t) => isPlaceable(t) && (t.from === "missing" || (isData(t) && (t.from === "layout" || (t.from !== "absent" && t.text.trim() === "")))),
  );
  // A line of no known kind is named by what the layout says there; a known datum by its kind alone.
  const named = missing.map((t) => (t.zone === "body" && t.original ? { zone: t.zone as Zone, replaces: t.original } : { zone: t.zone as Zone }));
  return named.filter((m, i) => named.findIndex((n) => n.zone === m.zone && n.replaces === m.replaces) === i);
}

/** The label of a value the event does not have goes with it: a caption over nothing. */
export function withAbsentLabels(texts: PosterText[], lines: TextLine[] | undefined): PosterText[] {
  if (!lines) return texts;
  const gone = new Set(texts.flatMap((t) => (t.from === "absent" && t.line !== undefined ? [t.line] : [])));
  return texts.map((t) =>
    t.zone === "label" && t.line !== undefined && gone.has(valueBelow(lines, t.line) ?? -1) ? { ...t, from: "absent" as const } : t,
  );
}

function isPlaceable(t: PosterText): t is PosterText & { zone: Zone } {
  return (TEXT_ZONES as readonly string[]).includes(t.zone);
}

function inside(box: Box, area: Box): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return cx >= area.x && cx <= area.x + area.w && cy >= area.y && cy <= area.y + area.h;
}

export type NumberedLine = TextLine & { line: number; kind?: "logo" | "label" };

/** The measured lines outside the framed picture, keeping their numbers, marked when they are the logo or a label. */
export function numberedLines(lines: TextLine[] | undefined, kinds: LineKind[] | undefined): NumberedLine[] | undefined {
  return lines?.flatMap((l, line): NumberedLine[] => {
    const kind = kinds?.[line];
    if (kind === "picture") return [];
    return [{ line, ...l, ...(kind === "logo" || kind === "label" ? { kind } : {}) }];
  });
}

export type LineKind = "picture" | "logo" | "label" | "text";

/**
 * What each measured line of the layout is: the framed picture's own text, the brand's wordmark (kept as it is),
 * a field label (a short caption right above its value), or any other text of the poster.
 */
export function classifyLines(lines: TextLine[], picture: Box | undefined, wordmark: string): LineKind[] {
  return lines.map((line, i) => {
    if (picture && inside(line.box, picture)) return "picture";
    if (similarity(withoutIcon(line.text), wordmark) >= 0.6) return "logo";
    return valueBelow(lines, i) !== undefined ? "label" : "text";
  });
}

/** The line a short caption names: right under it, starting where it starts and at least as tall. */
export function valueBelow(lines: TextLine[], i: number): number | undefined {
  const caption = lines[i]!.box;
  if (withoutIcon(lines[i]!.text).trim().split(/\s+/).length > 2) return undefined;
  const bottom = caption.y + caption.h;
  const found = lines.findIndex(
    ({ box }, j) =>
      j !== i && box.y > caption.y + caption.h / 2 && box.y - bottom < 1.5 * caption.h && Math.abs(box.x - caption.x) < 0.02 && box.h >= 0.95 * caption.h,
  );
  return found >= 0 ? found : undefined;
}

/**
 * One text for every line of the poster's frame, so none stays painted in the background. A label keeps its
 * caption; a new value the model wrote on the caption's line moves to the value's line. A line the model left out
 * keeps its text when it is the footer, and is otherwise missing. The wordmark and the picture's lines get no text.
 */
export function completeTexts(texts: PosterText[], lines: TextLine[], kinds: LineKind[]): PosterText[] {
  const byLine = new Map(texts.flatMap((t) => (t.line !== undefined ? [[t.line, t] as const] : [])));
  kinds.forEach((kind, i) => {
    const given = byLine.get(i);
    const value = kind === "label" ? valueBelow(lines, i) : undefined;
    if (value === undefined || !given || (given.from !== "content" && given.from !== "owner") || given.zone === "label") return;
    const current = byLine.get(value);
    if (!current || current.from === "layout" || !current.text.trim()) byLine.set(value, { ...given, line: value });
  });
  // A line the model left out keeps its text only when it is the footer or a label: any other may be event data,
  // which never comes from the layout, so it is asked for.
  const kept = (i: number): PosterText =>
    lines[i]!.box.y > 0.9
      ? { line: i, zone: "footer", text: withoutIcon(lines[i]!.text), from: "layout" }
      : { line: i, zone: "body", text: "", from: "missing", original: withoutIcon(lines[i]!.text) };
  const framed = kinds.flatMap((kind, i): PosterText[] => {
    if (kind === "picture" || kind === "logo" || byLine.get(i)?.zone === "logo") return [];
    if (kind === "label") return [{ line: i, zone: "label", text: withoutIcon(lines[i]!.text), from: "layout" }];
    const given = byLine.get(i);
    return [given && isPlaceable(given) && (given.text.trim() || unwritten(given)) ? given : kept(i)];
  });
  return [...framed, ...texts.filter((t) => t.line === undefined)];
}

/** The layout lines the generator is asked to keep in place, to register its image against: all but the picture's. */
export function anchorLines(texts: PosterText[], lines: TextLine[] | undefined, picture?: Box): TextLine[] {
  const named = new Set(texts.flatMap((t) => (t.zone === "picture" && t.line !== undefined ? [t.line] : [])));
  return (lines ?? []).filter((line, i) => !named.has(i) && !(picture && inside(line.box, picture)));
}

export function keepTextsPrompt(contentAttached: boolean): string {
  return [
    "Reproduce the first image exactly: same layout, colors, typography, logo, icons, cards, chips and spacing, with every text exactly as it is written.",
    contentAttached
      ? "Only replace the picture inside the frame with the second image, as it is."
      : "Change nothing else.",
  ].join(" ");
}

function normalized(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function bigrams(text: string): string[] {
  const t = normalized(text);
  return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2));
}

/** Dice coefficient over character bigrams, ignoring case, accents and punctuation. */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return normalized(a) === normalized(b) ? 1 : 0;
  const pool = [...y];
  let shared = 0;
  for (const g of x) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      shared++;
      pool.splice(i, 1);
    }
  }
  return (2 * shared) / (x.length + y.length);
}

const ANCHOR_THRESHOLD = 0.8;

/** Where the generator drew the slide: generated = scale * slide + offset, per axis, in fractions. */
export interface Registration {
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

export const IDENTITY: Registration = { sx: 1, ox: 0, sy: 1, oy: 0 };

/** Where the slide sits in an image of another proportion when it is letterboxed there, centred. */
export function letterbox(imageAspect: number, slideAspect: number): Registration {
  if (imageAspect <= slideAspect) {
    const sy = imageAspect / slideAspect;
    return { sx: 1, ox: 0, sy, oy: (1 - sy) / 2 };
  }
  const sx = slideAspect / imageAspect;
  return { sx, ox: (1 - sx) / 2, sy: 1, oy: 0 };
}

/**
 * The generator keeps the texts but not their geometry: it stretches the layout over its padding. Pairing each anchor
 * with the generated line that reads the same, the edges of both boxes fit a scale and offset per axis by least
 * squares; pairs far off the first fit (a repeated word matched to the wrong place) are dropped before refitting.
 */
export function register(anchors: TextLine[], generated: TextLine[] | undefined, fallback = IDENTITY): Registration {
  const free = [...(generated ?? [])];
  const pairs = anchors.flatMap((anchor) => {
    const best = free
      .map((line) => ({ line, score: similarity(anchor.text, line.text) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < ANCHOR_THRESHOLD) return [];
    free.splice(free.indexOf(best.line), 1);
    return [{ from: anchor.box, to: best.line.box }];
  });
  if (pairs.length < 3) return fallback;
  const xs = pairs.flatMap(({ from, to }) => [[from.x, to.x], [from.x + from.w, to.x + to.w]] as Array<[number, number]>);
  const ys = pairs.flatMap(({ from, to }) => [[from.y, to.y], [from.y + from.h, to.y + to.h]] as Array<[number, number]>);
  const [sx, ox] = robustFit(xs);
  const [sy, oy] = robustFit(ys);
  const plausible = (scale: number) => scale > 0.5 && scale < 1.5;
  return plausible(sx) && plausible(sy) ? { sx, ox, sy, oy } : fallback;
}

function robustFit(points: Array<[number, number]>): [number, number] {
  const first = fit(points);
  const residual = ([a, b]: [number, number]) => Math.abs(first[0] * a + first[1] - b);
  const sorted = points.map(residual).sort((a, b) => a - b);
  const limit = Math.max(0.01, 3 * sorted[sorted.length >> 1]!);
  const inliers = points.filter((p) => residual(p) <= limit);
  return inliers.length >= 4 ? fit(inliers) : first;
}

function fit(points: Array<[number, number]>): [number, number] {
  const n = points.length;
  const mx = points.reduce((sum, [a]) => sum + a, 0) / n;
  const my = points.reduce((sum, [, b]) => sum + b, 0) / n;
  const cov = points.reduce((sum, [a, b]) => sum + (a - mx) * (b - my), 0);
  const variance = points.reduce((sum, [a]) => sum + (a - mx) ** 2, 0);
  const scale = variance > 0 ? cov / variance : 1;
  return [scale, my - scale * mx];
}

/** A box measured on the generated image, moved to where it lands once the image is registered to the slide. */
export function unregister(box: Box, r: Registration): Box {
  return { x: (box.x - r.ox) / r.sx, y: (box.y - r.oy) / r.sy, w: box.w / r.sx, h: box.h / r.sy };
}

function overlaps(a: Box, b: Box): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 && w * h >= 0.3 * Math.min(a.w * a.h, b.w * b.h);
}

const SETTLE_DISTANCE = 0.1;

/**
 * Settles each text on the registered image. Registration is one fit for the whole slide, but the generator also
 * moves single pieces (a chip under the picture): a generated line that still reads the replaced text, close to
 * where it was, is where the text goes. What is erased is each text's final box (only there: the reference spot may
 * now hold something else) plus every generated line over one of them, redrawn a little larger, shifted or reworded.
 */
export function settleTexts(texts: PlacedText[], generated: TextLine[] | undefined, r: Registration): { texts: PlacedText[]; erase: Box[] } {
  const drawn = (generated ?? []).map((line) => ({ text: withoutIcon(line.text), box: withoutLeadingIcon({ ...line, box: unregister(line.box, r) }).box }));
  const free = [...drawn];
  const settled = texts.map((t) => {
    const centre = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2] as const;
    const [cx, cy] = centre(t.box);
    const best = free
      .filter((line) => Math.hypot(centre(line.box)[0] - cx, centre(line.box)[1] - cy) < SETTLE_DISTANCE)
      .map((line) => ({ line, score: similarity(t.original ?? t.text, line.text) }))
      .sort((x, y) => y.score - x.score)[0];
    if (!best || best.score < ANCHOR_THRESHOLD) return t;
    free.splice(free.indexOf(best.line), 1);
    return { ...t, box: best.line.box };
  });
  const boxes = settled.map((t) => t.box);
  return { texts: settled, erase: [...boxes, ...drawn.map((l) => l.box).filter((box) => boxes.some((b) => overlaps(box, b)))] };
}

/** Maps a box measured on the reference to the slide, where the reference sits letterboxed at its own proportion. */
export function toSlide(box: Box, referenceAspect: number, canvas: CarouselDocument["canvas"]): Box {
  const slideAspect = canvas.w / canvas.h;
  const scaleX = referenceAspect >= slideAspect ? 1 : referenceAspect / slideAspect;
  const scaleY = referenceAspect >= slideAspect ? slideAspect / referenceAspect : 1;
  return {
    x: (1 - scaleX) / 2 + box.x * scaleX,
    y: (1 - scaleY) / 2 + box.y * scaleY,
    w: box.w * scaleX,
    h: box.h * scaleY,
  };
}

/**
 * A measured line box spans about 0.88 of the font size for a line with capitals or ascenders only, and 1.1 when a
 * letter hangs below the baseline (measured on rendered slides); the original text says which one applies.
 */
const BOX_PER_EM = { flat: 0.88, descending: 1.1 };
const DESCENDERS = /[gjpqy,;]/;
const GLYPH_WIDTH = { lower: 0.58, upper: 0.72 };
/** A bold weight sets about this much wider. */
const BOLD_WIDTH = 1.08;
/** A chip's pill is about this much wider than the text measured in it. */
export const CHIP_SLACK = 1.3;
const LARGE_TEXT = 24;
/** Colour distance (RGB) under which a measured ink is taken as a brand colour. */
const SAME_COLOUR = 28;
/** A text centred past this fraction of the slide's width is aligned right, on its measured right edge. */
const RIGHT_ALIGNED = 0.6;

/** The CSS weight of a measured stroke-to-height ratio (see `inkReader`). */
export function weightFor(stroke: number): number {
  return stroke >= 0.18 ? 700 : stroke >= 0.145 ? 600 : 400;
}

const COLUMN_TOLERANCE = 0.012;

/**
 * Texts that start at about the same x on the layout share one column: each gets the column's median start, so a
 * card's captions and values line up instead of following each line's own measuring error. Right-aligned and
 * chip texts keep their boxes.
 */
export function alignColumns(texts: PlacedText[]): PlacedText[] {
  const leftAligned = (t: PlacedText) => t.zone !== "chip" && t.box.x + t.box.w / 2 <= RIGHT_ALIGNED;
  const starts = texts.filter(leftAligned).map((t) => t.box.x).sort((a, b) => a - b);
  const columns: number[][] = [];
  for (const x of starts) {
    const column = columns.at(-1);
    if (column && x - column.at(-1)! <= COLUMN_TOLERANCE) column.push(x);
    else columns.push([x]);
  }
  const columnOf = (x: number) => columns.find((c) => x >= c[0]! && x <= c.at(-1)!)!;
  return texts.map((t) => {
    if (!leftAligned(t)) return t;
    const column = columnOf(t.box.x);
    const x = column[column.length >> 1]!;
    return { ...t, box: { ...t.box, x, w: t.box.x + t.box.w - x } };
  });
}

/**
 * Writes the weekday of `iso` in the profile's locale over the text's leading word, in that word's case, when the
 * text shows that day of the month; any other text is returned as it is.
 */
export function withWeekday(text: string, iso: string, locale: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || !new RegExp(`(^|\\D)0?${date.getUTCDate()}(\\D|$)`).test(text)) return text;
  const leading = /^(\p{L}+)\.?(?=\s)/u.exec(text);
  if (!leading) return text;
  const word = leading[1]!;
  const name = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(date).replace(/\.$/, "");
  const upper = word === word.toLocaleUpperCase(locale);
  const capital = word[0] === word[0]!.toLocaleUpperCase(locale);
  const cased = upper ? name.toLocaleUpperCase(locale) : capital ? name[0]!.toLocaleUpperCase(locale) + name.slice(1) : name;
  return cased + text.slice(leading[0].length);
}

/**
 * What the model cannot be trusted with, settled from the layout and the profile: each text's weight, colour and
 * start measured on the layout's ink, columns lined up, and a date's weekday written from its day.
 */
export function refineTexts(
  texts: PlacedText[],
  profile: { locale: string },
  ink?: { stroke: (box: Box) => number; left: (box: Box) => number; colour: (box: Box) => string },
): PlacedText[] {
  const measured = texts.map((t): PlacedText => {
    if (!ink || t.line === undefined) return t;
    const weight = weightFor(ink.stroke(t.box));
    const color = ink.colour(t.box);
    if (t.zone === "chip") return { ...t, weight, color };
    const x = ink.left(t.box);
    return { ...t, weight, color, box: { ...t.box, x, w: t.box.x + t.box.w - x } };
  });
  return alignColumns(measured).map((t) => (t.date ? { ...t, text: withWeekday(t.text, t.date, profile.locale) } : t));
}

export function fontSizeFor(t: PlacedText, box: Box, canvas: CarouselDocument["canvas"], brand: BrandTokens): number {
  const perEm = DESCENDERS.test(t.original ?? t.text) ? BOX_PER_EM.descending : BOX_PER_EM.flat;
  return snapToScale(brand, (box.h * canvas.h) / perEm);
}

/** About how wide the text sets at that size and weight, in pixels. */
export function textWidth(text: string, fontSize: number, weight = 400): number {
  const glyph = text === text.toUpperCase() ? GLYPH_WIDTH.upper : GLYPH_WIDTH.lower;
  return text.length * fontSize * glyph * (weight >= 600 ? BOLD_WIDTH : 1);
}

type Ink = { colorKey: string } | { color: string };

function textObject(t: PlacedText, box: Box, canvas: CarouselDocument["canvas"], brand: BrandTokens, ink?: Ink): SlideObject {
  const role = ZONE_TYPE[t.zone];
  const style = typeStyle(brand, role);
  const measuredW = box.w * canvas.w;
  const measured = fontSizeFor(t, box, canvas, brand);
  // A chip's text must stay inside its pill: past it, the size leaves the brand's scale and shrinks without a floor.
  const fitting = Math.floor((measuredW * CHIP_SLACK) / textWidth(t.text, 1, t.weight));
  const fitted = role === "chip" ? Math.max(1, Math.min(measured, fitting)) : measured;
  const weight = t.restyle?.weight ?? t.weight;
  // A size the owner asked for is used as asked, off the brand's scale, but it stays inside the layout's margins.
  // The width estimate is calibrated on the line it replaces, whose real width was measured.
  const calibration = t.original ? Math.min(1.5, Math.max(0.5, measuredW / textWidth(t.original, measured, t.weight))) : 1;
  const margin = Math.max(0, Math.min(box.x, 1 - box.x - box.w)) * canvas.w;
  const roomy = Math.floor((canvas.w - 2 * margin) / (textWidth(t.text, 1, weight) * calibration));
  const fontSize = t.restyle?.scale ? Math.max(1, Math.min(Math.round(fitted * t.restyle.scale), Math.max(roomy, fitted))) : fitted;
  const neededW = Math.min(canvas.w, textWidth(t.text, fontSize, weight));
  const align = role === "chip" ? "center" : box.x + box.w / 2 > RIGHT_ALIGNED ? "right" : "left";
  // The estimate runs wide, so a left or right text keeps its anchored edge and loses width at the canvas edge instead.
  const room = align === "left" ? canvas.w - box.x * canvas.w : align === "right" ? box.x * canvas.w + measuredW : canvas.w;
  const w = Math.round(Math.max(measuredW, Math.min(neededW, room)));
  const left = align === "right" ? box.x * canvas.w + measuredW - w : align === "center" ? box.x * canvas.w + (measuredW - w) / 2 : box.x * canvas.w;
  const x = Math.round(Math.min(Math.max(left, 0), canvas.w - w));
  const height = Math.round(fontSize * 1.3);
  return {
    id: newChatId(`obj-poster-${t.zone}`),
    kind: "text",
    text: t.text,
    geometry: { x, y: Math.round(box.y * canvas.h - (height - box.h * canvas.h) / 2), w, h: height, rotation: 0 },
    fontKey: style.font,
    fontSize,
    ...(weight ? { fontWeight: weight } : {}),
    lineHeight: 1.15,
    align,
    ...(ink ?? { colorKey: brand.roles[style.color as keyof BrandRoles] }),
    pinned: false,
    locked: false,
    source: "ai",
  };
}

/**
 * Each text (box on the slide) as an editable text object in the brand's typography: its measured colour, as a brand
 * colour when it is one, else the role's; replaced by the best-contrast brand colour when it would not read on what
 * `behind` says is under it (a hex without `#`).
 */
function textObjects(texts: PlacedText[], canvas: CarouselDocument["canvas"], brand: BrandTokens, behind?: (box: Box) => string): SlideObject[] {
  const ink = (t: PlacedText): Ink | undefined => {
    const roleKey = brand.roles[typeStyle(brand, ZONE_TYPE[t.zone]).color as keyof BrandRoles];
    // The owner's colour is used as asked, without the contrast check.
    if (t.restyle?.color) return inkFor(brand, t.restyle.color);
    const wanted: Ink = t.color ? inkFor(brand, t.color) : { colorKey: roleKey };
    if (!behind) return t.color ? wanted : undefined;
    const under = `#${behind(t.box)}`;
    const hex = "color" in wanted ? wanted.color : brand.colors[wanted.colorKey]!;
    // WCAG AA: 3:1 is enough for large text, 4.5:1 below that.
    const needed = fontSizeFor(t, t.box, canvas, brand) >= LARGE_TEXT ? 3 : 4.5;
    return contrast(hex, under) >= needed ? wanted : { colorKey: bestContrastColorKey(brand, hex, under) };
  };
  return texts.filter((t) => t.from !== "absent").map((t) => textObject(t, t.box, canvas, brand, ink(t)));
}

/**
 * The poster's background fills the slide, pinned; the event's picture, when given, goes in the frame, movable;
 * each text (boxes already on the slide) goes on top, editable, in the ink that reads best on what is behind it.
 */
export function placePoster(
  slide: Slide | undefined,
  assetId: string,
  texts: PlacedText[],
  canvas: CarouselDocument["canvas"],
  brand: BrandTokens,
  options: { picture?: { assetId: string; box: Box }; behind?: (box: Box) => string } = {},
): Slide {
  const background: SlideObject = {
    id: newChatId("obj-poster"),
    kind: "asset",
    assetId,
    fit: "cover",
    geometry: { x: 0, y: 0, w: canvas.w, h: canvas.h, rotation: 0 },
    pinned: true,
    locked: false,
    source: "ai",
  };
  const picture: SlideObject[] = options.picture
    ? [
        {
          id: newChatId("obj-poster-picture"),
          kind: "asset",
          assetId: options.picture.assetId,
          fit: "cover",
          geometry: pixels(options.picture.box, canvas),
          pinned: false,
          locked: false,
          source: "ai",
        },
      ]
    : [];
  const placed = textObjects(texts, canvas, brand, options.behind);
  return {
    id: slide?.id ?? newChatId("slide"),
    kind: slide?.kind ?? "cover",
    background: slide?.background ?? { mode: "color", colorKey: brand.roles.surface, pinned: false, source: "manual" },
    objects: [
      ...(slide?.objects ?? []).filter((o) => o.pinned || o.locked),
      background,
      ...picture,
      ...placed,
    ],
  };
}

/** A measured colour as a brand colour when it is one of them, give or take rendering, else as it is. */
function inkFor(brand: BrandTokens, color: string): Ink {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const measured = rgb(color);
  const near = Object.entries(brand.colors).find(([, hex]) => Math.hypot(...rgb(hex).map((v, c) => v - measured[c]!)) <= SAME_COLOUR);
  return near ? { colorKey: near[0] } : { color: color.toLowerCase() };
}

function pixels(box: Box, canvas: CarouselDocument["canvas"]): { x: number; y: number; w: number; h: number; rotation: number } {
  return { x: Math.round(box.x * canvas.w), y: Math.round(box.y * canvas.h), w: Math.round(box.w * canvas.w), h: Math.round(box.h * canvas.h), rotation: 0 };
}
