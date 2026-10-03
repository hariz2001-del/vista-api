-- Staff PINs viewable in the RMS behind an eye button: an AES-GCM encrypted
-- copy beside the bcrypt hash (src/team/seal.ts). Additive; PINs set before
-- this have none and show as "reset to see".
ALTER TABLE "staff_credentials" ADD COLUMN "secret_sealed" TEXT;
