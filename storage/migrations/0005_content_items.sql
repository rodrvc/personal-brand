-- Ideas, drafts and published pieces as markdown rows (the former ideas/ and content/ trees).
-- Revisions reuse the 0001 `revisions` table and trigger (entity_type 'content_item').

-- `stage` lives only in its column: the repository strips it from `meta` on write and
-- overlays it on read, so the CHECK below rejects a stray copy. `slug` never changes
-- across stages; `channel` and `format` are free-form slugs, deliberately without a fixed list.
CREATE TABLE content_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id            uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  slug                text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  title               text NOT NULL,
  stage               text NOT NULL DEFAULT 'idea' CHECK (stage IN ('idea', 'draft', 'published', 'archived')),
  channel             text CHECK (channel ~ '^[a-z0-9-]+$'),
  format              text CHECK (format ~ '^[a-z0-9-]+$'),
  body_md             text NOT NULL DEFAULT '',
  meta                jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object' AND NOT (meta ? 'stage')),
  meta_schema_version int NOT NULL DEFAULT 1 CHECK (meta_schema_version >= 1),
  derived_from        uuid,
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1,
  UNIQUE (brand_id, slug),
  UNIQUE (brand_id, id),
  -- A derivation never crosses brands.
  FOREIGN KEY (brand_id, derived_from) REFERENCES content_items (brand_id, id) ON DELETE RESTRICT,
  CHECK (derived_from <> id),
  CHECK ((stage = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX content_items_stage_idx ON content_items (brand_id, stage, slug);
CREATE INDEX content_items_derived_idx ON content_items (brand_id, derived_from) WHERE derived_from IS NOT NULL;

DO $$
DECLARE
  r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('brand_owner', 'brand_app') LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON content_items TO %I', r);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON content_items TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON content_items TO brand_purger;
  END IF;
END
$$;
