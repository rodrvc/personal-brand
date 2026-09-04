import type { ReactNode } from "react";
import { useEffect } from "react";

import "./Modal.css";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions: ReactNode;
}

/**
 * In-app modal dialog. Used for every confirmation in the editor
 * (specs/editor-ui: "use an in-app modal, never window.confirm") — the
 * mockup carries no native dialogs and neither does this component.
 */
export function Modal({ title, children, onClose, actions }: ModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
