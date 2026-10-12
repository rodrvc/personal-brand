-- Provisioning for the local dev database (runs once, on first container
-- start). Cluster-level roles are never created by migrations. Passwords are
-- local-only placeholders; hosted databases use real secrets.
CREATE ROLE brand_migrator LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_owner    LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_app      LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_reader   LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_purger   LOGIN PASSWORD 'local-dev-only';
-- The migrator owns the schema it migrates and may create test schemas.
ALTER SCHEMA public OWNER TO brand_migrator;
GRANT CREATE ON DATABASE brands TO brand_migrator;
