import { z } from "zod";

import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument, Slide, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { newChatId } from "./chat-log.js";

export const TEXT_ZONES = ["tag", "date", "title", "subtitle", "time", "place", "price", "entry", "label", "body"] as const;

export const replacementSchema = z.object({ what: z.enum(TEXT_ZONES), text: z.string().min(1) });
export type Replacement = z.infer<typeof replacementSchema>;

const textReplacements = z
  .array(z.unknown())
  .default([])
  .transform((items) => items.flatMap((item) => {
    const parsed = replacementSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }));

export const recreateActionFields = {
  slideId: z.string().optional(),
  replacements: textReplacements,
};

export function recreatePrompt(request: string, replacements: Replacement[], contentAttached: boolean): string {
  const texts = replacements.map((r) => `${r.what} "${r.text}"`).join("; ");
  return [
    "Reproduce the first image exactly: same layout, colors, typography, logo, icons, cards and spacing.",
    contentAttached
      ? "Replace only the event data and the framed picture with the event of the second image, whose poster goes inside the frame as-is."
      : "Replace only the event data and the framed picture with the new event described here.",
    texts ? `Use exactly these texts: ${texts}.` : "",
    "Keep every other element identical. All text must be crisp and correctly spelled.",
    `The owner's request: ${request}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function placeFullSlideImage(
  slide: Slide | undefined,
  assetId: string,
  canvas: CarouselDocument["canvas"],
  brand: BrandTokens,
): Slide {
  const picture: SlideObject = {
    id: newChatId("obj-ref-poster"),
    kind: "asset",
    assetId,
    fit: "contain",
    geometry: { x: 0, y: 0, w: canvas.w, h: canvas.h, rotation: 0 },
    pinned: false,
    locked: false,
    source: "ai",
  };
  return {
    id: slide?.id ?? newChatId("slide"),
    kind: slide?.kind ?? "cover",
    background: slide?.background ?? { mode: "color", colorKey: brand.roles.surface, pinned: false, source: "manual" },
    objects: [...(slide?.objects ?? []).filter((o) => o.pinned || o.locked), picture],
  };
}
