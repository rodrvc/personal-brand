import { useState } from "react";
import { Link } from "react-router-dom";

import { slidePngUrl } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";
import { relativeTime } from "../utils/relativeTime";
import "./CarouselCoverCard.css";

export interface CarouselCoverCardProps {
  slug: string;
  carousel: CarouselSummary;
  /** Tints the placeholder shown before the thumbnail loads — the brand home dashboard's own accent, same source `SheetLoader` uses. */
  accentColor?: string;
  /** `"small"` for the "Últimos exportados/publicados" row — same card, smaller cover. */
  size?: "large" | "small";
}

/** Same status labels as the carousel list; `t()` runs at render time, never at module load. */
const STATUS_LABEL_KEY: Record<CarouselSummary["status"], LocaleKey> = {
  draft: "carouselList.status.draft",
  exported: "carouselList.status.exported",
  published: "carouselList.status.published",
};

/**
 * A carousel's cover card for the brand home dashboard ("Seguir editando"
 * and "Últimos exportados/publicados"): a 4:5 first-slide thumbnail, title
 * (falling back to a friendlier label than the raw id when no title was
 * ever set), slide count, and relative "hace …". Clicking opens the
 * editor.
 *
 * The thumbnail's placeholder is a quiet tint of `accentColor` (via
 * `color-mix`, same approach `SheetLoader` uses) rather than a skeleton
 * shimmer — the owner dislikes skeletons — that only fades out once the
 * `<img>` itself has actually painted (`onLoad`), so a slow/cold PNG
 * render never shows a blank box. A thumbnail that fails to load drops the
 * `<img>` and keeps that same static tint, rather than a broken-image icon
 * or a placeholder that waits forever.
 */
export function CarouselCoverCard({ slug, carousel, accentColor, size = "large" }: CarouselCoverCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const hasTitle = carousel.title.trim().length > 0 && carousel.title !== carousel.id;
  const label = hasTitle ? carousel.title : t("coverCard.untitled", { time: relativeTime(carousel.updatedAt) });
  const style = accentColor ? ({ "--cover-card-accent": accentColor } as React.CSSProperties) : undefined;

  return (
    <Link
      to={`/${slug}/carousels/${carousel.id}`}
      className={`cover-card cover-card-${size}`}
      style={style}
    >
      <div className={`cover-card-thumb${loaded ? " loaded" : ""}`}>
        {!failed && (
          <img
            className="cover-card-thumb-img"
            src={slidePngUrl(slug, carousel.id, 0)}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <div className="cover-card-body">
        <span className="cover-card-title">{label}</span>
        {/*
         * Status chip stays fixed-width; the count/date run is the one
         * flexible piece and truncates with an ellipsis instead of
         * wrapping — a fixed-width small card (132px) has no room for two
         * lines of meta without the chip and text breaking mid-word.
         */}
        <div className="cover-card-meta">
          <span className={`cover-card-status ${carousel.status}`}>{t(STATUS_LABEL_KEY[carousel.status])}</span>
          <span className="cover-card-meta-text">
            {carousel.slideCount === 1 ? t("coverCard.oneSlide") : t("coverCard.slides", { count: carousel.slideCount })}
            {hasTitle ? ` · ${relativeTime(carousel.updatedAt)}` : ""}
          </span>
        </div>
      </div>
    </Link>
  );
}
