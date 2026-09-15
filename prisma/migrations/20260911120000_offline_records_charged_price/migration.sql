-- An offline sale records the money that actually moved.
--
-- Before this, a sale rung up offline was written at whatever the menu said when
-- it finally synced. A customer who paid RM 12.00 against a cached menu was
-- booked at RM 12.50 if the price had moved — revenue that never arrived, and a
-- shift that could never be reconciled against the bank.
--
-- `total_amount_sen` now means what the customer paid, always. The server's own
-- recomputation is kept beside it so the divergence stays visible and reportable
-- instead of being discarded.

ALTER TABLE "orders" ADD COLUMN "menu_price_sen" INTEGER;

-- Every existing row was written at the server's price, so for those two figures
-- are the same by definition.
UPDATE "orders" SET "menu_price_sen" = "total_amount_sen" WHERE "menu_price_sen" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "menu_price_sen" SET NOT NULL;

ALTER TABLE "orders" ADD CONSTRAINT "orders_menu_price_non_negative"
  CHECK ("menu_price_sen" >= 0);
