-- CreateTable
CREATE TABLE "attempt_counters" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attempt_counters_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "attempt_counters_reset_at_idx" ON "attempt_counters"("reset_at");

-- Shut Supabase's Data API out of every table.
--
-- Supabase publishes the `public` schema through PostgREST to the `anon` and
-- `authenticated` roles, and its default privileges grant those roles every
-- table this role creates. Vista never uses that API — every read and write goes
-- through api-vista, which checks the session — so, left alone, anyone holding
-- the project's public anon key could read password hashes and the partners'
-- books straight out of the database.
--
--  * RLS on with no policies: those roles see no rows at all. The API connects
--    as the tables' owner, which RLS does not apply to, so it is unaffected.
--  * Their privileges revoked, now and for tables later migrations create.
--
-- Plain Postgres (local development, the tests) has no such roles, so the
-- revokes are skipped there; enabling RLS is harmless everywhere.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
END
$$;
