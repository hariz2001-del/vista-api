-- Chopper's stash, mirrored for sorting receipts in the RMS; receipts recorded
-- as not categorised until sorted. Additive only.
ALTER TABLE "expenses" ADD COLUMN "uncategorised" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ledger_entries" ADD COLUMN "expense_id" TEXT;
CREATE INDEX "ledger_entries_expense_id_idx" ON "ledger_entries"("expense_id");

CREATE TABLE "chopper_stash" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "receipt_key" TEXT NOT NULL,
    "telegram_user" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "data" JSONB NOT NULL,
    "vista_revision" INTEGER NOT NULL DEFAULT 0,
    "acked_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chopper_stash_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chopper_stash_business_id_receipt_key_key" ON "chopper_stash"("business_id", "receipt_key");
CREATE INDEX "chopper_stash_business_id_status_idx" ON "chopper_stash"("business_id", "status");
ALTER TABLE "chopper_stash" ADD CONSTRAINT "chopper_stash_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to Supabase's Data API, like every other table (chopper_submissions was missed before).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chopper_stash', 'chopper_submissions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END
$$;
