import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { listProfiles } from "../api/client";
import type { ProfileListingEntry } from "../api/types";
import "./ProfilePickerRoute.css";

export function ProfilePickerRoute() {
  const [profiles, setProfiles] = useState<ProfileListingEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProfiles()
      .then((res) => setProfiles(res.profiles))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="picker">
      <h1 className="picker-title">Perfiles</h1>
      {error && <p className="picker-error">{error}</p>}
      {!profiles && !error && <p className="picker-hint">Cargando perfiles…</p>}
      {profiles && profiles.length === 0 && (
        <p className="picker-hint">No se encontraron perfiles en la raíz configurada.</p>
      )}
      <div className="picker-list">
        {profiles?.map((profile) =>
          profile.hasBrand ? (
            <Link key={profile.slug} to={`/${profile.slug}/carousels`} className="picker-card">
              {profile.slug}
            </Link>
          ) : (
            <span
              key={profile.slug}
              className="picker-card picker-card-disabled"
              title="Este perfil no tiene brand.json configurado"
            >
              {profile.slug}
              <span className="picker-card-hint">Sin brand.json configurado</span>
            </span>
          ),
        )}
      </div>
    </div>
  );
}
