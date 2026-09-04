import { useState } from "react";

import type { Slide } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface RegenerateUnpinnedDialogProps {
  slide: Slide;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirmation before "Regenerar lo no fijado" spends anything
 * (specs/editor-ui "Regenerar lo no fijado with pinned pieces"): states how
 * many pieces will change and how many pinned ones are kept, as an in-app
 * modal — never window.confirm.
 */
export function RegenerateUnpinnedDialog({ slide, onCancel, onConfirm }: RegenerateUnpinnedDialogProps) {
  const [busy, setBusy] = useState(false);
  const pieces = [slide.background, ...slide.objects];
  const pinned = pieces.filter((p) => p.pinned).length;
  const toRegenerate = pieces.length - pinned;

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Regenerar lo no fijado"
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy}>
            {busy ? "Regenerando…" : "Regenerar"}
          </Button>
        </>
      }
    >
      <p>
        Se regeneran {toRegenerate} pieza{toRegenerate === 1 ? "" : "s"} de esta lámina, {pinned} fijada
        {pinned === 1 ? "" : "s"} se conserva{pinned === 1 ? "" : "n"}.
      </p>
    </Modal>
  );
}
