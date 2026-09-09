import { useEffect, useState } from "react";

import { assetFileUrl, listAssets } from "../../api/client";
import type { AssetEntry } from "../../api/types";
import { ASSET_KIND_LABEL, groupAssetsByKind } from "./asset-grouping";
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
    return <p className="props-hint">Cargando assets de {slug}…</p>;
  }

  const grouped = groupAssetsByKind(entries);

  if (grouped.size === 0) {
    return (
      <div className="props-card">
        <div className="props-card-heading">Assets</div>
        <p className="props-hint">
          La marca <b>{slug}</b> todavía no tiene assets en su biblioteca.
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
            {ASSET_KIND_LABEL[kind]}
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
              {kindEntries.length} archivos
            </span>
          </div>
          <div className="asset-grid">
            {kindEntries.map((entry) => (
              <div
                key={entry.id}
                className="asset-tile"
                style={{ backgroundImage: `url(${assetFileUrl(slug, entry.path.replace(/^assets\//, ""))})` }}
                title={entry.tags?.join(", ") ?? entry.id}
              >
                {entry.origin === "ai" && <span className="origin-tag">IA</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
