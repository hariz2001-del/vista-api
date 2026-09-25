-- What a promotion applies to and how often: the whole order (picked by the
-- cashier or applied automatically), certain items or categories, or a combo;
-- every match or once per receipt. Plus the items and categories it targets.
-- Additive only: existing promotions become whole-order, cashier-picked ones,
-- which is exactly what they were.

CREATE TYPE "PromotionScope" AS ENUM ('ORDER', 'ITEMS', 'COMBO');
CREATE TYPE "PromotionLimit" AS ENUM ('EACH', 'ONCE_PER_ORDER');

ALTER TABLE "promotions" ADD COLUMN "auto_apply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "limit" "PromotionLimit" NOT NULL DEFAULT 'EACH',
ADD COLUMN "scope" "PromotionScope" NOT NULL DEFAULT 'ORDER';

CREATE UNIQUE INDEX "promotions_business_id_id_key" ON "promotions"("business_id", "id");

CREATE TABLE "promotion_targets" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "promotion_id" TEXT NOT NULL,
    "product_id" TEXT,
    "category_id" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "promotion_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "promotion_targets_promotion_id_idx" ON "promotion_targets"("promotion_id");

-- Composite, like every relation between business-owned tables: a promo can
-- only target its own business's items. A deleted item or category simply
-- drops out of the promos that named it.
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_business_id_promotion_id_fkey"
  FOREIGN KEY ("business_id", "promotion_id") REFERENCES "promotions"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_business_id_product_id_fkey"
  FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_business_id_category_id_fkey"
  FOREIGN KEY ("business_id", "category_id") REFERENCES "categories"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of an item or a category, in a quantity of at least one.
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_one_target" CHECK (
  ("product_id" IS NULL) <> ("category_id" IS NULL)
);
ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_quantity_positive" CHECK ("quantity" BETWEEN 1 AND 20);

-- Closed to Supabase's Data API, like every other table.
ALTER TABLE "promotion_targets" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "promotion_targets" FROM anon, authenticated;
  END IF;
END
$$;
