import { useEffect } from "react";

/**
 * How many mounted consumers currently want each injected `<link>` —
 * module-level, so two routes (or two cards) asking for the same font
 * share one element and neither removes it out from under the other.
 */
const linkRefCounts = new Map<string, { link: HTMLLinkElement; count: number }>();

/**
 * Loads every unique Google Fonts `href` given as a `<link>` in `<head>`,
 * once each, so a brand's wordmark can render in its actual logo font.
 * Scoped in effect, not just in name: nothing but a caller's own
 * `fontFamily`-styled element ever references those font families, so the
 * chrome's own `--ui-display`/`--ui-font` never pick them up even though
 * the stylesheet itself loads globally — a `<link>` has no shadow-DOM
 * equivalent to actually scope to.
 *
 * Reference-counted: the `<link>` is removed only when the last consumer
 * that asked for it unmounts (or stops asking).
 *
 * Shared by the profile picker's brand card grid (every profile's font at
 * once) and the brand home dashboard (one profile's font).
 */
export function useBrandFonts(hrefs: string[]): void {
  useEffect(() => {
    const unique = Array.from(new Set(hrefs));
    for (const href of unique) {
      const entry = linkRefCounts.get(href);
      if (entry) {
        entry.count += 1;
        continue;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.brandFont = href;
      document.head.appendChild(link);
      linkRefCounts.set(href, { link, count: 1 });
    }
    return () => {
      for (const href of unique) {
        const entry = linkRefCounts.get(href);
        if (!entry) continue;
        entry.count -= 1;
        if (entry.count === 0) {
          entry.link.remove();
          linkRefCounts.delete(href);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hrefs.join("|")]);
}
