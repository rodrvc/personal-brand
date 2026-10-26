import { useEffect, useState } from "react";

import { listProfiles } from "../api/client";

/**
 * Whether the brand is archived (the picker lists it apart and the editor opens it read-only). The server's 403 on every
 * stored write stays the authority: this only lets the UI say so up front. `undefined` while loading (callers stay editable until it is `true`); a failed lookup reads as "not archived".
 */
export function useArchivedBrand(slug: string): boolean | undefined {
  const [archived, setArchived] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    listProfiles()
      .then(({ profiles }) => alive && setArchived(profiles.some((p) => p.slug === slug && p.archived === true)))
      .catch(() => alive && setArchived(false));
    return () => {
      alive = false;
    };
  }, [slug]);
  return archived;
}
