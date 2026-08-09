export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1350;

/**
 * Wraps a template's <style> rules and body markup into a full HTML document
 * sized exactly to the IG carousel canvas (1080x1350, 4:5). Every template
 * variant delegates to this instead of duplicating page boilerplate.
 *
 * `fontsHref` is the profile's webfont stylesheet, passed in rather than
 * imported: a profile using only system fonts omits it and no external font
 * request is made at all.
 */
export function wrapDocument(styles: string, bodyMarkup: string, fontsHref?: string): string {
  const fontLinks = fontsHref
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${fontsHref}" rel="stylesheet">`
    : "";

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
  ${styles}
</style>
</head>
<body>
${bodyMarkup}
</body>
</html>`;
}
