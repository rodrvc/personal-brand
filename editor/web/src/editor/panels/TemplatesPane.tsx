import { useEffect, useState } from "react";

import { getTemplate, listTemplates } from "../../api/client";
import type { CarouselDocument, LayoutTemplate, LayoutTemplateSummary } from "../../api/types";
import { Modal } from "../../components/Modal";
import { Button } from "../../components/Button";
import { setTemplateRef } from "../mutations";
import { t } from "../../i18n";

/**
 * Browsing a brand's templates with no carousel open (CarouselListRoute):
 * every row is inert and nothing is marked active, because there is no
 * document to be active for.
 */
interface BrowseProps {
  mode?: "browse";
  slug: string;
}

/**
 * The Templates tab of an open carousel's properties panel. This tab is the
 * only place template selection happens (design.md's open question on
 * ownership, resolved: the "Lámina" panel points here and owns nothing).
 */
interface SelectProps {
  mode: "select";
  slug: string;
  doc: CarouselDocument;
  /** The resolved template the stage is currently rendering — the swap's `from` side, which `doc.template` alone cannot supply (it is absent for "sin template"). */
  template: LayoutTemplate;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  onTemplateChange: (next: LayoutTemplate) => void;
}

type TemplatesPaneProps = BrowseProps | SelectProps;

/**
 * "Templates" tab (ACU-230, ACU-232): lists every template
 * `listLayoutTemplates` resolves for the brand (engine defaults plus that
 * profile's own overrides, an override replacing the default of the same
 * id), marking the one in use.
 *
 * `mode` is an explicit prop rather than "is `activeTemplateId` undefined?"
 * because those two questions have different answers: a carousel with no
 * template is selectable *and* has no active id, which the old overload
 * could not express.
 *
 * In select mode the first row is "sin template" — a first-class choice,
 * not an absence — carrying the sentinel id the server reports alongside
 * the listing. That id is never written to the document: `setTemplateRef`
 * takes `undefined` for it, so "no template" stays the field's absence.
 */
export function TemplatesPane(props: TemplatesPaneProps) {
  const { slug } = props;
  const select = props.mode === "select" ? props : null;
  const activeTemplateId = select ? select.doc.template?.id : undefined;

  const [listing, setListing] = useState<{ templates: LayoutTemplateSummary[]; freeTemplateId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The row the user clicked, awaiting confirmation. `null` while no dialog is open. */
  const [pending, setPending] = useState<{ id: string; displayName: string } | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setListing(null);
    setError(null);
    listTemplates(slug)
      .then((res) => {
        if (alive) setListing(res);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  /**
   * Fetches the chosen template, remaps every slide onto it and writes the
   * new reference. The PUT is the editor's existing save path, which
   * already snapshots a version when the template reference changes — this
   * only has to produce the new document. The stage is re-rendered by
   * handing the fetched template up, never by refetching the route.
   */
  async function confirmSwap() {
    if (!select || !pending || !listing) return;
    setSwapping(true);
    setSwapError(null);
    try {
      const next = await getTemplate(slug, pending.id);
      const ref = pending.id === listing.freeTemplateId ? undefined : { id: pending.id };
      select.onDocUpdate((prev) => setTemplateRef(prev, ref, select.template, next));
      select.onTemplateChange(next);
      setPending(null);
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwapping(false);
    }
  }

  if (error) {
    return <p style={{ color: "var(--ui-danger)" }}>{error}</p>;
  }
  if (!listing) {
    return <p className="props-hint">{t("templatesPane.loading", { slug })}</p>;
  }
  const { templates, freeTemplateId } = listing;

  if (templates.length === 0 && !select) {
    // Shouldn't happen in practice (the engine always ships at least one
    // default), but a brand-owned removal isn't impossible — never leave
    // this blank. In select mode the "sin template" row is still a real
    // choice, so the list is never actually empty there.
    return (
      <div className="props-card">
        <div className="props-card-heading">{t("templatesPane.heading")}</div>
        <p className="props-hint">
          {t("templatesPane.emptyPrefix")} <b>{slug}</b> {t("templatesPane.emptySuffix")}
        </p>
      </div>
    );
  }

  const hasBrandOverride = templates.some((tpl) => tpl.origin === "brand-override");
  /** The "sin template" row, first, only when a carousel is open to apply it to. */
  const rows: Array<{ id: string; displayName: string; origin?: LayoutTemplateSummary["origin"] }> = select
    ? [{ id: freeTemplateId, displayName: t("templatesPane.none") }, ...templates]
    : templates;
  /** "Sin template" is active exactly when the document carries no reference. */
  const activeRowId = select ? activeTemplateId ?? freeTemplateId : undefined;

  return (
    <div className="props-card">
      <div className="props-card-heading">{t("templatesPane.heading")}</div>
      {select && <p className="props-hint">{t("templatesPane.selectHint")}</p>}
      {!hasBrandOverride && templates.length > 0 && <p className="props-hint">{t("templatesPane.noOwnTemplates")}</p>}
      {swapError && <p style={{ color: "var(--ui-danger)" }}>{swapError}</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row) => {
          const active = row.id === activeRowId;
          const content = (
            <>
              <span>
                {row.displayName}
                {active && (
                  <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: "var(--ui-accent-ink)" }}>
                    {t("templatesPane.inUse")}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--ui-ink-3)" }}>
                {row.origin === undefined
                  ? ""
                  : row.origin === "brand-override"
                    ? t("templatesPane.originBrand")
                    : t("templatesPane.originEngine")}
              </span>
            </>
          );
          const rowStyle = {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            textAlign: "left" as const,
            font: "inherit",
            color: "inherit",
            cursor: select && !active ? "pointer" : "default",
            padding: "6px 8px",
            borderRadius: "var(--ui-radius-sm, 6px)",
            background: active ? "var(--ui-accent-soft, var(--ui-g100))" : "transparent",
            border: active ? "1px solid var(--ui-accent)" : "1px solid transparent",
          };
          return (
            <li key={row.id}>
              {select ? (
                <button
                  type="button"
                  style={rowStyle}
                  aria-pressed={active}
                  disabled={active}
                  onClick={() => setPending({ id: row.id, displayName: row.displayName })}
                >
                  {content}
                </button>
              ) : (
                <div style={rowStyle}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {pending && (
        <Modal
          title={t("templatesPane.confirmTitle")}
          onClose={() => setPending(null)}
          actions={
            <>
              <Button onClick={() => setPending(null)}>{t("templatesPane.confirmCancel")}</Button>
              <Button variant="primary" onClick={() => void confirmSwap()} disabled={swapping}>
                {swapping ? t("templatesPane.changing") : t("templatesPane.confirmAccept")}
              </Button>
            </>
          }
        >
          <p>{t("templatesPane.confirmBody", { name: pending.displayName })}</p>
        </Modal>
      )}
    </div>
  );
}
