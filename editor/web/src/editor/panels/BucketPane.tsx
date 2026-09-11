import { useCallback, useEffect, useState } from "react";

import { assetFileUrl, listAssets, listOutputs, patchAsset, uploadAsset } from "../../api/client";
import type { AssetEntry, AssetKind, CarouselDocument, OutputVersion, StatsResponse } from "../../api/types";
import { addLibraryAssetObject, setBackgroundAsset } from "../mutations";
import { ASSET_KIND_LABEL, groupAssetsByKind, isRenderableImage } from "./asset-grouping";

interface BucketPaneProps {
  slug: string;
  doc: CarouselDocument;
  activeIndex: number;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  stats: StatsResponse | null;
}

function usedAssetIds(doc: CarouselDocument): Set<string> {
  const ids = new Set<string>();
  for (const slide of doc.slides) {
    if (slide.background.mode === "asset") ids.add(slide.background.assetId);
    for (const object of slide.objects) {
      // A `pending: true` asset object may have no `assetId` yet (immediate-build compose flow's placeholder).
      if (object.kind === "asset" && object.assetId) ids.add(object.assetId);
    }
  }
  return ids;
}

export function BucketPane({ slug, doc, activeIndex, onDocUpdate, stats }: BucketPaneProps) {
  const [entries, setEntries] = useState<AssetEntry[] | null>(null);
  const [outputs, setOutputs] = useState<OutputVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const reloadAssets = useCallback(() => {
    listAssets(slug)
      .then((res) => setEntries(res.entries))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [slug]);

  useEffect(() => {
    let alive = true;
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

  useEffect(() => {
    let alive = true;
    listOutputs(slug, doc.id)
      .then((res) => {
        if (alive) setOutputs(res.versions);
      })
      .catch(() => {
        if (alive) setOutputs([]);
      });
    return () => {
      alive = false;
    };
  }, [slug, doc.id]);

  const used = usedAssetIds(doc);

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      try {
        await uploadAsset(slug, file);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    reloadAssets();
  }

  // Two explicit actions per tile rather than a hidden mode: which one
  // fires must never depend on state that lives in another pane
  // (SlidePane's "Biblioteca" background-mode toggle) — that's the bug
  // this replaces (QA #1). "Añadir a la lámina" keeps the previous
  // click behaviour; "Usar de fondo" is the only path that actually sets
  // `slide.background = {mode:"asset", assetId}`.
  function bumpUsage(entry: AssetEntry) {
    // Optimistic usage bump so the border/counter update without waiting for a full reload.
    setEntries((prev) => prev?.map((e) => (e.id === entry.id ? { ...e, usageCount: (e.usageCount ?? 0) + 1 } : e)) ?? prev);
  }

  function handleUseAsBackground(entry: AssetEntry) {
    onDocUpdate((prev) => setBackgroundAsset(prev, prev.slides[activeIndex]!.id, entry.id));
    bumpUsage(entry);
  }

  function handleAddToSlide(entry: AssetEntry) {
    onDocUpdate((prev) => addLibraryAssetObject(prev, prev.slides[activeIndex]!.id, entry.id));
    bumpUsage(entry);
  }

  async function handleReclassify(entry: AssetEntry, kind: AssetKind) {
    try {
      const updated = await patchAsset(slug, entry.id, { kind });
      setEntries((prev) => prev?.map((e) => (e.id === entry.id ? updated : e)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleHide(entry: AssetEntry) {
    try {
      const updated = await patchAsset(slug, entry.id, { status: "hidden" });
      setEntries((prev) => prev?.map((e) => (e.id === entry.id ? updated : e)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const grouped = groupAssetsByKind(entries ?? []);
  const candidates = (entries ?? []).filter((e) => e.status === "candidate");

  return (
    <>
      <div className="bucket-path">
        📦 <b>{slug}/assets/</b>
      </div>

      {stats && (
        <div className="savings-banner">
          <span className="big">{stats.libraryRatio}%</span>
          <span className="tx">
            de este carrusel salió de la biblioteca.
            {stats.history.length > 0 ? ` Hace un tiempo era ${stats.history[0]!.libraryRatio}%.` : " Sin historial previo aún."}
          </span>
        </div>
      )}

      {error && <p style={{ color: "var(--ui-danger)" }}>{error}</p>}

      {Array.from(grouped.entries()).map(([kind, kindEntries]) => (
        <div key={kind} className="props-card">
          <div className="props-card-heading">
            {ASSET_KIND_LABEL[kind]}
            <span style={{ marginLeft: "auto", fontWeight: 500, textTransform: "none", letterSpacing: 0, fontSize: 10.5, color: "var(--ui-ink-3)" }}>
              {kindEntries.length} archivos
            </span>
          </div>
          <div className="asset-grid">
            {kindEntries.map((entry) => {
              const renderable = isRenderableImage(entry);
              const fileName = entry.path.split("/").pop() ?? entry.id;
              return (
                <div
                  key={entry.id}
                  className={`asset-tile ${used.has(entry.id) ? "used" : ""}`}
                  style={
                    renderable
                      ? { backgroundImage: `url(${assetFileUrl(slug, entry.path.replace(/^assets\//, ""))})` }
                      : undefined
                  }
                  title={entry.tags?.join(", ") ?? entry.id}
                  onClick={() => handleAddToSlide(entry)}
                >
                  {!renderable && (
                    <span className="asset-tile-file">
                      <span className="asset-tile-file-glyph">📄</span>
                      {fileName}
                    </span>
                  )}
                  {entry.origin === "ai" && <span className="origin-tag">IA</span>}
                  {used.has(entry.id) && <span className="usage-count">↻{entry.usageCount ?? 1}</span>}
                  <button
                    type="button"
                    className="asset-tile-bg-btn"
                    title="Usar de fondo"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleUseAsBackground(entry);
                    }}
                  >
                    Fondo
                  </button>
                </div>
              );
            })}
          </div>
          <p className="props-hint">Borde verde = ya está en este carrusel. ↻ = veces reutilizado.</p>
        </div>
      ))}

      {candidates.length > 0 && (
        <div className="props-card">
          <div className="props-card-heading">Candidatos generados</div>
          <div className="asset-grid">
            {candidates.map((entry) => (
              <div
                key={entry.id}
                className="asset-tile"
                style={{ backgroundImage: `url(${assetFileUrl(slug, entry.path.replace(/^assets\//, ""))})` }}
              >
                <span className="origin-tag">IA</span>
              </div>
            ))}
          </div>
          <p className="props-hint">Al fijar una pieza, entra a la biblioteca clasificada.</p>
          <div className="props-row">
            <select
              className="ui-input"
              onChange={(e) => {
                const [id, kind] = e.target.value.split("::");
                if (id && kind) void handleReclassify(candidates.find((c) => c.id === id)!, kind as AssetKind);
                e.target.selectedIndex = 0;
              }}
            >
              <option value="">Reclasificar candidato…</option>
              {candidates.flatMap((c) =>
                (Object.keys(ASSET_KIND_LABEL) as AssetKind[])
                  .filter((k) => k !== "unclassified")
                  .map((k) => (
                    <option key={`${c.id}::${k}`} value={`${c.id}::${k}`}>
                      {c.id.slice(0, 8)} → {ASSET_KIND_LABEL[k]}
                    </option>
                  )),
              )}
            </select>
          </div>
        </div>
      )}

      <div className="props-card">
        <div className="props-card-heading">Subir asset</div>
        <label
          className={`upload-dropzone ${dragOver ? "dragover" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleUpload(e.dataTransfer.files);
          }}
        >
          Arrastra un archivo aquí o haz click para subir
          <input type="file" hidden onChange={(e) => void handleUpload(e.target.files)} />
        </label>
      </div>

      <div className="props-card">
        <div className="props-card-heading">outputs/ · versiones exportadas</div>
        <div className="output-list">
          {(outputs ?? []).map((v) => (
            <div key={v.version} className="output-row">
              <span className="output-name">
                <div>
                  {doc.id} · v{v.version}
                </div>
                <div className="output-meta">
                  {v.slideCount ?? "?"} PNG ·{" "}
                  {v.exportedAt ? new Date(v.exportedAt).toLocaleString() : "fecha no disponible"}
                </div>
              </span>
            </div>
          ))}
          {outputs && outputs.length === 0 && <p className="props-hint">Aún no hay exportaciones de este carrusel.</p>}
        </div>
        <p className="props-hint">Cada exportación crea una versión nueva. Nada se sobrescribe.</p>
      </div>
    </>
  );
}
