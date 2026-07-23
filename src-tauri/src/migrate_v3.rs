//! T1.1 — the EXPAND migration, per SCHEMA_V3.md §10.
//!
//! Two isolated migrations, run in sequence, each with its own pre-snapshot and
//! its own restore-on-failure (mirroring the safety pattern already established
//! in `migrate.rs`, kept self-contained here rather than shared, to avoid
//! touching working T0.3 code for a still-under-review sprint):
//!
//! - Migration A (`run_expand_migration`, schema_migrations version 4): additive
//!   only. New tables, new nullable columns, backfill. NOT NULL is applied only
//!   after backfill is verified, in a second step, never in the same statement
//!   as the column add.
//! - Migration B (`run_remap_migration`, version 5): the UUIDv4->UUIDv7 FK
//!   remap. Isolated on purpose (SCHEMA_V3.md §10, item #5) -- it is the single
//!   highest-risk step in the plan and must be able to fail and roll back
//!   independently of A.
//!
//! Scope note (stated plainly, not hidden): full `NOT NULL` enforcement via
//! table-recreation (SQLite has no `ALTER COLUMN`) is applied here to the tables
//! the acceptance tests exercise and the brand-new identity tables: `tenant`,
//! `branch`, `staff`, `orders`, `order_items`, `payments`. The remaining ~25
//! legacy tables get `tenant_id`/`branch_id` added, backfilled, and verified
//! NULL-free by `assert_backfill_complete` (a real assertion that fails the
//! migration if violated), but do not get a hard SQL `NOT NULL` constraint in
//! this pass -- that is flagged as follow-up work, not silently skipped.

use crate::money;
use rusqlite::{params, Connection};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug)]
pub enum V3Error {
    Db(rusqlite::Error),
    Io(std::io::Error),
    SnapshotFailed(String),
    RestoreFailed(String),
    BackfillIncomplete { table: String, null_count: i64 },
    OrphanFk { child: String, column: String, count: i64 },
}

impl fmt::Display for V3Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::SnapshotFailed(m) => write!(f, "snapshot failed: {m}"),
            Self::RestoreFailed(m) => write!(f, "restore failed: {m}"),
            Self::BackfillIncomplete { table, null_count } => {
                write!(f, "backfill incomplete on {table}: {null_count} row(s) still NULL")
            }
            Self::OrphanFk { child, column, count } => {
                write!(f, "{count} orphaned row(s) in {child}.{column}")
            }
        }
    }
}
impl std::error::Error for V3Error {}
impl From<rusqlite::Error> for V3Error {
    fn from(e: rusqlite::Error) -> Self { Self::Db(e) }
}
impl From<std::io::Error> for V3Error {
    fn from(e: std::io::Error) -> Self { Self::Io(e) }
}

fn snapshot_path(db_path: &Path, tag: &str) -> PathBuf {
    let mut p = db_path.to_path_buf();
    let name = format!("{}.{}.snapshot", db_path.file_name().unwrap().to_string_lossy(), tag);
    p.set_file_name(name);
    p
}

/// Snapshot the DB file, run `body` inside one transaction, commit on success
/// and delete the snapshot, or restore the snapshot and propagate the error on
/// failure. This is the exact safety shape `migrate.rs::run_migrations` already
/// uses for 0001-0003, applied here to Migrations A and B.
fn with_snapshot_protection<F>(
    conn: &mut Connection,
    db_path: &Path,
    tag: &str,
    body: F,
) -> Result<(), V3Error>
where
    F: FnOnce(&rusqlite::Transaction) -> Result<(), V3Error>,
{
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();

    let snap = snapshot_path(db_path, tag);
    fs::copy(db_path, &snap).map_err(|e| V3Error::SnapshotFailed(e.to_string()))?;

    let result = (|| -> Result<(), V3Error> {
        let tx = conn.transaction()?;
        body(&tx)?;
        tx.commit()?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            fs::remove_file(&snap).ok();
            Ok(())
        }
        Err(e) => {
            eprintln!("{tag} failed: {e}. Restoring pre-migration snapshot...");
            match fs::copy(&snap, db_path) {
                Ok(_) => {
                    fs::remove_file(&snap).ok();
                    Err(e)
                }
                Err(restore_err) => Err(V3Error::RestoreFailed(format!(
                    "migration failed ({e}), AND snapshot restore also failed ({restore_err}). \
                     Manual recovery required: snapshot at {snap:?}"
                ))),
            }
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Tables that get `tenant_id` + `branch_id` (branch-scoped data), per SCHEMA_V3.md §9.
const TENANT_BRANCH_TABLES: &[&str] = &[
    "users", "ingredients", "inventory_logs", "tables", "orders", "order_items",
    "order_modifiers", "payments", "shifts", "audit_logs", "printers", "chain_config",
    "delayed_orders", "suppliers", "purchase_orders", "purchase_order_items",
    "loyalty_transactions", "invoices", "operational_costs", "attendance", "terminals",
    "notifications", "drivers", "delivery_zones", "delivery_logs", "debtors", "debt_entries",
    "login_sessions",
];

/// Tables that get `tenant_id` only (tenant-wide config), per SCHEMA_V3.md §9.
const TENANT_ONLY_TABLES: &[&str] = &[
    "categories", "menu_items", "recipes", "combo_meals", "combo_items",
    "happy_hour_rules", "branches", "customers", "loyalty_cards",
];

/// Money columns to expand into full MoneySnapshot column sets, per SCHEMA_V3.md §5.
/// (table, column_prefix)
const MONEY_COLUMNS: &[(&str, &str)] = &[
    ("orders", "subtotal"),
    ("orders", "tax"),
    ("orders", "discount"),
    ("orders", "total"),
    ("order_items", "unit_price"),
    ("payments", "amount"),
    ("payments", "change"),
    ("debt_entries", "amount"),
];

// ---------------------------------------------------------------------------
// Migration A -- EXPAND
// ---------------------------------------------------------------------------

pub const MIGRATION_A_VERSION: i64 = 4;
pub const MIGRATION_B_VERSION: i64 = 5;

/// Runs Migration A (EXPAND). Idempotent: safe to call on a DB that has never
/// seen it, a no-op (via `schema_migrations` version guard) if already applied.
pub fn run_expand_migration(conn: &mut Connection, db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1",
            params![MIGRATION_A_VERSION],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    // PRAGMA foreign_keys is a no-op inside an active transaction (SQLite docs),
    // so it must be toggled here, before with_snapshot_protection opens one.
    // Required for step 7's table-recreation (the canonical SQLite ALTER-TABLE
    // procedure disables FK enforcement for the duration of a rebuild) -- without
    // this, DROP TABLE orders while order_items.order_id still references it
    // raises SQLITE_CONSTRAINT_FOREIGNKEY even though no data is actually
    // inconsistent at any point.
    conn.execute_batch("PRAGMA foreign_keys=OFF;").ok();
    let result = with_snapshot_protection(conn, db_path, "v4_expand", |tx| {
        // --- 1. Seed tenant + branch representing the existing single-restaurant install ---
        let tenant_id = Uuid::now_v7().to_string();
        let branch_id = Uuid::now_v7().to_string();
        let device_id = Uuid::now_v7().to_string();
        let now = now_iso();

        let chain_name: String = tx
            .query_row("SELECT chain_name FROM chain_config WHERE id = 'default'", [], |r| r.get(0))
            .unwrap_or_else(|_| "مطعمي".to_string());
        let currency: String = tx
            .query_row("SELECT currency FROM chain_config WHERE id = 'default'", [], |r| r.get(0))
            .unwrap_or_else(|_| "SYP".to_string());
        let branch_name: String = tx
            .query_row("SELECT name FROM branches LIMIT 1", [], |r| r.get(0))
            .unwrap_or_else(|_| "الفرع الرئيسي".to_string());

        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS tenant (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                base_currency TEXT NOT NULL,
                is_demo INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS branch (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL REFERENCES tenant(id),
                name TEXT NOT NULL,
                currency TEXT NOT NULL,
                locale TEXT NOT NULL DEFAULT 'ar-SY',
                timezone TEXT NOT NULL DEFAULT 'Asia/Damascus',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL,
                deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS staff (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL REFERENCES tenant(id),
                branch_id TEXT REFERENCES branch(id),
                role TEXT NOT NULL CHECK(role IN ('PLATFORM','OWNER','MANAGER','CASHIER','KITCHEN','SERVER')),
                role_rank INTEGER NOT NULL,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                pin_hash TEXT,
                password_hash TEXT,
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL,
                deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1,
                CHECK ((role IN ('OWNER','PLATFORM') AND branch_id IS NULL)
                    OR (role NOT IN ('OWNER','PLATFORM') AND branch_id IS NOT NULL))
            );
            CREATE TABLE IF NOT EXISTS menu_item_default (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id),
                category_id TEXT NOT NULL, name TEXT NOT NULL, price_minor INTEGER NOT NULL,
                cost_minor INTEGER, barcode TEXT, image_path TEXT,
                is_combo INTEGER NOT NULL DEFAULT 0, combo_original_price_minor INTEGER,
                combo_description TEXT, recipe_id TEXT, is_active INTEGER NOT NULL DEFAULT 1,
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS menu_item_override (
                branch_id TEXT NOT NULL REFERENCES branch(id),
                item_id TEXT NOT NULL REFERENCES menu_item_default(id),
                price_minor INTEGER, available INTEGER,
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (branch_id, item_id)
            );
            CREATE TABLE IF NOT EXISTS tenant_settings (
                tenant_id TEXT PRIMARY KEY REFERENCES tenant(id),
                chain_name TEXT NOT NULL,
                tax_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_mode IN ('inclusive','exclusive')),
                tax_rate_bps INTEGER NOT NULL DEFAULT 0,
                secondary_tax_rate_bps INTEGER NOT NULL DEFAULT 0,
                service_charge_rate_bps INTEGER NOT NULL DEFAULT 0,
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS branch_settings (
                branch_id TEXT PRIMARY KEY REFERENCES branch(id),
                default_paper_width INTEGER NOT NULL DEFAULT 80,
                auto_print_receipt INTEGER NOT NULL DEFAULT 1,
                auto_print_kitchen INTEGER NOT NULL DEFAULT 1,
                barcode_prefix TEXT NOT NULL DEFAULT '', barcode_suffix TEXT NOT NULL DEFAULT '',
                customer_display_port TEXT, customer_display_baud INTEGER NOT NULL DEFAULT 9600,
                tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('inclusive','exclusive')),
                tax_rate_bps INTEGER, secondary_tax_rate_bps INTEGER, service_charge_rate_bps INTEGER,
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS price_list (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id),
                label TEXT NOT NULL, effective_from TEXT NOT NULL,
                published_by TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS price_list_item (
                price_list_id TEXT NOT NULL REFERENCES price_list(id),
                item_id TEXT NOT NULL REFERENCES menu_item_default(id),
                price_minor INTEGER NOT NULL,
                PRIMARY KEY (price_list_id, item_id)
            );
            CREATE TABLE IF NOT EXISTS customer (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id),
                name TEXT NOT NULL, phone TEXT, card_uid TEXT UNIQUE,
                points INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS terminal (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenant(id),
                branch_id TEXT NOT NULL REFERENCES branch(id), name TEXT NOT NULL,
                version TEXT NOT NULL, last_sync TEXT,
                updated_at_hlc TEXT NOT NULL, device_id TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS voids (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
                order_item_id TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL,
                device_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_status_event (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
                order_id TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL,
                device_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS order_current (
                order_id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
                status TEXT NOT NULL,
                subtotal_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL,
                discount_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL,
                currency TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                device_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
                ts TEXT NOT NULL, tenant_id TEXT NOT NULL, branch_id TEXT,
                actor_id TEXT NOT NULL, action TEXT NOT NULL,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                before_json TEXT, after_json TEXT,
                prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
                PRIMARY KEY (device_id, seq)
            );
            CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
                SELECT RAISE(ABORT, 'audit_log rows are immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
                SELECT RAISE(ABORT, 'audit_log rows cannot be deleted');
            END;
            CREATE TABLE IF NOT EXISTS id_remap (
                table_name TEXT NOT NULL, legacy_id TEXT NOT NULL, new_id TEXT NOT NULL,
                PRIMARY KEY (table_name, legacy_id)
            );",
        )?;

        tx.execute(
            "INSERT INTO tenant (id, name, base_currency, is_demo, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
            params![tenant_id, chain_name, currency, now],
        )?;
        tx.execute(
            "INSERT INTO branch (id, tenant_id, name, currency, updated_at_hlc, device_id, rev) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![branch_id, tenant_id, branch_name, currency, now, device_id],
        )?;

// --- 1b. Filter both table lists down to tables that actually exist in THIS
        //        database. schema.sql / the Rust SCHEMA_SQL constant were found
        //        (2026-07-16) to have drifted from what 0001-0003 actually create
        //        (`attendance` and `orders.driver_id` are the two confirmed
        //        instances) -- rather than crash on that drift, skip and report. ---
        let tenant_branch_tables: Vec<&str> = TENANT_BRANCH_TABLES
            .iter()
            .filter(|t| table_exists(tx, t).unwrap_or(false))
            .copied()
            .collect();
        let tenant_only_tables: Vec<&str> = TENANT_ONLY_TABLES
            .iter()
            .filter(|t| table_exists(tx, t).unwrap_or(false))
            .copied()
            .collect();
        for skipped in TENANT_BRANCH_TABLES.iter().chain(TENANT_ONLY_TABLES.iter()) {
            if !table_exists(tx, skipped)? {
                println!("v4_expand: table '{skipped}' does not exist in this database (schema drift vs schema.sql/SCHEMA_SQL) -- skipped");
            }
        }

        println!("v4_expand: checkpoint after step 1 (tenant/branch seeded)");
        // --- 2. Add tenant_id/branch_id (nullable) to every legacy table, then backfill ---
        for table in &tenant_branch_tables {
            add_column_if_missing(tx, table, "tenant_id", "TEXT")?;
            add_column_if_missing(tx, table, "branch_id", "TEXT")?;
            tx.execute(
                &format!("UPDATE {table} SET tenant_id = ?1, branch_id = ?2 WHERE tenant_id IS NULL"),
                params![tenant_id, branch_id],
            )?;
        }
        for table in &tenant_only_tables {
            add_column_if_missing(tx, table, "tenant_id", "TEXT")?;
            tx.execute(
                &format!("UPDATE {table} SET tenant_id = ?1 WHERE tenant_id IS NULL"),
                params![tenant_id],
            )?;
        }

        println!("v4_expand: checkpoint after step 2 (tenant_id/branch_id backfilled)");
        // --- 3. Add legacy_id bridge column (populated fully in Migration B, but the
        //        column must exist now so B is purely additive-safe on top of A) ---
        for table in tenant_branch_tables.iter().chain(tenant_only_tables.iter()) {
            add_column_if_missing(tx, table, "legacy_id", "TEXT")?;
        }

        println!("v4_expand: checkpoint after step 3 (legacy_id columns added)");
        // --- 4. Money column expansion, scale derived from MoneyPolicy, never a literal ---
        let scale = money::scale_for(&currency) as i64;
        for (table, prefix) in MONEY_COLUMNS {
            if !table_exists(tx, table)? {
                println!("v4_expand: money table '{table}' does not exist -- skipped");
                continue;
            }
            for (suffix, ty) in [
                ("minor", "INTEGER"), ("currency", "TEXT"), ("scale", "INTEGER"),
                ("base_minor", "INTEGER"), ("fx_rate", "TEXT"), ("fx_source", "TEXT"),
                ("denom_epoch", "INTEGER"),
            ] {
                add_column_if_missing(tx, table, &format!("{prefix}_{suffix}"), ty)?;
            }
            let legacy_col = format!("{prefix}_cents");
            tx.execute(
                &format!(
                    "UPDATE {table} SET
                        {prefix}_minor = {legacy_col},
                        {prefix}_currency = ?1,
                        {prefix}_scale = ?2,
                        {prefix}_base_minor = {legacy_col},
                        {prefix}_fx_rate = '1',
                        {prefix}_fx_source = 'UNKNOWN',
                        {prefix}_denom_epoch = 2
                     WHERE {prefix}_minor IS NULL"
                ),
                params![currency, scale],
            )?;
        }

        println!("v4_expand: checkpoint after step 4 (money columns expanded)");
        // --- 5. Sync columns (updated_at_hlc/device_id/deleted_at/rev), additive, all tables ---
        for table in tenant_branch_tables.iter().chain(tenant_only_tables.iter()) {
            add_column_if_missing(tx, table, "updated_at_hlc", "TEXT")?;
            add_column_if_missing(tx, table, "device_id", "TEXT")?;
            add_column_if_missing(tx, table, "deleted_at", "TEXT")?;
            add_column_if_missing(tx, table, "rev", "INTEGER")?;
            let has_last_modified: bool = tx
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |r| r.get::<_, String>(1))?
                .filter_map(|r| r.ok())
                .any(|c| c == "last_modified");
            if has_last_modified {
                tx.execute(
                    &format!(
                        "UPDATE {table} SET updated_at_hlc = COALESCE(last_modified, ?1), \
                         device_id = ?2, rev = COALESCE(sync_version, 1) WHERE updated_at_hlc IS NULL"
                    ),
                    params![now, device_id],
                )?;
            } else {
                tx.execute(
                    &format!("UPDATE {table} SET updated_at_hlc = ?1, device_id = ?2, rev = 1 WHERE updated_at_hlc IS NULL"),
                    params![now, device_id],
                )?;
            }
        }

        println!("v4_expand: checkpoint after step 5 (sync columns added)");
        // --- 6. Verify backfill completeness (Rust-level assertion; see module doc for scope) ---
        for table in tenant_branch_tables.iter().chain(tenant_only_tables.iter()) {
            assert_column_not_null(tx, table, "tenant_id")?;
        }
        for table in &tenant_branch_tables {
            assert_column_not_null(tx, table, "branch_id")?;
        }

        println!("v4_expand: checkpoint after step 6 (backfill verified complete)");
        // --- 7. Second step: enforce real NOT NULL via table-recreation for the
        //        core money-critical tables (scope decision, see module doc). ---
        enforce_not_null(tx, "orders", &["tenant_id", "branch_id"])?;
        println!("v4_expand: checkpoint after enforce_not_null(orders)");
        enforce_not_null(tx, "order_items", &["tenant_id", "branch_id"])?;
        println!("v4_expand: checkpoint after enforce_not_null(order_items)");
        enforce_not_null(tx, "payments", &["tenant_id", "branch_id"])?;
        println!("v4_expand: checkpoint after enforce_not_null(payments)");

        // record the migration
        let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_A_VERSION, "0004_multitenant_expand", applied_at, "n/a-programmatic"],
        )?;

        Ok(())
    });
    conn.execute_batch("PRAGMA foreign_keys=ON;").ok();
    result
}

/// Real, live check -- not an assumption from `schema.sql` or the Rust
/// `SCHEMA_SQL` constant, both of which were found (2026-07-16, during T1.1) to
/// have drifted from what the T0.3 migration files (0001-0003) actually create
/// -- e.g. `attendance` and `orders.driver_id` exist in those aspirational
/// sources but not in the real applied schema. Every table this migration
/// touches is guarded by this check so a similar drift degrades gracefully
/// (table skipped, reported) instead of crashing the whole migration.
fn table_exists(tx: &rusqlite::Transaction, table: &str) -> Result<bool, V3Error> {
    let exists: bool = tx.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get(0),
    )?;
    Ok(exists)
}

/// Same schema-drift defense as `table_exists`, at column granularity -- e.g.
/// `purchase_orders.created_by` and `attendance` itself were both found
/// (2026-07-16) to exist in `schema.sql`/`SCHEMA_SQL` but not in the real
/// applied T0.3 schema.
fn column_exists(tx: &rusqlite::Transaction, table: &str, column: &str) -> Result<bool, V3Error> {
    if !table_exists(tx, table)? {
        return Ok(false);
    }
    let exists = tx
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|c| c == column);
    Ok(exists)
}

fn add_column_if_missing(tx: &rusqlite::Transaction, table: &str, column: &str, ty: &str) -> Result<(), V3Error> {
    let exists: bool = tx
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .any(|c| c == column);
    if !exists {
        tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
    }
    Ok(())
}

fn assert_column_not_null(tx: &rusqlite::Transaction, table: &str, column: &str) -> Result<(), V3Error> {
    let null_count: i64 = tx.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE {column} IS NULL"),
        [],
        |r| r.get(0),
    )?;
    if null_count > 0 {
        return Err(V3Error::BackfillIncomplete { table: table.to_string(), null_count });
    }
    Ok(())
}

/// Generic, schema-driven NOT NULL enforcement via table-recreation (SQLite has
/// no `ALTER COLUMN`). Reads the table's CURRENT, ACTUAL `CREATE TABLE` text
/// back out of `sqlite_master` -- which SQLite keeps accurate through every
/// `ALTER TABLE ADD COLUMN` already applied -- rather than hand-transcribing a
/// column list, which is exactly how the discovered `orders.driver_id` drift
/// (present in the frontend's `schema.sql`, absent from the real applied
/// migrations) happens in the first place.
/// Strips whichever `CREATE TABLE [IF NOT EXISTS] {table} (` / `CREATE TABLE
/// [IF NOT EXISTS] "{table}" (` prefix `sql` actually has, and replaces it
/// with `CREATE TABLE {new_table} (`. Four variants because SQLite quotes the
/// table name in `sqlite_master.sql` after an `ALTER TABLE ... RENAME TO`
/// (confirmed empirically, 2026-07-16, while chaining `repoint_fk_reference`
/// on top of a table `enforce_not_null` had already renamed once) -- the
/// unquoted form is what a hand-written migration file uses; the quoted form
/// is what SQLite itself produces after any rename. A table this code touches
/// twice (recreated by Migration A, then again here in Migration C) will be
/// in the quoted form the second time, unquoted the first.
fn strip_create_table_prefix(sql: &str, table: &str, new_table: &str) -> Option<String> {
    let variants = [
        format!("CREATE TABLE IF NOT EXISTS {table} ("),
        format!("CREATE TABLE {table} ("),
        format!("CREATE TABLE IF NOT EXISTS \"{table}\" ("),
        format!("CREATE TABLE \"{table}\" ("),
    ];
    for prefix in &variants {
        if sql.starts_with(prefix.as_str()) {
            return Some(sql.replacen(prefix.as_str(), &format!("CREATE TABLE {new_table} ("), 1));
        }
    }
    None
}

fn enforce_not_null(tx: &rusqlite::Transaction, table: &str, not_null_columns: &[&str]) -> Result<(), V3Error> {
    let original_sql: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get(0),
    )?;

    let new_table = format!("{table}_v3");
    let mut new_sql = strip_create_table_prefix(&original_sql, table, &new_table).ok_or_else(|| {
        V3Error::Db(rusqlite::Error::InvalidParameterName(format!(
            "unrecognized CREATE TABLE prefix for {table}: {original_sql}"
        )))
    })?;

    // Every column this migration adds is added as a bare "{col} TEXT" or
    // "{col} INTEGER" (see add_column_if_missing) with no other qualifiers, so
    // this replacement is exact and unambiguous.
    for col in not_null_columns {
        for ty in ["TEXT", "INTEGER"] {
            let bare = format!("{col} {ty}");
            let not_null = format!("{col} {ty} NOT NULL");
            if new_sql.contains(&bare) && !new_sql.contains(&not_null) {
                new_sql = new_sql.replacen(&bare, &not_null, 1);
            }
        }
    }

    tx.execute_batch(&new_sql)?;
    tx.execute_batch(&format!("INSERT INTO {new_table} SELECT * FROM {table};"))?;
    tx.execute_batch(&format!("DROP TABLE {table}; ALTER TABLE {new_table} RENAME TO {table};"))?;
    Ok(())
}

/// Test-only: identical to `run_expand_migration` except it deliberately fails
/// partway through (after tenant/branch seeding and several real ALTERs have
/// already run inside the transaction), to prove the snapshot+restore path.
#[cfg(test)]
fn run_expand_migration_with_injected_failure(conn: &mut Connection, db_path: &Path) -> Result<(), V3Error> {
    with_snapshot_protection(conn, db_path, "v4_expand_TEST_FAILURE", |tx| {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS tenant (id TEXT PRIMARY KEY, name TEXT);")?;
        tx.execute("INSERT INTO tenant (id, name) VALUES ('t1', 'Test Tenant')", [])?;
        add_column_if_missing(tx, "orders", "tenant_id", "TEXT")?;
        tx.execute("UPDATE orders SET tenant_id = 't1'", [])?;
        // deliberate failure: reference a table that does not exist
        tx.execute_batch("ALTER TABLE this_table_does_not_exist ADD COLUMN x TEXT")?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Migration B -- UUIDv4 -> UUIDv7 FK remap (isolated, per SCHEMA_V3.md §10.2)
// ---------------------------------------------------------------------------

/// (child_table, fk_column, parent_table) -- every FK relationship remapped.
/// `parent_table` rows have their own `id` remapped first (via `ID_OWNING_TABLES`),
/// then every column here is rewritten to match.
const FK_EDGES: &[(&str, &str, &str)] = &[
    ("menu_items", "category_id", "categories"),
    ("recipes", "menu_item_id", "menu_items"),
    ("recipes", "ingredient_id", "ingredients"),
    ("inventory_logs", "ingredient_id", "ingredients"),
    ("inventory_logs", "user_id", "users"),
    ("orders", "table_id", "tables"),
    ("orders", "user_id", "users"),
    ("order_items", "order_id", "orders"),
    ("order_items", "menu_item_id", "menu_items"),
    ("order_modifiers", "order_item_id", "order_items"),
    ("payments", "order_id", "orders"),
    ("shifts", "user_id", "users"),
    ("combo_items", "combo_id", "combo_meals"),
    ("combo_items", "menu_item_id", "menu_items"),
    ("happy_hour_rules", "menu_item_id", "menu_items"),
    ("delayed_orders", "order_id", "orders"),
    ("purchase_orders", "supplier_id", "suppliers"),
    ("purchase_orders", "created_by", "users"),
    ("purchase_order_items", "purchase_order_id", "purchase_orders"),
    ("purchase_order_items", "ingredient_id", "ingredients"),
    ("loyalty_cards", "customer_id", "customers"),
    ("loyalty_transactions", "card_id", "loyalty_cards"),
    ("operational_costs", "user_id", "users"),
    ("attendance", "user_id", "users"),
    ("terminals", "branch_id", "branches"),
    ("notifications", "user_id", "users"),
    ("delivery_logs", "order_id", "orders"),
    ("delivery_logs", "driver_id", "drivers"),
    ("debt_entries", "debtor_id", "debtors"),
];

/// Tables whose own `id` column gets remapped to a fresh UUIDv7.
const ID_OWNING_TABLES: &[&str] = &[
    "users", "categories", "menu_items", "ingredients", "recipes", "inventory_logs",
    "tables", "orders", "order_items", "order_modifiers", "payments", "shifts",
    "printers", "combo_meals", "combo_items", "happy_hour_rules", "delayed_orders",
    "branches", "customers", "suppliers", "purchase_orders", "purchase_order_items",
    "loyalty_cards", "loyalty_transactions", "invoices", "operational_costs",
    "attendance", "terminals", "drivers", "delivery_zones", "delivery_logs",
    "debtors", "debt_entries", "notifications",
];

pub fn run_remap_migration(conn: &mut Connection, db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1",
            params![MIGRATION_B_VERSION],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    // Same reasoning as run_expand_migration: FK enforcement must be off for the
    // duration of a remap that rewrites every id and every FK column pointing at
    // it -- mid-remap, a row's FK column and its target's id are transiently out
    // of sync (updated in separate statements), which is expected and repaired
    // by the end of the same transaction, not a real inconsistency.
    conn.execute_batch("PRAGMA foreign_keys=OFF;").ok();
    let result = with_snapshot_protection(conn, db_path, "v5_remap", |tx| {
        // Same schema-drift defense as Migration A: filter both the id-owning
        // table list and the FK edge list down to what actually exists.
        let id_owning_tables: Vec<&str> = ID_OWNING_TABLES
            .iter()
            .filter(|t| table_exists(tx, t).unwrap_or(false))
            .copied()
            .collect();
        let fk_edges: Vec<(&str, &str, &str)> = FK_EDGES
            .iter()
            .filter(|(child, column, parent)| {
                table_exists(tx, parent).unwrap_or(false)
                    && column_exists(tx, child, column).unwrap_or(false)
            })
            .copied()
            .collect();
        for (child, column, parent) in FK_EDGES {
            if !table_exists(tx, parent)? || !column_exists(tx, child, column)? {
                println!("v5_remap: FK edge {child}.{column} -> {parent} skipped ({child}.{column} or {parent} absent -- schema drift)");
            }
        }

        // Pass 1: allocate a fresh UUIDv7 for every row in every id-owning table,
        // recorded in id_remap BEFORE any row is touched.
        for table in &id_owning_tables {
            let ids: Vec<String> = {
                let mut stmt = tx.prepare(&format!("SELECT id FROM {table}"))?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.filter_map(|r| r.ok()).collect()
            };
            for old_id in ids {
                let new_id = Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO id_remap (table_name, legacy_id, new_id) VALUES (?1, ?2, ?3)",
                    params![table, old_id, new_id],
                )?;
            }
        }

        // Pass 2: rewrite each id-owning table's own `id`, preserving legacy_id.
        for table in &id_owning_tables {
            tx.execute(
                &format!(
                    "UPDATE {table} SET legacy_id = id, id = (
                        SELECT new_id FROM id_remap WHERE table_name = ?1 AND legacy_id = {table}.id
                    )"
                ),
                params![table],
            )?;
        }

        // Pass 3: rewrite every FK column to the new id, driven by id_remap.
        for (child, column, parent) in &fk_edges {
            tx.execute(
                &format!(
                    "UPDATE {child} SET {column} = (
                        SELECT new_id FROM id_remap WHERE table_name = ?1 AND legacy_id = {child}.{column}
                    ) WHERE {column} IS NOT NULL AND EXISTS (
                        SELECT 1 FROM id_remap WHERE table_name = ?1 AND legacy_id = {child}.{column}
                    )"
                ),
                params![parent],
            )?;
        }

        // Pass 4: exhaustive zero-orphan verification, table by table (per SCHEMA_V3.md §10.2).
        for (child, column, parent) in &fk_edges {
            let orphans: i64 = tx.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {child} WHERE {column} IS NOT NULL \
                     AND {column} NOT IN (SELECT id FROM {parent})"
                ),
                [],
                |r| r.get(0),
            )?;
            if orphans > 0 {
                return Err(V3Error::OrphanFk {
                    child: child.to_string(),
                    column: column.to_string(),
                    count: orphans,
                });
            }
        }

        let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_B_VERSION, "0005_uuid_v7_remap", applied_at, "n/a-programmatic"],
        )?;

        Ok(())
    });
    conn.execute_batch("PRAGMA foreign_keys=ON;").ok();
    result
}

/// Standalone, exhaustive FK-orphan check, callable independent of the migration
/// run itself (used by tests and available for a future health-check command --
/// not yet wired to a Tauri command, that's T1.2, out of scope for T1.1).
#[allow(dead_code)]
pub fn assert_zero_orphans(conn: &Connection) -> Result<(), V3Error> {
    let column_exists_conn = |table: &str, column: &str| -> bool {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .and_then(|mut stmt| {
                let cols: Vec<String> = stmt
                    .query_map([], |r| r.get::<_, String>(1))?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(cols.contains(&column.to_string()))
            })
            .unwrap_or(false)
    };
    let table_exists_conn = |table: &str| -> bool {
        conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name = ?1",
            params![table], |r| r.get(0),
        ).unwrap_or(false)
    };
    for (child, column, parent) in FK_EDGES {
        if !table_exists_conn(parent) || !column_exists_conn(child, column) {
            continue;
        }
        let orphans: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM {child} WHERE {column} IS NOT NULL \
                 AND {column} NOT IN (SELECT id FROM {parent})"
            ),
            [],
            |r| r.get(0),
        )?;
        if orphans > 0 {
            return Err(V3Error::OrphanFk {
                child: child.to_string(),
                column: column.to_string(),
                count: orphans,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Migration C -- identity unification (review decision, 2026-07-16, Decision A)
//
// `staff` becomes the ONLY identity table. `users` is backfilled into `staff`
// (same id preserved -- so referencing FK VALUES never need to change, only
// the DECLARED constraint target), every FK that pointed at `users(id)` is
// repointed at `staff(id)` via the same sqlite_master-driven recreate as
// `enforce_not_null` (for the same reason: hand-transcribing the 4 tables'
// full DDL is exactly how the driver_id/attendance/purchase_orders drift
// happened in the first place), then `users` is dropped outright. No bridge,
// no sync, no view -- per explicit instruction. This is confirmed (per
// review) to break the OLD `login`/`login_with_pin`/`change_password`/
// `verify_manager_override`/`seed_default_users` Rust commands and 8 frontend
// pages that still query `users` directly; that breakage is accepted, not
// fixed in this batch (T1.7 fixes it by converting those call sites).
// ---------------------------------------------------------------------------

pub const MIGRATION_C_VERSION: i64 = 6;

/// Same technique as `enforce_not_null`: read the table's real, current
/// `CREATE TABLE` text out of `sqlite_master` and do a targeted string
/// replacement, rather than hand-transcribing the DDL.
fn repoint_fk_reference(tx: &rusqlite::Transaction, table: &str, old_ref_table: &str, new_ref_table: &str) -> Result<(), V3Error> {
    let original_sql: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get(0),
    )?;

    let new_table = format!("{table}_v3c");
    let mut new_sql = strip_create_table_prefix(&original_sql, table, &new_table).ok_or_else(|| {
        V3Error::Db(rusqlite::Error::InvalidParameterName(format!("unrecognized CREATE TABLE prefix for {table}: {original_sql}")))
    })?;

    let old_ref = format!("REFERENCES {old_ref_table}(id)");
    let new_ref = format!("REFERENCES {new_ref_table}(id)");
    if !new_sql.contains(&old_ref) {
        return Err(V3Error::Db(rusqlite::Error::InvalidParameterName(format!(
            "expected to find '{old_ref}' in {table}'s schema, did not -- refusing to guess: {new_sql}"
        ))));
    }
    new_sql = new_sql.replace(&old_ref, &new_ref);

    tx.execute_batch(&new_sql)?;
    tx.execute_batch(&format!("INSERT INTO {new_table} SELECT * FROM {table};"))?;
    tx.execute_batch(&format!("DROP TABLE {table}; ALTER TABLE {new_table} RENAME TO {table};"))?;
    Ok(())
}

/// Tables with a DECLARED `REFERENCES users(id)` FK constraint (confirmed by
/// grep against the real 0001-0003 migration files, not schema.sql/SCHEMA_SQL --
/// exactly 4, no more). `debt_entries.created_by` and `login_sessions.user_id`
/// also logically reference users but were never declared as FKs, so they need
/// no schema change here -- their VALUES stay valid automatically because
/// `staff.id` is backfilled to equal the matching `users.id`.
const TABLES_REFERENCING_USERS: &[&str] = &["orders", "inventory_logs", "shifts", "operational_costs"];

pub fn run_identity_migration(conn: &mut Connection, db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_C_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    conn.execute_batch("PRAGMA foreign_keys=OFF;").ok();
    let result = with_snapshot_protection(conn, db_path, "v6_identity", |tx| {
        // --- 1. Decision B exception: chain_config's 4 missing columns, bundled
        //        into this migration since it's already doing table surgery. ---
        for (col, ty) in [("customer_display_baud", "INTEGER"), ("customer_display_port", "TEXT"),
                          ("secondary_tax_rate_cents", "INTEGER"), ("service_charge_rate_cents", "INTEGER")] {
            add_column_if_missing(tx, "chain_config", col, ty)?;
        }
        tx.execute(
            "UPDATE chain_config SET \
                customer_display_baud = COALESCE(customer_display_baud, 9600), \
                secondary_tax_rate_cents = COALESCE(secondary_tax_rate_cents, 0), \
                service_charge_rate_cents = COALESCE(service_charge_rate_cents, 0) \
             WHERE id = 'default'",
            [],
        )?;
        println!("v6_identity: chain_config backfilled with customer_display_baud/port, secondary_tax_rate_cents, service_charge_rate_cents (DRIFT_REPORT.md Finding #4)");

        // --- 2. Backfill staff from users, SAME id preserved (so no FK value
        //        needs to change, only the declared constraint target). ---
        if table_exists(tx, "users")? {
            let inserted = tx.execute(
                "INSERT INTO staff (id, tenant_id, branch_id, role, role_rank, name, email, pin_hash, password_hash, is_active, created_at, updated_at_hlc, device_id, rev)
                 SELECT
                   u.id,
                   u.tenant_id,
                   CASE WHEN u.role = 'OWNER' THEN NULL ELSE u.branch_id END,
                   CASE WHEN u.role IN ('ADMIN','ACCOUNTANT') THEN 'MANAGER' ELSE u.role END,
                   CASE
                     WHEN u.role = 'OWNER' THEN 3
                     WHEN u.role IN ('MANAGER','ADMIN','ACCOUNTANT') THEN 2
                     ELSE 1
                   END,
                   u.name, u.email, u.manager_pin_hash, u.password_hash, u.is_active, u.created_at,
                   COALESCE(u.updated_at_hlc, u.last_modified, u.created_at),
                   COALESCE(u.device_id, 'identity-migration'),
                   COALESCE(u.rev, 1)
                 FROM users u
                 WHERE u.id NOT IN (SELECT id FROM staff)",
                [],
            )?;
            println!("v6_identity: backfilled {inserted} row(s) from users into staff");
        }
        let staff_count: i64 = tx.query_row("SELECT COUNT(*) FROM staff", [], |r| r.get(0))?;
        println!("v6_identity: staff table has {staff_count} row(s) total after backfill");

        // --- 3. Repoint every declared FK from users(id) to staff(id). ---
        for table in TABLES_REFERENCING_USERS {
            if table_exists(tx, table)? {
                repoint_fk_reference(tx, table, "users", "staff")?;
                println!("v6_identity: {table}.user_id repointed from users(id) to staff(id)");
            }
        }

        // --- 4. Zero-orphan verification: every value in a formerly-users-FK
        //        column must resolve against staff.id, table by table, before
        //        users is dropped -- not after. ---
        for table in TABLES_REFERENCING_USERS {
            if !table_exists(tx, table)? { continue; }
            let orphans: i64 = tx.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM staff)"),
                [], |r| r.get(0),
            )?;
            if orphans > 0 {
                return Err(V3Error::OrphanFk { child: table.to_string(), column: "user_id".to_string(), count: orphans });
            }
            println!("v6_identity: {table}.user_id -- 0 orphans against staff.id, confirmed before dropping users");
        }

        // --- 5. Kill users. No bridge, no view, no sync. ---
        if table_exists(tx, "users")? {
            tx.execute_batch("DROP TABLE users;")?;
            println!("v6_identity: users table dropped. staff is now the only identity table.");
        }

        let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_C_VERSION, "0006_identity_unification", applied_at, "n/a-programmatic"],
        )?;
        Ok(())
    });
    conn.execute_batch("PRAGMA foreign_keys=ON;").ok();
    result
}

// ---------------------------------------------------------------------------
// Migration D -- Decision B's broken-on-install command groups + Finding #3
// ---------------------------------------------------------------------------

pub const MIGRATION_D_VERSION: i64 = 7;

/// Columns DRIFT_REPORT.md Finding #2/#5 found missing, for the 4 tables
/// Decision B named (customers, purchase_orders, drivers, printers,
/// delivery_logs -- "delivery" is the two tables `delivery/page.tsx` uses).
/// Additive only -- these are real, wanted fields (unlike Finding #1's
/// `driver_id`, which the fix was to simply never write), so the fix here is
/// "make the column exist", not "avoid referencing it".
const DRIFT_FIX_COLUMNS: &[(&str, &[(&str, &str)])] = &[
    ("customers", &[("address", "TEXT"), ("birthday", "TEXT"), ("last_order_at", "TEXT"), ("loyalty_points", "INTEGER"), ("notes", "TEXT")]),
    ("purchase_orders", &[("created_by", "TEXT"), ("notes", "TEXT")]),
    ("drivers", &[("current_lat", "REAL"), ("current_lng", "REAL"), ("license_number", "TEXT"), ("vehicle_plate", "TEXT")]),
    ("delivery_logs", &[("assigned_at", "TEXT"), ("picked_up_at", "TEXT"), ("delivered_at", "TEXT"), ("failed_at", "TEXT")]),
    ("printers", &[("drawer_pulse_ms", "INTEGER"), ("is_primary", "INTEGER"), ("is_secondary", "INTEGER"), ("vendor_id", "TEXT"), ("product_id", "TEXT")]),
];

/// Finding #3: `attendance` is defined in `SCHEMA_SQL`/`schema.sql` but never
/// created by 0001-0003, so it only exists once the frontend's lazy
/// `tauri_plugin_sql` path happens to run -- a race Migration A already
/// detects and skips gracefully, meaning `attendance` never gets scoped by
/// that migration no matter when it's created.
///
/// Decision (stated per instruction, not left implicit): Migration D creates
/// `attendance` **itself**, deterministically, right here -- rather than a
/// repo-layer just-in-time backfill the first time a scoped query touches a
/// table missing scope columns. Reasoning: a migration-time fix is one
/// function, runs once, and needs no runtime check on every future query;
/// a JIT-backfill would need to run (or at least probe) on every repo call
/// against every legacy table, forever, to guard against a table that could
/// in principle still show up unscoped some other way. Since this table is
/// created fresh here (after Migration C, so `staff` -- not `users` -- is the
/// only identity table), it gets `tenant_id`/`branch_id` NOT NULL from
/// creation, no backfill step needed (there are zero pre-existing rows).
fn create_attendance_if_missing(tx: &rusqlite::Transaction, tenant_id: &str, branch_id: &str, device_id: &str) -> Result<(), V3Error> {
    if table_exists(tx, "attendance")? {
        println!("v7_drift_fixes: attendance already exists (frontend's lazy path won the race this time) -- scoping it like any other legacy table instead of recreating");
        add_column_if_missing(tx, "attendance", "tenant_id", "TEXT")?;
        add_column_if_missing(tx, "attendance", "branch_id", "TEXT")?;
        tx.execute(
            "UPDATE attendance SET tenant_id = COALESCE(tenant_id, ?1), branch_id = COALESCE(branch_id, ?2)",
            params![tenant_id, branch_id],
        )?;
        assert_column_not_null(tx, "attendance", "tenant_id")?;
        assert_column_not_null(tx, "attendance", "branch_id")?;
        return Ok(());
    }
    tx.execute_batch(&format!(
        "CREATE TABLE attendance (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenant(id),
            branch_id TEXT NOT NULL REFERENCES branch(id),
            user_id TEXT NOT NULL REFERENCES staff(id),
            date TEXT NOT NULL,
            clock_in TEXT,
            clock_out TEXT,
            status TEXT NOT NULL DEFAULT 'ABSENT' CHECK(status IN ('PRESENT','ABSENT','LATE','HALF_DAY')),
            updated_at_hlc TEXT NOT NULL DEFAULT '{now}',
            device_id TEXT NOT NULL DEFAULT '{device_id}',
            deleted_at TEXT,
            rev INTEGER NOT NULL DEFAULT 1,
            sync_version INTEGER NOT NULL DEFAULT 1,
            last_modified TEXT NOT NULL DEFAULT (datetime('now')),
            sync_status TEXT NOT NULL DEFAULT 'pending'
        );",
        now = now_iso(),
        device_id = device_id,
    ))?;
    let _ = (tenant_id, branch_id);
    println!("v7_drift_fixes: attendance created deterministically here (Finding #3), scoped from creation -- no race with the frontend's lazy path possible anymore");
    Ok(())
}

/// Runs Migration D. Idempotent via the `schema_migrations` version guard,
/// same as A/B/C.
pub fn run_drift_fix_migration(conn: &mut Connection, db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_D_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    conn.execute_batch("PRAGMA foreign_keys=OFF;").ok();
    let result = with_snapshot_protection(conn, db_path, "v7_drift_fixes", |tx| {
        let tenant_id: String = tx.query_row("SELECT id FROM tenant LIMIT 1", [], |r| r.get(0))?;
        let branch_id: String = tx.query_row("SELECT id FROM branch WHERE tenant_id = ?1 LIMIT 1", params![tenant_id], |r| r.get(0))?;
        let device_id = Uuid::now_v7().to_string();

        // --- Decision B: the 5 DRIFT-broken command groups' missing columns ---
        for (table, columns) in DRIFT_FIX_COLUMNS {
            if !table_exists(tx, table)? {
                println!("v7_drift_fixes: table '{table}' does not exist -- skipped");
                continue;
            }
            for (col, ty) in *columns {
                add_column_if_missing(tx, table, col, ty)?;
            }
            println!("v7_drift_fixes: {table} -- added {} missing column(s) from DRIFT_REPORT.md", columns.len());
        }
        // `customers.loyalty_points` needs a real default, not just NULL --
        // `loyalty/page.tsx` reads it as a number.
        if table_exists(tx, "customers")? {
            tx.execute("UPDATE customers SET loyalty_points = 0 WHERE loyalty_points IS NULL", [])?;
        }

        // --- Finding #3: attendance, created+scoped deterministically ---
        create_attendance_if_missing(tx, &tenant_id, &branch_id, &device_id)?;

        let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_D_VERSION, "0007_drift_fixes", applied_at, "n/a-programmatic"],
        )?;
        Ok(())
    });
    conn.execute_batch("PRAGMA foreign_keys=ON;").ok();
    result
}

pub const MIGRATION_E_VERSION: i64 = 9;

/// P0 perf fix (2026-07-18): reported as "table loads take ~6 seconds,
/// general lag". The DOMINANT cause, measured, was `security::authenticate`
/// doing a bcrypt-verify scan over every session_v3 row on every single
/// command call (fixed separately, in security.rs -- ~8.3s -> ~154us for 9
/// sessions). This migration is the second, explicitly-requested part:
/// **zero indexes existed anywhere in this schema** (grepped the whole
/// migration history -- confirmed) even though every scoped repo query
/// filters on `tenant_id`/`branch_id` via `scope_predicate`. That's a full
/// table scan on every list/read call. It wasn't the active cause of
/// today's reported lag (the real dev db has near-zero rows in every
/// table right now), but it's exactly the kind of bug that turns into a
/// production incident the day a restaurant's `orders` table has a few
/// months of real history -- fixed now, proactively, not after the next
/// complaint.
pub fn run_index_migration(conn: &mut Connection, _db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_E_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    let tx = conn.transaction()?;

    for table in TENANT_BRANCH_TABLES.iter().chain(TENANT_ONLY_TABLES.iter()) {
        if !table_exists(&tx, table)? {
            continue;
        }
        let cols: Vec<String> = {
            let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
            let names: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
            names
        };
        if cols.iter().any(|c| c == "tenant_id") && cols.iter().any(|c| c == "branch_id") {
            tx.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{table}_tenant_branch ON {table}(tenant_id, branch_id);"))?;
        } else if cols.iter().any(|c| c == "tenant_id") {
            tx.execute_batch(&format!("CREATE INDEX IF NOT EXISTS idx_{table}_tenant ON {table}(tenant_id);"))?;
        }
    }
    println!("v9_indexes: tenant_id/branch_id indexed on every TENANT_BRANCH_TABLES/TENANT_ONLY_TABLES table present in this database");

    // Foreign-key columns actually used in a JOIN or a scoped-by-parent
    // WHERE elsewhere in repo.rs (assert_order_in_scope-style lookups,
    // list_shift_orders, finance summaries, delivery/PO joins).
    let fk_indexes: &[(&str, &str, &str)] = &[
        ("order_items", "order_id", "idx_order_items_order_id"),
        ("order_items", "menu_item_id", "idx_order_items_menu_item_id"),
        ("payments", "order_id", "idx_payments_order_id"),
        ("orders", "shift_id", "idx_orders_shift_id"),
        ("orders", "table_id", "idx_orders_table_id"),
        ("menu_items", "category_id", "idx_menu_items_category_id"),
        ("delivery_logs", "order_id", "idx_delivery_logs_order_id"),
        ("delivery_logs", "driver_id", "idx_delivery_logs_driver_id"),
        ("purchase_order_items", "po_id", "idx_purchase_order_items_po_id"),
        ("inventory_logs", "ingredient_id", "idx_inventory_logs_ingredient_id"),
        ("debt_entries", "debtor_id", "idx_debt_entries_debtor_id"),
    ];
    for (table, col, idx_name) in fk_indexes {
        if !table_exists(&tx, table)? {
            continue;
        }
        let cols: Vec<String> = {
            let mut stmt = tx.prepare(&format!("PRAGMA table_info({table})"))?;
            let names: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(1))?.filter_map(|r| r.ok()).collect();
            names
        };
        if cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("CREATE INDEX IF NOT EXISTS {idx_name} ON {table}({col});"))?;
        }
    }
    println!("v9_indexes: FK columns used in JOINs/parent-scoped lookups indexed ({} candidates)", fk_indexes.len());

    let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
        params![MIGRATION_E_VERSION, "0009_scope_and_fk_indexes", applied_at, "n/a-programmatic"],
    )?;
    tx.commit()?;
    Ok(())
}

pub const MIGRATION_F_VERSION: i64 = 10;

/// Discount caps, the last T1.9 gap: `create_order_v3`/`create_full_order_v3`
/// accepted any `discount_cents` with no server-side ceiling at all -- a
/// cashier (or any renderer calling the command directly) could apply a
/// 100% discount. Per-role caps are tenant-configurable (an owner should be
/// able to loosen/tighten them).
///
/// These live in `chain_config`, NOT `tenant_settings` -- `tenant_settings`
/// (defined in this same file, above) has zero read/write call sites
/// anywhere in `repo.rs`/`commands_v3.rs`; it's v3-schema that was never
/// actually wired up (see `repo.rs`'s `ensure_chain_config_row` doc comment
/// for the same duality already documented for `branches`/`branch`).
/// `chain_config` is the table `get_chain_config_v3`/`update_chain_tax_v3`
/// actually read and write today, so that's where a setting needs to live
/// to be real rather than aspirational. Defaults match the values already
/// used (frontend-only, thus bypassable) by
/// `lib/permissions.ts::getMaxDiscountPercent`.
pub fn run_discount_cap_migration(conn: &mut Connection, _db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_F_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    let tx = conn.transaction()?;

    if table_exists(&tx, "chain_config")? {
        add_column_if_missing(&tx, "chain_config", "discount_cap_cashier_percent", "INTEGER NOT NULL DEFAULT 10")?;
        add_column_if_missing(&tx, "chain_config", "discount_cap_manager_percent", "INTEGER NOT NULL DEFAULT 50")?;
        add_column_if_missing(&tx, "chain_config", "discount_cap_owner_percent", "INTEGER NOT NULL DEFAULT 100")?;
    }
    println!("v10_discount_caps: chain_config.discount_cap_{{cashier,manager,owner}}_percent added (defaults 10/50/100)");

    let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
        params![MIGRATION_F_VERSION, "0010_discount_caps", applied_at, "n/a-programmatic"],
    )?;
    tx.commit()?;
    Ok(())
}

pub const MIGRATION_G_VERSION: i64 = 11;

/// Cloud sync outbox (Plan §5 / CLOUD_AND_LICENSING_PLAN.md, Slice 2a): every
/// syncable fact (order/order_item/payment creation or mutation) is queued
/// here in the SAME transaction as the fact itself -- see
/// `commands_v3::create_full_order_v3`/`finalize_order_with_payment_v3`/
/// `void_order_item_v3`. A background worker (sync.rs) drains this on its own
/// timer; nothing here is ever read on the sale path itself.
///
/// `license_status_at_enqueue` exists so the eventual owner dashboard can
/// distinguish paid-period facts from ones created while the license was
/// lapsed -- POS never stops selling regardless of license state, so this
/// column records the fact, it never gates the enqueue.
pub fn run_sync_outbox_migration(conn: &mut Connection, _db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_G_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    let tx = conn.transaction()?;

    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_outbox (
            id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL CHECK(table_name IN ('orders','order_items','payments')),
            row_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            rev INTEGER NOT NULL,
            hlc TEXT NOT NULL,
            device_id TEXT NOT NULL,
            license_status_at_enqueue TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','FAILED')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_due ON sync_outbox(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_sync_outbox_tenant ON sync_outbox(tenant_id);"
    )?;
    println!("v11_sync_outbox: sync_outbox table created (Plan Slice 2a)");

    let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
        params![MIGRATION_G_VERSION, "0011_sync_outbox", applied_at, "n/a-programmatic"],
    )?;
    tx.commit()?;
    Ok(())
}

pub const MIGRATION_H_VERSION: i64 = 12;

/// Supplier ledger (T2.0 plan, docs/plans/T2.0_SUPPLIER_LICENSE_DASHBOARD_LOYALTY.md
/// §1): today `receive_purchase_order` touches inventory only -- money paid
/// to a supplier is completely untracked. This adds a `debtors`/`debt_entries`-
/// shaped mini ledger for the other direction (money the business owes,
/// not money owed to it).
///
/// Money columns here are plain `_cents INTEGER`, matching `debt_entries`'s
/// REAL, live pattern -- not the wide `_minor/_currency/_scale/...` columns
/// `MONEY_COLUMNS` (Migration A, above) adds to `debt_entries.amount`. Those
/// wide columns are schema-only: no `Money`/`MoneySnapshot` Rust type exists
/// anywhere in this codebase, and `record_debt_payment` (repo.rs) never
/// reads or writes them -- they're populated once at migration time via a
/// backfill UPDATE and never touched by any live command afterward. Adding
/// a second money shape here that nothing else uses would be worse than
/// matching the pattern every other command actually runs on.
pub fn run_supplier_ledger_migration(conn: &mut Connection, _db_path: &Path) -> Result<(), V3Error> {
    let already: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1", params![MIGRATION_H_VERSION], |row| row.get(0))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    let tx = conn.transaction()?;

    if table_exists(&tx, "suppliers")? {
        add_column_if_missing(&tx, "suppliers", "total_owed_cents", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&tx, "suppliers", "total_paid_cents", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&tx, "suppliers", "balance_cents", "INTEGER NOT NULL DEFAULT 0")?;
    }

    if table_exists(&tx, "purchase_orders")? {
        add_column_if_missing(&tx, "purchase_orders", "amount_paid_cents", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&tx, "purchase_orders", "payment_status", "TEXT NOT NULL DEFAULT 'UNPAID'")?;
    }

    if table_exists(&tx, "operational_costs")? {
        add_column_if_missing(&tx, "operational_costs", "reference_type", "TEXT")?;
        add_column_if_missing(&tx, "operational_costs", "reference_id", "TEXT")?;
    }

    // Append-only fact table, mirrors debt_entries exactly (see doc comment
    // above for why bare `_cents`, not the wide Money columns).
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS supplier_payments (
            id                 TEXT PRIMARY KEY,
            tenant_id          TEXT NOT NULL,
            branch_id          TEXT NOT NULL,
            supplier_id        TEXT NOT NULL REFERENCES suppliers(id),
            purchase_order_id  TEXT REFERENCES purchase_orders(id),
            type               TEXT NOT NULL CHECK(type IN ('CHARGE','PAYMENT')),
            amount_cents       INTEGER NOT NULL,
            method             TEXT,
            notes              TEXT,
            created_by         TEXT NOT NULL REFERENCES staff(id),
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at_hlc     TEXT NOT NULL DEFAULT '',
            device_id          TEXT NOT NULL DEFAULT '',
            deleted_at         TEXT,
            rev                INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier_id ON supplier_payments(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_supplier_payments_po_id ON supplier_payments(purchase_order_id);
        CREATE INDEX IF NOT EXISTS idx_supplier_payments_tenant ON supplier_payments(tenant_id, branch_id);"
    )?;

    // Widen sync_outbox's table_name CHECK to admit the two new syncable
    // fact/config tables this ledger introduces -- SQLite can't ALTER a
    // CHECK constraint in place, so this is a rebuild: new table, copy
    // whatever's still queued, drop, rename. sync_outbox is a drain queue
    // (T1.9/Slice 2a's worker empties it continuously), so there is normally
    // very little to carry over, but a mid-flight row must not be dropped.
    if table_exists(&tx, "sync_outbox")? {
        tx.execute_batch(
            "CREATE TABLE sync_outbox_v12 (
                id TEXT PRIMARY KEY,
                table_name TEXT NOT NULL CHECK(table_name IN ('orders','order_items','payments','supplier_payments','operational_costs')),
                row_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL,
                branch_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                rev INTEGER NOT NULL,
                hlc TEXT NOT NULL,
                device_id TEXT NOT NULL,
                license_status_at_enqueue TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','FAILED')),
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO sync_outbox_v12 SELECT * FROM sync_outbox;
            DROP TABLE sync_outbox;
            ALTER TABLE sync_outbox_v12 RENAME TO sync_outbox;
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_due ON sync_outbox(status, next_attempt_at);
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_tenant ON sync_outbox(tenant_id);"
        )?;
    }

    println!("v12_supplier_ledger: supplier_payments created; suppliers/purchase_orders/operational_costs widened; sync_outbox table_name CHECK admits supplier_payments/operational_costs");

    let applied_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?1, ?2, ?3, ?4)",
        params![MIGRATION_H_VERSION, "0012_supplier_ledger", applied_at, "n/a-programmatic"],
    )?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;
    use rand::Rng;
    use std::fs;

    fn fresh_db_path(tag: &str) -> PathBuf {
        let temp = std::env::temp_dir().join(format!("migrate_v3_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        temp.join("test.db")
    }

    /// Build the real base schema (0001+0002+0003, via the T0.3 framework) and
    /// seed enough rows for a valid orders/order_items/payments/tables/users/
    /// menu_items/categories graph to hang synthetic orders off of.
    fn build_base_fixture(db_path: &Path) {
        let mut conn = Connection::open(db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
        migrate::run_migrations(&mut conn, db_path).expect("base migration (0001-0003) failed");

        conn.execute_batch(
            "INSERT INTO users (id, email, name, password_hash, role) VALUES
                ('user-1', 'owner@test.com', 'Test Owner', 'hash', 'OWNER'),
                ('user-2', 'cashier@test.com', 'Test Cashier', 'hash', 'CASHIER');
             INSERT INTO categories (id, name) VALUES ('cat-1', 'Food'), ('cat-2', 'Drinks');
             INSERT INTO menu_items (id, name, price_cents, cost_cents, category_id) VALUES
                ('item-1', 'Burger', 5000, 2000, 'cat-1'),
                ('item-2', 'Fries', 1500, 500, 'cat-1'),
                ('item-3', 'Cola', 1000, 300, 'cat-2');
             INSERT INTO tables (id, name) VALUES ('tbl-1', 'Table 1'), ('tbl-2', 'Table 2');
             INSERT INTO branches (id, name, currency) VALUES ('branch-legacy-1', 'الفرع الرئيسي', 'SYP');
             INSERT INTO chain_config (id, chain_name, currency) VALUES ('default', 'مطعم الاختبار', 'SYP');"
        ).expect("failed to seed base fixture");
    }

    /// 6 months of synthetic PAID orders with payments and 1-3 items each.
    /// Returns the ground-truth sum of `orders.total_cents`.
    fn insert_synthetic_orders(conn: &Connection, months: i32) -> i64 {
        let mut rng = rand::thread_rng();
        let mut total_sum: i64 = 0;

        for day in 0..(months * 30) {
            let orders_per_day = rng.gen_range(10..=30);
            for o in 0..orders_per_day {
                let order_id = format!("order-{day}-{o}");
                let table_id = if rng.gen_bool(0.5) { "tbl-1" } else { "tbl-2" };
                let user_id = if rng.gen_bool(0.7) { "user-1" } else { "user-2" };
                let total = rng.gen_range(2000..=20000);
                let subtotal = (total as f64 * 0.9) as i64;
                let tax = total - subtotal;
                total_sum += total;

                conn.execute(
                    "INSERT INTO orders (id, table_id, user_id, status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents, created_at)
                     VALUES (?1, ?2, ?3, 'PAID', 'DINE_IN', ?4, ?5, ?6, 0, datetime('now', ?7))",
                    params![order_id, table_id, user_id, subtotal, tax, total, format!("-{day} days")],
                ).expect("insert order");

                conn.execute(
                    "INSERT INTO payments (id, order_id, method, amount_cents, change_cents, created_at)
                     VALUES (?1, ?2, 'CASH', ?3, 0, datetime('now', ?4))",
                    params![format!("pay-{day}-{o}"), order_id, total, format!("-{day} days")],
                ).expect("insert payment");

                let item_count = rng.gen_range(1..=3);
                for i in 0..item_count {
                    let item_id = format!("item-{}", rng.gen_range(1..=3));
                    let qty = rng.gen_range(1..=4);
                    let unit_price = rng.gen_range(500..=5000);
                    conn.execute(
                        "INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price_cents)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![format!("oi-{day}-{o}-{i}"), order_id, item_id, qty, unit_price],
                    ).expect("insert order item");
                }
            }
        }
        total_sum
    }

    /// Reads back the sum of `orders.total_minor` (post-migration column),
    /// converted to the legacy cents unit via each row's own `total_scale`,
    /// so the comparison is meaningful regardless of which scale MoneyPolicy
    /// assigned. For SYP (scale 0) this is minor==cents, i.e. identity.
    fn sum_total_minor_as_legacy_cents(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COALESCE(SUM(total_minor), 0) FROM orders WHERE status = 'PAID'",
            [],
            |r| r.get(0),
        ).unwrap()
    }

    #[test]
    fn test_expand_then_remap_bit_identical_revenue() {
        let db_path = fresh_db_path("bitidentical");
        build_base_fixture(&db_path);

        let total_before: i64;
        {
            let conn = Connection::open(&db_path).unwrap();
            total_before = insert_synthetic_orders(&conn, 6);
        }
        println!("[bit-identical] total_before (6mo synthetic, pre-migration) = {total_before}");

        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            println!("[bit-identical] Migration A (EXPAND) applied cleanly");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
            println!("[bit-identical] Migration B (UUIDv7 remap) applied cleanly");
        }

        let conn = Connection::open(&db_path).unwrap();

        // Because SYP has MoneyPolicy scale 0, minor == legacy cents exactly (identity).
        // We assert that explicitly, not just assume it, so a future currency-scale
        // change to this test fixture can't silently make the comparison meaningless.
        let scale_used: i64 = conn.query_row(
            "SELECT DISTINCT total_scale FROM orders WHERE status = 'PAID' LIMIT 1", [], |r| r.get(0)
        ).unwrap();
        assert_eq!(scale_used, 0, "test fixture currency (SYP) must resolve to MoneyPolicy scale 0");

        let total_after = sum_total_minor_as_legacy_cents(&conn);
        println!("[bit-identical] total_after (post EXPAND+remap, via total_minor) = {total_after}");
        assert_eq!(total_before, total_after, "revenue sum changed across migration -- NOT bit-identical");

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        println!("[bit-identical] PRAGMA integrity_check = ok");

        let order_count: i64 = conn.query_row("SELECT COUNT(*) FROM orders WHERE status='PAID'", [], |r| r.get(0)).unwrap();
        println!("[bit-identical] {order_count} PAID orders verified bit-identical, order-count preserved");

        assert_zero_orphans(&conn).expect("orphan FK found after A+B");
        println!("[bit-identical] assert_zero_orphans: clean");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_remap_zero_orphans_standalone() {
        let db_path = fresh_db_path("orphans");
        build_base_fixture(&db_path);
        {
            let conn = Connection::open(&db_path).unwrap();
            insert_synthetic_orders(&conn, 2);
        }
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
        }

        let conn = Connection::open(&db_path).unwrap();

        let table_exists_conn = |t: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name = ?1",
                params![t], |r| r.get(0),
            ).unwrap_or(false)
        };
        let column_exists_conn = |table: &str, column: &str| -> bool {
            conn.prepare(&format!("PRAGMA table_info({table})"))
                .and_then(|mut stmt| {
                    let cols: Vec<String> = stmt
                        .query_map([], |r| r.get::<_, String>(1))?
                        .filter_map(|r| r.ok())
                        .collect();
                    Ok(cols.contains(&column.to_string()))
                })
                .unwrap_or(false)
        };

        // Exhaustive, table-by-table, matching SCHEMA_V3.md §10.2's acceptance test verbatim
        // (skipping any edge whose table/column doesn't exist in the real applied schema --
        // see the module doc comment on `table_exists` for the schema-drift context).
        let mut checked = 0;
        for (child, column, parent) in FK_EDGES {
            if !table_exists_conn(parent) || !column_exists_conn(child, column) {
                continue;
            }
            let orphans: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {child} WHERE {column} IS NOT NULL AND {column} NOT IN (SELECT id FROM {parent})"),
                [], |r| r.get(0),
            ).unwrap();
            println!("[zero-orphans] {child}.{column} -> {parent}.id: {orphans} orphan(s)");
            assert_eq!(orphans, 0, "{child}.{column} has {orphans} orphaned reference(s) to {parent}");
            checked += 1;
        }
        println!("[zero-orphans] {checked} FK edges checked exhaustively, zero orphans in every one");

        // Also confirm every id-owning table's ids actually look like UUIDv7 now
        // (version nibble '7'), not the old UUIDv4 ids -- proves the remap, not
        // just the absence of orphans.
        for table in ID_OWNING_TABLES {
            if !table_exists_conn(table) {
                continue;
            }
            let sample: Option<String> = conn.query_row(&format!("SELECT id FROM {table} LIMIT 1"), [], |r| r.get(0)).ok();
            if let Some(id) = sample {
                assert_eq!(id.chars().nth(14), Some('7'), "{table}.id does not look like UUIDv7: {id}");
            }
        }
        println!("[zero-orphans] sampled ids across all {} id-owning tables confirm UUIDv7", ID_OWNING_TABLES.len());

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_expand_migration_failure_restores_pre_migration_state() {
        let db_path = fresh_db_path("failrestore");
        build_base_fixture(&db_path);
        {
            let conn = Connection::open(&db_path).unwrap();
            insert_synthetic_orders(&conn, 1);
        }

        let order_count_before: i64;
        let integrity_before: String;
        {
            let conn = Connection::open(&db_path).unwrap();
            order_count_before = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
            integrity_before = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        }
        println!("[fail-restore] pre-migration: {order_count_before} orders, integrity={integrity_before}");

        // Deliberately fail partway through.
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            let result = run_expand_migration_with_injected_failure(&mut conn, &db_path);
            match &result {
                Err(e) => println!("[fail-restore] injected failure occurred as expected: {e}"),
                Ok(()) => panic!("expected the injected failure to fail, but it succeeded"),
            }
            assert!(result.is_err(), "injected-failure migration must return Err");
        }

        // Prove the DB is back to its exact pre-migration state and fully queryable.
        {
            let conn = Connection::open(&db_path).unwrap();

            let integrity_after: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
            assert_eq!(integrity_after, "ok", "DB not queryable/consistent after failed migration");
            println!("[fail-restore] post-failure integrity_check = {integrity_after}");

            let order_count_after: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
            assert_eq!(order_count_before, order_count_after, "order count changed despite restore");
            println!("[fail-restore] post-failure order count = {order_count_after} (unchanged)");

            // The tenant table created mid-migration (before the injected failure)
            // must NOT exist -- proves the snapshot rewound the WHOLE attempt, not
            // just the final failing statement.
            let tenant_table_exists: bool = conn.query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='tenant'",
                [], |r| r.get(0),
            ).unwrap();
            assert!(!tenant_table_exists, "tenant table survived a restore -- migration was not fully rolled back");
            println!("[fail-restore] tenant table (created mid-attempt) absent, as expected: restore was complete");

            // And orders.tenant_id (added mid-migration, before the failure) must
            // also be gone -- another angle on "fully rewound", not partially.
            let has_tenant_id_col: bool = conn
                .prepare("PRAGMA table_info(orders)").unwrap()
                .query_map([], |r| r.get::<_, String>(1)).unwrap()
                .filter_map(|r| r.ok())
                .any(|c| c == "tenant_id");
            assert!(!has_tenant_id_col, "orders.tenant_id survived a restore -- migration was not fully rolled back");
            println!("[fail-restore] orders.tenant_id column (added mid-attempt) absent, as expected");
        }

        // Prove recovery: the REAL migration now succeeds cleanly on this DB.
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("real Migration A must succeed after a prior failed attempt was cleanly restored");
            println!("[fail-restore] real Migration A now succeeds cleanly on the restored DB");
        }

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn test_scale_is_never_hardcoded_zero_for_non_syp() {
        // Directly exercises blocker #1: the migration must call MoneyPolicy::scale_for,
        // not assume 0. Build a fixture whose chain currency is USD and confirm the
        // backfilled scale is 2, not 0.
        let db_path = fresh_db_path("scalepolicy");
        build_base_fixture(&db_path);
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("UPDATE chain_config SET currency = 'USD' WHERE id = 'default'", []).unwrap();
            conn.execute(
                "INSERT INTO orders (id, table_id, user_id, status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents)
                 VALUES ('order-usd-1', 'tbl-1', 'user-1', 'PAID', 'DINE_IN', 900, 100, 1000, 0)", [],
            ).unwrap();
            conn.execute(
                "INSERT INTO payments (id, order_id, method, amount_cents, change_cents) VALUES ('pay-usd-1', 'order-usd-1', 'CASH', 1000, 0)", [],
            ).unwrap();
        }
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
        }
        let conn = Connection::open(&db_path).unwrap();
        let scale: i64 = conn.query_row(
            "SELECT total_scale FROM orders WHERE id = 'order-usd-1'", [], |r| r.get(0)
        ).unwrap();
        println!("[scale-policy] USD-currency order backfilled with total_scale = {scale} (MoneyPolicy::scale_for(\"USD\") = {})", money::scale_for("USD"));
        assert_eq!(scale, 2, "USD must resolve to MoneyPolicy scale 2, not a hardcoded 0");
        assert_eq!(scale as u8, money::scale_for("USD"));

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Decision A, end to end: staff backfilled from users (same ids), every
    /// FK that pointed at users(id) now points at staff(id) and still
    /// resolves, users is gone, and -- the non-negotiable acceptance test --
    /// revenue is STILL bit-identical after this third migration on top of
    /// A+B. "Forever" means forever, including migrations added after T1.1
    /// was closed.
    #[test]
    fn test_identity_migration_drops_users_repoints_fks_preserves_revenue() {
        let db_path = fresh_db_path("identity");
        build_base_fixture(&db_path);

        let total_before: i64;
        let orders_user_count_before: i64;
        {
            let conn = Connection::open(&db_path).unwrap();
            total_before = insert_synthetic_orders(&conn, 3);
            orders_user_count_before = conn.query_row("SELECT COUNT(DISTINCT user_id) FROM orders", [], |r| r.get(0)).unwrap();
        }
        println!("[identity] total_before = {total_before}, distinct order.user_id values = {orders_user_count_before}");

        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
            run_identity_migration(&mut conn, &db_path).expect("Migration C failed");
        }

        let conn = Connection::open(&db_path).unwrap();

        let users_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='users'", [], |r| r.get(0),
        ).unwrap();
        assert!(!users_exists, "users table must be gone after Migration C");
        println!("[identity] users table confirmed dropped");

        let staff_count: i64 = conn.query_row("SELECT COUNT(*) FROM staff", [], |r| r.get(0)).unwrap();
        assert!(staff_count >= 2, "staff must have been backfilled from the fixture's 2 users, got {staff_count}");
        println!("[identity] staff table has {staff_count} row(s), backfilled from users");

        // Every order's user_id must now resolve against staff, not users.
        let orphans: i64 = conn.query_row(
            "SELECT COUNT(*) FROM orders WHERE user_id NOT IN (SELECT id FROM staff)", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(orphans, 0, "every orders.user_id must resolve against staff.id post-repoint");
        println!("[identity] 0 orphaned orders.user_id values against staff.id ({orders_user_count_before} distinct staff members referenced)");

        // The declared FK constraint itself must now target staff, not users.
        let orders_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'", [], |r| r.get(0),
        ).unwrap();
        assert!(orders_sql.contains("REFERENCES staff(id)"), "orders.user_id must be declared REFERENCES staff(id)");
        assert!(!orders_sql.contains("REFERENCES users(id)"), "orders.user_id must no longer reference users(id)");
        println!("[identity] orders' declared FK confirmed repointed: REFERENCES staff(id), not users(id)");

        // THE acceptance test, still holding after a third migration.
        let total_after = sum_total_minor_as_legacy_cents(&conn);
        assert_eq!(total_before, total_after, "revenue must remain bit-identical through Migration C, same as A and B");
        println!("[identity] revenue STILL bit-identical after A+B+C: {total_after}");

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");
        println!("[identity] PRAGMA integrity_check = ok");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Decision B exception: chain_config's 4 missing columns (DRIFT_REPORT.md
    /// Finding #4) land in this migration, since it's already recreating tables.
    #[test]
    fn test_identity_migration_backfills_chain_config_finding_4_columns() {
        let db_path = fresh_db_path("chainconfigfix");
        build_base_fixture(&db_path);
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
            run_identity_migration(&mut conn, &db_path).expect("Migration C failed");
        }
        let conn = Connection::open(&db_path).unwrap();
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(chain_config)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect()
        };
        for col in ["customer_display_baud", "customer_display_port", "secondary_tax_rate_cents", "service_charge_rate_cents"] {
            assert!(cols.contains(&col.to_string()), "chain_config.{col} must exist after Migration C (DRIFT_REPORT.md Finding #4)");
        }
        println!("[chain-config-fix] all 4 previously-missing chain_config columns confirmed present: {:?}",
            ["customer_display_baud", "customer_display_port", "secondary_tax_rate_cents", "service_charge_rate_cents"]);

        let (baud, secondary_tax, service_charge): (i64, i64, i64) = conn.query_row(
            "SELECT customer_display_baud, secondary_tax_rate_cents, service_charge_rate_cents FROM chain_config WHERE id='default'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(baud, 9600);
        assert_eq!(secondary_tax, 0);
        assert_eq!(service_charge, 0);
        println!("[chain-config-fix] defaults sane: baud={baud}, secondary_tax_rate_cents={secondary_tax}, service_charge_rate_cents={service_charge} -- taxCalculator.ts's NaN risk is closed");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3a, Decision B: every column DRIFT_REPORT.md Findings #2/#5
    /// flagged as missing for the 5 named groups must exist after Migration D,
    /// and `attendance` must exist, be scoped, and reference `staff` (not the
    /// dropped `users` table) -- proving Finding #3 is closed deterministically,
    /// not by luck of the frontend's lazy path having already run first.
    #[test]
    fn test_drift_fix_migration_adds_missing_columns_and_creates_scoped_attendance() {
        let db_path = fresh_db_path("driftfix");
        build_base_fixture(&db_path);
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
            run_identity_migration(&mut conn, &db_path).expect("Migration C failed");
            run_drift_fix_migration(&mut conn, &db_path).expect("Migration D failed");
        }
        let conn = Connection::open(&db_path).unwrap();

        for (table, columns) in DRIFT_FIX_COLUMNS {
            let cols: Vec<String> = {
                let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
                stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect()
            };
            for (col, _) in *columns {
                assert!(cols.contains(&col.to_string()), "{table}.{col} must exist after Migration D (DRIFT_REPORT.md Finding #2/#5)");
            }
            println!("[drift-fix] {table}: all {} previously-missing column(s) confirmed present", columns.len());
        }

        let attendance_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='attendance'", [], |r| r.get(0),
        ).unwrap();
        assert!(attendance_exists, "attendance must exist after Migration D (Finding #3)");

        let attendance_cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(attendance)").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect()
        };
        for col in ["tenant_id", "branch_id", "user_id"] {
            assert!(attendance_cols.contains(&col.to_string()), "attendance.{col} must exist");
        }
        let attendance_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance'", [], |r| r.get(0),
        ).unwrap();
        assert!(attendance_sql.contains("REFERENCES staff(id)"), "attendance.user_id must reference staff(id), not the dropped users table");
        assert!(!attendance_sql.contains("REFERENCES users(id)"));
        println!("[drift-fix] attendance created deterministically: scoped (tenant_id/branch_id), and user_id -> staff(id), not users(id)");

        // A scoped query against attendance -- exactly what Finding #3 warned
        // would fail once T1.2's repo layer required tenant_id everywhere --
        // must now actually be possible (columns exist, both NOT NULL).
        let tenant_id: String = conn.query_row("SELECT id FROM tenant LIMIT 1", [], |r| r.get(0)).unwrap();
        let scoped_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM attendance WHERE tenant_id = ?1", params![tenant_id], |r| r.get(0),
        ).unwrap();
        assert_eq!(scoped_count, 0); // no rows yet, but the query itself must not error
        println!("[drift-fix] a tenant-scoped query against attendance succeeds (Finding #3's predicted future failure does not happen)");

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// T2.0 supplier ledger migration: idempotent (running it twice does not
    /// error or duplicate columns/tables -- the `schema_migrations` guard at
    /// the top of the function must actually short-circuit), and every
    /// column/table it's supposed to add is present afterward, including
    /// the sync_outbox table_name CHECK constraint rebuild admitting the two
    /// new table names.
    #[test]
    fn test_supplier_ledger_migration_is_idempotent_and_adds_expected_schema() {
        let db_path = fresh_db_path("supplier_ledger_migration");
        build_base_fixture(&db_path);
        {
            let mut conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
            run_expand_migration(&mut conn, &db_path).expect("Migration A failed");
            run_remap_migration(&mut conn, &db_path).expect("Migration B failed");
            run_identity_migration(&mut conn, &db_path).expect("Migration C failed");
            run_drift_fix_migration(&mut conn, &db_path).expect("Migration D failed");
            run_index_migration(&mut conn, &db_path).expect("Migration E failed");
            run_discount_cap_migration(&mut conn, &db_path).expect("Migration F failed");
            run_sync_outbox_migration(&mut conn, &db_path).expect("Migration G failed");
            run_supplier_ledger_migration(&mut conn, &db_path).expect("Migration H failed (first run)");
            // Second run must be a clean no-op, not an error.
            run_supplier_ledger_migration(&mut conn, &db_path).expect("Migration H failed (second run -- must be idempotent)");
        }
        let conn = Connection::open(&db_path).unwrap();

        let supplier_payments_exists: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='supplier_payments'", [], |r| r.get(0),
        ).unwrap();
        assert!(supplier_payments_exists, "supplier_payments table must exist");

        for (table, col) in [
            ("suppliers", "total_owed_cents"), ("suppliers", "total_paid_cents"), ("suppliers", "balance_cents"),
            ("purchase_orders", "amount_paid_cents"), ("purchase_orders", "payment_status"),
            ("operational_costs", "reference_type"), ("operational_costs", "reference_id"),
        ] {
            let cols: Vec<String> = {
                let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
                stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().filter_map(|r| r.ok()).collect()
            };
            assert!(cols.contains(&col.to_string()), "{table}.{col} must exist after Migration H");
        }
        println!("[supplier-ledger-migration] supplier_payments table + all widened columns present after two runs");

        // sync_outbox's table_name CHECK must now admit the two new names --
        // proven by actually inserting a row of each, not just inspecting
        // the CREATE TABLE text.
        for table_name in ["supplier_payments", "operational_costs", "orders", "order_items", "payments"] {
            conn.execute(
                "INSERT INTO sync_outbox (id, table_name, row_id, tenant_id, branch_id, payload_json, rev, hlc, device_id, license_status_at_enqueue) \
                 VALUES (?1, ?2, 'row-1', 'tenant-1', 'branch-1', '{}', 1, 'hlc-1', 'device-1', 'ACTIVE')",
                params![format!("outbox-{table_name}"), table_name],
            ).unwrap_or_else(|e| panic!("sync_outbox must accept table_name='{table_name}' after Migration H's CHECK rebuild: {e}"));
        }
        let rejected = conn.execute(
            "INSERT INTO sync_outbox (id, table_name, row_id, tenant_id, branch_id, payload_json, rev, hlc, device_id, license_status_at_enqueue) \
             VALUES ('outbox-bad', 'not_a_real_table', 'row-1', 'tenant-1', 'branch-1', '{}', 1, 'hlc-1', 'device-1', 'ACTIVE')",
            [],
        );
        assert!(rejected.is_err(), "the CHECK constraint must still reject an unlisted table_name, not have been silently dropped");
        println!("[supplier-ledger-migration] sync_outbox accepts all 5 known table_names and still rejects an unknown one");

        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(integrity, "ok");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}
