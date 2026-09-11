import { useEffect, useState } from "react";

import { assetFileUrl, listAssets } from "../../api/client";
import type { AssetEntry } from "../../api/types";
import { assetKindLabel, groupAssetsByKind, isRenderableImage } from "./asset-grouping";
import { t } from "../../i18n";
import "./PropertiesPanel.css";

interface AssetsPaneProps {
  slug: string;
}

/**
 * ACU-230: before this, a brand's assets were only reachable from the
 * properties panel of an already-open document (`BucketPane`, inside
 * `PropertiesPanel`). This is the same listing, grouped the same way
 * (`groupAssetsByKind`, shared with `BucketPane` rather than duplicated),
 * shown read-only on `CarouselListRoute`'s side panel — so a brand's asset
 * library is visible before anyone opens a carousel. Most real assets land
 * as `kind: "unclassified"` before a human sorts them; `groupAssetsByKind`
 * keeps that group instead of filtering it out, and so does this pane.
 */
export function AssetsPane({ slug }: AssetsPaneProps) {
  const [entries, setEntries] = useState<AssetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    listAssets(slug)
      .then((res) => {
        if (alive) setEntries(res.entries);
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
  if (!entries) {
    return <p className="props-hint">{t("assetsPane.loading", { slug })}</p>;
  }

  const grouped = groupAssetsByKind(entries);

  if (grouped.size === 0) {
    return (
      <div className="props-card">
        <div className="props-card-heading">{t("assetsPane.heading")}</div>
        <p className="props-hint">
          {t("assetsPane.emptyPrefix")} <b>{slug}</b> {t("assetsPane.emptySuffix")}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="bucket-path">
        📦 <b>{slug}/assets/</b>
      </div>
      {Array.from(grouped.entries()).map(([kind, kindEntries]) => (
        <div key={kind} className="props-card">
          <div className="props-card-heading">
            {assetKindLabel(kind)}
            <span
              style={{
                marginLeft: "auto",
                fontWeight: 500,
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 10.5,
                color: "var(--ui-ink-3)",
              }}
            >
              {t("common.filesCount", { count: kindEntries.length })}
            </span>
          </div>
          <div className="asset-grid">
            {kindEntries.map((entry) => {
              const renderable = isRenderableImage(entry);
              const fileName = entry.path.split("/").pop() ?? entry.id;
              return (
                <div
                  key={entry.id}
                  className="asset-tile"
                  style={
                    renderable
                      ? { backgroundImage: `url(${assetFileUrl(slug, entry.path.replace(/^assets\//, ""))})` }
                      : undefined
                  }
                  title={entry.tags?.join(", ") ?? entry.id}
                >
                  {!renderable && (
                    <span className="asset-tile-file">
                      <span className="asset-tile-file-glyph">📄</span>
                      {fileName}
                    </span>
                  )}
                  {entry.origin === "ai" && <span className="origin-tag">{t("common.originAi")}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
