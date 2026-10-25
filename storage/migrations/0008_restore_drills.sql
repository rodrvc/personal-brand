-- One row per backup restore drill: `brand backup drill` dumps the database, restores it into a scratch database and compares
-- row counts. The import backup gate (design section 10) reads the newest row. Insert-only; `detail` holds counts or the failure
-- text, never data. `latest()` reads only rows whose database_name is the current database: the drill's scratch copy has a different
-- name, so it never sees (or satisfies the gate with) the source's rows. Known limit: a provider backup or PITR restore that keeps the
-- same database name inherits the verified row. `recorded_at` is the server clock at insert: the gate orders by it, so a client clock
-- that is wrong cannot make an old drill look newer.
CREATE TABLE restore_drills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_name text NOT NULL,
  status        text NOT NULL CHECK (status IN ('verified', 'failed')),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL CHECK (finished_at >= started_at),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  detail        jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX restore_drills_recorded_idx ON restore_drills (recorded_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT ON restore_drills TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT ON restore_drills TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON restore_drills TO brand_reader;
  END IF;
END
$$;
