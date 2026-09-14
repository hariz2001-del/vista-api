-- CreateTable
CREATE TABLE "account_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "business_name" TEXT NOT NULL,
    "outlet_name" TEXT NOT NULL,
    "shared_overhead_food_pct" INTEGER NOT NULL,
    "host_commission_pct" INTEGER NOT NULL,
    "capital_asset_food_pct" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- One row only: the settings are a singleton, not a history. Past periods keep
-- the split they were computed with, because each expense snapshots its own.
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_singleton" CHECK ("id" = 1);

-- Whole percentages from 0 to 100.
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_pct_range" CHECK (
  "shared_overhead_food_pct" BETWEEN 0 AND 100
  AND "host_commission_pct" BETWEEN 0 AND 100
  AND "capital_asset_food_pct" BETWEEN 0 AND 100
);
