import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, exportCarousel, getExportJob } from "../api/client";
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
  // Set only when the server refused with 409 (pieces still pending) —
  // shows the "Exportar igual" override instead of the plain error text.
  const [pendingWarning, setPendingWarning] = useState(false);
  const started = useRef(false);

  const startExport = useCallback(
    (allowPending: boolean) => {
      setError(null);
      setPendingWarning(false);
      exportCarousel(slug, carouselId, { allowPending })
        .then(({ jobId }) => setJob({ jobId, slug, carouselId, status: "queued" }))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 409) {
            setPendingWarning(true);
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [slug, carouselId],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startExport(false);
  }, [startExport]);

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
        pendingWarning ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => startExport(true)}>
              Exportar igual
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Cerrar
          </Button>
        )
      }
    >
      {pendingWarning && (
        <p style={{ color: "var(--ui-warn)" }}>
          Todavía hay piezas generándose en segundo plano. Si exportás ahora, el PNG puede salir con texto vacío o
          sin imagen en esas piezas.
        </p>
      )}
      {!pendingWarning && error && <p style={{ color: "var(--ui-danger)" }}>{error}</p>}
      {!pendingWarning && !error && !job && <p>Encolando exportación…</p>}
      {!pendingWarning && !error && job && job.status !== "done" && job.status !== "error" && (
        <p>Exportando ({job.status})…</p>
      )}
      {!pendingWarning && !error && job?.status === "done" && (
        <p>
          Exportación lista{job.version !== undefined ? ` · versión v${job.version}` : ""}. Los PNG quedan en{" "}
          <code>outputs/</code> dentro del perfil.
        </p>
      )}
      {!pendingWarning && !error && job?.status === "error" && (
        <p style={{ color: "var(--ui-danger)" }}>{job.error}</p>
      )}
    </Modal>
  );
}
