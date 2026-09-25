-- Discount presets for promos, with the business dates they run on; and each
-- business's own trading-day rollover hour.
-- Additive only: a new enum, a new table and a new column with a default that
-- keeps every existing business exactly as it was (5am).

ALTER TABLE "account_settings" ADD COLUMN "day_rollover_hour" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_rollover_range" CHECK (
  "day_rollover_hour" BETWEEN 0 AND 12
);

CREATE TYPE "PromotionKind" AS ENUM ('PERCENT', 'AMOUNT');

CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "value" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "promotions_business_id_starts_on_idx" ON "promotions"("business_id", "starts_on");

ALTER TABLE "promotions" ADD CONSTRAINT "promotions_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A percentage is 1–100; an amount is at least 1 sen; a range runs forwards.
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_value_valid" CHECK (
  "value" > 0 AND ("kind" <> 'PERCENT' OR "value" <= 100)
);
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_range_valid" CHECK (
  "ends_on" IS NULL OR "ends_on" >= "starts_on"
);

-- Closed to Supabase's Data API, like every other table.
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "promotions" FROM anon, authenticated;
  END IF;
END
$$;
