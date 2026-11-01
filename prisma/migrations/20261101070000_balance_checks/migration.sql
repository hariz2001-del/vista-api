-- Bank balance checks: what the bank actually held at the end of a day, for
-- comparing with the cash book. Never writes to the ledger. Additive only.
CREATE TABLE "balance_checks" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "bank_sen" INTEGER NOT NULL,
    "cash_sen" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "balance_checks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "balance_checks_cash_sen_check" CHECK ("cash_sen" >= 0)
);
CREATE UNIQUE INDEX "balance_checks_business_id_business_date_key" ON "balance_checks"("business_id", "business_date");
ALTER TABLE "balance_checks" ADD CONSTRAINT "balance_checks_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_checks" ADD CONSTRAINT "balance_checks_business_id_created_by_id_fkey" FOREIGN KEY ("business_id", "created_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed to Supabase's Data API, like every other table.
DO $$
BEGIN
  ALTER TABLE public.balance_checks ENABLE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.balance_checks FROM anon, authenticated;
  END IF;
END
$$;
