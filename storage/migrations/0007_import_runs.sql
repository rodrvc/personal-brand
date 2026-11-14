-- One row per real import pass of a brand folder; dry runs write nothing, so there is no dry_run column. Insert-only.
-- `brands.cutover_at` already exists since 0001. The report holds counts and per-item outcomes, never secrets.
CREATE TABLE import_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  source_kind      text NOT NULL CHECK (source_kind IN ('folder')),
  source_root_hash char(64) NOT NULL CHECK (source_root_hash ~ '^[0-9a-f]{64}$'),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  report           jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX import_runs_brand_idx ON import_runs (brand_id, started_at DESC);

-- Only the owner role writes import runs (the importer is an owner operation); the app role may read them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT ON import_runs TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT ON import_runs TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON import_runs TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, DELETE ON import_runs TO brand_purger;
  END IF;
END
$$;
