-- `recorded_at` is the server clock the gate judges the age of a drill by; a role that could set it could backdate or postdate a row.
-- 0008 granted a table-wide INSERT: narrow it to the columns a drill legitimately supplies (`id` and `recorded_at` keep their defaults).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_owner') THEN
    REVOKE INSERT ON restore_drills FROM brand_owner;
    GRANT INSERT (database_name, status, started_at, finished_at, detail) ON restore_drills TO brand_owner;
  END IF;
END
$$;
