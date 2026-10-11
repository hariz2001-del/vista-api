-- Originals and processed scans retain separate references. Cache is removed
-- only after both have reached Drive. No new public tables or grants.
ALTER TABLE receipt_documents ADD COLUMN scan_drive_file_id TEXT;
ALTER TABLE receipt_documents ADD COLUMN scan_drive_url TEXT;
ALTER TABLE receipt_images ADD COLUMN scan_bytes BYTEA;
