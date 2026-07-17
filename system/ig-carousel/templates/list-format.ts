import { BRAND, CATEGORY_COLORS } from "../brand.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideGroupTemplate } from "../types.js";

type CategoryColor = (typeof CATEGORY_COLORS)[keyof typeof CATEGORY_COLORS];

function resolveCategoryColor(category: string | undefined): CategoryColor {
  if (category && category in CATEGORY_COLORS) {
    return CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS];
  }
  return CATEGORY_COLORS.fallback;
}

/**
 * Extracts a short clock-style time (e.g. "20:00 HRS") from a free-form
 * subtitle string like "Vie 21 Mar, 20:00" or "Sab 11 Jul, invitado Nicky
 * Jam" (no parseable time). Falls back to the first comma-separated segment
 * after the date (or the whole subtitle) so the chip never renders empty —
 * real scraped data doesn't always carry a clean HH:MM.
 */
function extractTimeLabel(subtitle: string): string {
  const match = subtitle.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (match) {
    return `${match[0]} HRS`;
  }
  const parts = subtitle.split(",").map((p) => p.trim());
  return parts[1] || parts[0] || subtitle;
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
 * Typography: title (header + each event's title) uses `BRAND.fonts.handwritten`
 * ("Kalam", bold) instead of Inter — per anti-slop.md's "single default font
 * doing all the work" warning, pairing a hand-drawn display face with plain
 * Inter for body copy is what gives type itself a personality decision,
 * not just the palette. Pacifico remains reserved for other variants; this
 * one intentionally uses a thicker, more legible marker face to match the
 * reference's lettering weight.
 *
 * Header decoration: concentric arcs + two 4-point sparkles, hand-built as
 * inline SVG in the brand's own accent hue (terracotta), not a borrowed
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
 * reference, which shows Música/Fiesta/Comedia together under one "this
 * week" cover) — grouping here is purely "up to N events per slide", not
 * category-based, since the header no longer announces a single category.
 *
 * Price: the reference mockup shows a price chip ("Desde $8.000"); omitted
 * here per explicit product decision — the data contract has no price
 * field, and most real scraped events don't carry one anyway.
 */
export const renderListFormat: SlideGroupTemplate = (
  slides: Slide[],
  options?: { headerLabel?: string; city?: string },
) => {
  const photoSize = 300;
  // The caller (render-week.ts) computes this from the actual current
  // calendar week (Monday-Sunday), not from the events shown — the header
  // always reflects the real week being published, regardless of which
  // days within it happen to have events.
  const headerLabel = options?.headerLabel ?? "de la semana";
  const city = options?.city ?? "Antofagasta";

  const styles = `
    .frame {
      position: relative;
      width: 100%; height: 100%;
      background: ${BRAND.colors.backgroundLight};
      font-family: ${BRAND.fonts.body};
      display: flex; flex-direction: column;
      padding: 56px 64px 40px;
    }
    .wordmark {
      font-family: ${BRAND.fonts.handwritten};
      font-weight: 700;
      font-size: 40px;
      color: ${BRAND.colors.petrol};
    }
    .header {
      position: relative;
      margin-top: 20px;
    }
    .header-title {
      font-family: ${BRAND.fonts.handwritten};
      font-weight: 700;
      font-size: 76px;
      line-height: 1.05;
      color: ${BRAND.colors.textDark};
    }
    .header-title .accent {
      display: block;
      color: ${BRAND.colors.terracotta};
    }
    .header-subtitle {
      margin-top: 18px;
      font-size: 26px;
      line-height: 1.4;
      color: ${BRAND.colors.textSecondary};
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
      box-shadow: 0 8px 24px rgba(45, 52, 54, 0.08);
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
      font-family: ${BRAND.fonts.handwritten};
      font-weight: 700;
      font-size: 42px;
      line-height: 1.1;
      color: ${BRAND.colors.textDark};
      margin-top: 14px;
      margin-right: 36px;
    }
    .meta {
      font-size: 24px;
      color: ${BRAND.colors.textSecondary};
      margin-top: 10px;
    }
    .location-row {
      display: flex; align-items: center; gap: 8px;
      margin-top: auto;
      padding-top: 14px;
      font-size: 22px;
      color: ${BRAND.colors.textSecondary};
    }
    .location-row svg { width: 18px; height: 18px; flex: 0 0 auto; }
    .footer {
      margin-top: auto;
      padding-top: 36px;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      font-size: 22px;
      color: ${BRAND.colors.textSecondary};
    }
    .footer svg { width: 18px; height: 18px; }
    .footer .divider { color: rgba(45, 52, 54, 0.25); }
    .footer .link { color: ${BRAND.colors.terracotta}; font-weight: 600; }
  `;

  const pinIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-7.2-7-12a7 7 0 0 1 14 0c0 4.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
  const clockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;
  const starIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="${BRAND.colors.textDark}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.6l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9L12 2.5z"/></svg>`;

  // Hand-built decorative flourish (concentric partial arcs + two 4-point
  // sparkles) in the brand's own terracotta/coral accent — thin strokes
  // only, no fill, no borrowed iconography. See file header for rationale.
  const headerDeco = `
    <svg class="header-deco" viewBox="0 0 190 190" fill="none">
      <circle cx="150" cy="40" r="28" stroke="${BRAND.colors.coral}" stroke-width="2" stroke-opacity="0.55"/>
      <circle cx="150" cy="40" r="42" stroke="${BRAND.colors.coral}" stroke-width="2" stroke-opacity="0.35"/>
      <path d="M60 70 L64 82 L76 86 L64 90 L60 102 L56 90 L44 86 L56 82 Z" fill="${BRAND.colors.terracotta}" fill-opacity="0.7"/>
      <path d="M96 40 L98 47 L105 49 L98 51 L96 58 L94 51 L87 49 L94 47 Z" fill="${BRAND.colors.terracotta}" fill-opacity="0.5"/>
    </svg>
  `;

  const cards = slides
    .map((slide) => {
      const color = resolveCategoryColor(slide.category);
      const categoryLabel = (slide.category ?? "Evento").toUpperCase();
      const timeLabel = extractTimeLabel(slide.subtitle);
      return `
        <div class="card">
          <div class="photo-wrap">
            <div class="photo"><img src="${slide.image}" alt=""></div>
            <div class="time-chip" style="background: ${color.solid};">
              ${clockIcon}<span>${timeLabel}</span>
            </div>
          </div>
          <div class="details">
            <div class="star">${starIcon}</div>
            <div class="category-label" style="color: ${color.solid};">${categoryLabel}</div>
            <div class="category-underline" style="background: ${color.solid};"></div>
            <div class="title">${slide.title}</div>
            <div class="meta">${slide.subtitle}</div>
            <div class="location-row">${pinIcon}<span>${slide.meta}</span></div>
          </div>
        </div>
      `;
    })
    .join("");

  const body = `
    <div class="frame">
      <div class="wordmark">Adondepo</div>
      <div class="header">
        ${headerDeco}
        <div class="header-title">Panoramas<span class="accent">${headerLabel}</span></div>
        <div class="header-subtitle">Los mejores panoramas en ${city}, en un solo lugar.</div>
      </div>
      <div class="cards">${cards}</div>
      <div class="footer">
        ${pinIcon}<span>${city}, Chile</span>
        <span class="divider">|</span>
        <span>Descubre más panoramas en <span class="link">adondepo.cl</span></span>
      </div>
    </div>
  `;

  return wrapDocument(styles, body);
};
