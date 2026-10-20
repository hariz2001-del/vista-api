-- Receipt photos through the RMS chat and Expenses, for Chopper to read. Additive only.
ALTER TABLE "chopper_chat_messages" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "chopper_chat_messages" ADD COLUMN "batch" TEXT;
ALTER TABLE "chopper_chat_messages" ADD COLUMN "receipt_key" TEXT;
