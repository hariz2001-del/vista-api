-- Daily interest the bank pays into the stall account: real money in, so the
-- cash book matches the bank, but not a sale — sales, the operating result and
-- partner settlement never read ledger categories. Additive only.
ALTER TYPE "LedgerCategory" ADD VALUE 'BANK_INTEREST';
