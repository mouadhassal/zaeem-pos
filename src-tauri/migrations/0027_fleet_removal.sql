-- 2026-09-07: fleet (delivery driver/zone/dispatch) removal, zaeem-pos only.
--
-- The delivery fleet is deleted from the POS: the `drivers`, `delivery_zones`
-- and `delivery_logs` tables and the internal `orders.delivery_zone_id`
-- bridge column are gone. DELIVERY remains a plain order type with
-- `delivery_address` (0001) and `delivery_fee_cents` (0002) -- customers still
-- pay a delivery fee, there is just no driver/zone roster behind it.
--
-- Safe to run on a fresh install (0001 created the tables moments ago) and
-- on existing installs (0001 and 0002 already applied with their checksums
-- unchanged, since this is an additive, versioned SQL migration that never
-- touches them).

ALTER TABLE orders DROP COLUMN delivery_zone_id;

DROP TABLE IF EXISTS delivery_logs;
DROP TABLE IF EXISTS drivers;
DROP TABLE IF EXISTS delivery_zones;