-- One run of a recipe for a period (the former week-input.json + storyboard.yaml) and the artifacts it rendered.
-- Revisions reuse the 0001 `revisions` table and trigger (entity_type 'recipe_run').

-- `recipe` is a slug, deliberately without a foreign key: a run outlives edits to the brand's recipe row.
-- Re-running a period is allowed, so there is no uniqueness on it. `input` and `storyboard` share `schema_version`.
CREATE TABLE recipe_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  recipe         text NOT NULL CHECK (recipe ~ '^[a-z0-9-]+$'),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  input          jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  storyboard     jsonb CHECK (jsonb_typeof(storyboard) = 'object'),
  schema_version int NOT NULL CHECK (schema_version >= 1),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  CHECK (period_end >= period_start)
);

CREATE INDEX recipe_runs_period_idx ON recipe_runs (brand_id, recipe, period_start DESC, created_at DESC);

-- Insert-only: a re-render appends a row and the latest per (kind, card_index) is current, so old clips stay.
-- The blob key derives from the brand and `sha256`. A timeline is per run: no card_index, no card_id.
CREATE TABLE run_artifacts (
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES recipe_runs (id) ON DELETE RESTRICT,
  kind        text NOT NULL CHECK (kind IN ('clip', 'audio', 'timeline')),
  card_index  int CHECK (card_index >= 0),
  card_id     text CHECK (card_id <> ''),
  sha256      char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  inputs_hash text NOT NULL CHECK (inputs_hash <> ''),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'timeline') = (card_index IS NULL)),
  CHECK ((kind = 'timeline') = (card_id IS NULL))
);

CREATE INDEX run_artifacts_current_idx ON run_artifacts (run_id, kind, card_index, seq DESC);

DO $$
DECLARE
  r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('brand_owner', 'brand_app') LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON recipe_runs TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT ON run_artifacts TO %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON recipe_runs, run_artifacts TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_runs TO brand_purger;
    GRANT SELECT, INSERT, DELETE ON run_artifacts TO brand_purger;
  END IF;
END
$$;
