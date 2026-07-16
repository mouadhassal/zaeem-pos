-- up
-- Reconciliation migration for devices created with the v0.1 schema
-- that had these columns added via ad-hoc ALTER TABLE in init_db().
-- Safe to run on a fresh install (columns already exist, ALTER TABLE
-- will fail but the migration runner catches per-statement errors).

ALTER TABLE users ADD COLUMN photo_path TEXT;
ALTER TABLE users ADD COLUMN cv_path TEXT;
ALTER TABLE users ADD COLUMN qr_code TEXT;
ALTER TABLE ingredients ADD COLUMN barcode TEXT;
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN name_en TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN last_login TEXT;
ALTER TABLE users ADD COLUMN restaurant_id TEXT;
ALTER TABLE orders ADD COLUMN shift_id TEXT;
ALTER TABLE menu_items ADD COLUMN is_combo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN combo_original_price_cents INTEGER;
ALTER TABLE menu_items ADD COLUMN combo_description TEXT;
ALTER TABLE combo_items ADD COLUMN is_free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE combo_items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_zone_id TEXT;
