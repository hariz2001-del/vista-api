-- Money a campaign's partner holds outside the stall bank (SIB's TNG wallet):
-- the stall moving campaign money out to that wallet, campaign payments that
-- went straight into it, or campaign money landing in the stall bank first.
-- Real bank movement, so the cash book and daily closings tally, but never a
-- sale or an operating expense. Additive only.
ALTER TYPE "LedgerCategory" ADD VALUE 'CAMPAIGN_TRANSFER';
