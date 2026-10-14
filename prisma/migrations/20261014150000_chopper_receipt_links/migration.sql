-- Chopper's receipt key and where it filed the scan. Additive only.
ALTER TABLE "receipt_documents" ADD COLUMN "receipt_key" TEXT;
ALTER TABLE "receipt_documents" ADD COLUMN "file_name" TEXT;
ALTER TABLE "receipt_documents" ADD COLUMN "drive_path" TEXT;
CREATE UNIQUE INDEX "receipt_documents_business_id_receipt_key_key" ON "receipt_documents"("business_id", "receipt_key");

CREATE TABLE "chopper_submissions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "receipt_key" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "agent_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chopper_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chopper_submissions_business_id_submission_id_key" ON "chopper_submissions"("business_id", "submission_id");
CREATE INDEX "chopper_submissions_business_id_receipt_key_idx" ON "chopper_submissions"("business_id", "receipt_key");
ALTER TABLE "chopper_submissions" ADD CONSTRAINT "chopper_submissions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
