import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getBrand, getProfileCard, listCarousels } from "../api/client";
import type { CarouselSummary, ProfileCardSummary } from "../api/types";
import { Button } from "../components/Button";
import { CarouselCoverCard } from "../components/CarouselCoverCard";
import { SheetLoader } from "../components/SheetLoader";
import { useBrandFonts } from "../hooks/useBrandFonts";
import { useCreateCarousel } from "../hooks/useCreateCarousel";
import { useDelayedVisible } from "../hooks/useDelayedVisible";
import { t } from "../i18n";
import "./BrandHomeRoute.css";

const RECENT_DRAFTS_COUNT = 5;
const RECENT_NON_DRAFTS_COUNT = 4;

interface StatusCounts {
  draft: number;
  exported: number;
  published: number;
}

function countByStatus(carousels: CarouselSummary[]): StatusCounts {
  const counts: StatusCounts = { draft: 0, exported: 0, published: 0 };
  for (const c of carousels) counts[c.status] += 1;
  return counts;
}

/**
 * A brand's home: what used to be the first thing a profile showed (the
 * full carousel table) is now one click away behind "Ver todos los
 * carruseles" — this route is the dashboard the owner actually wants to
 * land on: create, a status summary, and the carousels actually being
 * worked on right now.
 *
 * All three fetches (`card`, `brand` for the accent, `carousels` for the
 * counts and recent lists) run in parallel; `carousels` already comes back
 * newest-updated-first (`document-store.ts`'s `listCarousels`), so the
 * "recent" sections are plain filters over that same array — no separate
 * endpoint or re-sort needed.
 */
export function BrandHomeRoute() {
  const { slug } = useParams<{ slug: string }>();
  const [card, setCard] = useState<ProfileCardSummary | undefined>(undefined);
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined);
  const [carousels, setCarousels] = useState<CarouselSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { creating, createError, handleCreate } = useCreateCarousel(slug, accentColor);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    getProfileCard(slug)
      .then((res) => {
        if (alive) setCard(res.card);
      })
      .catch(() => {
        // No card — the header falls back to the raw slug, same as the picker's disabled card.
      });
    getBrand(slug)
      .then((brand) => {
        if (alive) setAccentColor(brand.colors[brand.roles.accent]);
      })
      .catch(() => {
        // No brand loaded — SheetLoader/cover placeholders fall back to the chrome accent.
      });
    listCarousels(slug)
      .then((res) => {
        if (alive) setCarousels(res.carousels);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  useBrandFonts(card?.googleFontsHref ? [card.googleFontsHref] : []);

  // Every hook runs before the early return below, so the hook order never
  // changes between renders.
  const showListLoader = useDelayedVisible(!carousels && !error, { minShowMs: 400 });
  const showCreateLoader = useDelayedVisible(creating, { immediate: true });

  if (!slug) return null;

  // Loaded content waits for the loader's minimum-show tail, so the two never paint together.
  const shownCarousels = showListLoader ? null : carousels;
  const counts = shownCarousels ? countByStatus(shownCarousels) : null;
  const recentDrafts = carousels?.filter((c) => c.status === "draft").slice(0, RECENT_DRAFTS_COUNT) ?? [];
  const recentNonDrafts = carousels?.filter((c) => c.status !== "draft").slice(0, RECENT_NON_DRAFTS_COUNT) ?? [];
  const wordmark = card?.wordmark || slug;

  return (
    <div className="brand-home-page">
      <div className="brand-home">
        <header className="brand-home-header">
          <div>
            <Link to="/" className="brand-home-back">
              {t("brandHome.back")}
            </Link>
            <p className="ui-kicker">{t("brandHome.kicker")}</p>
            <h1 className="brand-home-wordmark" style={card?.logoFont ? { fontFamily: card.logoFont } : undefined}>
              {wordmark}
            </h1>
          </div>
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating ? t("carouselList.creating") : t("carouselList.new")}
          </Button>
        </header>

        {error && <p className="brand-home-error">{error}</p>}
        {createError && <p className="brand-home-error">{createError}</p>}

        {showCreateLoader ? (
          <SheetLoader caption={t("carouselList.creatingCaption")} accentColor={accentColor} />
        ) : (
          <>
            {showListLoader && <SheetLoader caption={t("brandHome.loadingCaption")} accentColor={accentColor} />}

            {counts && (
              <div className="brand-home-summary ui-reveal">
                <Link to={`/${slug}/carousels?status=draft`} className="brand-home-figure">
                  <span className="brand-home-figure-value">{counts.draft}</span>
                  <span className="brand-home-figure-label">{t("carouselList.filter.draft")}</span>
                </Link>
                <Link to={`/${slug}/carousels?status=exported`} className="brand-home-figure">
                  <span className="brand-home-figure-value">{counts.exported}</span>
                  <span className="brand-home-figure-label">{t("carouselList.filter.exported")}</span>
                </Link>
                <Link to={`/${slug}/carousels?status=published`} className="brand-home-figure">
                  <span className="brand-home-figure-value">{counts.published}</span>
                  <span className="brand-home-figure-label">{t("carouselList.filter.published")}</span>
                </Link>
              </div>
            )}

            {shownCarousels && (
              <section className="brand-home-section">
                <h2 className="brand-home-section-title">{t("brandHome.continueEditing")}</h2>
                {recentDrafts.length === 0 ? (
                  <p className="brand-home-hint">{t("brandHome.noDrafts")}</p>
                ) : (
                  <div className="brand-home-draft-grid ui-reveal">
                    {recentDrafts.map((c) => (
                      <CarouselCoverCard key={c.id} slug={slug} carousel={c} accentColor={accentColor} size="large" />
                    ))}
                  </div>
                )}
              </section>
            )}

            {shownCarousels && (
              <section className="brand-home-section">
                <h2 className="brand-home-section-title">{t("brandHome.recentTitle")}</h2>
                {recentNonDrafts.length === 0 ? (
                  <p className="brand-home-hint">{t("brandHome.noRecent")}</p>
                ) : (
                  <div className="brand-home-recent-row">
                    {recentNonDrafts.map((c) => (
                      <CarouselCoverCard key={c.id} slug={slug} carousel={c} accentColor={accentColor} size="small" />
                    ))}
                  </div>
                )}
              </section>
            )}

            {shownCarousels && (
              <Link to={`/${slug}/carousels`} className="brand-home-all-link">
                {t("brandHome.allCarousels")}
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}
