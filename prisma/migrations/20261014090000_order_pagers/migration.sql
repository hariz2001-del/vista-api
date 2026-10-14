ALTER TABLE "account_settings" ADD COLUMN "pager_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "pager_number" VARCHAR(4);
ALTER TABLE "orders" ADD CONSTRAINT "orders_pager_number_valid" CHECK (pager_number IS NULL OR pager_number ~ '^[0-9]{1,4}$');
