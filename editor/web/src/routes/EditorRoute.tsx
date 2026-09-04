import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { getBrand, getCarousel, getStats, getTemplate } from "../api/client";
import type { BrandTokens, CarouselDocument, LayoutTemplate, StatsResponse } from "../api/types";
import { useDocumentEditor } from "../hooks/useDocumentEditor";
import { Editor } from "../editor/Editor";
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

export function EditorRoute() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const [brand, setBrand] = useState<BrandTokens | null>(null);
  const [doc, setDoc] = useState<CarouselDocument | null>(null);
  const [template, setTemplate] = useState<LayoutTemplate | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug || !id) return;
    let alive = true;
    setError(null);
    setDoc(null);
    Promise.all([getBrand(slug), getCarousel(slug, id)])
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
  }, [slug, id]);

  if (!slug || !id) return null;
  if (error) return <div className="editor-route-error">{error}</div>;
  if (!doc || !brand || !template) return <div className="editor-route-loading">Cargando carrusel…</div>;

  return (
    <EditorLoaded
      slug={slug}
      brand={brand}
      template={template}
      initialDoc={doc}
      stats={stats}
      initialActiveSlide={readStoredActiveSlide(id)}
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
}: {
  slug: string;
  brand: BrandTokens;
  template: LayoutTemplate;
  initialDoc: CarouselDocument;
  stats: StatsResponse | null;
  initialActiveSlide: number;
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
    />
  );
}
