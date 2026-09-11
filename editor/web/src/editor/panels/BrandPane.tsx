import { useEffect, useState } from "react";

import { getBrandStyle } from "../../api/client";
import type { BrandStyle } from "../../api/types";
import { t } from "../../i18n";

interface BrandPaneProps {
  slug: string;
}

const SOURCE_LABEL: Record<string, string> = {
  "brand-spec.md": "brand-spec.md",
  "profile.md": "profile.md",
  "config.yaml": "config.yaml",
  "brand.json": "brand.json",
};

/**
 * Read-only "Marca" tab (piece-generation spec's "Brand style context in
 * every generation", editor-ui's "Marca" tab requirement): shows the same
 * brand-style guide the server folds into every AI prompt, so the person
 * editing a carousel can see *why* the AI drafted what it drafted — and
 * where to change it if it's wrong. Nothing here is editable: the hint at
 * the bottom always points back to the profile's own files, since the
 * editor only consumes the brand, per this repo's engine/business
 * separation (CLAUDE.md's "Motor vs negocio").
 */
export function BrandPane({ slug }: BrandPaneProps) {
  const [style, setStyle] = useState<BrandStyle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStyle(null);
    setError(null);
    getBrandStyle(slug)
      .then((res) => {
        if (alive) setStyle(res);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  if (error) {
    return <p style={{ color: "var(--ui-danger)" }}>{error}</p>;
  }
  if (!style) {
    return <p className="props-hint">{t("brandPane.loading")}</p>;
  }

  const hasNothing =
    style.palette.length === 0 &&
    style.styleKeywords.length === 0 &&
    style.tone.style.length === 0 &&
    style.tone.avoid.length === 0 &&
    !style.positioning &&
    !style.imageDirection &&
    !style.logoRules;

  if (hasNothing) {
    return (
      <div className="props-card">
        <div className="props-card-heading">{t("brandPane.emptyHeading")}</div>
        <p className="props-hint">{t("brandPane.emptyHint")}</p>
        <p className="props-note">
          {t("brandPane.emptyNotePrefix")} <code>brand-spec.md</code>, <code>profile.md</code>{" "}
          {t("brandPane.emptyNoteMiddle")} <code>config.yaml</code> {t("brandPane.emptyNoteSuffix")}
        </p>
      </div>
    );
  }

  return (
    <>
      {style.palette.length > 0 && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.paletteHeading")}</div>
          <div className="color-swatches">
            {style.palette.map((entry) => (
              <div key={entry.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div
                  className="color-swatch"
                  style={{ background: entry.hex, cursor: "default" }}
                  title={entry.hex}
                />
                <span style={{ fontSize: 10, color: "var(--ui-ink-3)", textAlign: "center" }}>
                  {entry.key}
                  {entry.role ? ` · ${entry.role}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(style.fonts.logo || style.fonts.body || style.fonts.handwritten) && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.typographyHeading")}</div>
          {style.fonts.logo && (
            <p style={{ fontFamily: style.fonts.logo, fontSize: 18, margin: "4px 0" }}>
              {style.fonts.logo.split(",")[0]}
            </p>
          )}
          {style.fonts.body && (
            <p style={{ fontFamily: style.fonts.body, fontSize: 14, margin: "4px 0" }}>{style.fonts.body.split(",")[0]}</p>
          )}
          {style.fonts.handwritten && (
            <p style={{ fontFamily: style.fonts.handwritten, fontSize: 14, margin: "4px 0" }}>
              {style.fonts.handwritten.split(",")[0]}
            </p>
          )}
        </div>
      )}

      {style.styleKeywords.length > 0 && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.styleKeywordsHeading")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {style.styleKeywords.map((kw) => (
              <span
                key={kw}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: "var(--ui-surface-2, var(--ui-surface))",
                  border: "1px solid var(--ui-line)",
                }}
              >
                {kw}
              </span>
            ))}
          </div>
        </div>
      )}

      {(style.tone.style.length > 0 || style.tone.avoid.length > 0) && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.toneHeading")}</div>
          {style.tone.style.length > 0 && (
            <p className="props-hint">
              <b>{t("brandPane.toneStyleLabel")}</b> {style.tone.style.join(", ")}
            </p>
          )}
          {style.tone.avoid.length > 0 && (
            <p className="props-hint">
              <b>{t("brandPane.toneAvoidLabel")}</b> {style.tone.avoid.join(", ")}
            </p>
          )}
        </div>
      )}

      {style.positioning && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.positioningHeading")}</div>
          <p className="props-hint" style={{ whiteSpace: "pre-wrap" }}>
            {style.positioning}
          </p>
        </div>
      )}

      {style.imageDirection && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.imageDirectionHeading")}</div>
          <p className="props-hint" style={{ whiteSpace: "pre-wrap" }}>
            {style.imageDirection}
          </p>
        </div>
      )}

      {style.logoRules && (
        <div className="props-card">
          <div className="props-card-heading">{t("brandPane.logoRulesHeading")}</div>
          <p className="props-hint" style={{ whiteSpace: "pre-wrap" }}>
            {style.logoRules}
          </p>
        </div>
      )}

      <div className="props-card">
        <div className="props-card-heading">{t("brandPane.sourcesHeading")}</div>
        <p className="props-hint">
          {style.sources.length > 0
            ? style.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")
            : t("brandPane.sourcesEmpty")}
        </p>
        <p className="props-note">{t("brandPane.sourcesNote")}</p>
      </div>
    </>
  );
}
