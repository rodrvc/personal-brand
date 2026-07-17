import { GOOGLE_FONTS_LINK } from "./brand.js";

export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1350;

/**
 * Wraps a template's <style> rules and body markup into a full HTML document
 * sized exactly to the IG carousel canvas (1080x1350, 4:5). Every template
 * variant delegates to this instead of duplicating page boilerplate.
 */
export function wrapDocument(styles: string, bodyMarkup: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${GOOGLE_FONTS_LINK}
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${CANVAS_WIDTH}px;
    height: ${CANVAS_HEIGHT}px;
    overflow: hidden;
  }
  ${styles}
</style>
</head>
<body>
${bodyMarkup}
</body>
</html>`;
}
