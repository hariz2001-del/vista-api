-- CreateEnum
CREATE TYPE "StockBalance" AS ENUM ('MORE_THAN_HALF', 'HALF', 'LESS_THAN_HALF');

-- CreateTable
CREATE TABLE "stock_items" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "name" TEXT NOT NULL,
    "unit_label" TEXT,
    "track_unopened" BOOLEAN NOT NULL DEFAULT true,
    "track_opened" BOOLEAN NOT NULL DEFAULT false,
    "track_balance" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branch_name" TEXT NOT NULL,
    "staff_id" TEXT,
    "staff_name" TEXT NOT NULL,
    "submitted_by_id" TEXT NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "count_id" TEXT NOT NULL,
    "stock_item_id" TEXT,
    "brand_id" TEXT,
    "brand_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "name" TEXT NOT NULL,
    "unit_label" TEXT,
    "track_unopened" BOOLEAN NOT NULL,
    "track_opened" BOOLEAN NOT NULL,
    "track_balance" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL,
    "unopened_milli" INTEGER,
    "opened_milli" INTEGER,
    "balance" "StockBalance",

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_items_business_id_is_active_idx" ON "stock_items"("business_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_business_id_id_key" ON "stock_items"("business_id", "id");

-- CreateIndex
CREATE INDEX "stock_counts_business_id_business_date_idx" ON "stock_counts"("business_id", "business_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_counts_business_id_id_key" ON "stock_counts"("business_id", "id");

-- CreateIndex
CREATE INDEX "stock_count_lines_count_id_idx" ON "stock_count_lines"("count_id");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_business_id_submitted_by_id_fkey" FOREIGN KEY ("business_id", "submitted_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_business_id_count_id_fkey" FOREIGN KEY ("business_id", "count_id") REFERENCES "stock_counts"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Closed to Supabase's Data API, like every other table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_items', 'stock_counts', 'stock_count_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END
$$;
