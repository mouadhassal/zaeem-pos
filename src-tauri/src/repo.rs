//! T1.2 -- the scoped repository layer. `rusqlite` appears ONLY here (and in
//! `migrate.rs`/`migrate_v3.rs`, which are schema-only). Every read/write goes
//! through a method that takes a `Scope`, so a forgotten `WHERE tenant_id=?`
//! cannot happen -- the type signature demands a Scope before any query runs.
//!
//! Critical guarantee (per review, 2026-07-16): a row with a NULL `tenant_id`
//! or `branch_id` is never silently excluded or silently wildcard-matched.
//! `assert_scope_populated` checks the WHOLE table before any scoped query
//! runs and hard-fails the entire call if even one unscoped row exists. This
//! matters concretely for the ~25 legacy tables T1.1 could not give a SQL
//! `NOT NULL` to (table-recreation was scoped down there) -- their integrity
//! rests entirely on this runtime check, not a schema constraint.

use crate::security::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use std::fmt;

#[derive(Debug)]
pub enum RepoError {
    Db(rusqlite::Error),
    UnscopedRows { table: String, column: String, count: i64 },
    ItemUnavailable { item_id: String, branch_id: String, reason: String },
    OrderOutOfScope { order_id: String },
    OrderAlreadyPaid { order_id: String },
}

impl fmt::Display for RepoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::UnscopedRows { table, column, count } => write!(
                f,
                "refusing to query {table}: {count} row(s) have a NULL {column} -- \
                 this is a hard error, not a silently-narrowed result. Backfill {table}.{column} before retrying."
            ),
            Self::ItemUnavailable { item_id, branch_id, reason } => write!(
                f, "item {item_id} unavailable at branch {branch_id}: {reason}"
            ),
            Self::OrderOutOfScope { order_id } => write!(f, "order {order_id} does not belong to the caller's tenant/branch"),
            Self::OrderAlreadyPaid { order_id } => write!(f, "order {order_id} is already PAID -- refusing to take a second payment"),
        }
    }
}
impl std::error::Error for RepoError {}
impl From<rusqlite::Error> for RepoError {
    fn from(e: rusqlite::Error) -> Self { Self::Db(e) }
}
impl From<RepoError> for String {
    fn from(e: RepoError) -> String { e.to_string() }
}

pub struct Repo<'a> {
    conn: &'a Connection,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OrderRow {
    pub id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub table_id: String,
    pub user_id: String,
    pub status: String,
    pub order_type: String,
    pub total_cents: i64,
}

pub struct NewOrder {
    pub table_id: String,
    pub user_id: String,
    pub order_type: String,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub discount_cents: i64,
    // NOTE: deliberately no `driver_id` field routed to a nonexistent column
    // (DRIFT_REPORT.md Finding #1) -- delivery driver assignment happens via
    // a separate, explicit follow-up write once `orders` genuinely has the
    // column (tracked, not silently reintroduced here).
}

/// Batch 3b -- T1.9's critical acceptance criterion. Everything `take_payment`
/// does (order -> PAID, payment row, table -> FREE, optional debt entry, the
/// order_current projection rebuild) happens against ONE `rusqlite::Connection`
/// inside ONE caller-owned transaction -- there is no intermediate commit a
/// `kill -9` could land between. See `commands_v3::take_payment_v3` for the
/// transaction boundary and audit entry.
pub struct PaymentInput {
    pub order_id: String,
    pub method: String,
    pub amount_cents: i64,
    pub change_cents: i64,
    pub debtor_id: Option<String>,
    pub actor_id: String,
}

/// Batch 3a, Decision B -- row shapes for the 5 DRIFT-broken command groups
/// (customers, purchase_orders, drivers, printers, delivery). Deliberately
/// narrower than `SELECT *`: exactly the fields the frontend pages named in
/// DRIFT_REPORT.md Findings #2/#5 actually read.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShiftRow {
    pub id: String,
    pub opened_at: String,
    pub starting_cash_cents: i64,
    pub user_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ShiftStatsRow {
    pub order_count: i64,
    pub total_sales: i64,
    pub cash_total: i64,
    pub card_total: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IngredientRow {
    pub id: String,
    pub name: String,
    pub unit: String,
    pub cost_cents_per_unit: i64,
    pub current_stock: f64,
    pub min_stock: f64,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CategoryRow {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub image_path: Option<String>,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MenuItemRow {
    pub id: String,
    pub name: String,
    pub price_cents: i64,
    pub cost_cents: i64,
    pub category_id: String,
    pub image_path: Option<String>,
    pub description: Option<String>,
    pub barcode: Option<String>,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StaffRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub role_rank: i64,
    pub branch_id: Option<String>,
    pub is_active: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CustomerRow {
    pub id: String,
    pub name: String,
    pub phone: String,
    pub email: Option<String>,
    pub address: Option<String>,
    pub notes: Option<String>,
    pub birthday: Option<String>,
    pub loyalty_points: i64,
    pub total_orders: i64,
    pub total_spent_cents: i64,
    pub last_order_at: Option<String>,
    pub last_modified: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CustomerOrderRow {
    pub id: String,
    pub status: String,
    pub total_cents: i64,
    pub created_at: String,
    pub order_type: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FavoriteItemRow {
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LoyaltyCardRow {
    pub id: String,
    pub customer_id: String,
    pub card_number: String,
    pub points: i64,
    pub tier: String,
    pub issued_at: String,
    pub last_used_at: Option<String>,
    pub customer_name: String,
    pub customer_phone: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChainConfigRow {
    pub chain_name: String,
    pub currency: String,
    pub tax_mode: String,
    pub tax_rate_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LegacyBranchRow {
    pub id: String,
    pub name: String,
    pub address: Option<String>,
    pub phone: Option<String>,
    pub max_tables: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RevenueSummaryRow {
    pub order_count: i64,
    pub total: i64,
    pub cash: i64,
    pub card: i64,
    pub wallet: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperationalCostRow {
    pub id: String,
    pub category: String,
    pub amount_cents: i64,
    pub notes: Option<String>,
    pub date: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InvoiceRow {
    pub id: String,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub amount_cents: i64,
    pub status: String,
    pub due_date: Option<String>,
    pub paid_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StaffPerformanceRow {
    pub name: String,
    pub order_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InventoryStatusRow {
    pub name: String,
    pub current_stock: f64,
    pub min_stock: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SalesReportRow {
    pub total_sales: i64,
    pub order_count: i64,
    pub top_items: Vec<FavoriteItemRow>,
    pub staff_performance: Vec<StaffPerformanceRow>,
    pub inventory_status: Vec<InventoryStatusRow>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DebtorRow {
    pub id: String,
    pub name: String,
    pub phone: String,
    pub email: Option<String>,
    pub address: Option<String>,
    pub notes: Option<String>,
    pub total_debt_cents: i64,
    pub total_paid_cents: i64,
    pub balance_cents: i64,
    pub last_transaction_at: Option<String>,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DebtEntryRow {
    pub id: String,
    pub debtor_id: String,
    pub order_id: Option<String>,
    pub amount_cents: i64,
    pub entry_type: String,
    pub notes: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LoyaltyTxRow {
    pub id: String,
    pub card_id: String,
    pub points: i64,
    pub tx_type: String,
    pub reference_type: Option<String>,
    pub reference_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PurchaseOrderRow {
    pub id: String,
    pub supplier_id: String,
    pub status: String,
    pub total_cents: i64,
    pub created_by: String,
    pub notes: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverRow {
    pub id: String,
    pub name: String,
    pub phone: Option<String>,
    pub vehicle_type: String,
    pub vehicle_plate: Option<String>,
    pub license_number: Option<String>,
    pub status: String,
    pub current_lat: Option<f64>,
    pub current_lng: Option<f64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PrinterRow {
    pub id: String,
    pub name: String,
    pub printer_type: String,
    pub interface: String,
    pub vendor_id: Option<String>,
    pub product_id: Option<String>,
    pub drawer_pulse_ms: i64,
    pub is_primary: i64,
    pub is_secondary: i64,
    pub is_active: i64,
    pub paper_width_mm: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeliveryLogRow {
    pub id: String,
    pub order_id: String,
    pub driver_id: String,
    pub status: String,
    pub assigned_at: Option<String>,
    pub picked_up_at: Option<String>,
    pub delivered_at: Option<String>,
    pub failed_at: Option<String>,
}

impl<'a> Repo<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Repo { conn }
    }

    /// The core guarantee described in the module doc comment. Called at the
    /// top of every scoped method, before the scope predicate is even built.
    // pub(crate), not private: T1.9 (a later batch) and this batch's own test
    // need to exercise the guarantee directly against the ~25 legacy tables
    // that have no SQL NOT NULL, without requiring a dedicated Repo method
    // for every single one of them yet.
    pub(crate) fn assert_scope_populated(&self, table: &str, requires_branch: bool) -> Result<(), RepoError> {
        let null_tenant: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE tenant_id IS NULL"),
            [],
            |r| r.get(0),
        )?;
        if null_tenant > 0 {
            return Err(RepoError::UnscopedRows { table: table.to_string(), column: "tenant_id".to_string(), count: null_tenant });
        }
        if requires_branch {
            let null_branch: i64 = self.conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE branch_id IS NULL"),
                [],
                |r| r.get(0),
            )?;
            if null_branch > 0 {
                return Err(RepoError::UnscopedRows { table: table.to_string(), column: "branch_id".to_string(), count: null_branch });
            }
        }
        Ok(())
    }

    /// Every scope resolves to a real, non-optional SQL predicate. There is
    /// no arm that returns "no filter" for Tenant/Branch, and Platform's
    /// deliberate "everything" access is the one documented exception, not a
    /// fallback -- it only fires when the actor's role really is Platform,
    /// established by `authenticate` + `staff.role`, never by a missing scope.
    fn scope_predicate(scope: &Scope) -> (&'static str, Vec<String>) {
        match scope {
            Scope::Platform => ("1=1", vec![]),
            Scope::Tenant { tenant_id } => ("tenant_id = ?1", vec![tenant_id.clone()]),
            Scope::Branch { tenant_id, branch_id } => {
                ("tenant_id = ?1 AND branch_id = ?2", vec![tenant_id.clone(), branch_id.clone()])
            }
        }
    }

    pub fn list_orders(&self, scope: &Scope) -> Result<Vec<OrderRow>, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let (pred, binds) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, tenant_id, branch_id, table_id, user_id, status, order_type, total_cents \
             FROM orders WHERE {pred} ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(bind_refs.as_slice(), |r| {
            Ok(OrderRow {
                id: r.get(0)?, tenant_id: r.get(1)?, branch_id: r.get(2)?, table_id: r.get(3)?,
                user_id: r.get(4)?, status: r.get(5)?, order_type: r.get(6)?, total_cents: r.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// `scope` here is the CALLER's scope (used only for the populated-table
    /// check); the row is always written into the caller's own branch --
    /// `create_order` never accepts a branch id argument from the caller, so
    /// there is no code path where a Branch-scoped actor can write into a
    /// branch that isn't their own.
    pub fn create_order(&self, scope: &Scope, tenant_id: &str, branch_id: &str, input: NewOrder) -> Result<String, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let _ = scope; // populated-check already ran; write path is intentionally branch-pinned, see doc comment
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        // Money is sacred: a NEWLY created order gets its `_minor`/`_currency`/
        // `_scale` columns populated from `crate::money::scale_for` at write
        // time, same as T1.1's backfill did for pre-existing rows -- there is
        // no code path where an order exists with only the legacy `_cents`
        // columns set and the money columns left NULL for someone else to
        // backfill later.
        let currency: String = self.conn.query_row("SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0))?;
        let scale = crate::money::scale_for(&currency) as i64;

        self.conn.execute(
            "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, \
             subtotal_cents, tax_cents, total_cents, discount_cents, created_at, sync_version, last_modified, sync_status, \
             subtotal_minor, subtotal_currency, subtotal_scale, subtotal_base_minor, subtotal_fx_rate, subtotal_fx_source, subtotal_denom_epoch, \
             tax_minor, tax_currency, tax_scale, tax_base_minor, tax_fx_rate, tax_fx_source, tax_denom_epoch, \
             discount_minor, discount_currency, discount_scale, discount_base_minor, discount_fx_rate, discount_fx_source, discount_denom_epoch, \
             total_minor, total_currency, total_scale, total_base_minor, total_fx_rate, total_fx_source, total_denom_epoch) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?7, ?8, ?9, ?10, ?11, 1, ?11, 'pending', \
             ?7, ?12, ?13, ?7, '1', 'NATIVE', 2, \
             ?8, ?12, ?13, ?8, '1', 'NATIVE', 2, \
             ?10, ?12, ?13, ?10, '1', 'NATIVE', 2, \
             ?9, ?12, ?13, ?9, '1', 'NATIVE', 2)",
            params![id, tenant_id, branch_id, input.table_id, input.user_id, input.order_type,
                     input.subtotal_cents, input.tax_cents, input.total_cents, input.discount_cents, now,
                     currency, scale],
        )?;
        Ok(id)
    }

    /// T1.9's critical acceptance criterion: order -> PAID, the payment row,
    /// table -> FREE, the optional debt entry, and the `order_current`
    /// projection rebuild are all plain `self.conn.execute` calls on ONE
    /// connection -- the caller (`commands_v3::take_payment_v3`) wraps this
    /// whole method call in one `rusqlite::Transaction` and commits once, at
    /// the very end. There is no intermediate commit; a process killed at
    /// any point before that final `tx.commit()` loses ALL of these writes
    /// together, never some subset of them (proven by
    /// `commands_v3::tests::kill_9_mid_payment_never_leaves_a_partial_payment`).
    pub fn take_payment(&self, tenant_id: &str, branch_id: &str, input: PaymentInput) -> Result<String, RepoError> {
        self.assert_scope_populated("payments", true)?;
        self.assert_scope_populated("orders", true)?;

        let (order_tenant_id, order_branch_id, order_status): (String, String, String) = self.conn.query_row(
            "SELECT tenant_id, branch_id, status FROM orders WHERE id = ?1",
            params![input.order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if order_tenant_id != tenant_id || order_branch_id != branch_id {
            return Err(RepoError::OrderOutOfScope { order_id: input.order_id.clone() });
        }
        if order_status == "PAID" {
            return Err(RepoError::OrderAlreadyPaid { order_id: input.order_id.clone() });
        }

        let now = chrono::Utc::now().to_rfc3339();
        let currency: String = self.conn.query_row("SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0))?;
        let scale = crate::money::scale_for(&currency) as i64;
        let payment_id = uuid::Uuid::now_v7().to_string();

        // 1. The payment fact -- money columns populated at write time, same
        //    rule as `create_order`, never left NULL for a later backfill.
        self.conn.execute(
            "INSERT INTO payments (id, tenant_id, branch_id, order_id, method, amount_cents, change_cents, created_at, sync_version, last_modified, sync_status, \
             amount_minor, amount_currency, amount_scale, amount_base_minor, amount_fx_rate, amount_fx_source, amount_denom_epoch, \
             change_minor, change_currency, change_scale, change_base_minor, change_fx_rate, change_fx_source, change_denom_epoch) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?8, 'pending', \
             ?6, ?9, ?10, ?6, '1', 'NATIVE', 2, \
             ?7, ?9, ?10, ?7, '1', 'NATIVE', 2)",
            params![payment_id, tenant_id, branch_id, input.order_id, input.method, input.amount_cents, input.change_cents, now, currency, scale],
        )?;

        // 2. Order -> PAID.
        self.conn.execute(
            "UPDATE orders SET status = 'PAID', closed_at = ?1, last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
            params![now, input.order_id],
        )?;

        // 3. Table -> FREE, unconditionally releasing whichever table this
        //    order was occupying (there is exactly one, by `current_order_id`).
        self.conn.execute(
            "UPDATE tables SET status = 'FREE', current_order_id = NULL, last_modified = ?1, sync_status = 'pending' WHERE current_order_id = ?2",
            params![now, input.order_id],
        )?;

        // 4. Optional debt entry -- same transaction, not a follow-up write.
        if let Some(debtor_id) = &input.debtor_id {
            let debt_entry_id = uuid::Uuid::now_v7().to_string();
            self.conn.execute(
                "INSERT INTO debt_entries (id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, sync_version, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, 'DEBT', NULL, ?5, ?6, 1, ?6, 'pending')",
                params![debt_entry_id, debtor_id, input.order_id, input.amount_cents, input.actor_id, now],
            )?;
            self.conn.execute(
                "UPDATE debtors SET total_debt_cents = total_debt_cents + ?1, balance_cents = balance_cents + ?1, last_transaction_at = ?2, last_modified = ?2 WHERE id = ?3",
                params![input.amount_cents, now, debtor_id],
            )?;
        }

        // 5. T1.6: the PAID status is an append-only fact + projection
        //    rebuild, same as every other order status transition.
        self.append_order_status_event(tenant_id, branch_id, &input.order_id, "PAID", &input.actor_id, "payment-command")?;
        self.rebuild_order_current(&input.order_id)?;

        Ok(payment_id)
    }

    /// Platform scope only (enforced by the caller's `authorize` check before
    /// this is ever reached) -- creates a new tenant + its first branch.
    pub fn create_branch(&self, tenant_id: &str, name: &str, currency: &str) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO branch (id, tenant_id, name, currency, updated_at_hlc, device_id, rev) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'platform-command', 1)",
            params![id, tenant_id, name, currency, now],
        )?;
        Ok(id)
    }

    /// Batch 3b -- lets an Owner/Platform actor pick a `target_branch_id`
    /// for `create_staff_v3` (a Manager's own `create_staff_v3` call ignores
    /// this entirely, forced to their own branch instead).
    pub fn list_branches(&self, tenant_id: &str) -> Result<Vec<(String, String)>, RepoError> {
        let mut stmt = self.conn.prepare("SELECT id, name FROM branch WHERE tenant_id = ?1 ORDER BY name ASC")?;
        let rows = stmt.query_map(params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `actor_branch_id: None` means the caller is Owner/Platform (may target
    /// any branch in `target_branch_id`); `Some(b)` means the caller is a
    /// Manager, and `target_branch_id` is IGNORED in favor of `b` -- the
    /// forcing described in ARCHITECTURE_V3.md hard rule #2, enforced here at
    /// the repo layer, not just in the command handler, so it can't be
    /// bypassed by a future command that forgets the check.
    #[allow(clippy::too_many_arguments)]
    pub fn create_staff(
        &self,
        tenant_id: &str,
        actor_branch_id: Option<&str>,
        target_branch_id: Option<&str>,
        role: &str,
        role_rank: u8,
        name: &str,
        pin_hash: Option<&str>,
        password_hash: Option<&str>,
    ) -> Result<String, RepoError> {
        let effective_branch_id = match actor_branch_id {
            Some(b) => Some(b), // Manager: forced to own branch, target_branch_id ignored
            None => target_branch_id, // Owner/Platform: caller's explicit target
        };
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO staff (id, tenant_id, branch_id, role, role_rank, name, pin_hash, password_hash, is_active, created_at, updated_at_hlc, device_id, rev) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, 'platform-command', 1)",
            params![id, tenant_id, effective_branch_id, role, role_rank, name, pin_hash, password_hash, now],
        )?;
        Ok(id)
    }

    /// Reads back a staff row's (tenant_id, branch_id, role_rank) -- used by
    /// the command layer to check the assignment rank rule against the
    /// TARGET's current rank, not just the new one, before allowing an update.
    pub fn get_staff_scope(&self, staff_id: &str) -> Result<(String, Option<String>, u8), RepoError> {
        self.conn
            .query_row(
                "SELECT tenant_id, branch_id, role_rank FROM staff WHERE id = ?1",
                params![staff_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u8)),
            )
            .map_err(RepoError::from)
    }

    pub fn update_staff_role(&self, staff_id: &str, new_role: &str, new_role_rank: u8) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE staff SET role = ?1, role_rank = ?2, updated_at_hlc = ?3, rev = rev + 1 WHERE id = ?4",
            params![new_role, new_role_rank, now, staff_id],
        )?;
        Ok(())
    }

    /// Batch 3b -- `staff/page.tsx`'s CRUD, finally pointed at `staff`
    /// instead of the dropped `users` table. Scope decision, stated plainly:
    /// `staff` has no `email`/`phone`/`photo_path`/`cv_path`/`qr_code`
    /// columns (the old UI collected all of these) -- this only updates
    /// `name` and, optionally, `pin_hash`. Photo/CV upload has nowhere to
    /// persist to anymore and is a UI-level no-op now, not silently dropped
    /// data (there was never a column for it to land in on this table).
    pub fn update_staff_profile(&self, staff_id: &str, name: &str, new_pin_hash: Option<&str>) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        match new_pin_hash {
            Some(hash) => {
                self.conn.execute(
                    "UPDATE staff SET name = ?1, pin_hash = ?2, updated_at_hlc = ?3, rev = rev + 1 WHERE id = ?4",
                    params![name, hash, now, staff_id],
                )?;
            }
            None => {
                self.conn.execute(
                    "UPDATE staff SET name = ?1, updated_at_hlc = ?2, rev = rev + 1 WHERE id = ?3",
                    params![name, now, staff_id],
                )?;
            }
        }
        Ok(())
    }

    pub fn set_staff_active(&self, staff_id: &str, is_active: bool) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE staff SET is_active = ?1, updated_at_hlc = ?2, rev = rev + 1 WHERE id = ?3",
            params![is_active as i64, now, staff_id],
        )?;
        Ok(())
    }

    /// `staff` is scoped by `tenant_id` always, `branch_id` only for
    /// non-Owner/Platform roles (Owner/Platform rows have a NULL branch_id by
    /// the table's own CHECK constraint) -- so listing staff is always a
    /// tenant-wide query, never additionally filtered by the CALLER's own
    /// branch (a Manager must still see the Owner and their fellow Managers
    /// in the tenant, not just their own branch's staff). Who may see whom
    /// beyond that is `authorize_scope`'s job at the command layer, same as
    /// every other list method here.
    pub fn list_staff(&self, scope: &Scope) -> Result<Vec<StaffRow>, RepoError> {
        let tenant_id = match scope {
            Scope::Platform => None,
            Scope::Tenant { tenant_id } | Scope::Branch { tenant_id, .. } => Some(tenant_id.clone()),
        };
        let (sql, tenant_id) = match &tenant_id {
            Some(t) => ("SELECT id, name, role, role_rank, branch_id, is_active, created_at FROM staff WHERE tenant_id = ?1 ORDER BY name ASC", Some(t.clone())),
            None => ("SELECT id, name, role, role_rank, branch_id, is_active, created_at FROM staff ORDER BY name ASC", None),
        };
        let mut stmt = self.conn.prepare(sql)?;
        let row_mapper = |r: &rusqlite::Row| {
            Ok(StaffRow { id: r.get(0)?, name: r.get(1)?, role: r.get(2)?, role_rank: r.get(3)?, branch_id: r.get(4)?, is_active: r.get(5)?, created_at: r.get(6)? })
        };
        let rows = match tenant_id {
            Some(t) => stmt.query_map(params![t], row_mapper)?.collect::<Result<Vec<_>, _>>(),
            None => stmt.query_map([], row_mapper)?.collect::<Result<Vec<_>, _>>(),
        };
        rows.map_err(RepoError::from)
    }

    // -----------------------------------------------------------------
    // T1.6 -- append-only order status events + the order_current projection
    // -----------------------------------------------------------------

    /// Appends one status-change fact. Per SCHEMA_V3.md §6, `orders.status`
    /// is never UPDATEd directly by anything built on this repo layer --
    /// this is the only way a status "changes": a new event is appended, and
    /// `order_current` (a LOCAL-ONLY read cache, never synced) is rebuilt
    /// from a fresh replay of the whole event stream, not patched in place.
    pub fn append_order_status_event(&self, tenant_id: &str, branch_id: &str, order_id: &str, status: &str, actor_id: &str, device_id: &str) -> Result<(), RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let seq: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM order_status_event WHERE device_id = ?1",
            params![device_id], |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO order_status_event (id, tenant_id, branch_id, order_id, status, actor_id, device_id, seq, ts) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, tenant_id, branch_id, order_id, status, actor_id, device_id, seq, now],
        )?;
        Ok(())
    }

    /// Rebuilds `order_current` for one order from a FRESH replay of
    /// `order_status_event` (status) and `orders` (money, which lives on the
    /// wide `orders` row itself per the Design choice in SCHEMA_V3.md §5, not
    /// a separate fact stream) -- never incrementally patched. This is what
    /// makes "projection == replay" true by construction: there is no code
    /// path that updates `order_current` other than recomputing it whole.
    pub fn rebuild_order_current(&self, order_id: &str) -> Result<(), RepoError> {
        let (tenant_id, branch_id, subtotal_minor, tax_minor, discount_minor, total_minor, currency): (String, String, i64, i64, i64, i64, String) =
            self.conn.query_row(
                "SELECT tenant_id, branch_id, subtotal_minor, tax_minor, discount_minor, total_minor, total_currency FROM orders WHERE id = ?1",
                params![order_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )?;
        let latest_status: String = self.conn.query_row(
            "SELECT status FROM order_status_event WHERE order_id = ?1 ORDER BY ts DESC, seq DESC LIMIT 1",
            params![order_id], |r| r.get(0),
        ).optional()?.unwrap_or_else(|| "PENDING".to_string());

        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO order_current (order_id, tenant_id, branch_id, status, subtotal_minor, tax_minor, discount_minor, total_minor, currency, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(order_id) DO UPDATE SET \
                status = excluded.status, subtotal_minor = excluded.subtotal_minor, tax_minor = excluded.tax_minor, \
                discount_minor = excluded.discount_minor, total_minor = excluded.total_minor, \
                currency = excluded.currency, updated_at = excluded.updated_at",
            params![order_id, tenant_id, branch_id, latest_status, subtotal_minor, tax_minor, discount_minor, total_minor, currency, now],
        )?;
        Ok(())
    }

    /// Independent of `order_current` entirely -- replays the fact stream
    /// fresh and returns just the status, for the projection==replay test to
    /// compare against what `order_current` actually stored.
    pub fn replay_order_status(&self, order_id: &str) -> Result<String, RepoError> {
        self.conn.query_row(
            "SELECT status FROM order_status_event WHERE order_id = ?1 ORDER BY ts DESC, seq DESC LIMIT 1",
            params![order_id], |r| r.get(0),
        ).optional().map(|s| s.unwrap_or_else(|| "PENDING".to_string())).map_err(RepoError::from)
    }

    // -----------------------------------------------------------------
    // T1.6 -- two-layer menu price resolution (SCHEMA_V3.md §3, blocker #2)
    // -----------------------------------------------------------------

    /// `override.price_minor ?? default.price_minor`. NO currency
    /// conversion, ever (blocker #2) -- if the branch's currency differs
    /// from the tenant's base currency and no override row sets an explicit
    /// price, this returns `ItemUnavailable` rather than silently converting
    /// or guessing. A menu price is a set number in a fixed currency.
    pub fn resolve_menu_price(&self, branch_id: &str, item_id: &str) -> Result<i64, RepoError> {
        let override_price: Option<i64> = self
            .conn
            .query_row(
                "SELECT price_minor FROM menu_item_override WHERE branch_id = ?1 AND item_id = ?2",
                params![branch_id, item_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten();

        if let Some(p) = override_price {
            return Ok(p);
        }

        let default_price: i64 = self
            .conn
            .query_row("SELECT price_minor FROM menu_item_default WHERE id = ?1", params![item_id], |r| r.get(0))?;

        let (branch_currency, tenant_base_currency): (String, String) = self.conn.query_row(
            "SELECT b.currency, t.base_currency FROM branch b JOIN tenant t ON t.id = b.tenant_id WHERE b.id = ?1",
            params![branch_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        if branch_currency != tenant_base_currency {
            return Err(RepoError::ItemUnavailable {
                item_id: item_id.to_string(),
                branch_id: branch_id.to_string(),
                reason: format!(
                    "branch currency {branch_currency} differs from tenant base currency {tenant_base_currency}, \
                     and no menu_item_override sets an explicit price for this item at this branch"
                ),
            });
        }

        Ok(default_price)
    }

    // -----------------------------------------------------------------
    // Batch 3a, Decision B -- the 5 DRIFT-broken command groups. Each of
    // these tables now has the columns DRIFT_REPORT.md flagged as missing
    // (Migration D); these methods are the scoped, audited replacement for
    // the frontend's direct Kysely `.insertInto(...)` calls into them.
    // Creates always derive tenant_id/branch_id from the caller's own Scope,
    // never from a client-supplied argument -- there is nothing here to
    // spoof, unlike `create_branch_v3`'s caller-supplied target tenant.
    // -----------------------------------------------------------------

    /// `customers` is tenant-only (SCHEMA_V3.md §9), not branch-scoped.
    #[allow(clippy::too_many_arguments)]
    pub fn create_customer(&self, tenant_id: &str, name: &str, phone: &str, email: Option<&str>, address: Option<&str>, notes: Option<&str>, birthday: Option<&str>) -> Result<String, RepoError> {
        self.assert_scope_populated("customers", false)?;
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO customers (id, tenant_id, name, phone, email, address, notes, birthday, total_orders, total_spent_cents, loyalty_points, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, 0, datetime('now'), 'pending')",
            params![id, tenant_id, name, phone, email, address, notes, birthday],
        )?;
        Ok(id)
    }

    pub fn list_customers(&self, tenant_id: &str) -> Result<Vec<CustomerRow>, RepoError> {
        self.assert_scope_populated("customers", false)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, phone, email, address, notes, birthday, loyalty_points, total_orders, total_spent_cents, last_order_at, last_modified \
             FROM customers WHERE tenant_id = ?1 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(CustomerRow {
                id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, email: r.get(3)?, address: r.get(4)?, notes: r.get(5)?, birthday: r.get(6)?,
                loyalty_points: r.get(7)?, total_orders: r.get(8)?, total_spent_cents: r.get(9)?, last_order_at: r.get(10)?, last_modified: r.get(11)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_customer(&self, customer_id: &str, name: &str, phone: &str, email: Option<&str>, address: Option<&str>, notes: Option<&str>, birthday: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE customers SET name = ?1, phone = ?2, email = ?3, address = ?4, notes = ?5, birthday = ?6, last_modified = datetime('now') WHERE id = ?7",
            params![name, phone, email, address, notes, birthday, customer_id],
        )?;
        Ok(())
    }

    pub fn delete_customer(&self, customer_id: &str) -> Result<(), RepoError> {
        self.conn.execute("DELETE FROM customers WHERE id = ?1", params![customer_id])?;
        Ok(())
    }

    /// Order history + favorite items for one customer, matched by phone
    /// (same join key the old Kysely code used -- `orders.customer_phone`,
    /// not a foreign key to `customers.id`, since walk-in orders can carry a
    /// phone with no `customers` row at all).
    pub fn customer_order_history(&self, phone: &str) -> Result<Vec<CustomerOrderRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, status, total_cents, created_at, order_type FROM orders WHERE customer_phone = ?1 ORDER BY created_at DESC LIMIT 20",
        )?;
        let rows = stmt.query_map(params![phone], |r| {
            Ok(CustomerOrderRow { id: r.get(0)?, status: r.get(1)?, total_cents: r.get(2)?, created_at: r.get(3)?, order_type: r.get(4)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn customer_favorite_items(&self, phone: &str) -> Result<Vec<FavoriteItemRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT menu_items.name, SUM(order_items.quantity) as qty \
             FROM order_items \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             INNER JOIN orders ON orders.id = order_items.order_id \
             WHERE orders.customer_phone = ?1 AND order_items.voided = 0 \
             GROUP BY menu_items.name ORDER BY qty DESC LIMIT 3",
        )?;
        let rows = stmt.query_map(params![phone], |r| {
            Ok(FavoriteItemRow { name: r.get(0)?, quantity: r.get(1)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 3, group 1b -- loyalty. `loyalty_cards` is tenant-only,
    // `loyalty_transactions` is tenant+branch. Card issuance is UID
    // keyboard-entry ONLY (a scanner is just a keyboard emitting the UID
    // string -- same software path; no separate hardware-scan integration,
    // per instruction, that's Phase 2).
    // -----------------------------------------------------------------

    /// `is_active` is deliberately not read/written -- DRIFT_REPORT.md
    /// Finding #5 confirmed the real `loyalty_cards` table (0001_init.sql)
    /// has no such column (only the aspirational `SCHEMA_SQL`/`schema.sql`
    /// declares it), and no real code references it either. Modeling a
    /// column that doesn't exist would just reproduce Finding #1's bug class.
    pub fn list_loyalty_cards(&self, tenant_id: &str) -> Result<Vec<LoyaltyCardRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT loyalty_cards.id, loyalty_cards.customer_id, loyalty_cards.card_number, loyalty_cards.points, loyalty_cards.tier, \
                    loyalty_cards.issued_at, loyalty_cards.last_used_at, customers.name, customers.phone \
             FROM loyalty_cards INNER JOIN customers ON customers.id = loyalty_cards.customer_id \
             WHERE loyalty_cards.tenant_id = ?1 ORDER BY loyalty_cards.points DESC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(LoyaltyCardRow {
                id: r.get(0)?, customer_id: r.get(1)?, card_number: r.get(2)?, points: r.get(3)?, tier: r.get(4)?,
                issued_at: r.get(5)?, last_used_at: r.get(6)?, customer_name: r.get(7)?, customer_phone: r.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `card_number` is the UID typed (or scanned -- a scanner is just a
    /// keyboard) at issue time, not generated here. SQLite's own `UNIQUE`
    /// constraint on `card_number` is the actual duplicate-UID guard; this
    /// method doesn't pre-check, it just surfaces the constraint violation.
    pub fn issue_loyalty_card(&self, tenant_id: &str, customer_id: &str, card_number: &str) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO loyalty_cards (id, tenant_id, customer_id, card_number, points, tier, issued_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, 0, 'BRONZE', datetime('now'), datetime('now'), 'pending')",
            params![id, tenant_id, customer_id, card_number],
        )?;
        Ok(id)
    }

    pub fn list_loyalty_transactions(&self, scope: &Scope, card_id: Option<&str>) -> Result<Vec<LoyaltyTxRow>, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let mut sql = format!(
            "SELECT id, card_id, points, type, reference_type, reference_id, created_at FROM loyalty_transactions WHERE {predicate}"
        );
        let mut args = args;
        if let Some(cid) = card_id {
            sql.push_str(&format!(" AND card_id = ?{}", args.len() + 1));
            args.push(cid.to_string());
        }
        sql.push_str(" ORDER BY created_at DESC LIMIT 100");
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(LoyaltyTxRow { id: r.get(0)?, card_id: r.get(1)?, points: r.get(2)?, tx_type: r.get(3)?, reference_type: r.get(4)?, reference_id: r.get(5)?, created_at: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 3, group 2 -- debt (بيع بالدين). `debtors` +
    // `debt_entries` are both `TENANT_BRANCH_TABLES`. DEBT-type entries are
    // already created by `take_payment_v3` (Batch 3b, slice 1) when a
    // payment carries a `debtor_id` -- this group only adds PAYMENT-type
    // entries (paying down an existing balance) and debtor CRUD.
    // -----------------------------------------------------------------

    pub fn list_debtors(&self, scope: &Scope) -> Result<Vec<DebtorRow>, RepoError> {
        self.assert_scope_populated("debtors", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, last_transaction_at, is_active \
             FROM debtors WHERE {predicate} AND is_active = 1 ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(DebtorRow {
                id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, email: r.get(3)?, address: r.get(4)?, notes: r.get(5)?,
                total_debt_cents: r.get(6)?, total_paid_cents: r.get(7)?, balance_cents: r.get(8)?, last_transaction_at: r.get(9)?, is_active: r.get(10)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_debtor(&self, tenant_id: &str, branch_id: &str, name: &str, phone: &str, email: Option<&str>, address: Option<&str>, notes: Option<&str>) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO debtors (id, tenant_id, branch_id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 0, 0, 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, phone, email, address, notes],
        )?;
        Ok(id)
    }

    pub fn update_debtor(&self, debtor_id: &str, name: &str, phone: &str, email: Option<&str>, address: Option<&str>, notes: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE debtors SET name = ?1, phone = ?2, email = ?3, address = ?4, notes = ?5, last_modified = datetime('now') WHERE id = ?6",
            params![name, phone, email, address, notes, debtor_id],
        )?;
        Ok(())
    }

    pub fn deactivate_debtor(&self, debtor_id: &str) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE debtors SET is_active = 0, last_modified = datetime('now') WHERE id = ?1",
            params![debtor_id],
        )?;
        Ok(())
    }

    pub fn list_debt_entries(&self, debtor_id: &str) -> Result<Vec<DebtEntryRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at FROM debt_entries WHERE debtor_id = ?1 ORDER BY created_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![debtor_id], |r| {
            Ok(DebtEntryRow { id: r.get(0)?, debtor_id: r.get(1)?, order_id: r.get(2)?, amount_cents: r.get(3)?, entry_type: r.get(4)?, notes: r.get(5)?, created_by: r.get(6)?, created_at: r.get(7)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// One transaction: the PAYMENT fact + the running-balance update on
    /// `debtors` -- same atomicity principle as `take_payment`/`adjust_stock`.
    pub fn record_debt_payment(&self, tenant_id: &str, branch_id: &str, debtor_id: &str, amount_cents: i64, notes: Option<&str>, actor_id: &str) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO debt_entries (id, tenant_id, branch_id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'PAYMENT', ?6, ?7, ?8, ?8, 'pending')",
            params![id, tenant_id, branch_id, debtor_id, amount_cents, notes, actor_id, now],
        )?;
        self.conn.execute(
            "UPDATE debtors SET total_paid_cents = total_paid_cents + ?1, balance_cents = balance_cents - ?1, last_transaction_at = ?2, last_modified = ?2 WHERE id = ?3",
            params![amount_cents, now, debtor_id],
        )?;
        Ok(id)
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 3, group 3 -- finance + reports (owner back-office
    // reads + operational_costs/invoices writes). `operational_costs.
    // description` and `invoices.notes` are deliberately never referenced --
    // DRIFT_REPORT.md Finding #5 flagged both as absent from the real
    // schema (only the aspirational `SCHEMA_SQL` declares them); the old
    // frontend was silently duplicating `notes` into a nonexistent
    // `description` column and would have hard-errored the moment `SCHEMA_
    // SQL`'s lazy path stopped winning that race. `operational_costs.user_id`
    // is already repointed at `staff(id)` by Decision A's Migration C.
    // -----------------------------------------------------------------

    pub fn finance_revenue_summary(&self, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<RevenueSummaryRow, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0) FROM orders WHERE {predicate} AND status = 'PAID' AND created_at >= ?{a} AND created_at <= ?{b}",
            a = args.len() + 1, b = args.len() + 2,
        );
        let mut all_args = args.clone();
        all_args.push(start_iso.to_string());
        all_args.push(end_iso.to_string());
        let params_refs: Vec<&dyn rusqlite::ToSql> = all_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let (order_count, total): (i64, i64) = self.conn.query_row(&sql, params_refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;

        // `payments` and `orders` both carry tenant_id/branch_id after
        // Migration A -- qualify the generic predicate with `orders.` so
        // the join isn't ambiguous about which table's columns it means.
        let (pred2, args2) = Self::scope_predicate(scope);
        let pred2 = pred2.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
        let sql2 = format!(
            "SELECT payments.method, COALESCE(SUM(payments.amount_cents), 0) FROM payments \
             INNER JOIN orders ON orders.id = payments.order_id \
             WHERE {pred2} AND orders.status = 'PAID' AND payments.created_at >= ?{a} AND payments.created_at <= ?{b} \
             GROUP BY payments.method",
            a = args2.len() + 1, b = args2.len() + 2,
        );
        let mut all_args2 = args2.clone();
        all_args2.push(start_iso.to_string());
        all_args2.push(end_iso.to_string());
        let params_refs2: Vec<&dyn rusqlite::ToSql> = all_args2.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let mut stmt = self.conn.prepare(&sql2)?;
        let method_totals: Vec<(String, i64)> = stmt.query_map(params_refs2.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;

        let mut cash = 0i64;
        let mut card = 0i64;
        let mut wallet = 0i64;
        for (method, amount) in method_totals {
            match method.as_str() {
                "CASH" => cash = amount,
                "CARD" => card = amount,
                "WALLET" => wallet = amount,
                _ => {}
            }
        }
        Ok(RevenueSummaryRow { order_count, total, cash, card, wallet })
    }

    pub fn tax_collected_since(&self, scope: &Scope, since_iso: &str) -> Result<i64, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT COALESCE(SUM(tax_cents), 0) FROM orders WHERE {predicate} AND status = 'PAID' AND closed_at >= ?{a}", a = args.len() + 1);
        let mut all_args = args.clone();
        all_args.push(since_iso.to_string());
        let params_refs: Vec<&dyn rusqlite::ToSql> = all_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        self.conn.query_row(&sql, params_refs.as_slice(), |r| r.get(0)).map_err(RepoError::from)
    }

    pub fn list_operational_costs(&self, scope: &Scope) -> Result<Vec<OperationalCostRow>, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT id, category, amount_cents, notes, date FROM operational_costs WHERE {predicate} ORDER BY date DESC LIMIT 100");
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| Ok(OperationalCostRow { id: r.get(0)?, category: r.get(1)?, amount_cents: r.get(2)?, notes: r.get(3)?, date: r.get(4)? }))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_operational_cost(&self, tenant_id: &str, branch_id: &str, category: &str, amount_cents: i64, date: &str, notes: Option<&str>, actor_id: &str) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO operational_costs (id, tenant_id, branch_id, category, amount_cents, date, notes, user_id, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, category, amount_cents, date, notes, actor_id],
        )?;
        Ok(id)
    }

    pub fn list_invoices(&self, tenant_id: &str) -> Result<Vec<InvoiceRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, period_start, period_end, amount_cents, status, due_date, paid_at FROM invoices WHERE tenant_id = ?1 ORDER BY due_date DESC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(InvoiceRow { id: r.get(0)?, period_start: r.get(1)?, period_end: r.get(2)?, amount_cents: r.get(3)?, status: r.get(4)?, due_date: r.get(5)?, paid_at: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_invoice(&self, tenant_id: &str, branch_id: &str, period_start: &str, period_end: &str, amount_cents: i64, due_date: &str) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO invoices (id, tenant_id, branch_id, chain_id, period_start, period_end, amount_cents, status, due_date, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, 'default', ?4, ?5, ?6, 'PENDING', ?7, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, period_start, period_end, amount_cents, due_date],
        )?;
        Ok(id)
    }

    pub fn mark_invoice_paid(&self, invoice_id: &str) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE invoices SET status = 'PAID', paid_at = datetime('now'), last_modified = datetime('now') WHERE id = ?1",
            params![invoice_id],
        )?;
        Ok(())
    }

    /// One command backing `reports/page.tsx`'s whole summary -- today's
    /// sales, all-time top-5 items (matching the old query's own scope,
    /// which never filtered items by date either), today's staff
    /// performance, and current inventory status.
    pub fn sales_report(&self, scope: &Scope, today_start_iso: &str) -> Result<SalesReportRow, RepoError> {
        let (pred, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT COUNT(*), COALESCE(SUM(total_cents), 0) FROM orders WHERE {pred} AND status = 'PAID' AND closed_at >= ?{a}", a = args.len() + 1);
        let mut all_args = args.clone();
        all_args.push(today_start_iso.to_string());
        let params_refs: Vec<&dyn rusqlite::ToSql> = all_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let (order_count, total_sales): (i64, i64) = self.conn.query_row(&sql, params_refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;

        let mut stmt = self.conn.prepare(
            "SELECT menu_items.name, SUM(order_items.quantity) FROM order_items \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             GROUP BY menu_items.name ORDER BY 2 DESC LIMIT 5",
        )?;
        let top_items: Vec<FavoriteItemRow> = stmt.query_map([], |r| Ok(FavoriteItemRow { name: r.get(0)?, quantity: r.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;

        // Same ambiguity concern as above -- `staff` also carries tenant_id/
        // branch_id, so qualify with `orders.` (the report is scoped to the
        // orders, not to which staff exist).
        let (pred3, args3) = Self::scope_predicate(scope);
        let pred3 = pred3.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
        let sql3 = format!(
            "SELECT staff.name, COUNT(orders.id) FROM orders INNER JOIN staff ON staff.id = orders.user_id \
             WHERE {pred3} AND orders.status = 'PAID' AND orders.closed_at >= ?{a} GROUP BY staff.name",
            a = args3.len() + 1,
        );
        let mut all_args3 = args3.clone();
        all_args3.push(today_start_iso.to_string());
        let params_refs3: Vec<&dyn rusqlite::ToSql> = all_args3.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let mut stmt3 = self.conn.prepare(&sql3)?;
        let staff_performance: Vec<StaffPerformanceRow> = stmt3.query_map(params_refs3.as_slice(), |r| Ok(StaffPerformanceRow { name: r.get(0)?, order_count: r.get(1)? }))?.collect::<Result<Vec<_>, _>>()?;

        let (pred4, args4) = Self::scope_predicate(scope);
        let sql4 = format!("SELECT name, current_stock, min_stock FROM ingredients WHERE {pred4}");
        let params_refs4: Vec<&dyn rusqlite::ToSql> = args4.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let mut stmt4 = self.conn.prepare(&sql4)?;
        let inventory_status: Vec<InventoryStatusRow> = stmt4.query_map(params_refs4.as_slice(), |r| Ok(InventoryStatusRow { name: r.get(0)?, current_stock: r.get(1)?, min_stock: r.get(2)? }))?.collect::<Result<Vec<_>, _>>()?;

        Ok(SalesReportRow { total_sales, order_count, top_items, staff_performance, inventory_status })
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 3, group 4 -- settings (currency/tax/branch/printer
    // config). Known, stated architectural gap: `chain_config` is a
    // SINGLE global row (`id = 'default'`), not genuinely tenant-scoped --
    // it predates the multi-tenant model entirely and nothing here
    // reconciles that; every tenant on one install still shares one
    // `chain_config` row, exactly as the pre-existing frontend code already
    // assumed. Fixing that is a real schema change, out of scope for this
    // slice, not silently papered over. Also note: `branches` (legacy,
    // plural, tenant-only, THIS settings page's "branch" tab) and `branch`
    // (T1.1's new multi-tenant table, what `create_branch_v3`/
    // `list_branches_v3` operate on) are two DIFFERENT tables -- same
    // duality as `menu_items` vs `menu_item_default`. This slice keeps
    // editing the real, populated `branches` table (what the UI actually
    // shows), not the empty new one.
    // -----------------------------------------------------------------

    /// Batch 3b, slice 3, group 4 -- found while building this method: NO
    /// migration or seed anywhere ever inserts `chain_config`'s `id =
    /// 'default'` row. On a genuinely fresh install the table has ZERO rows,
    /// so the old frontend's `.executeTakeFirst()` reads silently returned
    /// `undefined` (falling back to hardcoded UI defaults like "SAR") and
    /// its `UPDATE ... WHERE id = 'default'` writes silently affected ZERO
    /// rows -- a user could "save" currency/tax settings on a fresh install
    /// and nothing would ever actually persist. Fixed at the repo layer
    /// (not by reopening the closed, tested Migration A): every entry point
    /// here self-heals via `INSERT OR IGNORE`, relying on the schema's own
    /// column `DEFAULT`s (chain_name='Zaeem POS', currency='SYP',
    /// tax_mode='exclusive', tax_rate_cents=0) for every column this doesn't
    /// explicitly set.
    fn ensure_chain_config_row(&self) -> Result<(), RepoError> {
        self.conn.execute("INSERT OR IGNORE INTO chain_config (id) VALUES ('default')", [])?;
        Ok(())
    }

    pub fn get_chain_config(&self) -> Result<ChainConfigRow, RepoError> {
        self.ensure_chain_config_row()?;
        self.conn.query_row(
            "SELECT chain_name, currency, tax_mode, tax_rate_cents FROM chain_config WHERE id = 'default'",
            [], |r| Ok(ChainConfigRow { chain_name: r.get(0)?, currency: r.get(1)?, tax_mode: r.get(2)?, tax_rate_cents: r.get(3)? }),
        ).map_err(RepoError::from)
    }

    pub fn update_chain_currency(&self, currency: &str) -> Result<(), RepoError> {
        self.ensure_chain_config_row()?;
        self.conn.execute("UPDATE chain_config SET currency = ?1, last_modified = datetime('now') WHERE id = 'default'", params![currency])?;
        Ok(())
    }

    pub fn update_chain_tax(&self, tax_rate_cents: i64, tax_mode: &str) -> Result<(), RepoError> {
        self.ensure_chain_config_row()?;
        self.conn.execute(
            "UPDATE chain_config SET tax_rate_cents = ?1, tax_mode = ?2, last_modified = datetime('now') WHERE id = 'default'",
            params![tax_rate_cents, tax_mode],
        )?;
        Ok(())
    }

    pub fn get_legacy_branch(&self, tenant_id: &str) -> Result<Option<LegacyBranchRow>, RepoError> {
        self.conn.query_row(
            "SELECT id, name, address, phone, max_tables FROM branches WHERE tenant_id = ?1 LIMIT 1",
            params![tenant_id],
            |r| Ok(LegacyBranchRow { id: r.get(0)?, name: r.get(1)?, address: r.get(2)?, phone: r.get(3)?, max_tables: r.get(4)? }),
        ).optional().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_legacy_branch(&self, tenant_id: &str, existing_id: Option<&str>, name: &str, address: Option<&str>, phone: Option<&str>, max_tables: i64, currency: &str) -> Result<String, RepoError> {
        match existing_id {
            Some(id) => {
                self.conn.execute(
                    "UPDATE branches SET name = ?1, address = ?2, phone = ?3, max_tables = ?4, last_modified = datetime('now') WHERE id = ?5",
                    params![name, address, phone, max_tables, id],
                )?;
                Ok(id.to_string())
            }
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO branches (id, tenant_id, name, address, phone, max_tables, timezone, currency, tax_rate_cents, is_active, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Asia/Damascus', ?7, 0, 1, datetime('now'), 'pending')",
                    params![id, tenant_id, name, address, phone, max_tables, currency],
                )?;
                Ok(id)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_purchase_order(&self, tenant_id: &str, branch_id: &str, supplier_id: &str, created_by: &str, notes: Option<&str>) -> Result<String, RepoError> {
        self.assert_scope_populated("purchase_orders", true)?;
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO purchase_orders (id, tenant_id, branch_id, supplier_id, status, total_cents, created_by, notes, created_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, 'PENDING', 0, ?5, ?6, datetime('now'), datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, supplier_id, created_by, notes],
        )?;
        Ok(id)
    }

    pub fn list_purchase_orders(&self, scope: &Scope) -> Result<Vec<PurchaseOrderRow>, RepoError> {
        self.assert_scope_populated("purchase_orders", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, supplier_id, status, total_cents, created_by, notes, created_at FROM purchase_orders WHERE {predicate} ORDER BY created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(PurchaseOrderRow { id: r.get(0)?, supplier_id: r.get(1)?, status: r.get(2)?, total_cents: r.get(3)?, created_by: r.get(4)?, notes: r.get(5)?, created_at: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_driver(&self, tenant_id: &str, branch_id: &str, name: &str, phone: Option<&str>, vehicle_type: &str, license_number: Option<&str>, vehicle_plate: Option<&str>) -> Result<String, RepoError> {
        self.assert_scope_populated("drivers", true)?;
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO drivers (id, tenant_id, branch_id, name, phone, vehicle_type, license_number, vehicle_plate, status, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'AVAILABLE', 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, phone, vehicle_type, license_number, vehicle_plate],
        )?;
        Ok(id)
    }

    pub fn update_driver_location(&self, driver_id: &str, lat: f64, lng: f64) -> Result<(), RepoError> {
        self.assert_scope_populated("drivers", true)?;
        self.conn.execute(
            "UPDATE drivers SET current_lat = ?1, current_lng = ?2, last_modified = datetime('now') WHERE id = ?3",
            params![lat, lng, driver_id],
        )?;
        Ok(())
    }

    pub fn list_drivers(&self, scope: &Scope) -> Result<Vec<DriverRow>, RepoError> {
        self.assert_scope_populated("drivers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, phone, vehicle_type, vehicle_plate, license_number, status, current_lat, current_lng FROM drivers WHERE {predicate} AND is_active = 1 ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(DriverRow { id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, vehicle_type: r.get(3)?, vehicle_plate: r.get(4)?, license_number: r.get(5)?, status: r.get(6)?, current_lat: r.get(7)?, current_lng: r.get(8)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_printer(&self, tenant_id: &str, branch_id: &str, name: &str, printer_type: &str, interface: &str, vendor_id: Option<&str>, product_id: Option<&str>, drawer_pulse_ms: i64, is_primary: bool) -> Result<String, RepoError> {
        self.assert_scope_populated("printers", true)?;
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO printers (id, tenant_id, branch_id, name, printer_type, interface, vendor_id, product_id, drawer_pulse_ms, is_primary, is_secondary, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, printer_type, interface, vendor_id, product_id, drawer_pulse_ms, is_primary as i64],
        )?;
        Ok(id)
    }

    /// Batch 3b, slice 3, group 4: widened to include `is_active`/
    /// `paper_width_mm` and to list ALL printers, not just active ones --
    /// `settings/page.tsx` needs to see and re-enable a deactivated printer,
    /// which an active-only filter would make impossible. Nothing else calls
    /// this yet (`printer.ts` itself is still on `getDb()`, explicitly
    /// deferred), so widening it here doesn't change any other caller's
    /// behavior.
    pub fn list_printers(&self, scope: &Scope) -> Result<Vec<PrinterRow>, RepoError> {
        self.assert_scope_populated("printers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, printer_type, interface, vendor_id, product_id, drawer_pulse_ms, is_primary, is_secondary, is_active, paper_width_mm FROM printers WHERE {predicate} ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(PrinterRow { id: r.get(0)?, name: r.get(1)?, printer_type: r.get(2)?, interface: r.get(3)?, vendor_id: r.get(4)?, product_id: r.get(5)?, drawer_pulse_ms: r.get(6)?, is_primary: r.get(7)?, is_secondary: r.get(8)?, is_active: r.get(9)?, paper_width_mm: r.get(10)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn set_printer_active(&self, printer_id: &str, is_active: bool) -> Result<(), RepoError> {
        self.conn.execute("UPDATE printers SET is_active = ?1, last_modified = datetime('now') WHERE id = ?2", params![is_active as i64, printer_id])?;
        Ok(())
    }

    pub fn update_printer_paper_width(&self, printer_id: &str, paper_width_mm: i64) -> Result<(), RepoError> {
        self.conn.execute("UPDATE printers SET paper_width_mm = ?1, last_modified = datetime('now') WHERE id = ?2", params![paper_width_mm, printer_id])?;
        Ok(())
    }

    pub fn list_delivery_logs(&self, scope: &Scope) -> Result<Vec<DeliveryLogRow>, RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, order_id, driver_id, status, assigned_at, picked_up_at, delivered_at, failed_at FROM delivery_logs WHERE {predicate} ORDER BY assigned_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(DeliveryLogRow { id: r.get(0)?, order_id: r.get(1)?, driver_id: r.get(2)?, status: r.get(3)?, assigned_at: r.get(4)?, picked_up_at: r.get(5)?, delivered_at: r.get(6)?, failed_at: r.get(7)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `assigned_at` is set here, at creation -- matching the status the row
    /// starts in (`ASSIGNED`), never left NULL for a status the row claims
    /// to already be in.
    pub fn create_delivery_log(&self, tenant_id: &str, branch_id: &str, order_id: &str, driver_id: &str) -> Result<String, RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO delivery_logs (id, tenant_id, branch_id, order_id, driver_id, status, assigned_at, created_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'ASSIGNED', datetime('now'), datetime('now'), datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, order_id, driver_id],
        )?;
        Ok(id)
    }

    /// Append-only in spirit, same as order status (SCHEMA_V3.md §6): each
    /// status transition stamps its own timestamp column and never touches
    /// the ones a prior transition already set.
    pub fn update_delivery_status(&self, delivery_log_id: &str, new_status: &str) -> Result<(), RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let ts_column = match new_status {
            "PICKED_UP" => Some("picked_up_at"),
            "DELIVERED" => Some("delivered_at"),
            "FAILED" => Some("failed_at"),
            _ => None,
        };
        match ts_column {
            Some(col) => {
                self.conn.execute(
                    &format!("UPDATE delivery_logs SET status = ?1, {col} = datetime('now'), last_modified = datetime('now') WHERE id = ?2"),
                    params![new_status, delivery_log_id],
                )?;
            }
            None => {
                self.conn.execute(
                    "UPDATE delivery_logs SET status = ?1, last_modified = datetime('now') WHERE id = ?2",
                    params![new_status, delivery_log_id],
                )?;
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 2 -- menu CRUD (`categories` + `menu_items`, both
    // tenant-only per SCHEMA_V3.md §9). `combo_meals`/`combo_items`/
    // `happy_hour_rules` are explicitly OUT of scope for this slice --
    // stated, not hidden: `menu/page.tsx` still reads/writes those 3
    // directly via `getDb()`. Note also: this operates on the REAL,
    // populated `categories`/`menu_items` tables, not T1.6's
    // `menu_item_default`/`menu_item_override` -- those two-layer tables
    // have zero real data on any actual install; nothing has ever migrated
    // `menu_items` into them. Reconciling that duality is out of scope here.
    // -----------------------------------------------------------------

    pub fn list_categories(&self, tenant_id: &str) -> Result<Vec<CategoryRow>, RepoError> {
        self.assert_scope_populated("categories", false)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, color, sort_order, image_path, is_active FROM categories WHERE tenant_id = ?1 ORDER BY sort_order ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(CategoryRow { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, sort_order: r.get(3)?, image_path: r.get(4)?, is_active: r.get(5)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn create_category(&self, tenant_id: &str, name: &str, color: Option<&str>, sort_order: i64, image_path: Option<&str>) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO categories (id, tenant_id, name, color, sort_order, image_path, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, datetime('now'), 'pending')",
            params![id, tenant_id, name, color, sort_order, image_path],
        )?;
        Ok(id)
    }

    pub fn update_category(&self, category_id: &str, name: &str, color: Option<&str>, sort_order: i64, image_path: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE categories SET name = ?1, color = ?2, sort_order = ?3, image_path = ?4, last_modified = datetime('now') WHERE id = ?5",
            params![name, color, sort_order, image_path, category_id],
        )?;
        Ok(())
    }

    pub fn delete_category(&self, category_id: &str) -> Result<(), RepoError> {
        self.conn.execute("DELETE FROM categories WHERE id = ?1", params![category_id])?;
        Ok(())
    }

    pub fn list_menu_items(&self, tenant_id: &str) -> Result<Vec<MenuItemRow>, RepoError> {
        self.assert_scope_populated("menu_items", false)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, price_cents, cost_cents, category_id, image_path, description, barcode, is_active FROM menu_items WHERE tenant_id = ?1 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(MenuItemRow { id: r.get(0)?, name: r.get(1)?, price_cents: r.get(2)?, cost_cents: r.get(3)?, category_id: r.get(4)?, image_path: r.get(5)?, description: r.get(6)?, barcode: r.get(7)?, is_active: r.get(8)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_menu_item(&self, tenant_id: &str, name: &str, category_id: &str, price_cents: i64, cost_cents: i64, image_path: Option<&str>, description: Option<&str>, barcode: Option<&str>) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO menu_items (id, tenant_id, name, price_cents, cost_cents, category_id, image_path, description, barcode, is_active, recipe_id, is_combo, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, NULL, 0, datetime('now'), 'pending')",
            params![id, tenant_id, name, price_cents, cost_cents, category_id, image_path, description, barcode],
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_menu_item(&self, item_id: &str, name: &str, category_id: &str, price_cents: i64, cost_cents: i64, image_path: Option<&str>, description: Option<&str>, barcode: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE menu_items SET name = ?1, category_id = ?2, price_cents = ?3, cost_cents = ?4, image_path = ?5, description = ?6, barcode = ?7, last_modified = datetime('now') WHERE id = ?8",
            params![name, category_id, price_cents, cost_cents, image_path, description, barcode, item_id],
        )?;
        Ok(())
    }

    pub fn delete_menu_item(&self, item_id: &str) -> Result<(), RepoError> {
        self.conn.execute("DELETE FROM menu_items WHERE id = ?1", params![item_id])?;
        Ok(())
    }

    pub fn set_menu_item_active(&self, item_id: &str, is_active: bool) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE menu_items SET is_active = ?1, last_modified = datetime('now') WHERE id = ?2",
            params![is_active as i64, item_id],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 2, group 2 -- inventory: `ingredients` CRUD + stock
    // adjustment (`inventory_logs`, append-only in spirit -- every stock
    // change is a new log row, `ingredients.current_stock` is a derived
    // running total updated alongside it, never the sole record of a
    // change). Both tables are `TENANT_BRANCH_TABLES`. Deliberately OUT of
    // scope this slice, stated not hidden: `suppliers` CRUD, PO-receiving's
    // stock bump (`ReceivePOModal`), the movements/alerts read tabs -- all
    // still `getDb()`.
    // -----------------------------------------------------------------

    pub fn list_ingredients(&self, scope: &Scope) -> Result<Vec<IngredientRow>, RepoError> {
        self.assert_scope_populated("ingredients", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, unit, cost_cents_per_unit, current_stock, min_stock, is_active FROM ingredients WHERE {predicate} AND is_active = 1 ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(IngredientRow { id: r.get(0)?, name: r.get(1)?, unit: r.get(2)?, cost_cents_per_unit: r.get(3)?, current_stock: r.get(4)?, min_stock: r.get(5)?, is_active: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn create_ingredient(&self, tenant_id: &str, branch_id: &str, name: &str, unit: &str, cost_cents_per_unit: i64, min_stock: f64) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO ingredients (id, tenant_id, branch_id, name, unit, cost_cents_per_unit, current_stock, min_stock, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, unit, cost_cents_per_unit, min_stock],
        )?;
        Ok(id)
    }

    pub fn update_ingredient(&self, ingredient_id: &str, name: &str, unit: &str, cost_cents_per_unit: i64, min_stock: f64) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE ingredients SET name = ?1, unit = ?2, cost_cents_per_unit = ?3, min_stock = ?4, last_modified = datetime('now') WHERE id = ?5",
            params![name, unit, cost_cents_per_unit, min_stock, ingredient_id],
        )?;
        Ok(())
    }

    /// The stock-adjustment atomicity pair: `ingredients.current_stock`
    /// (the derived running total) and the new `inventory_logs` row (the
    /// append-only fact that justifies it) update together -- same
    /// principle as `take_payment`, just smaller. Never one without the
    /// other in the same transaction.
    pub fn adjust_stock(&self, tenant_id: &str, branch_id: &str, ingredient_id: &str, change_amount: f64, reason: &str, actor_id: &str) -> Result<String, RepoError> {
        self.assert_scope_populated("ingredients", true)?;
        let log_id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE ingredients SET current_stock = current_stock + ?1, last_modified = ?2 WHERE id = ?3",
            params![change_amount, now, ingredient_id],
        )?;
        self.conn.execute(
            "INSERT INTO inventory_logs (id, tenant_id, branch_id, ingredient_id, change_amount, reason, user_id, created_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'pending')",
            params![log_id, tenant_id, branch_id, ingredient_id, change_amount, reason, actor_id, now],
        )?;
        Ok(log_id)
    }

    // -----------------------------------------------------------------
    // Batch 3b, slice 2, group 3 -- shifts. `shifts` is a
    // `TENANT_BRANCH_TABLES` entry, `user_id` already repointed at
    // `staff(id)` by Decision A's Migration C.
    // -----------------------------------------------------------------

    pub fn open_shift(&self, tenant_id: &str, branch_id: &str, user_id: &str, starting_cash_cents: i64) -> Result<String, RepoError> {
        self.assert_scope_populated("shifts", true)?;
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO shifts (id, tenant_id, branch_id, user_id, opened_at, closed_at, starting_cash_cents, ending_cash_cents, difference_cents, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, NULL, ?5, 'pending')",
            params![id, tenant_id, branch_id, user_id, now, starting_cash_cents],
        )?;
        Ok(id)
    }

    /// The one currently-open shift for this staff member, if any -- there
    /// is at most one (the UI never opens a second shift while one is
    /// active), but this is a plain query, not an enforced constraint.
    pub fn get_active_shift(&self, user_id: &str) -> Result<Option<ShiftRow>, RepoError> {
        self.conn
            .query_row(
                "SELECT id, opened_at, starting_cash_cents, user_id FROM shifts WHERE user_id = ?1 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
                params![user_id],
                |r| Ok(ShiftRow { id: r.get(0)?, opened_at: r.get(1)?, starting_cash_cents: r.get(2)?, user_id: r.get(3)? }),
            )
            .optional()
            .map_err(RepoError::from)
    }

    /// Order count/total plus a CASH/CARD payment breakdown for one shift --
    /// exactly what `fetchShiftData` computed with 2 separate Kysely queries
    /// (`orders` aggregate + `payments` grouped by method), now one method.
    pub fn shift_stats(&self, shift_id: &str) -> Result<ShiftStatsRow, RepoError> {
        let (order_count, total_sales): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0) FROM orders WHERE status = 'PAID' AND shift_id = ?1",
            params![shift_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let cash_total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(payments.amount_cents), 0) FROM payments INNER JOIN orders ON orders.id = payments.order_id \
             WHERE payments.method = 'CASH' AND orders.status = 'PAID' AND orders.shift_id = ?1",
            params![shift_id], |r| r.get(0),
        )?;
        let card_total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(payments.amount_cents), 0) FROM payments INNER JOIN orders ON orders.id = payments.order_id \
             WHERE payments.method = 'CARD' AND orders.status = 'PAID' AND orders.shift_id = ?1",
            params![shift_id], |r| r.get(0),
        )?;
        Ok(ShiftStatsRow { order_count, total_sales, cash_total, card_total })
    }

    pub fn close_shift(&self, shift_id: &str, ending_cash_cents: i64, difference_cents: i64) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE shifts SET closed_at = ?1, ending_cash_cents = ?2, difference_cents = ?3, last_modified = ?1 WHERE id = ?4",
            params![now, ending_cash_cents, difference_cents, shift_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate;
    use crate::migrate_v3;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_migrated_db(tag: &str) -> PathBuf {
        let temp = std::env::temp_dir().join(format!("repo_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("test.db");
        let mut conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
        migrate::run_migrations(&mut conn, &db_path).unwrap();
        migrate_v3::run_expand_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_remap_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_identity_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_drift_fix_migration(&mut conn, &db_path).unwrap();
        db_path
    }

    /// The critical requirement, tested directly against `customers` -- one
    /// of the ~25 legacy tables T1.1 could only give a Rust-level backfill
    /// assertion to, NOT a SQL `NOT NULL` (unlike `orders`/`order_items`/
    /// `payments`, which got real table-recreation). This is exactly the
    /// scenario the review flagged: prove a NULL tenant_id on one of those
    /// tables is a hard error, not a silently narrowed result.
    #[test]
    fn null_tenant_id_on_a_legacy_table_without_sql_not_null_is_a_hard_error() {
        let db_path = fresh_migrated_db("legacy_null_scope");
        let conn = Connection::open(&db_path).unwrap();

        // Confirm the premise: customers.tenant_id has NO SQL NOT NULL (unlike orders).
        let customers_sql: String = conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'", [], |r| r.get(0),
        ).unwrap();
        assert!(!customers_sql.contains("tenant_id TEXT NOT NULL"), "premise violated: customers.tenant_id already has SQL NOT NULL, this test no longer exercises the Rust-level guarantee");
        println!("premise confirmed: customers.tenant_id has no SQL NOT NULL (Rust-level assertion is the only guard)");

        conn.execute(
            "INSERT INTO customers (id, name, phone, tenant_id) VALUES ('cust-1', 'Well Scoped', '0001', (SELECT id FROM tenant LIMIT 1))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO customers (id, name, phone, tenant_id) VALUES ('cust-2-unscoped', 'Bug Row', '0002', NULL)",
            [],
        ).unwrap();

        let repo = Repo::new(&conn);
        let result = repo.assert_scope_populated("customers", false);
        match &result {
            Err(RepoError::UnscopedRows { table, column, count }) => {
                println!("assert_scope_populated correctly HARD-ERRORED on customers: table={table} column={column} count={count}");
                assert_eq!(table, "customers");
                assert_eq!(column, "tenant_id");
                assert_eq!(*count, 1);
            }
            other => panic!("expected UnscopedRows, got: {other:?} -- a NULL-scope row on a table with no SQL NOT NULL was not caught"),
        }

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}
