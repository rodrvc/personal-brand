import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";

import { getBrand, getCarousel, getStats, getTemplate } from "../api/client";
import type { BrandTokens, CarouselDocument, LayoutTemplate, StatsResponse } from "../api/types";
import { useDocumentEditor } from "../hooks/useDocumentEditor";
import { Editor } from "../editor/Editor";
import { t } from "../i18n";
import "./EditorRoute.css";

const ACTIVE_SLIDE_STORAGE_PREFIX = "editor-active-slide:";

function readStoredActiveSlide(carouselId: string): number {
  try {
    const raw = localStorage.getItem(ACTIVE_SLIDE_STORAGE_PREFIX + carouselId);
    const n = raw ? Number(raw) : 0;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

interface EditorRouteProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

/** Router state NewCarouselDialog/CarouselListRoute hand off on navigate — see that route's comment. Optional: a direct URL visit or a page reload has none, and the effect below falls back to fetching. */
interface EditorRouteLocationState {
  doc?: CarouselDocument;
}

export function EditorRoute({ theme, onToggleTheme }: EditorRouteProps) {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const location = useLocation();
  const locationState = (location.state as EditorRouteLocationState | null) ?? null;
  // Only honored when it actually matches the carousel this route mounted
  // for — react-router keeps `state` around across an in-place param change,
  // and a stale document from a previous carousel must never be shown here.
  const seededDoc = locationState?.doc && locationState.doc.id === id ? locationState.doc : undefined;

  const [brand, setBrand] = useState<BrandTokens | null>(null);
  const [doc, setDoc] = useState<CarouselDocument | null>(seededDoc ?? null);
  const [template, setTemplate] = useState<LayoutTemplate | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || !id) return;
    let alive = true;
    setError(null);

    // A freshly created carousel arrives with its document already in hand
    // (NewCarouselDialog's create call) — skip the redundant GET and its
    // flash, but still fetch brand/template/stats, which the create
    // response doesn't carry.
    const docPromise = seededDoc ? Promise.resolve(seededDoc) : getCarousel(slug, id);
    if (!seededDoc) setDoc(null);

    Promise.all([getBrand(slug), docPromise])
      .then(async ([brandRes, docRes]) => {
        if (!alive) return;
        setBrand(brandRes);
        setDoc(docRes);
        const [templateRes, statsRes] = await Promise.all([
          getTemplate(slug, docRes.template.id, docRes.template.params),
          getStats(slug, id).catch(() => null),
        ]);
        if (!alive) return;
        setTemplate(templateRes);
        setStats(statsRes);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seededDoc is only meant to apply once, on the navigation that created it; re-running this effect off it would refetch on every re-render.
  }, [slug, id]);

  if (!slug || !id) return null;
  if (error) return <div className="editor-route-error">{error}</div>;
  if (!doc || !brand || !template) return <div className="editor-route-loading">{t("editorRoute.loading")}</div>;

  return (
    <EditorLoaded
      slug={slug}
      brand={brand}
      template={template}
      initialDoc={doc}
      stats={stats}
      initialActiveSlide={readStoredActiveSlide(id)}
      theme={theme}
      onToggleTheme={onToggleTheme}
    />
  );
}

function EditorLoaded({
  slug,
  brand,
  template,
  initialDoc,
  stats,
  initialActiveSlide,
  theme,
  onToggleTheme,
}: {
  slug: string;
  brand: BrandTokens;
  template: LayoutTemplate;
  initialDoc: CarouselDocument;
  stats: StatsResponse | null;
  initialActiveSlide: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const editorState = useDocumentEditor(slug, initialDoc);
  return (
    <Editor
      slug={slug}
      brand={brand}
      template={template}
      editorState={editorState}
      stats={stats}
      initialActiveSlide={initialActiveSlide}
      theme={theme}
      onToggleTheme={onToggleTheme}
    />
  );
}
