import { color, type BrandTokens } from "../brand-schema.js";
import { resolveSlide, type ResolvedObject, type ResolvedSlide } from "../carousel-document-resolve.js";
import type { CarouselDocument } from "../carousel-document.js";
import { wrapDocument, type FontFace } from "../document.js";
import type { LayoutTemplate } from "../layout-template.js";
import type { PickedLogo } from "../../assets/logo.js";

/**
 * Rendering context free-layout needs beyond `brand`/`template`/`doc`, kept
 * separate from the document because it's about *where things live on this
 * machine/request*, not about the carousel's content (design.md D2, D9):
 *
 * - `assetUrl` turns a document `assetId` into a URL — the caller decides
 *   whether that's an HTTP path (browser preview) or a local filesystem
 *   path (Playwright export). `free-layout.ts` never constructs a path
 *   itself, so it stays agnostic of both the asset index and the server.
 * - `fontFaces` is the resolved list of local `@font-face` declarations to
 *   emit (already URL-resolved the same way as `assetUrl`).
 * - `logo` is the already-picked logo asset for *this slide's* real
 *   background (via `pickLogo` + `pickLogoVariant`, D8) — resolved by the
 *   caller because picking it requires the asset index and the slide's
 *   painted background color, neither of which this pure function touches.
 *   `undefined` means "no logo asset in the library": the footer falls back
 *   to `brand.copy.wordmark` set in `brand.fonts.logo`, exactly like the
 *   reel engine does today.
 */
export interface FreeLayoutRenderContext {
  assetUrl: (assetId: string) => string;
  fontFaces?: FontFace[];
  logo?: (PickedLogo & { url: string }) | undefined;
}

/** Escapes text for safe interpolation into HTML markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Characters that would let a `brand.json` value break out of the `style="…"`
 * attribute it's interpolated into and inject CSS (or worse) into the
 * rendered `srcdoc` — `;` ends a declaration, `{`/`}` open/close a rule
 * block, `<` opens a new tag. `brand.colors`/`brand.fonts` values are
 * trusted profile data, not user input, but this is cheap insurance against
 * a typo'd or copy-pasted value (e.g. a CSS snippet) silently becoming
 * live markup.
 */
const CSS_INJECTION_CHARS = /[;{}<]/;

/** Resolves a document color key to its literal value; `undefined` means "no pin". */
function colorFromKey(brand: BrandTokens, colorKey: string | undefined): string | undefined {
  if (colorKey === undefined) return undefined;
  const value = brand.colors[colorKey];
  if (!value) {
    throw new Error(`Unknown color key "${colorKey}" — not present in brand.colors.`);
  }
  if (CSS_INJECTION_CHARS.test(value)) {
    throw new Error(`brand.colors["${colorKey}"] contains a disallowed character (one of ; { } <): "${value}"`);
  }
  return value;
}

/**
 * Resolves a font key to its family. Throws rather than silently rendering
 * in the fallback face: an unknown key means the document (or a template
 * slot) names a font the brand doesn't declare, and a silent fallback is
 * exactly the WYSIWYG drift this engine exists to prevent.
 */
function fontFromKey(brand: BrandTokens, fontKey: string): string {
  const family = (brand.fonts as Record<string, string | undefined>)[fontKey];
  if (!family) {
    throw new Error(`Unknown font key "${fontKey}" — not present in brand.fonts.`);
  }
  if (CSS_INJECTION_CHARS.test(family)) {
    throw new Error(`brand.fonts["${fontKey}"] contains a disallowed character (one of ; { } <): "${family}"`);
  }
  return family;
}

/** Renders one resolved text object to an absolutely positioned `<div>`. */
function renderTextObject(brand: BrandTokens, object: ResolvedObject): string {
  const content = object.content;
  if (content.kind !== "text") {
    throw new Error(`renderTextObject called with a non-text object "${object.id}"`);
  }
  const { geometry } = object;
  const fontFamily = content.fontKey ? fontFromKey(brand, content.fontKey) : undefined;
  const textColor =
    colorFromKey(brand, content.colorKey) ?? (content.colorRole ? color(brand, content.colorRole as keyof BrandTokens["roles"]) : undefined);

  const style = [
    `position: absolute`,
    `left: ${geometry.x}px`,
    `top: ${geometry.y}px`,
    `width: ${geometry.w}px`,
    geometry.h !== undefined ? `height: ${geometry.h}px` : undefined,
    geometry.rotation ? `transform: rotate(${geometry.rotation}deg)` : undefined,
    fontFamily ? `font-family: ${fontFamily}` : undefined,
    content.fontSize !== undefined ? `font-size: ${content.fontSize}px` : undefined,
    content.lineHeight !== undefined ? `line-height: ${content.lineHeight}` : undefined,
    content.align ? `text-align: ${content.align}` : undefined,
    textColor ? `color: ${textColor}` : undefined,
    `white-space: pre-wrap`,
  ]
    .filter(Boolean)
    .join("; ");

  return `<div class="obj obj-text" data-object-id="${escapeHtml(object.id)}" style="${style}">${escapeHtml(
    content.text,
  )}</div>`;
}

/** Renders one resolved asset object to an absolutely positioned, cropped `<img>`. */
function renderAssetObject(object: ResolvedObject, ctx: FreeLayoutRenderContext): string {
  const content = object.content;
  if (content.kind !== "asset") {
    throw new Error(`renderAssetObject called with a non-asset object "${object.id}"`);
  }
  const { geometry } = object;
  const wrapperStyle = [
    `position: absolute`,
    `left: ${geometry.x}px`,
    `top: ${geometry.y}px`,
    `width: ${geometry.w}px`,
    `height: ${geometry.h ?? geometry.w}px`,
    geometry.rotation ? `transform: rotate(${geometry.rotation}deg)` : undefined,
    `overflow: hidden`,
  ]
    .filter(Boolean)
    .join("; ");

  const imgStyle = [
    `width: 100%`,
    `height: 100%`,
    `object-fit: ${content.fit}`,
    `display: block`,
  ].join("; ");

  // No `assetId` yet: either still `pending` (compose job hasn't reached
  // this slot) or `awaitingImage` (reached it, found no library candidate,
  // and — per the owner's decision that image generation is never
  // automatic — stopped there for an explicit per-piece request). Render
  // an empty box instead of an `<img>` with nothing to point at; the
  // editor overlays its own shimmer for `pending` on top of
  // `[data-object-id]` elements, and `awaitingImage` gets its own dashed
  // "Por generar" placeholder plus a `data-awaiting="true"` marker the UI
  // uses to place its "Generar imagen…" button.
  if (!content.assetId) {
    if (content.awaitingImage) {
      return `<div class="obj obj-asset obj-asset-awaiting" data-object-id="${escapeHtml(
        object.id,
      )}" data-awaiting="true" style="${wrapperStyle}"><div class="obj-asset-awaiting-inner" style="position: absolute; inset: 8px; border: 2px dashed currentColor; opacity: 0.5; display: flex; align-items: center; justify-content: center; box-sizing: border-box;"><span style="font-size: 14px; opacity: 0.8;">Por generar</span></div></div>`;
    }
    return `<div class="obj obj-asset obj-asset-pending" data-object-id="${escapeHtml(object.id)}" style="${wrapperStyle}"></div>`;
  }

  return `<div class="obj obj-asset" data-object-id="${escapeHtml(object.id)}" style="${wrapperStyle}"><img src="${escapeHtml(
    ctx.assetUrl(content.assetId),
  )}" style="${imgStyle}" /></div>`;
}

/** Renders the locked background zone: a flat color fill or a full-bleed cover image. */
function renderBackgroundZone(
  brand: BrandTokens,
  slide: ResolvedSlide,
  ctx: FreeLayoutRenderContext,
): string {
  const { background } = slide;
  const style = [`position: absolute`, `inset: 0`];

  if (background.mode === "color") {
    const bg = colorFromKey(brand, background.colorKey);
    style.push(`background-color: ${bg}`);
    // `awaitingImage: true` means the compose job found no library
    // candidate for this background and stopped rather than generating one
    // automatically (owner decision) — the color fill stands in, plus the
    // same dashed "Por generar" placeholder an asset object gets, so the
    // editor can offer its "Generar imagen…" button here too.
    if (background.awaitingImage) {
      const placeholder = `<div class="obj-asset-awaiting-inner" style="position: absolute; inset: 24px; border: 2px dashed currentColor; opacity: 0.5; display: flex; align-items: center; justify-content: center; box-sizing: border-box;"><span style="font-size: 14px; opacity: 0.8;">Por generar</span></div>`;
      return `<div class="zone zone-background" data-zone="background" data-awaiting="true" style="${style.join(
        "; ",
      )}">${placeholder}</div>`;
    }
    return `<div class="zone zone-background" data-zone="background" style="${style.join("; ")}"></div>`;
  }

  // mode === "asset": full-bleed cover image behind everything else.
  return `<div class="zone zone-background" data-zone="background" style="${style.join(
    "; ",
  )}"><img src="${escapeHtml(ctx.assetUrl(background.assetId))}" style="width: 100%; height: 100%; object-fit: cover; display: block;" /></div>`;
}

/**
 * Renders the locked footer zone: logo (or wordmark fallback) plus,
 * governed by the template's `zones.footer.pagination`, pagination text —
 * "all" shows "N/M" on every slide, "steps" only on `kind: step` slides,
 * "none" shows no pagination at all (design.md D8/the layout-template spec).
 */
function renderFooterZone(
  brand: BrandTokens,
  template: LayoutTemplate,
  slide: ResolvedSlide,
  slideIndex: number,
  totalSlides: number,
  ctx: FreeLayoutRenderContext,
): string {
  const footer = template.zones.footer;
  if (footer.height <= 0) {
    return "";
  }

  const style = [
    `position: absolute`,
    `left: 0`,
    `right: 0`,
    `bottom: 0`,
    `height: ${footer.height}px`,
    `display: flex`,
    `align-items: center`,
    `justify-content: space-between`,
    `padding: 0 ${template.zones.margins.right}px 0 ${template.zones.margins.left}px`,
    `box-sizing: border-box`,
  ].join("; ");

  let logoMarkup = "";
  if (footer.logo === "auto") {
    if (ctx.logo) {
      logoMarkup = `<img class="footer-logo" src="${escapeHtml(ctx.logo.url)}" style="height: ${Math.round(
        footer.height * 0.5,
      )}px; display: block;" />`;
    } else {
      // No logo asset in the library: fall back to the wordmark copy set in
      // the logo font, exactly like the reel engine does today (design.md D8).
      logoMarkup = `<span class="footer-wordmark" style="font-family: ${brand.fonts.logo}; font-size: ${Math.round(
        footer.height * 0.4,
      )}px; color: ${color(brand, "onSurface")};">${escapeHtml(brand.copy.wordmark)}</span>`;
    }
  }

  const showPagination =
    footer.pagination === "all" || (footer.pagination === "steps" && slide.kind === "step");
  const paginationMarkup = showPagination
    ? `<span class="footer-pagination" style="font-family: ${brand.fonts.body}; font-size: ${Math.round(
        footer.height * 0.3,
      )}px; color: ${color(brand, "onSurfaceMuted")};">${slideIndex + 1}/${totalSlides}</span>`
    : "";

  // Two edge groups, each its own flex item, so a `space-between` footer
  // still has exactly two children — logo+signature on the left,
  // signature+pagination on the right — instead of `justify-content:
  // space-between` redistributing a third top-level child and shifting the
  // logo/pagination off their edges (architect review: `order` only
  // permutes flex children in place, it does not anchor one to an edge).
  // With no signature this renders byte-identical wrapper markup to the
  // pre-signature footer, just with the same logo/pagination each wrapped
  // in its own (empty-margin, non-visual) edge group.
  const signatureLeft =
    footer.signature && footer.signature.align === "left"
      ? renderFooterSignature(brand, footer.signature, footer.height)
      : "";
  const signatureRight =
    footer.signature && footer.signature.align === "right"
      ? renderFooterSignature(brand, footer.signature, footer.height)
      : "";

  const groupStyle = `display: flex; align-items: center; gap: ${Math.round(footer.height * 0.25)}px;`;

  return `<div class="zone zone-footer" data-zone="footer" style="${style}"><div class="footer-left" style="${groupStyle}">${logoMarkup}${signatureLeft}</div><div class="footer-right" style="${groupStyle}">${signatureRight}${paginationMarkup}</div></div>`;
}

/**
 * Renders the footer's optional fixed signature line — painted straight
 * from the resolved template and brand, never from a document object
 * (layout-template spec's "Footer signature": structurally unreachable
 * from any composition). `loadLayoutTemplate` has already proven, at
 * resolve time, that the signature's `copyKey`/`fontKey`/`colorRole` exist
 * on the brand when `brand` was passed to it, so this still fails closed
 * (rather than emitting `color: undefined`) on a `colorRole` that somehow
 * reaches render unresolved.
 */
function renderFooterSignature(
  brand: BrandTokens,
  signature: NonNullable<LayoutTemplate["zones"]["footer"]["signature"]>,
  footerHeight: number,
): string {
  const text = (brand.copy as Record<string, unknown>)[signature.copyKey];
  if (typeof text !== "string") {
    throw new Error(
      `Footer signature copyKey "${signature.copyKey}" is not a string in brand.copy — ` +
        `loadLayoutTemplate should have caught this before render.`,
    );
  }
  const fontFamily = fontFromKey(brand, signature.fontKey);
  if (!(signature.colorRole in brand.roles)) {
    throw new Error(
      `Unknown colorRole "${signature.colorRole}" in zones.footer.signature — not present in brand.roles. ` +
        `loadLayoutTemplate should have caught this before render.`,
    );
  }
  const textColor = color(brand, signature.colorRole as keyof BrandTokens["roles"]);

  return `<span class="footer-signature" data-footer-signature="true" style="font-family: ${fontFamily}; font-size: ${Math.round(
    footerHeight * 0.3,
  )}px; color: ${textColor};">${escapeHtml(text)}</span>`;
}

/**
 * Renders the (invisible, export-transparent) margins zone as a safe-area
 * box the editor overlay can read via `data-zone="margins"` — never
 * visible in export, hence `pointer-events: none` and no paint.
 */
function renderMarginsZone(template: LayoutTemplate): string {
  const m = template.zones.margins;
  const style = [
    `position: absolute`,
    `left: ${m.left}px`,
    `top: ${m.top}px`,
    `right: ${m.right}px`,
    `bottom: ${m.bottom}px`,
    `pointer-events: none`,
  ].join("; ");
  return `<div class="zone zone-margins" data-zone="margins" style="${style}"></div>`;
}

/**
 * Pure render of one slide of a `CarouselDocument` to a full HTML document
 * string (design.md D2): the editor's `<iframe srcdoc>` preview and
 * Playwright's export capture both call this exact function, so there is no
 * second render implementation to drift out of sync.
 *
 * Zones (background, footer, margins) are painted from the resolved
 * template, never from the slide's own objects — objects then paint over
 * them in document order (design.md D4: "locked zones are not objects").
 */
export function renderFreeLayoutSlide(
  brand: BrandTokens,
  template: LayoutTemplate,
  doc: CarouselDocument,
  slideIndex: number,
  ctx: FreeLayoutRenderContext,
): string {
  const slide = doc.slides[slideIndex];
  if (!slide) {
    throw new Error(`Slide index ${slideIndex} out of range (document has ${doc.slides.length} slides).`);
  }
  const resolved = resolveSlide(doc, slide, template);

  const styles = `
    .stage {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: ${brand.fonts.body};
    }
    .obj { box-sizing: border-box; }
    .zone { box-sizing: border-box; }
  `;

  const objectsMarkup = resolved.objects
    .map((object) => (object.content.kind === "text" ? renderTextObject(brand, object) : renderAssetObject(object, ctx)))
    .join("\n");

  const body = `
    <div class="stage" data-canvas-w="${doc.canvas.w}" data-canvas-h="${doc.canvas.h}">
      ${renderBackgroundZone(brand, resolved, ctx)}
      ${objectsMarkup}
      ${renderFooterZone(brand, template, resolved, slideIndex, doc.slides.length, ctx)}
      ${renderMarginsZone(template)}
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref, ctx.fontFaces);
}
