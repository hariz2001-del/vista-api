-- Backup staff: a shift can take extra people beyond its places, each with
-- their own times or just a number of hours. Additive only.
ALTER TABLE "shift_slots" ADD COLUMN "allows_backup" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "assignments"
  ADD COLUMN "is_backup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "starts_at" TIMESTAMPTZ(3),
  ADD COLUMN "ends_at" TIMESTAMPTZ(3),
  ADD COLUMN "hours_only" BOOLEAN NOT NULL DEFAULT false;
