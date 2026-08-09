import {
  categoryStyle,
  color,
  interpolate,
  templateCopy,
  withAlpha,
  type BrandTokens,
} from "../brand-schema.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideGroupTemplate } from "../types.js";

/**
 * Renders the time chip's label from the slide's own `time` field.
 *
 * The engine used to regex-scrape an HH:MM out of the free-form `subtitle`,
 * falling back to "the second comma-separated fragment" when that failed.
 * That coupled the engine to one publisher's subtitle formatting: a subtitle
 * that isn't a date ("Lessons from 10 years building teams") produced an
 * arbitrary text fragment inside a clock-icon chip, with no error and no
 * warning. The time is structured data, so it now travels as structured data
 * — see `Slide.time` in types.ts. No `time`, no chip.
 *
 * The suffix comes from the profile, since it's locale-specific copy: Spanish
 * renders "20:00 HRS", English just "20:00".
 */
function timeChipLabel(time: string, suffix: string): string {
  return suffix ? `${time} ${suffix}` : time;
}

/**
 * Variant D — "Magazine card" list format: a hand-drawn marker-style header
 * (wordmark + "Imperdibles del <fecha>" + a thin decorative moon/sparkle
 * flourish) followed by up to 3 mixed-category event cards, each a soft
 * white card (rounded corners + subtle shadow, NO color frame around the
 * photo) with a time chip overlapping the photo's corner.
 *
 * Rebuilt from a user-supplied reference mockup (a warm, editorial-feeling
 * carousel cover), replacing the previous full-width category-gradient
 * header + per-photo color border design entirely — this is a deliberate
 * style change, not an incremental tweak.
 *
 * Typography: the header and each event's title use the profile's
 * `fonts.handwritten` rather than `fonts.body` — per anti-slop.md's "single
 * default font doing all the work" warning, pairing a display face with a
 * plain body face is what gives type itself a personality decision, not just
 * the palette. `fonts.logo` stays reserved for other variants; this one wants
 * a thicker, more legible marker face to match the reference's lettering
 * weight.
 *
 * Header decoration: concentric arcs + two 4-point sparkles, hand-built as
 * inline SVG in the profile's own accent hue, not a borrowed
 * icon set or generic particle field — anti-slop.md flags "decoration with
 * no source" (generic blobs/particles unrelated to the brand) as a tell;
 * this shape is deliberately restrained (a handful of thin strokes, not a
 * dense pattern) and drawn specifically for this piece.
 *
 * Cards: soft shadow + rounded corners, no color border around the photo —
 * this reference explicitly moves away from the "colored frame" signature
 * of the previous iteration. The category signal now lives in the small
 * label + underline above the title and the solid-color time chip, not a
 * card-level accent — avoiding the "left-edge accent-bar" and "same
 * treatment repeated redundantly" pitfalls anti-slop.md warns about.
 *
 * Grouping: unlike the previous per-category-header version, this variant
 * renders up to 3 events of MIXED categories per image (matching the
 * reference, which shows three different categories together under one "this
 * week" cover) — grouping here is purely "up to N events per slide", not
 * category-based, since the header no longer announces a single category.
 *
 * Price: the reference mockup shows a price chip ("Desde $8.000"); omitted
 * here per explicit product decision — the data contract has no price
 * field, and most real scraped events don't carry one anyway.
 */
export const renderListFormat: SlideGroupTemplate = (
  brand: BrandTokens,
  slides: Slide[],
  options?: { headerLabel?: string; city?: string; region?: string },
) => {
  const photoSize = 300;
  const copy = templateCopy(brand, "listFormat");
  // The caller (render-week.ts) computes this from the actual current
  // calendar week (Monday-Sunday), not from the events shown — the header
  // always reflects the real week being published, regardless of which
  // days within it happen to have events.
  const headerLabel = options?.headerLabel ?? copy.headerLabelFallback;
  // City comes from the carousel's input data, not the brand: one brand can
  // cover several cities. Empty string rather than a hardcoded default so a
  // missing city degrades to blank instead of silently naming the wrong place.
  const city = options?.city ?? "";
  // Region comes from the input alongside city — both describe the geography
  // of this content, not of the brand. Falls back to the brand token so a
  // profile that still declares one keeps working.
  const region = options?.region ?? brand.copy.region ?? "";
  const vars = { city, region };

  const styles = `
    .frame {
      position: relative;
      width: 100%; height: 100%;
      background: ${color(brand, "surface")};
      font-family: ${brand.fonts.body};
      display: flex; flex-direction: column;
      padding: 56px 64px 40px;
    }
    .wordmark {
      font-family: ${brand.fonts.handwritten};
      font-weight: 700;
      font-size: 40px;
      color: ${color(brand, "wordmark")};
    }
    .header {
      position: relative;
      margin-top: 20px;
    }
    .header-title {
      font-family: ${brand.fonts.handwritten};
      font-weight: 700;
      font-size: 76px;
      line-height: 1.05;
      color: ${color(brand, "onSurface")};
    }
    .header-title .accent {
      display: block;
      color: ${color(brand, "accent")};
    }
    .header-subtitle {
      margin-top: 18px;
      font-size: 26px;
      line-height: 1.4;
      color: ${color(brand, "onSurfaceMuted")};
      max-width: 640px;
    }
    .header-deco {
      position: absolute;
      top: -30px;
      right: -8px;
      width: 190px;
      height: 190px;
      pointer-events: none;
    }
    .cards {
      display: flex;
      flex-direction: column;
      gap: 28px;
      margin-top: 48px;
    }
    .card {
      background: #ffffff;
      border-radius: 24px;
      box-shadow: 0 8px 24px ${withAlpha(color(brand, "onSurface"), 0.08)};
      padding: 24px;
      display: flex;
      gap: 28px;
    }
    .photo-wrap {
      position: relative;
      flex: 0 0 auto;
      width: ${photoSize}px; height: ${photoSize}px;
    }
    .photo {
      width: 100%; height: 100%;
      border-radius: 18px;
      overflow: hidden;
    }
    .photo img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .time-chip {
      position: absolute;
      left: 12px; bottom: 12px;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      color: #ffffff;
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .time-chip svg { width: 16px; height: 16px; }
    /*
     * Photoless card: the chip has no photo corner to overlap, so it sits in
     * normal flow under the location row. Overrides the absolute positioning
     * above and shrinks to its content instead of stretching the row.
     */
    .time-inline {
      display: flex;
      margin-top: 14px;
    }
    .time-inline .time-chip {
      position: static;
    }
    .details {
      flex: 1;
      min-width: 0;
      display: flex; flex-direction: column;
      position: relative;
      padding-top: 4px;
    }
    .category-label {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .category-underline {
      width: 44px;
      height: 3px;
      margin-top: 6px;
      border-radius: 2px;
    }
    .star {
      position: absolute;
      top: 0; right: 0;
      width: 30px; height: 30px;
    }
    .title {
      font-family: ${brand.fonts.handwritten};
      font-weight: 700;
      font-size: 42px;
      line-height: 1.1;
      color: ${color(brand, "onSurface")};
      margin-top: 14px;
      margin-right: 36px;
    }
    .meta {
      font-size: 24px;
      color: ${color(brand, "onSurfaceMuted")};
      margin-top: 10px;
    }
    .location-row {
      display: flex; align-items: center; gap: 8px;
      margin-top: auto;
      padding-top: 14px;
      font-size: 22px;
      color: ${color(brand, "onSurfaceMuted")};
    }
    .location-row svg { width: 18px; height: 18px; flex: 0 0 auto; }
    .footer {
      margin-top: auto;
      padding-top: 36px;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      font-size: 22px;
      color: ${color(brand, "onSurfaceMuted")};
    }
    .footer svg { width: 18px; height: 18px; }
    .footer .divider { color: ${withAlpha(color(brand, "onSurface"), 0.25)}; }
    .footer .link { color: ${color(brand, "accent")}; font-weight: 600; }
  `;

  const pinIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-7.2-7-12a7 7 0 0 1 14 0c0 4.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
  const clockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;
  const starIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="${color(brand, 'onSurface')}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.6l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9L12 2.5z"/></svg>`;

  // Hand-built decorative flourish (concentric partial arcs + two 4-point
  // sparkles) in the profile's own accent/flourish colors — thin strokes
  // only, no fill, no borrowed iconography. See file header for rationale.
  const headerDeco = `
    <svg class="header-deco" viewBox="0 0 190 190" fill="none">
      <circle cx="150" cy="40" r="28" stroke="${color(brand, 'flourish')}" stroke-width="2" stroke-opacity="0.55"/>
      <circle cx="150" cy="40" r="42" stroke="${color(brand, 'flourish')}" stroke-width="2" stroke-opacity="0.35"/>
      <path d="M60 70 L64 82 L76 86 L64 90 L60 102 L56 90 L44 86 L56 82 Z" fill="${color(brand, 'accent')}" fill-opacity="0.7"/>
      <path d="M96 40 L98 47 L105 49 L98 51 L96 58 L94 51 L87 49 L94 47 Z" fill="${color(brand, 'accent')}" fill-opacity="0.5"/>
    </svg>
  `;

  const cards = slides
    .map((slide) => {
      const style = categoryStyle(brand, slide.category);
      const categoryLabel = (slide.category ?? copy.categoryFallbackLabel).toUpperCase();
      // No time in the data means no time chip — the engine no longer invents
      // one by scraping the subtitle.
      const timeChip = slide.time
        ? `<div class="time-chip" style="background: ${style.solid};">
              ${clockIcon}<span>${timeChipLabel(slide.time, copy.timeSuffix)}</span>
            </div>`
        : "";
      // A slide with no image renders no photo block at all, so the card's
      // flex row collapses to the text column instead of reserving an empty
      // 300x300 square. The chip normally overlaps the photo's corner; with
      // no photo to overlap it moves inline under the location row, so a
      // photoless-but-timed slide still shows its time rather than dropping it.
      const card = slide.image
        ? `<div class="photo-wrap">
            <div class="photo"><img src="${slide.image}" alt=""></div>
            ${timeChip}
          </div>`
        : "";
      const inlineTime = !slide.image && timeChip ? `<div class="time-inline">${timeChip}</div>` : "";
      return `
        <div class="card">
          ${card}
          <div class="details">
            <div class="star">${starIcon}</div>
            <div class="category-label" style="color: ${style.solid};">${categoryLabel}</div>
            <div class="category-underline" style="background: ${style.solid};"></div>
            <div class="title">${slide.title}</div>
            <div class="meta">${slide.subtitle}</div>
            <div class="location-row">${pinIcon}<span>${slide.meta}</span></div>
            ${inlineTime}
          </div>
        </div>
      `;
    })
    .join("");

  const body = `
    <div class="frame">
      <div class="wordmark">${brand.copy.wordmark}</div>
      <div class="header">
        ${headerDeco}
        <div class="header-title">${copy.headerTitle}<span class="accent">${headerLabel}</span></div>
        <div class="header-subtitle">${interpolate(copy.headerSubtitle, vars)}</div>
      </div>
      <div class="cards">${cards}</div>
      <div class="footer">
        ${pinIcon}<span>${interpolate(copy.footerLocation, vars)}</span>
        <span class="divider">|</span>
        <span>${copy.footerCta} <span class="link">${brand.copy.site}</span></span>
      </div>
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref);
};

// Declared here, beside the `categoryStyle` and `templateCopy` calls above
// that actually read this data, so the two cannot drift apart.
renderListFormat.features = ["categories", "listFormat"] as const;
