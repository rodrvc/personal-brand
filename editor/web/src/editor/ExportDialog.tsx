import { useEffect, useRef, useState } from "react";

import { exportCarousel, getExportJob } from "../api/client";
import type { ExportJob } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface ExportDialogProps {
  slug: string;
  carouselId: string;
  onClose: () => void;
}

const POLL_MS = 800;

export function ExportDialog({ slug, carouselId, onClose }: ExportDialogProps) {
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    exportCarousel(slug, carouselId)
      .then(({ jobId }) => setJob({ jobId, slug, carouselId, status: "queued" }))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [slug, carouselId]);

  useEffect(() => {
    if (!job || job.status === "done" || job.status === "error") return;
    const timer = setInterval(() => {
      getExportJob(slug, carouselId, job.jobId)
        .then(setJob)
        .catch((err: unknown) => {
          clearInterval(timer);
          setError(err instanceof Error ? err.message : String(err));
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job, slug, carouselId]);

  return (
    <Modal
      title="Exportar carrusel"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      {error && <p style={{ color: "var(--ui-danger)" }}>{error}</p>}
      {!error && !job && <p>Encolando exportación…</p>}
      {!error && job && job.status !== "done" && job.status !== "error" && (
        <p>Exportando ({job.status})…</p>
      )}
      {!error && job?.status === "done" && (
        <p>
          Exportación lista{job.version !== undefined ? ` · versión v${job.version}` : ""}. Los PNG quedan en{" "}
          <code>outputs/</code> dentro del perfil.
        </p>
      )}
      {!error && job?.status === "error" && <p style={{ color: "var(--ui-danger)" }}>{job.error}</p>}
    </Modal>
  );
}
