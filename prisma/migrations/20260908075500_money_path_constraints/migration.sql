-- Constraints Prisma's schema language cannot express.
--
-- These are not belt-and-braces: each one makes a class of money bug impossible
-- at the database level rather than merely unlikely at the application level.

-- A single counter cannot have two shifts open at once. Without this, a
-- double-tap on "open shift" leaves two OPEN rows and the declared bank total
-- at close becomes ambiguous.
CREATE UNIQUE INDEX "shifts_single_open_idx"
  ON "shifts" ((1))
  WHERE "status" = 'OPEN';

-- The order header must actually add up. If this ever fails, the checkout
-- transaction is wrong and the sale must not be written at all.
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_adds_up"
  CHECK ("total_amount_sen" = "gross_sen" - "line_discount_sen" - "order_discount_sen");

ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK (
    "gross_sen" >= 0
    AND "line_discount_sen" >= 0
    AND "order_discount_sen" >= 0
    AND "total_amount_sen" >= 0
  );

-- No line may be discounted below zero, whether by its own discount or by its
-- share of the order-wide one.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_net_non_negative"
  CHECK (
    ("unit_price_sen" + "modifier_total_sen") * "quantity"
      >= "line_discount_sen" + "allocated_order_discount_sen"
  );

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_sane"
  CHECK (
    "quantity" > 0
    AND "unit_price_sen" >= 0
    AND "modifier_total_sen" >= 0
    AND "line_discount_sen" >= 0
    AND "allocated_order_discount_sen" >= 0
  );

-- Direction carries the sign; the amount is always a positive magnitude. A
-- negative MONEY_IN would flip the running balance in a way no report expects.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_amount_positive"
  CHECK ("amount_sen" > 0);

ALTER TABLE "queue_counters" ADD CONSTRAINT "queue_counter_non_negative"
  CHECK ("current_val" >= 0);

ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_group_select_range"
  CHECK ("min_select" >= 0 AND "max_select" >= "min_select");

-- A closed shift must carry the numbers that closing produces, and an open one
-- must not pretend to.
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_has_totals"
  CHECK (
    ("status" = 'OPEN'   AND "closed_at" IS NULL AND "system_net_sales_sen" IS NULL)
    OR
    ("status" = 'CLOSED' AND "closed_at" IS NOT NULL AND "system_net_sales_sen" IS NOT NULL)
  );
