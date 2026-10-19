-- The RMS's chat with Chopper. Additive only.
CREATE TABLE "chopper_chat_messages" (
    "id" BIGSERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "file_name" TEXT,
    "file_mime" TEXT,
    "file_bytes" BYTEA,
    "reply_to" BIGINT,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chopper_chat_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chopper_chat_messages_business_id_id_idx" ON "chopper_chat_messages"("business_id", "id");
CREATE INDEX "chopper_chat_messages_status_created_at_idx" ON "chopper_chat_messages"("status", "created_at");
ALTER TABLE "chopper_chat_messages" ADD CONSTRAINT "chopper_chat_messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to Supabase's Data API, like every other table.
DO $$
BEGIN
  ALTER TABLE public.chopper_chat_messages ENABLE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.chopper_chat_messages FROM anon, authenticated;
  END IF;
END
$$;
