import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { createCarousel, listCarousels } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { Button } from "../components/Button";
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

/** Skeleton rows while `carousels` is still `null` — mirrors the loaded table's five columns so nothing jumps once real rows arrive. `prefers-reduced-motion` silences the shimmer via `tokens.css`'s global rule. */
function SkeletonRow({ index }: { index: number }) {
  return (
    <tr className="carousel-row-skeleton" aria-hidden="true">
      <td>
        <div
          className="carousel-skeleton-bar carousel-skeleton-shimmer"
          style={{ width: "70%", animationDelay: `${index * 60}ms` }}
        />
      </td>
      <td>
        <div
          className="carousel-skeleton-bar carousel-skeleton-shimmer carousel-skeleton-pill"
          style={{ animationDelay: `${index * 60}ms` }}
        />
      </td>
      <td>
        <div
          className="carousel-skeleton-bar carousel-skeleton-shimmer"
          style={{ width: "55%", animationDelay: `${index * 60}ms` }}
        />
      </td>
      <td>
        <div
          className="carousel-skeleton-bar carousel-skeleton-shimmer"
          style={{ width: "30%", animationDelay: `${index * 60}ms` }}
        />
      </td>
      <td>
        <div
          className="carousel-skeleton-bar carousel-skeleton-shimmer"
          style={{ width: "40%", animationDelay: `${index * 60}ms` }}
        />
      </td>
    </tr>
  );
}

export function CarouselListRoute() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [carousels, setCarousels] = useState<CarouselSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
    return () => {
      alive = false;
    };
  }, [slug]);

  if (!slug) return null;

  // Creates the carousel directly with its defaults (a placeholder title,
  // since the server requires one, and the engine default template) and
  // navigates straight into the editor — the "Nuevo carrusel" modal this
  // replaced (title/brand/template fields) asked for nothing the owner
  // actually wanted to fill in up front: brand was always fixed to this
  // profile, and the template can be picked, changed or dropped from the
  // editor's own Templates tab.
  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      const { document } = await createCarousel(slug!, { title: t("carouselList.untitled") });
      // Router state carries the just-created (empty) document straight
      // to EditorRoute so it can skip its own fetch-and-flash — see
      // EditorRoute's own comment.
      navigate(`/${slug}/carousels/${document.id}`, { state: { doc: document } });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  return (
    <div className="carousel-list-page">
      <div className="carousel-list">
        <header className="carousel-list-header">
          <div>
            <Link to="/" className="carousel-list-back">
              {t("carouselList.back")}
            </Link>
            <h1 className="carousel-list-title">{t("carouselList.title", { slug })}</h1>
          </div>
          <Button variant="primary" onClick={handleCreate} disabled={creating}>
            {creating && <span className="carousel-create-spinner" aria-hidden="true" />}
            {creating ? t("carouselList.creating") : t("carouselList.new")}
          </Button>
        </header>

        {error && <p className="carousel-list-error">{error}</p>}
        {createError && <p className="carousel-list-error">{createError}</p>}
        {carousels && carousels.length === 0 && (
          <p className="carousel-list-hint">{t("carouselList.empty")}</p>
        )}

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
            {!carousels && !error && Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} index={i} />)}
            {carousels?.map((c) => (
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
      </div>
    </div>
  );
}
