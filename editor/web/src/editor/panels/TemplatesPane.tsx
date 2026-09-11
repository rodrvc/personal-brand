import { useEffect, useState } from "react";

import { listTemplates } from "../../api/client";
import type { LayoutTemplateSummary } from "../../api/types";
import { t } from "../../i18n";

interface TemplatesPaneProps {
  slug: string;
  /**
   * The template id an open carousel actually uses, so it can be marked in
   * the list. Omitted on the carousels list route, where no carousel is
   * open yet — the pane still lists every template, just with nothing
   * marked as active.
   */
  activeTemplateId?: string;
}

/**
 * Read-only "Templates" tab (ACU-230): before `GET .../templates` existed,
 * there was no way to see what templates a brand has at all — only
 * `GET .../template/:id`, which needs an id the caller already knows. This
 * lists every template `listLayoutTemplates` resolves for the brand
 * (engine defaults plus that profile's own overrides, an override replacing
 * the default of the same id), and, when an `activeTemplateId` is given,
 * marks the one currently in use. Shared between `PropertiesPanel` (an
 * open carousel) and `CarouselListRoute` (browsing before opening one).
 */
export function TemplatesPane({ slug, activeTemplateId }: TemplatesPaneProps) {
  const [templates, setTemplates] = useState<LayoutTemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTemplates(null);
    setError(null);
    listTemplates(slug)
      .then((res) => {
        if (alive) setTemplates(res.templates);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  if (error) {
    return <p style={{ color: "var(--ui-danger)" }}>{error}</p>;
  }
  if (!templates) {
    return <p className="props-hint">{t("templatesPane.loading", { slug })}</p>;
  }
  if (templates.length === 0) {
    // Shouldn't happen in practice (the engine always ships at least one
    // default), but a brand-owned removal isn't impossible — never leave
    // this blank.
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

  return (
    <div className="props-card">
      <div className="props-card-heading">{t("templatesPane.heading")}</div>
      {!hasBrandOverride && <p className="props-hint">{t("templatesPane.noOwnTemplates")}</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {templates.map((tpl) => (
          <li
            key={tpl.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 8px",
              borderRadius: "var(--ui-radius-sm, 6px)",
              background: tpl.id === activeTemplateId ? "var(--ui-accent-soft, var(--ui-g100))" : "transparent",
              border: tpl.id === activeTemplateId ? "1px solid var(--ui-accent)" : "1px solid transparent",
            }}
          >
            <span>
              {tpl.displayName}
              {tpl.id === activeTemplateId && (
                <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: "var(--ui-accent-ink)" }}>
                  {t("templatesPane.inUse")}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--ui-ink-3)" }}>
              {tpl.origin === "brand-override" ? t("templatesPane.originBrand") : t("templatesPane.originEngine")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
