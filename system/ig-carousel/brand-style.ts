import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the human-authored brand-guidance files a profile *may* have —
 * `brand-spec.md`, `profile.md`, `config.yaml` — and turns them into a
 * small, structured "brand style" the editor can inject into every AI
 * prompt (piece-generation spec's "Brand style context in every
 * generation"). This is genuinely optional context: none of these files are
 * required for `system/ig-carousel` to render, so every extractor here is
 * defensive — a missing file, an unexpected heading, or a `config.yaml` with
 * no `tone:` block all resolve to an empty field, never a throw.
 *
 * `brand.json` (the compiled, mandatory tokens `loadBrand` validates) stays
 * the engine's source of colors/fonts/copy. This module only *describes*
 * those tokens in words for a prompt (see `describePaletteInWords`) and
 * layers on the prose a `brand.json` cannot carry: design rationale, tone
 * keywords, positioning, image direction, logo rules. Nothing it reads is
 * itself a brand literal — the profile directory decides which brand this
 * runs against.
 */

export interface BrandStylePaletteEntry {
  key: string;
  hex: string;
  role?: string;
}

export interface BrandStyle {
  palette: BrandStylePaletteEntry[];
  fonts: { logo?: string; body?: string; handwritten?: string };
  styleKeywords: string[];
  tone: { style: string[]; avoid: string[] };
  positioning?: string;
  imageDirection?: string;
  logoRules?: string;
  /** Which of brand-spec.md / profile.md / config.yaml / brand.json actually contributed a field, in that order — the editor shows this as "Fuentes:" and it doubles as "nothing found" detection. */
  sources: string[];
}

function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Extracts a markdown section's body by heading heuristics: the heading line
 * (any `#` level) must contain one of `keywords` (case-insensitive), and the
 * body runs until the next heading of the same or shallower level, or EOF.
 * Capped at ~1500 chars (trimmed at a line boundary where possible) since
 * this text is going straight into an AI prompt, not rendered for a human —
 * a multi-page section would drown out the actual generation instructions.
 * Returns `undefined` when no heading matches, which is the normal case for
 * a brand-spec.md that predates this feature.
 */
function extractSection(markdown: string, keywords: RegExp): string | undefined {
  const lines = markdown.split("\n");
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.*)$/);
    if (match && keywords.test(match[2]!)) {
      start = i + 1;
      startLevel = match[1]!.length;
      break;
    }
  }
  if (start === -1) return undefined;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+/);
    if (match && match[1]!.length <= startLevel) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start, end).join("\n").trim();
  if (!body) return undefined;
  const CAP = 1500;
  if (body.length <= CAP) return body;
  // Cut at the last blank line (paragraph boundary) before the cap when one
  // exists, so the excerpt doesn't stop mid-sentence more than it has to.
  const truncated = body.slice(0, CAP);
  const lastBreak = truncated.lastIndexOf("\n\n");
  return (lastBreak > CAP * 0.5 ? truncated.slice(0, lastBreak) : truncated).trim();
}

// Order matters where these could otherwise overlap on the same heading —
// see `loadBrandStyle`'s extraction order below, which tries image
// direction and positioning as separate, non-overlapping candidates rather
// than a single ambiguous match. "dirección" alone is deliberately NOT in
// `POSITIONING_HEADING`: a heading like "Dirección de imagen" must resolve
// to image direction, not positioning, so the positioning heading requires
// a more specific phrase ("dirección de marca"/"brand direction") instead
// of the bare word.
const IMAGE_DIRECTION_HEADING = /imagen|image|foto|photo|estilo visual|visual style/i;
const POSITIONING_HEADING = /posicionamiento|positioning|identidad|identity|dirección de marca|brand direction/i;
const LOGO_HEADING = /logo/i;
const STYLE_KEYWORDS_HEADING = /keywords|palabras clave|vibe keywords|tono|tone/i;

/** Longest a single extracted keyword/chip may be — past this it almost certainly isn't a keyword any more but a clause from surrounding prose (a section that documents its keywords as a sentence, not a list). */
const MAX_KEYWORD_LENGTH = 30;

/**
 * Splits a "vibe keywords"/"keywords" section's body into individual
 * chip-sized terms. Two authoring styles are supported: a real list (one
 * per bullet line, or a plain comma-separated line) and free prose that
 * happens to backtick-wrap its actual keywords inline (`` `warm`, `local` ``
 * followed by explanatory sentences) — backticked terms are extracted first
 * when present, since splitting THAT text by comma/newline would otherwise
 * chop the prose into sentence-sized, not word-sized, "keywords". Either
 * way, anything longer than `MAX_KEYWORD_LENGTH` is dropped: a real keyword
 * is a word or short phrase, not a clause.
 */
function splitKeywords(text: string): string[] {
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const candidates =
    backticked.length > 0
      ? backticked
      : text
          .split("\n")
          .map((line) => line.replace(/^[-*]\s*/, "").trim())
          .filter(Boolean)
          .flatMap((line) => line.split(","))
          .map((s) => s.trim());
  const items = candidates.filter((s) => s.length > 0 && s.length <= MAX_KEYWORD_LENGTH);
  return [...new Set(items)];
}

/** Reads `tone.style` / `tone.avoid` from `config.yaml` with the same minimal-regex approach `profile.ts` already uses for `outputs.*` — no YAML dependency for two small list fields. */
function readToneFromConfig(raw: string): { style: string[]; avoid: string[] } {
  const readList = (key: string): string[] => {
    // `<key>:` at some indentation under `tone:`, followed by `- item` lines
    // indented further, same lazy/anchored shape as profile.ts's `outputs.*`
    // extractor.
    const match = raw.match(new RegExp(`^tone:[^\\n]*\\n(?:(?!^\\S)[\\s\\S])*?^\\s+${key}:[ \\t]*\\n((?:^\\s+-\\s*.+\\n?)*)`, "m"));
    if (!match) return [];
    return match[1]!
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  };
  return { style: readList("style"), avoid: readList("avoid") };
}

/**
 * Loads a profile's optional brand-style context. Reads whatever of
 * `brand-spec.md`, `profile.md`, `config.yaml` exist; a profile with none of
 * them (or with none of the recognized headings) gets an all-empty style,
 * never an error — callers should treat that as "no guide yet", not a bug.
 */
export function loadBrandStyle(profileDir: string): BrandStyle {
  const sources: string[] = [];
  const style: BrandStyle = {
    palette: [],
    fonts: {},
    styleKeywords: [],
    tone: { style: [], avoid: [] },
    sources,
  };

  const brandSpec = readFileIfExists(join(profileDir, "brand-spec.md"));
  if (brandSpec !== undefined) {
    let used = false;
    const imageDirection = extractSection(brandSpec, IMAGE_DIRECTION_HEADING);
    if (imageDirection) {
      style.imageDirection = imageDirection;
      used = true;
    }
    const positioning = extractSection(brandSpec, POSITIONING_HEADING);
    if (positioning) {
      style.positioning = positioning;
      used = true;
    }
    const logoRules = extractSection(brandSpec, LOGO_HEADING);
    if (logoRules) {
      style.logoRules = logoRules;
      used = true;
    }
    const keywordsSection = extractSection(brandSpec, STYLE_KEYWORDS_HEADING);
    if (keywordsSection) {
      style.styleKeywords = splitKeywords(keywordsSection);
      used = true;
    }
    if (used) sources.push("brand-spec.md");
  }

  const profileMd = readFileIfExists(join(profileDir, "profile.md"));
  if (profileMd !== undefined) {
    let used = false;
    if (!style.positioning) {
      const positioning = extractSection(profileMd, POSITIONING_HEADING);
      if (positioning) {
        style.positioning = positioning;
        used = true;
      }
    }
    if (!style.imageDirection) {
      const imageDirection = extractSection(profileMd, IMAGE_DIRECTION_HEADING);
      if (imageDirection) {
        style.imageDirection = imageDirection;
        used = true;
      }
    }
    if (used) sources.push("profile.md");
  }

  const configYaml = readFileIfExists(join(profileDir, "config.yaml"));
  if (configYaml !== undefined) {
    const tone = readToneFromConfig(configYaml);
    if (tone.style.length > 0 || tone.avoid.length > 0) {
      style.tone = tone;
      sources.push("config.yaml");
    }
  }

  const brandJsonRaw = readFileIfExists(join(profileDir, "brand.json"));
  if (brandJsonRaw !== undefined) {
    try {
      const brandJson = JSON.parse(brandJsonRaw) as {
        colors?: Record<string, string>;
        roles?: Record<string, string>;
        fonts?: { logo?: string; body?: string; handwritten?: string };
      };
      const colorToRole = new Map<string, string>();
      for (const [role, colorKey] of Object.entries(brandJson.roles ?? {})) {
        colorToRole.set(colorKey, role);
      }
      const palette = Object.entries(brandJson.colors ?? {}).map(([key, hex]) => ({
        key,
        hex,
        role: colorToRole.get(key),
      }));
      if (palette.length > 0) {
        style.palette = palette;
        style.fonts = brandJson.fonts ?? {};
        sources.push("brand.json");
      }
    } catch {
      // brand.json exists but failed to parse — `loadBrand` (brand-schema.ts)
      // is the authority that would surface that error to a render call;
      // this style loader is best-effort context for a prompt, so it just
      // omits the palette rather than throwing.
    }
  }

  return style;
}
