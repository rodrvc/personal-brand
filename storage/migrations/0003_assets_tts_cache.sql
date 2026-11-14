-- Asset library metadata and the reel TTS cache. Bytes live in the bucket
-- (`blob_key`, content addressed); rows hold what programs decide on.
-- Revisions for assets reuse the 0001 `revisions` table and trigger.

CREATE TABLE assets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id   uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
    asset_id   text NOT NULL CHECK (asset_id ~ '^[0-9a-f]{16}$'),
  sha256     char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$' AND left(sha256, 16) = asset_id),
  blob_key   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('background', 'character', 'photo', 'logo', 'decoration', 'font', 'unclassified')),
  mime       text NOT NULL CHECK (mime <> ''),
  width      int CHECK (width > 0),
  height     int CHECK (height > 0),
  bytes      bigint NOT NULL CHECK (bytes >= 0),
  origin     text NOT NULL CHECK (origin IN ('manual', 'ai', 'reference')),
  status     text NOT NULL CHECK (status IN ('candidate', 'approved', 'hidden')),
  tags       text[] NOT NULL DEFAULT '{}',
  family     text,
  generation jsonb CHECK (jsonb_typeof(generation) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  CHECK (blob_key = 'brands/' || brand_id || '/blobs/sha256/' || left(sha256, 2) || '/' || sha256),
  UNIQUE (brand_id, asset_id),
  UNIQUE (brand_id, sha256)
);

-- Insert-only; a re-take (new audio for the same narration) is a new row and
-- the latest `seq` is current. Nothing is ever overwritten or deleted.
CREATE TABLE tts_cache (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  brand_id       uuid NOT NULL REFERENCES brands (id) ON DELETE RESTRICT,
  narration_hash text NOT NULL CHECK (narration_hash <> ''),
  sha256         char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  seconds        double precision NOT NULL CHECK (seconds >= 0),
  voice          jsonb NOT NULL CHECK (jsonb_typeof(voice) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, narration_hash, sha256),
  UNIQUE (seq)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    GRANT SELECT, INSERT, UPDATE ON assets TO brand_owner;
    GRANT SELECT, INSERT ON tts_cache TO brand_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_app') THEN
    GRANT SELECT, INSERT, UPDATE ON assets TO brand_app;
    GRANT SELECT, INSERT ON tts_cache TO brand_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_reader') THEN
    GRANT SELECT ON assets, tts_cache TO brand_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_purger') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON assets TO brand_purger;
    GRANT SELECT, INSERT, DELETE ON tts_cache TO brand_purger;
  END IF;
END
$$;
