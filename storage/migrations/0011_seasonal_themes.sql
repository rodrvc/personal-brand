-- Seasonal themes: a dated overlay of brand tokens plus a short guidance text (e.g. a winter sale). Revisions reuse the 0001
-- `revisions` table (entity type `seasonal_theme`). The name is a slug, unique per brand.
-- The 64 KiB rule on the overrides is the repositories' (it measures the compact JSON); jsonb text adds spaces, so the CHECK is a loose backstop.
-- No two themes of a brand may share a day, so "which theme applies on date D" has one answer. The repositories enforce it
-- (under a per-brand advisory lock on Postgres): a gist exclusion constraint would need btree_gist, which no migration installs.

CREATE TABLE seasonal_themes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (name ~ '^[a-z0-9-]+$'),
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  token_overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(token_overrides) = 'object' AND octet_length(token_overrides::text) <= 131072),
  guidance_md     text NOT NULL DEFAULT '' CHECK (octet_length(guidance_md) <= 32768),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, name),
  CHECK (ends_on >= starts_on)
);

-- Guidance text is read by agents, so like tools only the owner role writes it (a prompt injection cannot rewrite it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT, UPDATE ON seasonal_themes TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT ON seasonal_themes TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON seasonal_themes TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON seasonal_themes TO brand_purger;
  END IF;
END
$$;
