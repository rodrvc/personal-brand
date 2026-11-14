-- Brand-owned executable helper scripts (e.g. poster renderers with a hardcoded brand style). They are brand business logic,
-- so they live next to guidance, not in the engine. Revisions reuse the 0001 `revisions` table (entity type `brand_tool`).
-- The name is a file name (`render-cover.mjs`): the extension is checked by the repositories, the shape here.

CREATE TABLE brand_tools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  description text NOT NULL DEFAULT '',
  body        text NOT NULL CHECK (octet_length(body) <= 262144),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, name)
);

-- Code is read by agents and run only when the owner asks, so only the owner role writes it (a prompt injection cannot rewrite it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT, UPDATE ON brand_tools TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT ON brand_tools TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON brand_tools TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON brand_tools TO brand_purger;
  END IF;
END
$$;
