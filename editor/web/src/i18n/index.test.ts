import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { es } from "./es.js";
import { resetMissingKeyWarnings, t } from "./index.js";

/**
 * (a) Every key in the default locale carries a non-empty string — an
 * empty value would silently render nothing, which is indistinguishable
 * from a missing translation on screen.
 */
{
  const entries = Object.entries(es);
  assert.ok(entries.length > 0, "es.ts should declare at least one key");
  for (const [key, value] of entries) {
    assert.equal(typeof value, "string", `${key} should be a string`);
    assert.ok(value.trim().length > 0, `${key} should not be empty`);
  }
  console.log(`i18n: ${entries.length} keys in es.ts, all non-empty strings`);
}

/**
 * (b) `t()` never throws on a missing key: it returns the key itself (so a
 * missing string is visible on screen, not blank) and warns via
 * console.warn exactly once for that key.
 */
{
  resetMissingKeyWarnings(); // this assertion owns its own warning-dedupe state, not whatever an earlier lookup left behind
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    // @ts-expect-error -- deliberately calling with a key outside the LocaleKey union to exercise the fallback path.
    const result = t("this.key.does.not.exist");
    assert.equal(result, "this.key.does.not.exist", "missing key falls back to the key itself");
    assert.equal(warnings.length, 1, "missing key warns exactly once on first lookup");

    // @ts-expect-error -- same missing key, looked up again.
    t("this.key.does.not.exist");
    assert.equal(warnings.length, 1, "missing key does not warn again on a repeated lookup");
  } finally {
    console.warn = originalWarn;
  }
  console.log("i18n: t() falls back to the key and warns once for a missing key");
}

/** `t()` interpolates `{name}`-style placeholders from params. */
{
  // topbar.subtitle is a stable, always-present interpolated key — exercise it directly.
  const result = t("topbar.subtitle", { count: 3, w: 1080, h: 1350 });
  assert.ok(!result.includes("{"), "interpolated placeholders are replaced, not left as literal braces");
  assert.ok(result.includes("3") && result.includes("1080") && result.includes("1350"));
  console.log("i18n: t() interpolates {name}-style placeholders");
}

/** A placeholder with no matching entry in `params` is left as the literal `{name}`, unreplaced. */
{
  const result = t("topbar.subtitle", { count: 3, w: 1080 }); // `h` deliberately omitted
  assert.ok(result.includes("{h}"), "a placeholder missing from params is left as the literal brace");
  console.log("i18n: t() leaves an unmatched placeholder as a literal brace");
}

/**
 * Script-style check: nothing under editor/web/src outside i18n/ should
 * contain a Spanish accented character, or a common unaccented Spanish word
 * inside a string literal or JSX text — either would mean a user-facing
 * string escaped extraction (specs/editor-i18n, tasks.md 5.2/5.3). Locale
 * *values* are exempt (that's the whole point of i18n/es.ts), so i18n/ is
 * the only excluded directory; other test files are scanned like any other
 * source file — a Spanish literal slipping into a *.test.ts fixture is the
 * same kind of leak as one in a component.
 */
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC_ROOT = join(HERE, ".."); // editor/web/src
  const SPANISH_CHARS = /[À-ÿ]/;
  // Common unaccented Spanish words/particles that show up in UI copy.
  // Word-bounded and case-insensitive; checked only inside string literals
  // and JSX text (not identifiers, import paths, or CSS class names) to
  // avoid false positives like `de` inside `data-*` or a hex color.
  const SPANISH_WORDS =
    /\b(de|del|sin|con|para|una|uno|lámina|láminas|marca|perfil|fondo|texto|todavía|carrusel|plantilla|guardar|cargando|eliminar|agregar|imagen)\b/i;
  const SKIP_DIRS = new Set(["node_modules", "i18n"]);
  const CODE_EXT = new Set([".ts", ".tsx"]);

  // Block (/* ... */, including JSDoc) and line (// ...) comments are
  // developer-facing prose — they legitimately quote UI copy in English
  // sentences (e.g. `shown in the "Marca" tab`) without that being a leak.
  // Stripped before scanning so a quoted word inside a comment is never
  // mistaken for a real string literal or JSX text.
  const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
  const LINE_COMMENT = /\/\/[^\n]*/g;

  // String literals ('...', "...", `...`) and JSX text content (>text<
  // between tags) — the two places user-facing copy can hide. Deliberately
  // simple (no full parser): good enough to catch a stray Spanish literal
  // without flagging import paths.
  const STRING_LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const JSX_TEXT = />([^<>{}\n]+)</g;

  // Technical identifiers that happen to spell a Spanish word: PanelTab's
  // "marca" id ("Editor.tsx" `type PanelTab`, "PropertiesPanel.tsx"'s tab
  // switch) is never rendered — the display label is
  // `t("propertiesPanel.tab.brand")`. Whole-literal match only, so this
  // never widens into a loophole for real UI copy.
  const ALLOWED_LITERALS = new Set(['"marca"', "'marca'"]);

  function extractCandidateText(content: string): string[] {
    const withoutComments = content.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
    const candidates: string[] = [];
    for (const match of withoutComments.matchAll(STRING_LITERAL)) {
      if (ALLOWED_LITERALS.has(match[0])) continue;
      candidates.push(match[0]);
    }
    for (const match of withoutComments.matchAll(JSX_TEXT)) candidates.push(match[1] ?? "");
    return candidates;
  }

  function walk(dir: string, offenders: string[]) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, offenders);
        continue;
      }
      const dotIndex = entry.lastIndexOf(".");
      const ext = dotIndex === -1 ? "" : entry.slice(dotIndex);
      if (!CODE_EXT.has(ext)) continue;
      const content = readFileSync(full, "utf8");
      const withoutComments = content.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
      if (SPANISH_CHARS.test(withoutComments)) {
        offenders.push(full);
        continue;
      }
      if (extractCandidateText(content).some((text) => SPANISH_WORDS.test(text))) offenders.push(full);
    }
  }

  const offenders: string[] = [];
  walk(SRC_ROOT, offenders);
  assert.deepEqual(
    offenders,
    [],
    `Spanish text found outside i18n/ — move these strings into es.ts:\n${offenders.join("\n")}`,
  );
  console.log("i18n: no Spanish literals remain in editor/web/src outside i18n/");
}
