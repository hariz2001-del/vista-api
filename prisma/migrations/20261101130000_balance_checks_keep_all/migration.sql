-- Bank balance checks: keep every one, several a day allowed (the newest counts).
DROP INDEX "balance_checks_business_id_business_date_key";
CREATE INDEX "balance_checks_business_id_business_date_idx" ON "balance_checks"("business_id", "business_date");
