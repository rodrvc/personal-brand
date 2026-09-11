import { useState } from "react";

import type { Slide } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";

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

  const summaryKey: LocaleKey =
    toRegenerate === 1 && pinned === 1
      ? "regenerateUnpinned.summary.oneRegenerateOnePinned"
      : toRegenerate === 1
        ? "regenerateUnpinned.summary.oneRegenerateManyPinned"
        : pinned === 1
          ? "regenerateUnpinned.summary.manyRegenerateOnePinned"
          : "regenerateUnpinned.summary.manyRegenerateManyPinned";

  return (
    <Modal
      title={t("regenerateUnpinned.dialogTitle")}
      onClose={onCancel}
      actions={
        <>
          <Button onClick={onCancel}>{t("regenerateUnpinned.cancel")}</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy}>
            {busy ? t("regenerateUnpinned.regenerating") : t("regenerateUnpinned.confirm")}
          </Button>
        </>
      }
    >
      <p>{t(summaryKey, { count: toRegenerate, pinned })}</p>
    </Modal>
  );
}
