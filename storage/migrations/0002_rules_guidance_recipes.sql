-- Rules, guidance and recipes. Rule kinds mirror core/src/checks.js (closed set).
-- Revisions for these entities reuse the 0001 `revisions` table and trigger.

CREATE TABLE brand_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id   uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  kind       text NOT NULL CHECK (kind IN ('forbidden_terms', 'max_length', 'slide_count', 'image_hosts', 'date_window')),
  params     jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  severity   text NOT NULL CHECK (severity IN ('error', 'warning')),
  applies_to text[] NOT NULL CHECK (cardinality(applies_to) > 0 AND applies_to <@ ARRAY['carousel', 'caption']),
  message    text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
CREATE INDEX brand_rules_brand_idx ON brand_rules (brand_id, created_at);

CREATE TABLE brand_guidance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (name ~ '^[a-z0-9-]+$'),
  description text NOT NULL DEFAULT '',
  body_md     text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, name)
);

CREATE TABLE brand_recipes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  recipe         text NOT NULL CHECK (recipe ~ '^[a-z0-9-]+$'),
  schema_version int NOT NULL,
  params         jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, recipe)
);

-- Only the owner role writes rules and guidance (agents read them, so a prompt
-- injection cannot rewrite them); the app role writes recipes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT, UPDATE ON brand_rules, brand_guidance, brand_recipes TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT ON brand_rules, brand_guidance TO brand_app;
    GRANT SELECT, INSERT, UPDATE ON brand_recipes TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON brand_rules, brand_guidance, brand_recipes TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON brand_rules, brand_guidance, brand_recipes TO brand_purger;
  END IF;
END
$$;
