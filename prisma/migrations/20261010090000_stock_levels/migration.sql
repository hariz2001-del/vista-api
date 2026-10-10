-- Closing stock balance as a five-step level: 0%, 25%, 50% (the existing
-- HALF), 75%, 100%. Additive only: counts already sent keep MORE_THAN_HALF and
-- LESS_THAN_HALF, which stay readable as the old three-step scale.
ALTER TYPE "StockBalance" ADD VALUE IF NOT EXISTS 'EMPTY';
ALTER TYPE "StockBalance" ADD VALUE IF NOT EXISTS 'QUARTER';
ALTER TYPE "StockBalance" ADD VALUE IF NOT EXISTS 'THREE_QUARTERS';
ALTER TYPE "StockBalance" ADD VALUE IF NOT EXISTS 'FULL';
