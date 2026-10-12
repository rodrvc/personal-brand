-- Foundation: brands, brand documents and the append-only revision log.
-- Roles are provisioned outside migrations (see storage/docker/init-roles.sql).

CREATE TABLE brands (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  cutover_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);

CREATE TABLE brand_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('tokens', 'config', 'identity', 'spec', 'template')),
  name           text NOT NULL DEFAULT '',
  schema_version int NOT NULL,
  body_json      jsonb,
  body_text      text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, kind, name),
  CHECK ((body_json IS NULL) <> (body_text IS NULL))
);

CREATE TABLE revisions (
  id          bigserial PRIMARY KEY,
  brand_id    uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  version     int NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('save', 'autosave', 'structural', 'snapshot', 'status', 'import', 'archive')),
  body        jsonb,
  body_text   text,
  author      text NOT NULL,
  source      text NOT NULL CHECK (source IN ('editor', 'cli', 'agent', 'import', 'system')),
  source_hash text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, version)
);

CREATE INDEX revisions_brand_created_idx ON revisions (brand_id, created_at);

-- Append-only: UPDATE/DELETE fail unless the owner-run purge sets
-- `SET LOCAL app.purge_brand = '<brandId>'` for that very brand. The purge
-- (S8) must use SET LOCAL so the flag dies with its transaction.
CREATE FUNCTION revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.purge_brand', true) = OLD.brand_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'revisions is append-only (% rejected)', TG_OP;
END;
$$;

CREATE TRIGGER revisions_append_only
  BEFORE UPDATE OR DELETE ON revisions
  FOR EACH ROW EXECUTE FUNCTION revisions_append_only();

-- Grants apply only to roles that already exist; migrations never create roles.
DO $$
DECLARE
  r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('brand_owner', 'brand_app') LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), r);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON brands, brand_documents TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT ON revisions TO %I', r);
    EXECUTE format('GRANT USAGE ON SEQUENCE revisions_id_seq TO %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO brand_reader', current_schema());
    GRANT SELECT ON brands, brand_documents, revisions TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO brand_purger', current_schema());
    GRANT SELECT, INSERT, UPDATE, DELETE ON brands, brand_documents TO brand_purger;
    GRANT SELECT, INSERT, DELETE ON revisions TO brand_purger;
    GRANT USAGE ON SEQUENCE revisions_id_seq TO brand_purger;
  END IF;
END
$$;
