-- Carousels, their export history and the editor chat log.
-- Revisions for carousels reuse the 0001 `revisions` table and trigger.

-- `status` lives only in its column: the repository strips it from `document`
-- on write and overlays it on read, so the CHECK below rejects a stray copy.
CREATE TABLE carousels (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  slug                    text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  title                   text NOT NULL,
  status                  text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'scheduled', 'published')),
  scheduled_for           timestamptz,
  published_at            timestamptz,
  document                jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND NOT (document ? 'status')),
  document_schema_version int NOT NULL CHECK (document_schema_version >= 1),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, slug)
);

-- One row per export attempt. `version_no` is reserved under a per-carousel
-- lock; a `running` row that outlives its timeout is reclaimed as `failed`.
CREATE TABLE exports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carousel_id      uuid NOT NULL REFERENCES carousels (id) ON DELETE RESTRICT,
  version_no       int NOT NULL CHECK (version_no >= 1),
  carousel_version int NOT NULL CHECK (carousel_version >= 1),
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  manifest         jsonb CHECK (jsonb_typeof(manifest) = 'object'),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (carousel_id, version_no),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'done') = (manifest IS NOT NULL))
);

-- Insert-only; `seq` is gap-free per carousel (assigned under a per-carousel lock).
CREATE TABLE chat_messages (
  carousel_id uuid NOT NULL REFERENCES carousels (id) ON DELETE RESTRICT,
  seq         int NOT NULL CHECK (seq >= 1),
  body        jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (carousel_id, seq)
);

DO $$
DECLARE
  r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('brand_owner', 'brand_app') LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON carousels TO %I', r);
    -- Exports are never rewritten: only the outcome columns may change.
    EXECUTE format('GRANT SELECT, INSERT ON exports TO %I', r);
    EXECUTE format('GRANT UPDATE (status, manifest, finished_at) ON exports TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT ON chat_messages TO %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON carousels, exports, chat_messages TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON carousels TO brand_purger;
    GRANT SELECT, INSERT, DELETE ON exports, chat_messages TO brand_purger;
  END IF;
END
$$;
