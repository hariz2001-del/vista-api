-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CampaignSourceKind" AS ENUM ('NONE', 'GOOGLE_SHEET');

-- CreateEnum
CREATE TYPE "CampaignImageKind" AS ENUM ('BACKGROUND', 'LOGO');

-- CreateEnum
CREATE TYPE "CampaignBenefitKind" AS ENUM ('PREPAID_PRODUCT', 'FIXED_VOUCHER');

-- CreateEnum
CREATE TYPE "CampaignVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CampaignProofRead" AS ENUM ('PENDING', 'READING', 'DONE', 'FAILED', 'NONE');

-- CreateEnum
CREATE TYPE "CampaignRedemptionStatus" AS ENUM ('COMPLETED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CampaignSyncStatus" AS ENUM ('RUNNING', 'OK', 'FAILED');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "brand_id" TEXT,
    "tile_tone" TEXT NOT NULL DEFAULT 'LIGHT',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "starts_on" DATE,
    "ends_on" DATE,
    "source_kind" "CampaignSourceKind" NOT NULL DEFAULT 'NONE',
    "source_config" JSONB NOT NULL DEFAULT '{}',
    "source_secret" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_images" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "CampaignImageKind" NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_products" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_key" TEXT,
    "price_sen" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_benefits" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_product_id" TEXT,
    "kind" "CampaignBenefitKind" NOT NULL,
    "label" TEXT NOT NULL,
    "value_sen" INTEGER NOT NULL,
    "product_id" TEXT,
    "category_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expires_on" DATE,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_benefits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_orders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "contact" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "expected_sen" INTEGER NOT NULL,
    "fulfilment" JSONB NOT NULL DEFAULT '{}',
    "source_data" JSONB NOT NULL DEFAULT '{}',
    "source_status" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verification" "CampaignVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "payment_date" DATE,
    "payment_ref" TEXT,
    "paid_sen" INTEGER,
    "decided_by_id" TEXT,
    "decided_by_label" TEXT,
    "decided_at" TIMESTAMP(3),
    "review_note" TEXT,
    "ledger_entry_id" BIGINT,
    "reversal_entry_id" BIGINT,
    "sheet_dirty" BOOLEAN NOT NULL DEFAULT false,
    "sheet_pushed_at" TIMESTAMP(3),
    "sheet_push_error" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_order_lines" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "campaign_product_id" TEXT,
    "line_no" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "price_sen" INTEGER NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "campaign_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_coupons" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_line_id" TEXT,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_payment_proofs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "source_ref" TEXT,
    "source_url" TEXT,
    "mime_type" TEXT,
    "sha256" TEXT,
    "read_status" "CampaignProofRead" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "last_error" TEXT,
    "extraction" JSONB,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "read_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_payment_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_redemptions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "campaign_order_id" TEXT NOT NULL,
    "pos_order_id" TEXT NOT NULL,
    "client_txn_id" TEXT NOT NULL,
    "status" "CampaignRedemptionStatus" NOT NULL DEFAULT 'COMPLETED',
    "applied" JSONB NOT NULL,
    "prepaid_sen" INTEGER NOT NULL,
    "voucher_sen" INTEGER NOT NULL,
    "redeemed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMP(3),

    CONSTRAINT "campaign_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_sync_runs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "CampaignSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "added" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "campaign_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "order_id" TEXT,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_business_id_status_sort_order_idx" ON "campaigns"("business_id", "status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_business_id_id_key" ON "campaigns"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_images_business_id_id_key" ON "campaign_images"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_images_business_id_campaign_id_kind_key" ON "campaign_images"("business_id", "campaign_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_products_business_id_id_key" ON "campaign_products"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_products_business_id_campaign_id_external_key_key" ON "campaign_products"("business_id", "campaign_id", "external_key");

-- CreateIndex
CREATE INDEX "campaign_benefits_business_id_campaign_id_idx" ON "campaign_benefits"("business_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_benefits_business_id_id_key" ON "campaign_benefits"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_orders_ledger_entry_id_key" ON "campaign_orders"("ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_orders_reversal_entry_id_key" ON "campaign_orders"("reversal_entry_id");

-- CreateIndex
CREATE INDEX "campaign_orders_business_id_campaign_id_verification_idx" ON "campaign_orders"("business_id", "campaign_id", "verification");

-- CreateIndex
CREATE INDEX "campaign_orders_business_id_campaign_id_sheet_dirty_idx" ON "campaign_orders"("business_id", "campaign_id", "sheet_dirty");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_orders_business_id_id_key" ON "campaign_orders"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_orders_business_id_campaign_id_external_ref_key" ON "campaign_orders"("business_id", "campaign_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_order_lines_business_id_id_key" ON "campaign_order_lines"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_order_lines_business_id_order_id_line_no_key" ON "campaign_order_lines"("business_id", "order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_coupons_business_id_id_key" ON "campaign_coupons"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_coupons_business_id_code_key" ON "campaign_coupons"("business_id", "code");

-- CreateIndex
CREATE INDEX "campaign_payment_proofs_business_id_sha256_idx" ON "campaign_payment_proofs"("business_id", "sha256");

-- CreateIndex
CREATE INDEX "campaign_payment_proofs_read_status_lease_until_idx" ON "campaign_payment_proofs"("read_status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_payment_proofs_business_id_id_key" ON "campaign_payment_proofs"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_payment_proofs_business_id_order_id_key" ON "campaign_payment_proofs"("business_id", "order_id");

-- CreateIndex
CREATE INDEX "campaign_redemptions_business_id_coupon_id_idx" ON "campaign_redemptions"("business_id", "coupon_id");

-- CreateIndex
CREATE INDEX "campaign_redemptions_business_id_pos_order_id_idx" ON "campaign_redemptions"("business_id", "pos_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_redemptions_business_id_id_key" ON "campaign_redemptions"("business_id", "id");

-- CreateIndex
CREATE INDEX "campaign_sync_runs_business_id_campaign_id_started_at_idx" ON "campaign_sync_runs"("business_id", "campaign_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_sync_runs_business_id_id_key" ON "campaign_sync_runs"("business_id", "id");

-- CreateIndex
CREATE INDEX "campaign_audit_log_business_id_campaign_id_created_at_idx" ON "campaign_audit_log"("business_id", "campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "campaign_audit_log_business_id_order_id_idx" ON "campaign_audit_log"("business_id", "order_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_images" ADD CONSTRAINT "campaign_images_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_images" ADD CONSTRAINT "campaign_images_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_benefits" ADD CONSTRAINT "campaign_benefits_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_benefits" ADD CONSTRAINT "campaign_benefits_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_benefits" ADD CONSTRAINT "campaign_benefits_business_id_campaign_product_id_fkey" FOREIGN KEY ("business_id", "campaign_product_id") REFERENCES "campaign_products"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_benefits" ADD CONSTRAINT "campaign_benefits_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_reversal_entry_id_fkey" FOREIGN KEY ("reversal_entry_id") REFERENCES "ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_order_lines" ADD CONSTRAINT "campaign_order_lines_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_order_lines" ADD CONSTRAINT "campaign_order_lines_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "campaign_orders"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_order_lines" ADD CONSTRAINT "campaign_order_lines_business_id_campaign_product_id_fkey" FOREIGN KEY ("business_id", "campaign_product_id") REFERENCES "campaign_products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_coupons" ADD CONSTRAINT "campaign_coupons_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_coupons" ADD CONSTRAINT "campaign_coupons_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_coupons" ADD CONSTRAINT "campaign_coupons_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "campaign_orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_coupons" ADD CONSTRAINT "campaign_coupons_business_id_order_line_id_fkey" FOREIGN KEY ("business_id", "order_line_id") REFERENCES "campaign_order_lines"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_payment_proofs" ADD CONSTRAINT "campaign_payment_proofs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_payment_proofs" ADD CONSTRAINT "campaign_payment_proofs_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "campaign_orders"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_business_id_coupon_id_fkey" FOREIGN KEY ("business_id", "coupon_id") REFERENCES "campaign_coupons"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_business_id_campaign_order_id_fkey" FOREIGN KEY ("business_id", "campaign_order_id") REFERENCES "campaign_orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_business_id_pos_order_id_fkey" FOREIGN KEY ("business_id", "pos_order_id") REFERENCES "orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sync_runs" ADD CONSTRAINT "campaign_sync_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sync_runs" ADD CONSTRAINT "campaign_sync_runs_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audit_log" ADD CONSTRAINT "campaign_audit_log_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audit_log" ADD CONSTRAINT "campaign_audit_log_business_id_campaign_id_fkey" FOREIGN KEY ("business_id", "campaign_id") REFERENCES "campaigns"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A coupon is used at most once: one COMPLETED redemption per coupon. A
-- cancelled sale marks its redemption REVERSED, freeing the coupon again.
CREATE UNIQUE INDEX "campaign_redemptions_one_completed_per_coupon"
  ON "campaign_redemptions"("business_id", "coupon_id") WHERE "status" = 'COMPLETED';

-- Money is never negative here.
ALTER TABLE "campaign_products" ADD CONSTRAINT "campaign_products_price_check" CHECK ("price_sen" >= 0);
ALTER TABLE "campaign_benefits" ADD CONSTRAINT "campaign_benefits_value_check" CHECK ("value_sen" >= 0);
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_expected_check" CHECK ("expected_sen" >= 0);
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_paid_check" CHECK ("paid_sen" IS NULL OR "paid_sen" >= 0);
ALTER TABLE "campaign_order_lines" ADD CONSTRAINT "campaign_order_lines_price_check" CHECK ("price_sen" >= 0);
ALTER TABLE "campaign_redemptions" ADD CONSTRAINT "campaign_redemptions_amounts_check" CHECK ("prepaid_sen" >= 0 AND "voucher_sen" >= 0);
-- A verified order has the date it was paid on and its revenue line.
ALTER TABLE "campaign_orders" ADD CONSTRAINT "campaign_orders_verified_is_posted"
  CHECK ("verification" <> 'VERIFIED' OR ("payment_date" IS NOT NULL AND "ledger_entry_id" IS NOT NULL));

-- The campaign audit trail is append-only.
CREATE FUNCTION "campaign_audit_is_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the campaign audit log is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "campaign_audit_log_append_only" BEFORE UPDATE OR DELETE ON "campaign_audit_log"
  FOR EACH ROW EXECUTE FUNCTION "campaign_audit_is_append_only"();

-- Closed to Supabase's Data API, like every other table.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns','campaign_images','campaign_products','campaign_benefits','campaign_orders',
    'campaign_order_lines','campaign_coupons','campaign_payment_proofs','campaign_redemptions','campaign_sync_runs','campaign_audit_log']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END
$$;
