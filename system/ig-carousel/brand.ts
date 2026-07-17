/**
 * Adondepo brand tokens, verified against production frontend globals.css.
 * Centralized here so every template variant references the same source of
 * truth instead of hardcoding color/font literals inline.
 */
export const BRAND = {
  colors: {
    petrol: "#1a5f7a",
    terracotta: "#e05a47",
    gold: "#f5b742",
    coral: "#ff7a6b",
    textDark: "#2d3436",
    textSecondary: "#6b7280",
    backgroundLight: "#f8f6f3",
  },
  fonts: {
    // "Pacifico" is reserved for the literal Adondepo wordmark only —
    // never used for event copy (title/subtitle/meta).
    logo: "'Pacifico', cursive",
    body: "'Inter', sans-serif",
    // "Kalam" (Bold 700 available) is the hand-drawn/marker face used for
    // the section header wordmark+title and each event's title in the
    // "magazine-card" list-format variant — a thicker, more legible script
    // than Pacifico, matching the reference mockup's marker-style lettering.
    handwritten: "'Kalam', cursive",
  },
  radius: {
    card: "12px",
  },
  gradients: {
    goldCoral: "linear-gradient(135deg, #f5b742, #ff7a6b)",
  },
} as const;

/** Google Fonts import shared by every template's <head>. */
export const GOOGLE_FONTS_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Pacifico&family=Kalam:wght@400;700&display=swap" rel="stylesheet">';

/**
 * Category badge colors for the "list-format" variant. `solid` drives the
 * outline pill's border/text color (used uniformly across all categories);
 * `gradient` is an optional flourish some categories (e.g. Destacados) can
 * layer on top instead of a flat solid. `fallback` covers any category not
 * explicitly listed here (unknown strings, or slides with no category).
 */
export const CATEGORY_COLORS = {
  "Música": { solid: "#d93647" },
  "Deporte": { solid: "#0077cc" },
  "Cultura": { solid: "#7b3a9e" },
  "Familiar": { solid: "#008f5b" },
  "Fiesta": { solid: "#e01b1b" },
  "Destacados": {
    solid: "#d4840a",
    gradient: "linear-gradient(135deg, #e69500, #d4840a)",
  },
  fallback: { solid: "#555555" },
} as const;
