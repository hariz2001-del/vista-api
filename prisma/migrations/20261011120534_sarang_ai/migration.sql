-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('OWNER', 'BOOKKEEPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('UPLOADED', 'PENDING_REVIEW', 'POSTED', 'LINKED', 'SKIPPED', 'REJECTED');

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "receipt_document_id" TEXT;

-- CreateTable
CREATE TABLE "agent_keys" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_users" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_documents" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'UPLOADED',
    "sha256" TEXT NOT NULL,
    "telegram_chat_id" BIGINT,
    "telegram_message_id" BIGINT,
    "mime_type" TEXT NOT NULL,
    "drive_file_id" TEXT,
    "drive_url" TEXT,
    "vendor" TEXT,
    "receipt_date" DATE,
    "receipt_no" TEXT,
    "total_sen" INTEGER,
    "extracted" JSONB,
    "review_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "uploaded_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipt_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_images" (
    "receipt_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_images_pkey" PRIMARY KEY ("receipt_id")
);

-- CreateTable
CREATE TABLE "agent_actions" (
    "id" BIGSERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "agent_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_keys_key_hash_key" ON "agent_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_keys_business_id_id_key" ON "agent_keys"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_users_business_id_telegram_user_id_key" ON "agent_users"("business_id", "telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_users_business_id_id_key" ON "agent_users"("business_id", "id");

-- CreateIndex
CREATE INDEX "receipt_documents_business_id_status_created_at_idx" ON "receipt_documents"("business_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_documents_business_id_id_key" ON "receipt_documents"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_documents_business_id_sha256_key" ON "receipt_documents"("business_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_documents_business_id_telegram_chat_id_telegram_mes_key" ON "receipt_documents"("business_id", "telegram_chat_id", "telegram_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_images_business_id_receipt_id_key" ON "receipt_images"("business_id", "receipt_id");

-- CreateIndex
CREATE INDEX "agent_actions_business_id_created_at_idx" ON "agent_actions"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_business_id_receipt_document_id_fkey" FOREIGN KEY ("business_id", "receipt_document_id") REFERENCES "receipt_documents"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_users" ADD CONSTRAINT "agent_users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_documents" ADD CONSTRAINT "receipt_documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_documents" ADD CONSTRAINT "receipt_documents_business_id_uploaded_by_id_fkey" FOREIGN KEY ("business_id", "uploaded_by_id") REFERENCES "agent_users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_images" ADD CONSTRAINT "receipt_images_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_images" ADD CONSTRAINT "receipt_images_business_id_receipt_id_fkey" FOREIGN KEY ("business_id", "receipt_id") REFERENCES "receipt_documents"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_business_id_agent_user_id_fkey" FOREIGN KEY ("business_id", "agent_user_id") REFERENCES "agent_users"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Closed to Supabase's Data API, like every other table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_keys', 'agent_users', 'receipt_documents', 'receipt_images', 'agent_actions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END
$$;
