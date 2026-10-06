import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { getBrand, listCarousels } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { Button } from "../components/Button";
import { SheetLoader } from "../components/SheetLoader";
import { useCreateCarousel } from "../hooks/useCreateCarousel";
import { useDelayedVisible } from "../hooks/useDelayedVisible";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";
import "./CarouselListRoute.css";

/** Carousel status → its LocaleKey. `t()` is called lazily, in `statusLabel()`, never at module load. */
const STATUS_LABEL_KEY: Record<CarouselSummary["status"], LocaleKey> = {
  draft: "carouselList.status.draft",
  exported: "carouselList.status.exported",
  published: "carouselList.status.published",
};

function statusLabel(status: CarouselSummary["status"]): string {
  return t(STATUS_LABEL_KEY[status]);
}

type StatusFilter = "all" | CarouselSummary["status"];

const FILTER_CHIPS: Array<{ value: StatusFilter; label: LocaleKey }> = [
  { value: "all", label: "carouselList.filter.all" },
  { value: "draft", label: "carouselList.filter.draft" },
  { value: "exported", label: "carouselList.filter.exported" },
  { value: "published", label: "carouselList.filter.published" },
];

function isStatusFilter(value: string | null): value is CarouselSummary["status"] {
  return value === "draft" || value === "exported" || value === "published";
}

export function CarouselListRoute() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [carousels, setCarousels] = useState<CarouselSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Best-effort only, for the loader's colour — a profile reaches this
  // route only once the picker already knows it has a brand.json, but a
  // failed fetch here still just falls back to the chrome's own accent
  // rather than breaking the list.
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined);
  const { creating, createError, handleCreate } = useCreateCarousel(slug, accentColor);

  const rawStatus = searchParams.get("status");
  const statusFilter: StatusFilter = isStatusFilter(rawStatus) ? rawStatus : "all";

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    listCarousels(slug)
      .then((res) => {
        if (alive) setCarousels(res.carousels);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    getBrand(slug)
      .then((brand) => {
        if (alive) setAccentColor(brand.colors[brand.roles.accent]);
      })
      .catch(() => {
        // No brand loaded — SheetLoader falls back to the chrome accent.
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  // Passive load (the list itself): shows only past ~300ms, stays at
  // least ~500ms once shown. The create flow shows immediately — the
  // click itself is the request for feedback. Both hooks run before the
  // early return below, so the hook order never changes between renders.
  const showListLoader = useDelayedVisible(!carousels && !error, { minShowMs: 400 });
  const showCreateLoader = useDelayedVisible(creating, { immediate: true });

  if (!slug) return null;

  function setStatusFilter(next: StatusFilter) {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("status");
    else params.set("status", next);
    setSearchParams(params, { replace: true });
  }

  const visibleCarousels = carousels?.filter((c) => statusFilter === "all" || c.status === statusFilter) ?? null;

  return (
    <div className="carousel-list-page">
      <div className="carousel-list">
        <header className="carousel-list-header">
          <div>
            <Link to={`/${slug}`} className="carousel-list-back">
              ← {slug}
            </Link>
            <h1 className="carousel-list-title">{t("carouselList.title", { slug })}</h1>
          </div>
          {/*
           * No inline spinner here while `creating`: the full-area
           * SheetLoader below already shows progress the moment the click
           * happens, and showing both would be the exact "double loader"
           * this replaces.
           */}
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating ? t("carouselList.creating") : t("carouselList.new")}
          </Button>
        </header>

        <div className="carousel-list-filters" role="group" aria-label={t("carouselList.filterLabel")}>
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`carousel-filter-chip${statusFilter === chip.value ? " active" : ""}`}
              onClick={() => setStatusFilter(chip.value)}
            >
              {t(chip.label)}
            </button>
          ))}
        </div>

        {error && <p className="carousel-list-error">{error}</p>}
        {createError && <p className="carousel-list-error">{createError}</p>}

        {showCreateLoader ? (
          <SheetLoader caption={t("carouselList.creatingCaption")} accentColor={accentColor} />
        ) : (
          <>
            {showListLoader && <SheetLoader caption={t("carouselList.loadingCaption")} accentColor={accentColor} />}
            {/* Loaded content waits for the loader's minimum-show tail, so the two never paint together. */}
            {!showListLoader && visibleCarousels && visibleCarousels.length === 0 && (
              <p className="carousel-list-hint">
                {statusFilter === "all" ? t("carouselList.empty") : t("carouselList.emptyFiltered")}
              </p>
            )}
            {!showListLoader && visibleCarousels && visibleCarousels.length > 0 && (
              <table className="carousel-table">
                <thead>
                  <tr>
                    <th>{t("carouselList.columnTitle")}</th>
                    <th>{t("carouselList.columnStatus")}</th>
                    <th>{t("carouselList.columnUpdated")}</th>
                    <th>{t("carouselList.columnSlides")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCarousels.map((c) => (
                    <tr key={c.id}>
                      <td>{c.title || c.id}</td>
                      <td>
                        <span className={`carousel-status ${c.status}`}>{statusLabel(c.status)}</span>
                      </td>
                      <td>{new Date(c.updatedAt).toLocaleString()}</td>
                      <td>{c.slideCount}</td>
                      <td>
                        <Link to={`/${slug}/carousels/${c.id}`} className="carousel-open-link">
                          {t("carouselList.open")}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
