-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RAW_MATERIALS', 'PACKAGING', 'RENT', 'UTILITIES', 'OPERATIONS', 'MAINTENANCE', 'CAPITAL_ASSET');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('STALL_FUNDS', 'PARTNER_FOOD', 'PARTNER_DRINKS');

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "amount_sen" INTEGER NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "paid_by" "PaymentSource" NOT NULL,
    "brand_id" TEXT,
    "food_split_pct" INTEGER NOT NULL,
    "food_amount_sen" INTEGER NOT NULL,
    "drinks_amount_sen" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "receipt_url" TEXT,
    "is_settled" BOOLEAN NOT NULL DEFAULT false,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "period_closures" (
    "id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_id" TEXT NOT NULL,
    "food_net_sales_sen" INTEGER NOT NULL,
    "food_direct_expenses_sen" INTEGER NOT NULL,
    "food_overhead_share_sen" INTEGER NOT NULL,
    "food_net_result_sen" INTEGER NOT NULL,
    "opening_iou_sen" INTEGER NOT NULL,
    "host_commission_sen" INTEGER NOT NULL,
    "closing_iou_sen" INTEGER NOT NULL,
    "food_payout_sen" INTEGER NOT NULL,
    "drinks_payout_sen" INTEGER NOT NULL,

    CONSTRAINT "period_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_status" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "last_seen_at" TIMESTAMP(3),
    "consecutive_sync_failures" INTEGER NOT NULL DEFAULT 0,
    "last_seen_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_business_date_idx" ON "expenses"("business_date");

-- CreateIndex
CREATE INDEX "expenses_paid_by_is_settled_idx" ON "expenses"("paid_by", "is_settled");

-- CreateIndex
CREATE INDEX "period_closures_end_date_idx" ON "period_closures"("end_date");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "period_closures" ADD CONSTRAINT "period_closures_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An expense is a positive amount whose two shares always add back up to it.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_positive" CHECK ("amount_sen" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_split_pct_range" CHECK ("food_split_pct" BETWEEN 0 AND 100);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shares_add_up" CHECK (
  "food_amount_sen" >= 0 AND "drinks_amount_sen" >= 0
  AND "food_amount_sen" + "drinks_amount_sen" = "amount_sen"
);

-- A settled period runs forwards, and no two settled periods may share a day.
-- Enforced here, not only in the route, so a race or a bug cannot pay a day twice.
ALTER TABLE "period_closures" ADD CONSTRAINT "period_closures_range_valid" CHECK ("end_date" >= "start_date");
ALTER TABLE "period_closures" ADD CONSTRAINT "period_closures_no_overlap"
  EXCLUDE USING gist (daterange("start_date", "end_date", $$[]$$) WITH &&);

-- One counter, one row.
ALTER TABLE "terminal_status" ADD CONSTRAINT "terminal_status_singleton" CHECK ("id" = 1);
ALTER TABLE "terminal_status" ADD CONSTRAINT "terminal_status_failures_non_negative" CHECK ("consecutive_sync_failures" >= 0);
