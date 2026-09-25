-- Vista becomes multi-business.
--
-- Every business-owned table gets `business_id`, and every relation between
-- them becomes a composite foreign key `(business_id, x_id) → x(business_id, id)`,
-- so a row can only ever point at rows of its own business.
--
-- Written as expand → backfill → constrain, because it runs against live books:
--   1. Create `businesses`, add every `business_id` as NULLABLE.
--   2. If the database already holds a business, give it a `businesses` row and
--      stamp that id on every existing row. It keeps partner settlement on.
--      An empty database (a fresh install, the test database) gets nothing.
--   3. Make the columns NOT NULL, swap the singleton keys for per-business ones,
--      and rebuild every foreign key and uniqueness rule per business.
-- The whole file runs in one transaction: it applies completely or not at all.

-- ---------------------------------------------------------------------------
-- 1. Expand
-- ---------------------------------------------------------------------------

ALTER TYPE "SessionScope" ADD VALUE 'HUB';

CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "users"                   ADD COLUMN "business_id" TEXT;
ALTER TABLE "brands"                  ADD COLUMN "business_id" TEXT;
ALTER TABLE "categories"              ADD COLUMN "business_id" TEXT;
ALTER TABLE "products"                ADD COLUMN "business_id" TEXT;
ALTER TABLE "modifier_groups"         ADD COLUMN "business_id" TEXT;
ALTER TABLE "modifier_items"          ADD COLUMN "business_id" TEXT;
ALTER TABLE "shifts"                  ADD COLUMN "business_id" TEXT;
ALTER TABLE "queue_counters"          ADD COLUMN "business_id" TEXT;
ALTER TABLE "orders"                  ADD COLUMN "business_id" TEXT;
ALTER TABLE "sale_corrections"        ADD COLUMN "business_id" TEXT;
ALTER TABLE "correction_brand_deltas" ADD COLUMN "business_id" TEXT;
ALTER TABLE "order_items"             ADD COLUMN "business_id" TEXT;
ALTER TABLE "order_item_modifiers"    ADD COLUMN "business_id" TEXT;
ALTER TABLE "ledger_entries"          ADD COLUMN "business_id" TEXT;
ALTER TABLE "account_settings"        ADD COLUMN "business_id" TEXT;
ALTER TABLE "account_settings"        ADD COLUMN "settlement_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "expenses"                ADD COLUMN "business_id" TEXT;
ALTER TABLE "period_closures"         ADD COLUMN "business_id" TEXT;
ALTER TABLE "terminal_status"         ADD COLUMN "business_id" TEXT;
ALTER TABLE "sessions"                ADD COLUMN "business_id" TEXT;
ALTER TABLE "partners"                ADD COLUMN "business_id" TEXT;

-- ---------------------------------------------------------------------------
-- 2. Backfill the business that already exists
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  existing_id TEXT;
BEGIN
  -- Anything at all means a business is already trading here.
  IF NOT (EXISTS (SELECT 1 FROM "users")
       OR EXISTS (SELECT 1 FROM "brands")
       OR EXISTS (SELECT 1 FROM "account_settings")) THEN
    RETURN;
  END IF;

  existing_id := gen_random_uuid()::text;

  INSERT INTO "businesses" ("id", "name")
  VALUES (
    existing_id,
    COALESCE((SELECT "business_name" FROM "account_settings" LIMIT 1), 'Vista')
  );

  UPDATE "users"                   SET "business_id" = existing_id;
  UPDATE "brands"                  SET "business_id" = existing_id;
  UPDATE "categories"              SET "business_id" = existing_id;
  UPDATE "products"                SET "business_id" = existing_id;
  UPDATE "modifier_groups"         SET "business_id" = existing_id;
  UPDATE "modifier_items"          SET "business_id" = existing_id;
  UPDATE "shifts"                  SET "business_id" = existing_id;
  UPDATE "queue_counters"          SET "business_id" = existing_id;
  UPDATE "orders"                  SET "business_id" = existing_id;
  UPDATE "sale_corrections"        SET "business_id" = existing_id;
  UPDATE "correction_brand_deltas" SET "business_id" = existing_id;
  UPDATE "order_items"             SET "business_id" = existing_id;
  UPDATE "order_item_modifiers"    SET "business_id" = existing_id;
  UPDATE "ledger_entries"          SET "business_id" = existing_id;
  UPDATE "expenses"                SET "business_id" = existing_id;
  UPDATE "period_closures"         SET "business_id" = existing_id;
  UPDATE "terminal_status"         SET "business_id" = existing_id;
  UPDATE "sessions"                SET "business_id" = existing_id;
  UPDATE "partners"                SET "business_id" = existing_id;
  -- The business that exists today is the one partner settlement was built for.
  UPDATE "account_settings"        SET "business_id" = existing_id, "settlement_enabled" = true;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Constrain
-- ---------------------------------------------------------------------------

ALTER TABLE "users"                   ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "brands"                  ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "categories"              ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "products"                ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "modifier_groups"         ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "modifier_items"          ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "shifts"                  ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "queue_counters"          ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "orders"                  ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "sale_corrections"        ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "correction_brand_deltas" ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "order_items"             ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "order_item_modifiers"    ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "ledger_entries"          ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "account_settings"        ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "expenses"                ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "period_closures"         ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "terminal_status"         ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "sessions"                ALTER COLUMN "business_id" SET NOT NULL;
ALTER TABLE "partners"                ALTER COLUMN "business_id" SET NOT NULL;

-- One settings row and one terminal row per business, instead of one in total.
ALTER TABLE "account_settings" DROP CONSTRAINT "account_settings_singleton";
ALTER TABLE "account_settings" DROP CONSTRAINT "account_settings_pkey";
ALTER TABLE "account_settings" DROP COLUMN "id";
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_pkey" PRIMARY KEY ("business_id");

ALTER TABLE "terminal_status" DROP CONSTRAINT "terminal_status_singleton";
ALTER TABLE "terminal_status" DROP CONSTRAINT "terminal_status_pkey";
ALTER TABLE "terminal_status" DROP COLUMN "id";
ALTER TABLE "terminal_status" ADD CONSTRAINT "terminal_status_pkey" PRIMARY KEY ("business_id");

-- Queue numbers restart daily for each business separately.
ALTER TABLE "queue_counters" DROP CONSTRAINT "queue_counters_pkey";
ALTER TABLE "queue_counters" ADD CONSTRAINT "queue_counters_pkey" PRIMARY KEY ("business_id", "business_date");

-- One open shift per business, not one across every business.
DROP INDEX "shifts_single_open_idx";
CREATE UNIQUE INDEX "shifts_single_open_idx" ON "shifts" ("business_id") WHERE "status" = 'OPEN';

-- No two settled periods of the same business may share a day. Comparing the
-- text business id inside a GiST exclusion needs btree_gist.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "period_closures" DROP CONSTRAINT "period_closures_no_overlap";
ALTER TABLE "period_closures" ADD CONSTRAINT "period_closures_no_overlap"
  EXCLUDE USING gist ("business_id" WITH =, daterange("start_date", "end_date", $$[]$$) WITH &&);

-- Old single-column foreign keys. Replaced below by composite ones.
ALTER TABLE "categories"              DROP CONSTRAINT "categories_brand_id_fkey";
ALTER TABLE "products"                DROP CONSTRAINT "products_brand_id_fkey";
ALTER TABLE "products"                DROP CONSTRAINT "products_category_id_fkey";
ALTER TABLE "modifier_groups"         DROP CONSTRAINT "modifier_groups_product_id_fkey";
ALTER TABLE "modifier_items"          DROP CONSTRAINT "modifier_items_modifier_group_id_fkey";
ALTER TABLE "shifts"                  DROP CONSTRAINT "shifts_opened_by_id_fkey";
ALTER TABLE "shifts"                  DROP CONSTRAINT "shifts_closed_by_id_fkey";
ALTER TABLE "orders"                  DROP CONSTRAINT "orders_shift_id_fkey";
ALTER TABLE "orders"                  DROP CONSTRAINT "orders_confirmed_by_id_fkey";
ALTER TABLE "sale_corrections"        DROP CONSTRAINT "sale_corrections_original_order_id_fkey";
ALTER TABLE "sale_corrections"        DROP CONSTRAINT "sale_corrections_shift_id_fkey";
ALTER TABLE "sale_corrections"        DROP CONSTRAINT "sale_corrections_created_by_id_fkey";
ALTER TABLE "correction_brand_deltas" DROP CONSTRAINT "correction_brand_deltas_correction_id_fkey";
ALTER TABLE "correction_brand_deltas" DROP CONSTRAINT "correction_brand_deltas_brand_id_fkey";
ALTER TABLE "order_items"             DROP CONSTRAINT "order_items_order_id_fkey";
ALTER TABLE "order_items"             DROP CONSTRAINT "order_items_product_id_fkey";
ALTER TABLE "order_items"             DROP CONSTRAINT "order_items_brand_id_fkey";
ALTER TABLE "order_items"             DROP CONSTRAINT "order_items_category_id_fkey";
ALTER TABLE "order_item_modifiers"    DROP CONSTRAINT "order_item_modifiers_order_item_id_fkey";
ALTER TABLE "ledger_entries"          DROP CONSTRAINT "ledger_entries_brand_id_fkey";
ALTER TABLE "ledger_entries"          DROP CONSTRAINT "ledger_entries_order_id_fkey";
ALTER TABLE "ledger_entries"          DROP CONSTRAINT "ledger_entries_shift_id_fkey";
ALTER TABLE "ledger_entries"          DROP CONSTRAINT "ledger_entries_correction_id_fkey";
ALTER TABLE "expenses"                DROP CONSTRAINT "expenses_brand_id_fkey";
ALTER TABLE "expenses"                DROP CONSTRAINT "expenses_created_by_id_fkey";
ALTER TABLE "period_closures"         DROP CONSTRAINT "period_closures_closed_by_id_fkey";
ALTER TABLE "sessions"                DROP CONSTRAINT "sessions_user_id_fkey";
ALTER TABLE "partners"                DROP CONSTRAINT "partners_brand_id_fkey";

-- Indexes and uniqueness that were global and are now per business.
DROP INDEX "brands_name_key";
DROP INDEX "shifts_business_date_idx";
DROP INDEX "shifts_status_idx";
DROP INDEX "orders_business_date_idx";
DROP INDEX "orders_business_date_queue_number_key";
DROP INDEX "sale_corrections_business_date_idx";
DROP INDEX "ledger_entries_business_date_id_idx";
DROP INDEX "expenses_business_date_idx";
DROP INDEX "period_closures_end_date_idx";
DROP INDEX "sessions_scope_revoked_at_idx";
DROP INDEX "partners_brand_id_key";
DROP INDEX "partners_role_key";

-- Handoff codes: the one-time pass from vistahub.my to the POS or RMS.
CREATE TABLE "handoff_codes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "target" "SessionScope" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handoff_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "handoff_codes_code_hash_key" ON "handoff_codes"("code_hash");
CREATE INDEX "handoff_codes_expires_at_idx" ON "handoff_codes"("expires_at");

-- The `(business_id, id)` keys the composite foreign keys point at.
CREATE UNIQUE INDEX "users_business_id_id_key" ON "users"("business_id", "id");
CREATE UNIQUE INDEX "brands_business_id_id_key" ON "brands"("business_id", "id");
CREATE UNIQUE INDEX "categories_business_id_id_key" ON "categories"("business_id", "id");
CREATE UNIQUE INDEX "products_business_id_id_key" ON "products"("business_id", "id");
CREATE UNIQUE INDEX "modifier_groups_business_id_id_key" ON "modifier_groups"("business_id", "id");
CREATE UNIQUE INDEX "modifier_items_business_id_id_key" ON "modifier_items"("business_id", "id");
CREATE UNIQUE INDEX "shifts_business_id_id_key" ON "shifts"("business_id", "id");
CREATE UNIQUE INDEX "orders_business_id_id_key" ON "orders"("business_id", "id");
CREATE UNIQUE INDEX "sale_corrections_business_id_id_key" ON "sale_corrections"("business_id", "id");
CREATE UNIQUE INDEX "order_items_business_id_id_key" ON "order_items"("business_id", "id");

-- Per-business uniqueness and lookup indexes.
CREATE UNIQUE INDEX "brands_business_id_name_key" ON "brands"("business_id", "name");
CREATE UNIQUE INDEX "orders_business_id_business_date_queue_number_key" ON "orders"("business_id", "business_date", "queue_number");
CREATE UNIQUE INDEX "partners_business_id_brand_id_key" ON "partners"("business_id", "brand_id");
CREATE UNIQUE INDEX "partners_business_id_role_key" ON "partners"("business_id", "role");
CREATE INDEX "shifts_business_id_business_date_idx" ON "shifts"("business_id", "business_date");
CREATE INDEX "shifts_business_id_status_idx" ON "shifts"("business_id", "status");
CREATE INDEX "orders_business_id_business_date_idx" ON "orders"("business_id", "business_date");
CREATE INDEX "sale_corrections_business_id_business_date_idx" ON "sale_corrections"("business_id", "business_date");
CREATE INDEX "ledger_entries_business_id_business_date_id_idx" ON "ledger_entries"("business_id", "business_date", "id");
CREATE INDEX "expenses_business_id_business_date_idx" ON "expenses"("business_id", "business_date");
CREATE INDEX "period_closures_business_id_end_date_idx" ON "period_closures"("business_id", "end_date");
CREATE INDEX "sessions_business_id_scope_revoked_at_idx" ON "sessions"("business_id", "scope", "revoked_at");

-- Every table's link to its business.
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brands" ADD CONSTRAINT "brands_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "queue_counters" ADD CONSTRAINT "queue_counters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "terminal_status" ADD CONSTRAINT "terminal_status_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "handoff_codes" ADD CONSTRAINT "handoff_codes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite foreign keys: a row can only point at rows of its own business.
ALTER TABLE "categories" ADD CONSTRAINT "categories_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_category_id_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_items" ADD CONSTRAINT "modifier_items_business_id_modifier_group_id_fkey" FOREIGN KEY ("business_id", "modifier_group_id") REFERENCES "modifier_groups"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_business_id_opened_by_id_fkey" FOREIGN KEY ("business_id", "opened_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_business_id_closed_by_id_fkey" FOREIGN KEY ("business_id", "closed_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_id_shift_id_fkey" FOREIGN KEY ("business_id", "shift_id") REFERENCES "shifts"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_id_confirmed_by_id_fkey" FOREIGN KEY ("business_id", "confirmed_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_business_id_original_order_id_fkey" FOREIGN KEY ("business_id", "original_order_id") REFERENCES "orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_business_id_shift_id_fkey" FOREIGN KEY ("business_id", "shift_id") REFERENCES "shifts"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_corrections" ADD CONSTRAINT "sale_corrections_business_id_created_by_id_fkey" FOREIGN KEY ("business_id", "created_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "correction_brand_deltas" ADD CONSTRAINT "correction_brand_deltas_business_id_correction_id_fkey" FOREIGN KEY ("business_id", "correction_id") REFERENCES "sale_corrections"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "correction_brand_deltas" ADD CONSTRAINT "correction_brand_deltas_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "orders"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_business_id_category_id_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_business_id_order_item_id_fkey" FOREIGN KEY ("business_id", "order_item_id") REFERENCES "order_items"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_order_id_fkey" FOREIGN KEY ("business_id", "order_id") REFERENCES "orders"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_shift_id_fkey" FOREIGN KEY ("business_id", "shift_id") REFERENCES "shifts"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_business_id_correction_id_fkey" FOREIGN KEY ("business_id", "correction_id") REFERENCES "sale_corrections"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_created_by_id_fkey" FOREIGN KEY ("business_id", "created_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "period_closures" ADD CONSTRAINT "period_closures_business_id_closed_by_id_fkey" FOREIGN KEY ("business_id", "closed_by_id") REFERENCES "users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_business_id_user_id_fkey" FOREIGN KEY ("business_id", "user_id") REFERENCES "users"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handoff_codes" ADD CONSTRAINT "handoff_codes_business_id_user_id_fkey" FOREIGN KEY ("business_id", "user_id") REFERENCES "users"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partners" ADD CONSTRAINT "partners_business_id_brand_id_fkey" FOREIGN KEY ("business_id", "brand_id") REFERENCES "brands"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Shut Supabase's Data API out of the two new tables, exactly as
-- 20260915120000_supabase_hosting did for the rest: RLS on with no policies,
-- and no privileges for `anon` or `authenticated`. Revoked explicitly rather than
-- trusting the default-privilege change to have covered them.
ALTER TABLE "businesses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "handoff_codes" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "businesses", "handoff_codes" FROM anon, authenticated;
  END IF;
END
$$;
