import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listProfiles } from "../api/client";
import type { ProfileListingEntry } from "../api/types";
import { t } from "../i18n";
import "./ProfilePickerRoute.css";

/** Relative "hace X" label for `lastEditedAt`, coarse enough to not need a library; the copy lives in the locale resource (`time.*`). */
function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return t("time.justNow");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("time.days", { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? t("time.oneMonth") : t("time.months", { count: months });
  const years = Math.round(months / 12);
  return years === 1 ? t("time.oneYear") : t("time.years", { count: years });
}

/**
 * Loads every unique `googleFontsHref` present in the current listing as a
 * `<link>` in `<head>`, once each, so a card's wordmark can render in the
 * brand's actual logo font. Scoped in effect, not just in name: nothing but
 * `.brand-card-wordmark` (via inline `fontFamily`) ever references those
 * font families, so the chrome's own `--ui-display`/`--ui-font` never pick
 * them up even though the stylesheet itself loads globally — a `<link>` has
 * no shadow-DOM equivalent to actually scope to.
 */
function useBrandFonts(hrefs: string[]): void {
  useEffect(() => {
    const added: HTMLLinkElement[] = [];
    for (const href of hrefs) {
      if (document.querySelector(`link[data-brand-font="${href}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.brandFont = href;
      document.head.appendChild(link);
      added.push(link);
    }
    return () => {
      for (const link of added) link.remove();
    };
  }, [hrefs.join("|")]);
}

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
    <Link key={profile.slug} to={`/${profile.slug}/carousels`} className="brand-card">
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

function DisabledBrandCard({ profile }: { profile: ProfileListingEntry }) {
  return (
    <span key={profile.slug} className="brand-card brand-card-disabled" title={t("profilePicker.noBrandTitle")}>
      <div className="brand-card-cover brand-card-cover-empty" />
      <div className="brand-card-body">
        <span className="brand-card-wordmark">{profile.slug}</span>
        <span className="brand-card-hint">{t("profilePicker.noBrandHint")}</span>
      </div>
    </span>
  );
}

function SkeletonCard({ index }: { index: number }) {
  return (
    <div className="brand-card brand-card-skeleton" aria-hidden="true" style={{ animationDelay: `${index * 60}ms` }}>
      <div className="brand-card-cover brand-card-skeleton-shimmer" />
      <div className="brand-card-body">
        <div className="brand-card-skeleton-line brand-card-skeleton-shimmer" style={{ width: "60%" }} />
        <div className="brand-card-skeleton-line brand-card-skeleton-shimmer" style={{ width: "40%", height: 8 }} />
      </div>
    </div>
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

  return (
    <div className="picker">
      <h1 className="picker-title">{t("profilePicker.title")}</h1>
      {error && <p className="picker-error">{error}</p>}
      {profiles && profiles.length === 0 && (
        <p className="picker-hint">{t("profilePicker.empty")}</p>
      )}
      <div className="brand-card-grid">
        {!profiles && !error && Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} index={i} />)}
        {profiles?.map((profile) =>
          profile.hasBrand ? (
            <BrandCard key={profile.slug} profile={profile} />
          ) : (
            <DisabledBrandCard key={profile.slug} profile={profile} />
          ),
        )}
      </div>
    </div>
  );
}
