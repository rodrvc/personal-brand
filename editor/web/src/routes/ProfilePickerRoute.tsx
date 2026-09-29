import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listProfiles } from "../api/client";
import type { ProfileListingEntry } from "../api/types";
import { SheetLoader } from "../components/SheetLoader";
import { useBrandFonts } from "../hooks/useBrandFonts";
import { useDelayedVisible } from "../hooks/useDelayedVisible";
import { t } from "../i18n";
import { relativeTime } from "../utils/relativeTime";
import "./ProfilePickerRoute.css";

function BrandCardCover({ profile }: { profile: ProfileListingEntry }) {
  const card = profile.card;
  const background = card?.gradient ?? (card?.colors && card.colors.length > 0 ? `linear-gradient(135deg, ${card.colors.slice(0, 2).join(", ")})` : undefined);

  return (
    <div className="brand-card-cover" style={!card?.coverImageUrl && background ? { background } : undefined}>
      {card?.coverImageUrl && <img className="brand-card-cover-img" src={card.coverImageUrl} alt="" loading="lazy" />}
      {card?.logoAssetUrl && <img className="brand-card-logo" src={card.logoAssetUrl} alt="" loading="lazy" />}
    </div>
  );
}

function BrandCard({ profile }: { profile: ProfileListingEntry }) {
  const card = profile.card;
  const wordmark = card?.wordmark || profile.slug;

  return (
    <Link key={profile.slug} to={`/${profile.slug}`} className="brand-card">
      <BrandCardCover profile={profile} />
      <div className="brand-card-body">
        <span className="brand-card-wordmark" style={card?.logoFont ? { fontFamily: card.logoFont } : undefined}>
          {wordmark}
        </span>
        {card && card.colors.length > 0 && (
          <div className="brand-card-swatches">
            {card.colors.map((hex) => (
              <span key={hex} className="brand-card-swatch" style={{ background: hex }} title={hex} />
            ))}
          </div>
        )}
        <div className="brand-card-meta">
          <span>{(card?.carouselCount ?? 0) === 1 ? t("profilePicker.oneCarousel") : t("profilePicker.carousels", { count: card?.carouselCount ?? 0 })}</span>
          {card?.lastEditedAt && <span>{relativeTime(card.lastEditedAt)}</span>}
        </div>
      </div>
    </Link>
  );
}

/**
 * No cover area at all: a profile with no `brand.json` has no cover image,
 * no palette, nothing to show — stretching it to the same height as a real
 * brand card would just be a bigger empty box. `.brand-card-grid`'s
 * `align-items: start` keeps the grid's columns aligned while letting this
 * card be exactly as tall as its own two lines of text.
 */
function DisabledBrandCard({ profile }: { profile: ProfileListingEntry }) {
  return (
    <span
      key={profile.slug}
      className="brand-card brand-card-disabled brand-card-compact"
      title={t("profilePicker.noBrandTitle")}
    >
      <div className="brand-card-body">
        <span className="brand-card-wordmark">{profile.slug}</span>
        <span className="brand-card-hint">{t("profilePicker.noBrandHint")}</span>
      </div>
    </span>
  );
}

export function ProfilePickerRoute() {
  const [profiles, setProfiles] = useState<ProfileListingEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const fontHrefs = Array.from(
    new Set((profiles ?? []).map((p) => p.card?.googleFontsHref).filter((href): href is string => Boolean(href))),
  );
  useBrandFonts(fontHrefs);

  // Passive load: no brand in context yet at all, so the loader uses the
  // chrome's own colours (no `accentColor`) — only once a profile's own
  // card has loaded does anything on this route know a brand's palette.
  const showLoader = useDelayedVisible(!profiles && !error);

  return (
    <div className="picker">
      <header className="picker-header ui-reveal">
        <p className="ui-kicker">{t("profilePicker.kicker")}</p>
        <h1 className="ui-display-title picker-title">
          {t("profilePicker.title")} <em>{t("profilePicker.titleAccent")}</em>
        </h1>
      </header>
      {error && <p className="picker-error">{error}</p>}
      {showLoader && <SheetLoader caption={t("profilePicker.loading")} />}
      {/* Loaded content waits for the loader's minimum-show tail, so the two never paint together. */}
      {!showLoader && profiles && profiles.length === 0 && (
        <p className="picker-hint">{t("profilePicker.empty")}</p>
      )}
      {!showLoader && profiles && profiles.length > 0 && (
        <div className="brand-card-grid ui-reveal">
          {profiles.map((profile) =>
            profile.hasBrand ? (
              <BrandCard key={profile.slug} profile={profile} />
            ) : (
              <DisabledBrandCard key={profile.slug} profile={profile} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
