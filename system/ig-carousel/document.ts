export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1350;

/**
 * A local font file to declare via `@font-face`. `family` is the name used
 * in CSS `font-family`; `url` is whatever the caller resolved it to — an
 * `/api/profiles/:slug/assets/fonts/<file>` HTTP URL for the browser preview,
 * or a local `file://`/filesystem path for Playwright's export pass (design.md
 * D9). This module doesn't care which: it only emits the `@font-face` rule.
 */
export interface FontFace {
  family: string;
  url: string;
  weight?: string | number;
  style?: string;
}

function fontFaceRule(font: FontFace): string {
  return `@font-face {
    font-family: "${font.family}";
    src: url("${font.url}") format("woff2");
    font-weight: ${font.weight ?? "normal"};
    font-style: ${font.style ?? "normal"};
    font-display: block;
  }`;
}

/**
 * Wraps a template's <style> rules and body markup into a full HTML document
 * sized exactly to the IG carousel canvas (1080x1350, 4:5). Every template
 * variant delegates to this instead of duplicating page boilerplate.
 *
 * `fontsHref` is the profile's webfont stylesheet, passed in rather than
 * imported: a profile using only system fonts omits it and no external font
 * request is made at all.
 *
 * `fontFaces` declares local `@font-face` rules (design.md D9: fonts
 * downloaded to the profile) — independent of `fontsHref`, since a document
 * can use local woff2 files, a Google Fonts stylesheet, both, or neither
 * (system fonts only).
 */
export function wrapDocument(
  styles: string,
  bodyMarkup: string,
  fontsHref?: string,
  fontFaces?: FontFace[],
): string {
  const fontLinks = fontsHref
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${fontsHref}" rel="stylesheet">`
    : "";

  const fontFaceRules = fontFaces?.length ? fontFaces.map(fontFaceRule).join("\n  ") : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${fontLinks}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${CANVAS_WIDTH}px;
    height: ${CANVAS_HEIGHT}px;
    overflow: hidden;
  }
  ${fontFaceRules}
  ${styles}
</style>
</head>
<body>
${bodyMarkup}
</body>
</html>`;
}
