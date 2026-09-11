import { useEffect, useState } from "react";

import { createCarousel, listTemplates } from "../api/client";
import type { CreateCarouselResponse, LayoutTemplateSummary } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { t } from "../i18n";
import "./NewCarouselDialog.css";

interface NewCarouselDialogProps {
  slug: string;
  onClose: () => void;
  onCreated: (result: CreateCarouselResponse) => void;
}

/**
 * New-carousel screen (specs/editor-ui "New carousel opens empty"): asks
 * only for what identifies the piece — title, brand (fixed to `slug`, the
 * profile this dialog was opened from) and an optional template. No
 * prompt, no cost, no background work: submitting creates an empty
 * document and the caller navigates straight into the editor with it.
 *
 * The template is picked from a `<select>` fed by `GET .../templates`
 * (ACU-232), whose first option is "sin template" — a first-class choice,
 * submitted as `templateId: null` so the document is created carrying no
 * template reference at all. The sentinel id from that response is only
 * ever the select's `value`; it is never sent to the server as an id.
 *
 * If the listing fails the field degrades to the free-text input it used to
 * be rather than blocking creation: not knowing what templates exist is a
 * reason to make the user type one, never a reason to refuse the carousel.
 */
export function NewCarouselDialog({ slug, onClose, onCreated }: NewCarouselDialogProps) {
  const [title, setTitle] = useState("");
  // Seeded empty, never with a guessed id: until the listing arrives this
  // component has no idea which templates the brand actually has, and the
  // fallback path below asks the user to type one rather than pre-filling
  // an id that may not exist.
  const [templateId, setTemplateId] = useState("");
  const [listing, setListing] = useState<{ templates: LayoutTemplateSummary[]; freeTemplateId: string } | null>(null);
  // Distinguishes "still loading" from "the listing failed, fall back to
  // the text input" — `listing === null` alone cannot tell them apart.
  const [listingFailed, setListingFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Don't show "required" the instant the dialog opens — only once the
  // user has interacted with the field (blurred it or typed and cleared
  // it), so an empty required field isn't scolded before it's been touched.
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    let alive = true;
    listTemplates(slug)
      .then((res) => {
        if (!alive) return;
        setListing(res);
        // Default to the first real template when one exists, otherwise to
        // "sin template" — never to an id that may not exist for this brand.
        setTemplateId(res.templates[0]?.id ?? res.freeTemplateId);
      })
      .catch(() => {
        if (alive) setListingFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  const trimmedTitle = title.trim();

  async function handleSubmit() {
    if (!trimmedTitle) return;
    setBusy(true);
    setError(null);
    try {
      // Three distinct intents, and the wire has a distinct shape for each:
      // `null` is the explicit "sin template"; an omitted field lets the
      // server pick its default (the fallback input left empty — the user
      // named no template, which is not the same as refusing one); an id is
      // an id.
      const isFree = listing !== null && templateId === listing.freeTemplateId;
      const trimmedTemplateId = templateId.trim();
      const result = await createCarousel(slug, {
        title: trimmedTitle,
        ...(isFree ? { templateId: null } : trimmedTemplateId ? { templateId: trimmedTemplateId } : {}),
      });
      onCreated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t("newCarousel.dialogTitle")}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>{t("newCarousel.cancel")}</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={busy || !trimmedTitle}>
            {busy ? t("newCarousel.creating") : t("newCarousel.create")}
          </Button>
        </>
      }
    >
      <div className="new-carousel-form">
        <label className="new-carousel-label">
          {t("newCarousel.titleLabel")}
          <input
            className="ui-input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleTouched(true);
            }}
            onBlur={() => setTitleTouched(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            placeholder={t("newCarousel.titlePlaceholder")}
            autoFocus
          />
          {titleTouched && !trimmedTitle && <span className="new-carousel-inline-hint">{t("newCarousel.titleRequired")}</span>}
        </label>
        <label className="new-carousel-label">
          {t("newCarousel.brandLabel")}
          <input className="ui-input" value={slug} disabled />
        </label>
        <label className="new-carousel-label">
          {t("newCarousel.templateLabel")}
          {listing ? (
            <select className="ui-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value={listing.freeTemplateId}>{t("newCarousel.templateNone")}</option>
              {listing.templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.displayName} —{" "}
                  {tpl.origin === "brand-override" ? t("templatesPane.originBrand") : t("templatesPane.originEngine")}
                </option>
              ))}
            </select>
          ) : listingFailed ? (
            <input className="ui-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
          ) : (
            <input className="ui-input" value={t("newCarousel.templateLoading")} disabled />
          )}
        </label>
        <p className="new-carousel-hint">{t("newCarousel.hint")}</p>
        {error && <p className="new-carousel-error">{error}</p>}
      </div>
    </Modal>
  );
}
