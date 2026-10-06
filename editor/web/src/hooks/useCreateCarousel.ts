import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { createCarousel } from "../api/client";
import { t } from "../i18n";

export interface UseCreateCarouselResult {
  /** True from the moment "Nuevo carrusel" is clicked through the navigation away from this route — callers show a `SheetLoader` while this is true. */
  creating: boolean;
  createError: string | null;
  handleCreate: () => Promise<void>;
}

/**
 * Direct carousel creation, shared by every entry point that offers a
 * "Nuevo carrusel" button (the carousel list and the brand home
 * dashboard): creates the carousel with its defaults (a placeholder
 * title, since the server requires one, and the engine default template)
 * and navigates straight into the editor — no modal asking for fields the
 * owner never wanted to fill in up front (brand is always fixed to the
 * current profile, and the template can be picked, changed or dropped from
 * the editor's own Templates tab).
 *
 * `creating` deliberately stays true across the navigation (never reset on
 * the success path): the caller's full-area loader keeps showing right up
 * to the moment its route unmounts, and `EditorRoute` picks up the exact
 * same-looking loader immediately via its own `immediate` case — one
 * continuous load, not a flash of the caller's own content before the page
 * changes.
 */
export function useCreateCarousel(slug: string | undefined, accentColor: string | undefined): UseCreateCarouselResult {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    if (!slug) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { document } = await createCarousel(slug, { title: t("carouselList.untitled") });
      // Router state carries the just-created (empty) document straight
      // to EditorRoute so it can skip its own fetch-and-flash — see
      // EditorRoute's own comment.
      navigate(`/${slug}/carousels/${document.id}`, { state: { doc: document, accentColor } });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  return { creating, createError, handleCreate };
}
