-- Physical stock counts -- the missing "actual" measurement for COGS
-- variance. `ingredients.current_stock` is otherwise a pure ledger
-- (recipe depletion at payment + manual `adjust_stock` entries), so
-- comparing it to recipe-theoretical usage would just compare the ledger
-- to itself. A physical count is an independent fact recorded by a human
-- counting real stock, and `record_stock_count` (repo.rs) reconciles
-- `ingredients.current_stock` to it via the same `adjust_stock` path,
-- logging the delta to `inventory_logs` with reason 'physical_count'.
CREATE TABLE IF NOT EXISTS stock_counts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    counted_stock REAL NOT NULL,
    -- References `staff`, not `users` -- this table is created after
    -- `staff` already exists (0001_init.sql), and `users` is dropped
    -- entirely by migrate_v3's identity migration (v6_identity, "staff is
    -- now the only identity table"). A FK to `users` here would dangle
    -- the moment that migration runs.
    counted_by TEXT NOT NULL REFERENCES staff(id),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending',
    hlc TEXT,
    device_id TEXT,
    deleted_at TEXT,
    rev INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS stock_counts_ingredient_idx ON stock_counts(ingredient_id, created_at);
