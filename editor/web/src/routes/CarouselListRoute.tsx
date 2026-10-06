import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { createCarousel, getBrand, listCarousels } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { Button } from "../components/Button";
import { SheetLoader } from "../components/SheetLoader";
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

export function CarouselListRoute() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [carousels, setCarousels] = useState<CarouselSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Best-effort only, for the loader's colour — a profile reaches this
  // route only once the picker already knows it has a brand.json, but a
  // failed fetch here still just falls back to the chrome's own accent
  // rather than breaking the list.
  const [accentColor, setAccentColor] = useState<string | undefined>(undefined);

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
      // EditorRoute's own comment. `creating` deliberately stays true
      // across this navigation (never reset on the success path): the
      // full-area loader below keeps showing right up to the moment this
      // route unmounts, and EditorRoute picks up the exact same-looking
      // loader immediately (its own `immediate` case) — one continuous
      // load, not a flash of the table before the page changes.
      navigate(`/${slug}/carousels/${document.id}`, { state: { doc: document, accentColor } });
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

        {error && <p className="carousel-list-error">{error}</p>}
        {createError && <p className="carousel-list-error">{createError}</p>}

        {showCreateLoader ? (
          <SheetLoader caption={t("carouselList.creatingCaption")} accentColor={accentColor} />
        ) : (
          <>
            {showListLoader && <SheetLoader caption={t("carouselList.loadingCaption")} accentColor={accentColor} />}
            {/* Loaded content waits for the loader's minimum-show tail, so the two never paint together. */}
            {!showListLoader && carousels && carousels.length === 0 && (
              <p className="carousel-list-hint">{t("carouselList.empty")}</p>
            )}
            {!showListLoader && carousels && carousels.length > 0 && (
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
                  {carousels.map((c) => (
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
