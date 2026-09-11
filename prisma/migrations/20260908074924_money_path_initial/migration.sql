-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER_FOOD', 'OWNER_DRINKS', 'CASHIER');

-- CreateEnum
CREATE TYPE "ModifierType" AS ENUM ('ADD_ON', 'REMOVAL');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('NOT_REQUIRED', 'UNRECONCILED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('MANUALLY_CONFIRMED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderOrigin" AS ENUM ('ONLINE', 'OFFLINE_SYNC');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('NONE', 'FLAGGED', 'DISMISSED', 'RESOLVED_REFUND', 'RESOLVED_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('MONEY_IN', 'MONEY_OUT');

-- CreateEnum
CREATE TYPE "LedgerCategory" AS ENUM ('REVENUE', 'REFUND', 'OPERATING_EXPENSE', 'CAPITAL_INJECTION', 'CAPITAL_ASSET', 'OWNER_DRAWING', 'LOAN_PROCEEDS', 'LOAN_REPAYMENT', 'RECONCILIATION_ADJUSTMENT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "pin_hash" TEXT,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "soft_colour" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "base_price_sen" INTEGER NOT NULL,
    "image_url" TEXT,
    "is_sold_out" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_groups" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "min_select" INTEGER NOT NULL DEFAULT 0,
    "max_select" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_items" (
    "id" TEXT NOT NULL,
    "modifier_group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_sen" INTEGER NOT NULL DEFAULT 0,
    "type" "ModifierType" NOT NULL DEFAULT 'ADD_ON',
    "is_sold_out" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "opened_by_id" TEXT NOT NULL,
    "closed_by_id" TEXT,
    "declared_bank_total_sen" INTEGER,
    "system_net_sales_sen" INTEGER,
    "variance_sen" INTEGER,
    "reconciliation_status" "ReconciliationStatus" NOT NULL DEFAULT 'NOT_REQUIRED',

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_counters" (
    "business_date" DATE NOT NULL,
    "current_val" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_counters_pkey" PRIMARY KEY ("business_date")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "queue_number" TEXT NOT NULL,
    "offline_label" TEXT,
    "client_txn_id" TEXT NOT NULL,
    "origin" "OrderOrigin" NOT NULL DEFAULT 'ONLINE',
    "gross_sen" INTEGER NOT NULL,
    "line_discount_sen" INTEGER NOT NULL DEFAULT 0,
    "order_discount_sen" INTEGER NOT NULL DEFAULT 0,
    "total_amount_sen" INTEGER NOT NULL,
    "payment_status" "OrderPaymentStatus" NOT NULL DEFAULT 'MANUALLY_CONFIRMED',
    "payment_mode" TEXT NOT NULL DEFAULT 'DUITNOW_QR',
    "confirmed_by_id" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "flag_status" "FlagStatus" NOT NULL DEFAULT 'NONE',
    "flag_reason" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" TEXT,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_sen" INTEGER NOT NULL,
    "modifier_total_sen" INTEGER NOT NULL DEFAULT 0,
    "line_discount_sen" INTEGER NOT NULL DEFAULT 0,
    "allocated_order_discount_sen" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "modifier_item_id" TEXT,
    "name" TEXT NOT NULL,
    "price_sen" INTEGER NOT NULL DEFAULT 0,
    "type" "ModifierType" NOT NULL DEFAULT 'ADD_ON',

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "business_date" DATE NOT NULL,
    "entry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" "LedgerDirection" NOT NULL,
    "amount_sen" INTEGER NOT NULL,
    "category" "LedgerCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "brand_id" TEXT,
    "order_id" TEXT,
    "shift_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_brand_id_name_key" ON "categories"("brand_id", "name");

-- CreateIndex
CREATE INDEX "products_brand_id_idx" ON "products"("brand_id");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "modifier_groups_product_id_idx" ON "modifier_groups"("product_id");

-- CreateIndex
CREATE INDEX "modifier_items_modifier_group_id_idx" ON "modifier_items"("modifier_group_id");

-- CreateIndex
CREATE INDEX "shifts_business_date_idx" ON "shifts"("business_date");

-- CreateIndex
CREATE INDEX "shifts_status_idx" ON "shifts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_client_txn_id_key" ON "orders"("client_txn_id");

-- CreateIndex
CREATE INDEX "orders_shift_id_idx" ON "orders"("shift_id");

-- CreateIndex
CREATE INDEX "orders_business_date_idx" ON "orders"("business_date");

-- CreateIndex
CREATE INDEX "orders_needs_review_idx" ON "orders"("needs_review");

-- CreateIndex
CREATE UNIQUE INDEX "orders_business_date_queue_number_key" ON "orders"("business_date", "queue_number");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_brand_id_idx" ON "order_items"("brand_id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_order_item_id_idx" ON "order_item_modifiers"("order_item_id");

-- CreateIndex
CREATE INDEX "ledger_entries_business_date_id_idx" ON "ledger_entries"("business_date", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries"("order_id");

-- CreateIndex
CREATE INDEX "ledger_entries_shift_id_idx" ON "ledger_entries"("shift_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_items" ADD CONSTRAINT "modifier_items_modifier_group_id_fkey" FOREIGN KEY ("modifier_group_id") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_modifier_item_id_fkey" FOREIGN KEY ("modifier_item_id") REFERENCES "modifier_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
