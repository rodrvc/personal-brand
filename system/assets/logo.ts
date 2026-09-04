import { pickLogoVariant } from "@personal-brand/core/color";

import type { AssetEntry, AssetIndexFile } from "./index.js";

/** Result of picking a logo variant: `exact: true` means an entry carried
 * the wanted `ink:*` tag; `exact: false` means no entry did and the caller
 * is getting an unverified fallback (any logo, picked arbitrarily) — the UI
 * should show "variant not verified" rather than presenting it as correct. */
export interface PickedLogo {
  entry: AssetEntry;
  exact: boolean;
}

/**
 * Picks which logo asset a template should stamp on a given background.
 *
 * The logo is a library asset (`kind: "logo"`), never a `brand.json` token —
 * see `system/config/assets.schema.md` and design decision D8. Variants are
 * distinguished by the `ink:dark` / `ink:light` tag (named for the logo's
 * own ink color, matching the naming convention `core/color.js` already
 * uses for `pickLogoVariant`'s `variant` field).
 *
 * Returns `undefined` when the library has no `kind: "logo"` entry at all,
 * so the caller can fall back to `brand.copy.wordmark` — exactly like the
 * reel engine does today when there's no logo asset to stamp.
 */
export function pickLogo(index: AssetIndexFile, backgroundHex: string): PickedLogo | undefined {
  const logos = index.entries.filter(
    (entry) => entry.kind === "logo" && entry.status !== "hidden",
  );
  if (logos.length === 0) return undefined;

  const { variant } = pickLogoVariant(backgroundHex);
  const wantedTag = variant === "dark" ? "ink:dark" : "ink:light";

  const tagged = logos.find((entry) => entry.tags.includes(wantedTag));
  if (tagged) return { entry: tagged, exact: true };

  // No entry carries the wanted ink tag: prefer any logo over none, so a
  // profile with a single untagged logo asset still gets it stamped rather
  // than silently falling back to the wordmark — but flag it as unverified
  // so the caller can surface that instead of presenting it as correct.
  return { entry: logos[0]!, exact: false };
}
