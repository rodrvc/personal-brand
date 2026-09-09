import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { listCarousels } from "../api/client";
import type { CarouselSummary } from "../api/types";
import { Button } from "../components/Button";
import { NewCarouselDialog } from "./NewCarouselDialog";
import "./CarouselListRoute.css";

const STATUS_LABEL: Record<CarouselSummary["status"], string> = {
  draft: "Borrador",
  exported: "Exportado",
  published: "Publicado",
};

export function CarouselListRoute() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [carousels, setCarousels] = useState<CarouselSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

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
    <div className="carousel-list">
      <header className="carousel-list-header">
        <div>
          <Link to="/" className="carousel-list-back">
            ← Perfiles
          </Link>
          <h1 className="carousel-list-title">{slug} · Carruseles</h1>
        </div>
        <Button variant="primary" onClick={() => setShowNew(true)}>
          Nuevo carrusel
        </Button>
      </header>

      {error && <p className="carousel-list-error">{error}</p>}
      {!carousels && !error && <p className="carousel-list-hint">Cargando…</p>}
      {carousels && carousels.length === 0 && (
        <p className="carousel-list-hint">Este perfil aún no tiene carruseles.</p>
      )}

      <table className="carousel-table">
        <thead>
          <tr>
            <th>Título</th>
            <th>Estado</th>
            <th>Actualizado</th>
            <th>Láminas</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {carousels?.map((c) => (
            <tr key={c.id}>
              <td>{c.title || c.id}</td>
              <td>
                <span className={`carousel-status ${c.status}`}>{STATUS_LABEL[c.status]}</span>
              </td>
              <td>{new Date(c.updatedAt).toLocaleString()}</td>
              <td>{c.slideCount}</td>
              <td>
                <Link to={`/${slug}/carousels/${c.id}`} className="carousel-open-link">
                  Abrir
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
  );
}
