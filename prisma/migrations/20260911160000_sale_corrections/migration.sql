-- Paid sales are never edited or deleted. A cancellation or exchange is an
-- append-only correction, with signed per-brand deltas and ordinary ledger
-- entries for the money that moved.

CREATE TYPE "CorrectionKind" AS ENUM ('CANCEL', 'EXCHANGE');

CREATE TABLE "sale_corrections" (
    "id" TEXT NOT NULL,
    "client_txn_id" TEXT NOT NULL,
    "original_order_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "kind" "CorrectionKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "delta_sen" INTEGER NOT NULL,
    "replacement_items" JSONB,
    "replacement_cart_discount_sen" INTEGER,
    "replacement_total_sen" INTEGER,
    "replacement_menu_price_sen" INTEGER,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_corrections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "correction_brand_deltas" (
    "id" BIGSERIAL NOT NULL,
    "correction_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "delta_sen" INTEGER NOT NULL,

    CONSTRAINT "correction_brand_deltas_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ledger_entries" ADD COLUMN "correction_id" TEXT;

CREATE UNIQUE INDEX "sale_corrections_client_txn_id_key"
    ON "sale_corrections"("client_txn_id");
CREATE INDEX "sale_corrections_original_order_id_created_at_idx"
    ON "sale_corrections"("original_order_id", "created_at");
CREATE INDEX "sale_corrections_shift_id_idx" ON "sale_corrections"("shift_id");
CREATE INDEX "sale_corrections_business_date_idx" ON "sale_corrections"("business_date");
CREATE UNIQUE INDEX "correction_brand_deltas_correction_id_brand_id_key"
    ON "correction_brand_deltas"("correction_id", "brand_id");
CREATE INDEX "correction_brand_deltas_brand_id_idx"
    ON "correction_brand_deltas"("brand_id");
CREATE INDEX "ledger_entries_correction_id_idx" ON "ledger_entries"("correction_id");

ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_original_order_id_fkey"
    FOREIGN KEY ("original_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_shift_id_fkey"
    FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "correction_brand_deltas" ADD CONSTRAINT "correction_brand_deltas_correction_id_fkey"
    FOREIGN KEY ("correction_id") REFERENCES "sale_corrections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "correction_brand_deltas" ADD CONSTRAINT "correction_brand_deltas_brand_id_fkey"
    FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_correction_id_fkey"
    FOREIGN KEY ("correction_id") REFERENCES "sale_corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_reason_present"
    CHECK (length(btrim("reason")) > 0);
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_replacement_shape"
    CHECK (
      ("kind" = 'CANCEL'
        AND "delta_sen" <= 0
        AND "replacement_items" IS NULL
        AND "replacement_cart_discount_sen" IS NULL
        AND "replacement_total_sen" IS NULL
        AND "replacement_menu_price_sen" IS NULL)
      OR
      ("kind" = 'EXCHANGE'
        AND "replacement_items" IS NOT NULL
        AND "replacement_cart_discount_sen" IS NOT NULL
        AND "replacement_cart_discount_sen" >= 0
        AND "replacement_total_sen" IS NOT NULL
        AND "replacement_total_sen" >= 0
        AND "replacement_menu_price_sen" IS NOT NULL
        AND "replacement_menu_price_sen" >= 0)
    );
ALTER TABLE "correction_brand_deltas" ADD CONSTRAINT "correction_brand_delta_non_zero"
    CHECK ("delta_sen" <> 0);
