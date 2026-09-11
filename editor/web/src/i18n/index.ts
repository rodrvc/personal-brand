import { es } from "./es";

/**
 * Plain keyed lookup, no i18n framework (design.md "Locale resource as a
 * plain keyed JSON module"): the product ships one language and needs no
 * pluralisation rules, date/number locale machinery or lazy bundle
 * splitting. `es` is both the type source and the runtime default locale.
 */
const defaultLocale: Record<string, string> = es;

export type LocaleKey = keyof typeof es;

const warnedKeys = new Set<string>();

/** Test-only: clears the missing-key warning dedupe, so a "warns once" assertion owns its own state instead of inheriting whatever earlier lookups (in this or another test) already warned about. */
export function resetMissingKeyWarnings(): void {
  warnedKeys.clear();
}

/**
 * Looks up `key` in the default locale and interpolates `{name}`-style
 * placeholders from `params`. A missing key never throws — it warns once
 * (so a broken key can't spam the console) and returns the key itself, so
 * a missing string is visible on screen instead of blank. A placeholder
 * with no matching entry in `params` (or no `params` at all) is left as
 * the literal `{name}` in the output, unreplaced.
 */
export function t(key: LocaleKey, params?: Record<string, string | number>): string {
  const template = defaultLocale[key];
  if (template === undefined) {
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(`[i18n] missing locale key: "${key}"`);
    }
    return key;
  }
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
