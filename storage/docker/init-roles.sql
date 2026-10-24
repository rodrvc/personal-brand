-- Provisioning for the local dev database (runs once, on first container
-- start). Cluster-level roles are never created by migrations. Passwords are
-- local-only placeholders; hosted databases use real secrets.
CREATE ROLE brand_migrator LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_owner    LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_app      LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_reader   LOGIN PASSWORD 'local-dev-only';
CREATE ROLE brand_purger   LOGIN PASSWORD 'local-dev-only';
-- All a shared-database admin needs to grant: the migrator creates and owns the
-- product schema itself (`content_platform`); it owns nothing in `public`.
GRANT CREATE ON DATABASE brands TO brand_migrator;
