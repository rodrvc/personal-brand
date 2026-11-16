import { NotFoundError, type BrandDocumentRepository, type ThemeEnvelope, type ThemeRepository } from "./contracts/index.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A copy of `value` without prototype keys at any depth. */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.has(key)).map(([key, v]) => [key, clean(v)]));
}

/**
 * The one overlay rule: `overrides` on top of `tokens` (the `brand.json` shape). Plain objects merge key by key; arrays and
 * scalars replace; a `null` replaces too. Neither input is mutated. Prototype keys are dropped, never copied.
 */
export function applyThemeOverrides(tokens: unknown, overrides: unknown): unknown {
  if (!isPlainObject(overrides)) return overrides;
  const base = isPlainObject(tokens) ? tokens : {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) if (!FORBIDDEN_KEYS.has(key)) merged[key] = clean(value);
  for (const [key, value] of Object.entries(overrides)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? applyThemeOverrides(merged[key], value) : clean(value);
  }
  return merged;
}

/** Whether `zone` is an IANA time zone name the runtime knows. */
const validZone = (zone: unknown): zone is string => {
  if (typeof zone !== "string" || !zone) return false;
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); return true; } catch { return false; }
};

/**
 * "Today" for a brand: the day it is now in the brand's time zone (optional `timezone`, an IANA name, in its config document),
 * else on the machine. An unset zone is silent; a set but invalid one falls back to the machine with a Spanish warning, so a typo never blocks a command.
 */
export const brandToday = (ctx: { repos: { documents: Pick<BrandDocumentRepository, "get"> }; now(): Date }, brandId: string): Promise<{ day: string; warning?: string }> => brandDay(ctx, brandId, ctx.now());

/** The day `instant` is on in the brand's time zone (same lookup and warning as `brandToday`, which is this at `now()`). */
export async function brandDay(ctx: { repos: { documents: Pick<BrandDocumentRepository, "get"> } }, brandId: string, instant: Date): Promise<{ day: string; warning?: string }> {
  const config = await ctx.repos.documents.get(brandId, "config", "", (b) => b).then((d) => d.value as { timezone?: unknown }, (e) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  const set = config?.timezone !== undefined && config.timezone !== null;
  const zone = config && validZone(config.timezone) ? config.timezone : undefined;
  const d = instant;
  if (zone) return { day: new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) };
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!set) return { day };
  const what = typeof config!.timezone === "string" ? `la zona horaria ${JSON.stringify(config!.timezone)} de la configuración no es válida (usa un nombre IANA como Pacific/Auckland)` : "la zona horaria de la configuración no es texto (usa un nombre IANA como Pacific/Auckland)";
  return { day, warning: `Aviso: ${what}; se usó la del equipo.` };
}

/**
 * The theme a render applies: the one active on `date` (the content's own day, `AAAA-MM-DD`), else on the brand's today.
 * Every path that reads a stored brand's tokens asks this and then calls `applyThemeOverrides`.
 */
export async function activeTheme(
  ctx: { repos: { documents: Pick<BrandDocumentRepository, "get">; themes: Pick<ThemeRepository, "activeOn"> }; now(): Date },
  brandId: string,
  date?: string,
): Promise<{ day: string; theme: ThemeEnvelope | null; warning?: string }> {
  const today = date === undefined ? await brandToday(ctx, brandId) : null;
  const day = date ?? today!.day;
  return { day, theme: await ctx.repos.themes.activeOn(brandId, day), ...(today?.warning ? { warning: today.warning } : {}) };
}

/** Families every machine has (or the CSS generics): a theme naming one of these needs no stored font. */
const SYSTEM_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "-apple-system", "blinkmacsystemfont", "georgia", "arial", "helvetica", "times new roman", "courier new", "verdana", "trebuchet ms", "segoe ui", "tahoma", "impact"]);

/** The first family of each `fonts` entry in a theme's overrides that is not a system family and not among `stored` (the brand's font assets' families), sorted and distinct. */
export function missingThemeFonts(overrides: unknown, stored: Iterable<string>): string[] {
  const fonts = isPlainObject(overrides) && isPlainObject(overrides.fonts) ? Object.values(overrides.fonts) : [];
  const have = new Set([...stored].map((f) => f.toLowerCase()));
  const wanted = fonts.flatMap((v) => (typeof v === "string" ? [v.split(",")[0]!.trim().replace(/^["']|["']$/g, "")] : [])).filter((f) => f && !SYSTEM_FAMILIES.has(f.toLowerCase()) && !have.has(f.toLowerCase()));
  return [...new Set(wanted)].sort();
}
