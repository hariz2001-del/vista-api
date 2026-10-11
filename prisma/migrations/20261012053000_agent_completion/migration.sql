CREATE TABLE "receipt_jobs" (
 "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "receipt_id" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
 "lease_until" TIMESTAMP(3), "error" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "receipt_jobs_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "receipt_jobs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "receipt_jobs_business_id_receipt_id_fkey" FOREIGN KEY ("business_id", "receipt_id") REFERENCES "receipt_documents"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "receipt_jobs_receipt_id_key" ON "receipt_jobs"("receipt_id");
CREATE UNIQUE INDEX "receipt_jobs_business_id_receipt_id_key" ON "receipt_jobs"("business_id", "receipt_id");
CREATE UNIQUE INDEX "receipt_jobs_business_id_id_key" ON "receipt_jobs"("business_id", "id");
CREATE INDEX "receipt_jobs_business_id_status_created_at_idx" ON "receipt_jobs"("business_id", "status", "created_at");
CREATE TABLE "reconciliation_cases" (
 "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "key" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'OPEN', "detail" JSONB NOT NULL, "resolution" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "reconciliation_cases_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "reconciliation_cases_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "reconciliation_cases_business_id_id_key" ON "reconciliation_cases"("business_id", "id");
CREATE UNIQUE INDEX "reconciliation_cases_business_id_key_key" ON "reconciliation_cases"("business_id", "key");
CREATE TABLE "product_recipes" (
 "id" TEXT NOT NULL, "business_id" TEXT NOT NULL, "product_id" TEXT NOT NULL, "components" JSONB NOT NULL,
 "overhead_sen" INTEGER NOT NULL DEFAULT 0, "source" TEXT NOT NULL, "effective_date" DATE NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "product_recipes_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "product_recipes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "product_recipes_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_recipes_product_id_key" ON "product_recipes"("product_id");
CREATE UNIQUE INDEX "product_recipes_business_id_product_id_key" ON "product_recipes"("business_id", "product_id");
CREATE UNIQUE INDEX "product_recipes_business_id_id_key" ON "product_recipes"("business_id", "id");
