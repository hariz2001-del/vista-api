-- A receipt logged in detail: the supplier and their receipt number, the time
-- printed on it, how it was paid, an audit remark, and its lines. Plus an
-- Ice & Gas category. Additive only: every existing expense keeps its figures
-- and simply has none of the new details.

ALTER TYPE "ExpenseCategory" ADD VALUE IF NOT EXISTS 'ICE_GAS';

CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'DUITNOW_QR', 'DEBIT_CARD', 'BANK_TRANSFER');

ALTER TABLE "expenses" ADD COLUMN "receipt_no" TEXT,
ADD COLUMN "vendor" TEXT,
ADD COLUMN "receipt_time" TEXT,
ADD COLUMN "payment_method" "PaymentMethod",
ADD COLUMN "notes" TEXT;

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receipt_time_format" CHECK (
  "receipt_time" IS NULL OR "receipt_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);

-- The composite key the lines hang off, as on every business-owned relation.
CREATE UNIQUE INDEX "expenses_business_id_id_key" ON "expenses"("business_id", "id");

CREATE TABLE "expense_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity_milli" INTEGER NOT NULL,
    "unit" TEXT,
    "unit_price_sen" INTEGER NOT NULL,
    "total_sen" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "expense_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expense_items_expense_id_idx" ON "expense_items"("expense_id");

ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_business_id_expense_id_fkey"
  FOREIGN KEY ("business_id", "expense_id") REFERENCES "expenses"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_quantity_positive" CHECK ("quantity_milli" > 0);

-- Closed to Supabase's Data API, like every other table.
ALTER TABLE "expense_items" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "expense_items" FROM anon, authenticated;
  END IF;
END
$$;
