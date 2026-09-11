import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { listCarousels } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { Button } from "../components/Button";
import { AssetsPane } from "../editor/panels/AssetsPane";
import { TemplatesPane } from "../editor/panels/TemplatesPane";
import { NewCarouselDialog } from "./NewCarouselDialog";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";
import "./CarouselListRoute.css";
import "../editor/panels/PropertiesPanel.css";

type SidePanelTab = "assets" | "templates";

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
  const [showNew, setShowNew] = useState(false);
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("assets");

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
          <Button variant="primary" onClick={() => setShowNew(true)}>
            {t("carouselList.new")}
          </Button>
        </header>

        {error && <p className="carousel-list-error">{error}</p>}
        {!carousels && !error && <p className="carousel-list-hint">{t("carouselList.loading")}</p>}
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

        {showNew && (
          <NewCarouselDialog
            slug={slug}
            onClose={() => setShowNew(false)}
            onCreated={({ document }) =>
              // Router state carries the just-created (empty) document
              // straight to EditorRoute so it can skip its own
              // fetch-and-flash — see EditorRoute's own comment.
              navigate(`/${slug}/carousels/${document.id}`, { state: { doc: document } })
            }
          />
        )}
      </div>

      {/*
       * ACU-230: assets and templates used to be reachable only from the
       * properties panel of an already-open document — a brand with no
       * carousel yet had no way to see either. This panel exists
       * independently of any open carousel, right on the listing.
       */}
      <aside className="props-panel carousel-list-side-panel">
        <div className="props-tabs" role="tablist">
          <button
            className="props-tab"
            role="tab"
            aria-selected={sidePanelTab === "assets"}
            onClick={() => setSidePanelTab("assets")}
          >
            {t("carouselList.sidePanel.assetsTab")}
          </button>
          <button
            className="props-tab"
            role="tab"
            aria-selected={sidePanelTab === "templates"}
            onClick={() => setSidePanelTab("templates")}
          >
            {t("carouselList.sidePanel.templatesTab")}
          </button>
        </div>
        <div className="props-body">
          {sidePanelTab === "assets" && <AssetsPane slug={slug} />}
          {sidePanelTab === "templates" && <TemplatesPane slug={slug} />}
        </div>
      </aside>
    </div>
  );
}
