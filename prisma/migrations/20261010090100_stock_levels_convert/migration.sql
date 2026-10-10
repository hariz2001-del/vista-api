-- Counts sent on the old three-step scale move onto the five-step bar, as the
-- owner asked: more than half is 75%, half stays 50%, less than half is 25%.
-- (A separate migration: a value added by ALTER TYPE cannot be used in the
-- transaction that added it.)
UPDATE "stock_count_lines" SET "balance" = 'THREE_QUARTERS' WHERE "balance" = 'MORE_THAN_HALF';
UPDATE "stock_count_lines" SET "balance" = 'QUARTER' WHERE "balance" = 'LESS_THAN_HALF';
