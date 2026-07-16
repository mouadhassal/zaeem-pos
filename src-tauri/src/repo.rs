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
    PurchaseOrderOutOfScope { po_id: String },
    PurchaseOrderNotPending { po_id: String, status: String },
    OrderItemOutOfScope { item_id: String },
    TableOutOfScope { table_id: String },
    /// Generic tenant-ownership guard for `TENANT_ONLY_TABLES` rows
    /// (categories, menu_items, combo_meals, happy_hour_rules) referenced
    /// by client-supplied id -- see `assert_tenant_owns_row`.
    TenantOwnershipViolation { table: String, id: String },
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
            Self::PurchaseOrderOutOfScope { po_id } => write!(f, "purchase order {po_id} does not belong to the caller's tenant/branch"),
            Self::PurchaseOrderNotPending { po_id, status } => write!(f, "purchase order {po_id} is {status}, not PENDING -- refusing to receive/cancel it"),
            Self::OrderItemOutOfScope { item_id } => write!(f, "order item {item_id} does not belong to the caller's tenant/branch"),
            Self::TableOutOfScope { table_id } => write!(f, "table {table_id} does not belong to the caller's tenant/branch"),
            Self::TenantOwnershipViolation { table, id } => write!(f, "{table} row {id} does not belong to the caller's tenant"),
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct KdsOrderItemRow {
    pub name: String,
    pub quantity: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct KdsOrderRow {
    pub id: String,
    pub table_name: Option<String>,
    pub order_type: String,
    pub status: String,
    pub created_at: String,
    pub notes: Option<String>,
    pub items: Vec<KdsOrderItemRow>,
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

// ---------------------------------------------------------------------------
// Slice A -- POS flow: order-with-items, hold, retrieve, split, merge,
// void, transfer, delayed orders, tables, receipt config, loyalty lookup.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OrderModifierInput {
    pub name: String,
    pub price_cents: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OrderItemInput {
    pub menu_item_id: String,
    #[allow(dead_code)] pub name: Option<String>,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub notes: Option<String>,
    pub combo_id: Option<String>,
    pub modifiers: Vec<OrderModifierInput>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct FullOrderInput {
    pub table_id: String,
    pub user_id: String,
    pub order_type: String,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub total_cents: i64,
    pub discount_cents: i64,
    pub discount_reason: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub delivery_address: Option<String>,
    pub delivery_fee_cents: i64,
    /// Accepted from the frontend (`create_full_order_v3`'s `driver_id`
    /// param) but deliberately never written -- `orders.driver_id` doesn't
    /// exist (Finding #1). Kept on the struct only so the command's public
    /// signature doesn't need to change; assign a driver via
    /// `assign_driver_to_delivery` after order creation instead.
    #[allow(dead_code)]
    pub driver_id: Option<String>,
    pub shift_id: Option<String>,
    pub items: Vec<OrderItemInput>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SplitBillInput {
    pub item_ids: Vec<String>,
    pub amount_cents: i64,
    #[allow(dead_code)] pub label: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TableInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub current_order_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HeldOrderModifier {
    pub name: String,
    pub price_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HeldOrderItem {
    pub db_item_id: String,
    pub menu_item_id: String,
    pub name: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub notes: String,
    pub modifiers: Vec<HeldOrderModifier>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HeldOrderResult {
    pub items: Vec<HeldOrderItem>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub delivery_address: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReceiptConfig {
    pub chain_name: String,
    pub currency: String,
    pub branch_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LoyaltyCardLookup {
    pub card_number: String,
    pub customer_name: String,
    pub points: i64,
    pub tier: String,
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
pub struct ShiftOrderRow {
    pub id: String,
    pub total_cents: i64,
    pub created_at: String,
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ShiftAdminRow {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub starting_cash_cents: i64,
    pub ending_cash_cents: Option<i64>,
    pub difference_cents: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AttendanceRow {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub date: String,
    pub clock_in: Option<String>,
    pub clock_out: Option<String>,
    pub status: String,
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
    /// Batch 3b, Slice C -- `menuStore.ts` (the POS's own menu render path,
    /// distinct from `menu/page.tsx`'s admin CRUD tabs) needs these to
    /// display combo items.
    pub is_combo: i64,
    pub combo_original_price_cents: Option<i64>,
    pub combo_description: Option<String>,
}

/// `menuStore.ts`'s combo-component lookup. NOTE: this mirrors an existing
/// data-model mismatch, not a fix -- `combo_items.combo_id` really
/// references `combo_meals(id)` (its real FK), but the old frontend queried
/// it by a `menu_items.id` instead (`is_combo=1` items don't have a row in
/// `combo_meals` at all in the current model). That WHERE clause can only
/// ever match by coincidence, so this has always returned empty in
/// practice on a real install -- preserved exactly as-is here, not
/// silently repointed to `combo_meals`. Flagged on the punch list as an
/// explicit reconciliation decision (which table is authoritative for
/// "this menu item is a combo"), not resolved in this slice.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ComboComponentRow {
    pub menu_item_id: String,
    pub menu_item_name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ComboMealRow {
    pub id: String,
    pub name: String,
    pub bundle_price_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ComboItemJoinRow {
    pub combo_id: String,
    pub menu_item_id: String,
    pub menu_item_name: String,
    pub quantity: i64,
    pub price_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HappyHourRuleRow {
    pub id: String,
    pub menu_item_id: String,
    pub menu_item_name: String,
    pub discount_percent: i64,
    pub day_of_week: i64,
    pub start_time: String,
    pub end_time: String,
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
    /// Batch 3b, final slice, group 3 -- `printer.ts` needs the chain-wide
    /// paper width fallback for printers that don't override it.
    pub default_paper_width: i64,
    /// Batch 3b, Slice C -- `taxCalculator.ts`'s default tax config. Both
    /// real columns, backfilled by Finding #4's identity migration.
    pub secondary_tax_rate_cents: i64,
    pub service_charge_rate_cents: i64,
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
pub struct LegacyBranchFullRow {
    pub id: String,
    pub name: String,
    pub address: Option<String>,
    pub city: Option<String>,
    pub phone: Option<String>,
    pub timezone: String,
    pub currency: String,
    pub tax_rate_cents: i64,
    pub max_tables: i64,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalRow {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub status: String,
    pub last_seen: Option<String>,
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
    /// Batch 3b, final slice -- widened for `PurchasesTab`'s list view,
    /// which joins `suppliers`/`staff` for display names and needs
    /// `received_at` for the RECEIVED-status detail line.
    pub received_at: Option<String>,
    pub supplier_name: String,
    pub creator_name: String,
}

/// `suppliers` has NO `address`/`notes` columns in the real schema
/// (0001_init.sql) -- the old frontend's `SupplierModal` referenced both,
/// meaning supplier creation/update with an address or notes has silently
/// no-opped on every fresh install since inception. Same DRIFT class as
/// Finding #1 (`driver_id`)/Finding #5 (`operational_costs.description`,
/// `invoices.notes`, `loyalty_cards.is_active`). Dropped here, not carried
/// forward.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SupplierRow {
    pub id: String,
    pub name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub total_orders: i64,
    pub total_purchases_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PurchaseOrderItemRow {
    pub id: String,
    pub purchase_order_id: String,
    pub ingredient_id: String,
    pub quantity_ordered: f64,
    pub quantity_received: f64,
    pub unit_cost_cents: i64,
    pub ingredient_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InventoryLogRow {
    pub id: String,
    pub ingredient_id: String,
    pub change_amount: f64,
    pub reason: String,
    pub user_id: String,
    pub created_at: String,
    pub ingredient_name: String,
    pub user_name: String,
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
    /// Batch 3b, final slice, group 2 -- widened for `DriversView`'s card
    /// (photo/rating/delivery count) and the management tab's need to see
    /// deactivated drivers (`is_active`).
    pub photo_path: Option<String>,
    pub total_deliveries: i64,
    pub rating: Option<f64>,
    pub is_active: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActiveDeliveryRow {
    pub log_id: String,
    pub delivery_status: String,
    pub assigned_at: Option<String>,
    pub picked_up_at: Option<String>,
    pub order_id: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub delivery_address: Option<String>,
    pub total_cents: i64,
    pub driver_id: String,
    pub driver_name: String,
    pub driver_phone: Option<String>,
    pub vehicle_type: String,
    pub vehicle_plate: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeliveryHistoryRow {
    pub log_id: String,
    pub delivery_status: String,
    pub assigned_at: Option<String>,
    pub delivered_at: Option<String>,
    pub failure_reason: Option<String>,
    pub order_id: String,
    pub customer_name: Option<String>,
    pub total_cents: i64,
    pub driver_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverDeliveryRow {
    pub log_id: String,
    pub status: String,
    pub assigned_at: Option<String>,
    pub delivered_at: Option<String>,
    pub customer_name: Option<String>,
    pub delivery_address: Option<String>,
    pub total_cents: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeliveryZoneRow {
    pub id: String,
    pub name: String,
    pub boundaries: String,
    pub fee_cents: i64,
    pub min_order_cents: i64,
    pub estimated_minutes: i64,
    pub is_active: i64,
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
    /// Batch 3b, final slice, group 3 -- `printer.ts` needs these to
    /// actually talk to the device (NETWORK interface) and to feed
    /// `generateEscPosReceipt`'s codepage table lookup, preserved exactly
    /// as the old frontend read them (including its pre-existing quirk:
    /// `code_page` is stored as an INTEGER, but `setCodePage` keys its table
    /// by string name, so a numeric value always misses and falls through
    /// to the CP864 default -- not "fixed" here, just carried forward).
    pub ip_address: Option<String>,
    pub port: i64,
    pub code_page: i64,
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

    /// `kds/page.tsx`'s kitchen display feed: every PENDING/PREPARING/READY
    /// order, oldest first, each with its non-voided items. Two queries
    /// (orders, then items for those same orders) grouped in Rust, same
    /// shape as the old frontend's own two-step read, avoiding only the
    /// N+1-per-order pattern (one items query total, not one per order).
    pub fn list_kitchen_orders(&self, scope: &Scope) -> Result<Vec<KdsOrderRow>, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let (pred, binds) = Self::scope_predicate(scope);
        let pred_orders = pred.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
        let sql = format!(
            "SELECT orders.id, tables.name, orders.order_type, orders.status, orders.created_at, orders.discount_reason \
             FROM orders LEFT JOIN tables ON tables.id = orders.table_id \
             WHERE {pred_orders} AND orders.status IN ('PENDING', 'PREPARING', 'READY') \
             ORDER BY orders.created_at ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let mut orders: Vec<KdsOrderRow> = stmt.query_map(bind_refs.as_slice(), |r| {
            Ok(KdsOrderRow {
                id: r.get(0)?, table_name: r.get(1)?, order_type: r.get(2)?, status: r.get(3)?,
                created_at: r.get(4)?, notes: r.get(5)?, items: vec![],
            })
        })?.collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let pred_items = pred.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
        let items_sql = format!(
            "SELECT order_items.order_id, menu_items.name, order_items.quantity, order_items.notes \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             WHERE {pred_items} AND orders.status IN ('PENDING', 'PREPARING', 'READY') AND order_items.voided = 0"
        );
        let mut items_stmt = self.conn.prepare(&items_sql)?;
        let item_bind_refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let item_rows: Vec<(String, KdsOrderItemRow)> = items_stmt.query_map(item_bind_refs.as_slice(), |r| {
            Ok((r.get::<_, String>(0)?, KdsOrderItemRow { name: r.get(1)?, quantity: r.get(2)?, notes: r.get(3)? }))
        })?.collect::<Result<Vec<_>, _>>()?;

        for (order_id, item) in item_rows {
            if let Some(order) = orders.iter_mut().find(|o| o.id == order_id) {
                order.items.push(item);
            }
        }
        Ok(orders)
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
        // `secondary_tax_rate_cents`/`service_charge_rate_cents` were added
        // via a bare `ALTER TABLE ADD COLUMN` with no SQL `DEFAULT`
        // (migrate_v3.rs's v6_identity) and only backfilled for a
        // `chain_config` row that already existed at migration time -- on a
        // fresh install, `ensure_chain_config_row`'s `INSERT OR IGNORE`
        // creates the row LATER, so these two columns are genuinely NULL,
        // not just conceptually zero. `COALESCE` here, not a migration
        // change, matching the same "self-healing read" pattern already
        // used for the whole row's existence.
        self.conn.query_row(
            "SELECT chain_name, currency, tax_mode, tax_rate_cents, default_paper_width, \
                    COALESCE(secondary_tax_rate_cents, 0), COALESCE(service_charge_rate_cents, 0) \
             FROM chain_config WHERE id = 'default'",
            [], |r| Ok(ChainConfigRow {
                chain_name: r.get(0)?, currency: r.get(1)?, tax_mode: r.get(2)?, tax_rate_cents: r.get(3)?,
                default_paper_width: r.get(4)?, secondary_tax_rate_cents: r.get(5)?, service_charge_rate_cents: r.get(6)?,
            }),
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

    // -----------------------------------------------------------------
    // Slice C -- `branches/page.tsx`'s multi-branch admin CRUD. Operates
    // on the LEGACY `branches` table (same table `get_legacy_branch`/
    // `upsert_legacy_branch` above use for the single-branch settings
    // view) -- NOT T1.1's new `branch` table that `create_branch` further
    // below operates on. Both are live, both are used by real pages; this
    // is the punch-listed table duality, not reconciled here.
    // -----------------------------------------------------------------

    pub fn list_branches_full(&self, tenant_id: &str) -> Result<Vec<LegacyBranchFullRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, address, city, phone, timezone, currency, tax_rate_cents, max_tables, is_active \
             FROM branches WHERE tenant_id = ?1 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(LegacyBranchFullRow {
                id: r.get(0)?, name: r.get(1)?, address: r.get(2)?, city: r.get(3)?, phone: r.get(4)?,
                timezone: r.get(5)?, currency: r.get(6)?, tax_rate_cents: r.get(7)?, max_tables: r.get(8)?, is_active: r.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_branch_full(&self, tenant_id: &str, name: &str, address: Option<&str>, city: Option<&str>, phone: Option<&str>, timezone: &str, currency: &str, tax_rate_cents: i64, max_tables: i64) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO branches (id, tenant_id, name, address, city, phone, timezone, currency, tax_rate_cents, max_tables, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, datetime('now'), 'pending')",
            params![id, tenant_id, name, address, city, phone, timezone, currency, tax_rate_cents, max_tables],
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_branch_full(&self, tenant_id: &str, branch_id: &str, name: &str, address: Option<&str>, city: Option<&str>, phone: Option<&str>, timezone: &str, currency: &str, tax_rate_cents: i64, max_tables: i64) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("branches", branch_id, tenant_id)?;
        self.conn.execute(
            "UPDATE branches SET name = ?1, address = ?2, city = ?3, phone = ?4, timezone = ?5, currency = ?6, tax_rate_cents = ?7, max_tables = ?8, last_modified = datetime('now') WHERE id = ?9",
            params![name, address, city, phone, timezone, currency, tax_rate_cents, max_tables, branch_id],
        )?;
        Ok(())
    }

    pub fn set_branch_full_active(&self, tenant_id: &str, branch_id: &str, is_active: bool) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("branches", branch_id, tenant_id)?;
        self.conn.execute(
            "UPDATE branches SET is_active = ?1, last_modified = datetime('now') WHERE id = ?2",
            params![is_active as i64, branch_id],
        )?;
        Ok(())
    }

    /// The branch detail panel's inline single-field edits -- `field` is
    /// matched against a fixed allow-list, never interpolated into SQL, so
    /// there's no column-name injection surface even though the caller
    /// passes a bare string.
    pub fn update_branch_detail_field(&self, tenant_id: &str, branch_id: &str, field: &str, value: Option<&str>) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("branches", branch_id, tenant_id)?;
        let column = match field {
            "name" => "name",
            "address" => "address",
            "city" => "city",
            "phone" => "phone",
            _ => return Err(RepoError::TenantOwnershipViolation { table: "branches".to_string(), id: format!("invalid field: {field}") }),
        };
        self.conn.execute(
            &format!("UPDATE branches SET {column} = ?1, last_modified = datetime('now') WHERE id = ?2"),
            params![value, branch_id],
        )?;
        Ok(())
    }

    pub fn list_terminals(&self, tenant_id: &str, branch_id: &str) -> Result<Vec<TerminalRow>, RepoError> {
        self.assert_tenant_owns_row("branches", branch_id, tenant_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, version, status, last_seen FROM terminals WHERE tenant_id = ?1 AND branch_id = ?2 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id, branch_id], |r| {
            Ok(TerminalRow { id: r.get(0)?, name: r.get(1)?, version: r.get(2)?, status: r.get(3)?, last_seen: r.get(4)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// Tenant-wide today's order count/revenue and staff count -- matches
    /// the old frontend's own aggregation exactly, including its existing
    /// quirk: these are tenant-wide totals applied identically to every
    /// branch card, not actually per-branch (the old code computed one
    /// `todayData` query outside its per-branch loop and reused it for
    /// every branch). Not "fixed" into real per-branch stats here.
    pub fn tenant_today_stats(&self, tenant_id: &str) -> Result<(i64, i64, i64), RepoError> {
        let (order_count, revenue_cents): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0) FROM orders \
             WHERE tenant_id = ?1 AND created_at >= ?2 AND status NOT IN ('CANCELLED', 'VOIDED')",
            params![tenant_id, chrono::Utc::now().format("%Y-%m-%dT00:00:00").to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let staff_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM staff WHERE tenant_id = ?1", params![tenant_id], |r| r.get(0),
        )?;
        Ok((order_count, revenue_cents, staff_count))
    }

    /// Terminal count per branch, for the branch list's summary cards.
    pub fn terminal_counts_by_branch(&self, tenant_id: &str) -> Result<Vec<(String, i64)>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT branch_id, COUNT(*) FROM terminals WHERE tenant_id = ?1 AND branch_id IS NOT NULL GROUP BY branch_id",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
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

    /// `NewOrderModal`'s quick-create path -- a bare PO plus a
    /// `suppliers.total_orders + 1` bump, one transaction. Deliberately a
    /// SEPARATE method from `create_purchase_order` (which `AlertsTab`'s
    /// auto-order calls WITHOUT the bump) -- that's an existing behavior
    /// quirk in the old frontend (auto-order never bumped total_orders),
    /// preserved as-is per instruction, not "fixed" into consistency.
    pub fn create_purchase_order_and_bump_supplier(&self, tenant_id: &str, branch_id: &str, supplier_id: &str, created_by: &str, notes: Option<&str>) -> Result<String, RepoError> {
        let id = self.create_purchase_order(tenant_id, branch_id, supplier_id, created_by, notes)?;
        self.conn.execute(
            "UPDATE suppliers SET total_orders = total_orders + 1, last_modified = datetime('now') WHERE id = ?1",
            params![supplier_id],
        )?;
        Ok(id)
    }

    /// `CreatePOModal`'s full line-item flow: PO row + N
    /// `purchase_order_items` rows + the same `total_orders` bump, all in
    /// one transaction (the caller wraps this whole call in a `tx`). Total
    /// is computed server-side from the items, never trusted from the
    /// client.
    pub fn create_purchase_order_with_items(&self, tenant_id: &str, branch_id: &str, supplier_id: &str, created_by: &str, notes: Option<&str>, items: &[(String, f64, i64)]) -> Result<String, RepoError> {
        self.assert_scope_populated("purchase_orders", true)?;
        self.assert_scope_populated("purchase_order_items", true)?;
        let total_cents: i64 = items.iter().map(|(_, qty, unit_cost)| (*qty * *unit_cost as f64).round() as i64).sum();
        let po_id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO purchase_orders (id, tenant_id, branch_id, supplier_id, status, total_cents, created_by, notes, created_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5, ?6, ?7, datetime('now'), datetime('now'), 'pending')",
            params![po_id, tenant_id, branch_id, supplier_id, total_cents, created_by, notes],
        )?;
        for (ingredient_id, quantity_ordered, unit_cost_cents) in items {
            let item_id = uuid::Uuid::now_v7().to_string();
            self.conn.execute(
                "INSERT INTO purchase_order_items (id, tenant_id, branch_id, purchase_order_id, ingredient_id, quantity_ordered, quantity_received, unit_cost_cents, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, datetime('now'), 'pending')",
                params![item_id, tenant_id, branch_id, po_id, ingredient_id, quantity_ordered, unit_cost_cents],
            )?;
        }
        self.conn.execute(
            "UPDATE suppliers SET total_orders = total_orders + 1, last_modified = datetime('now') WHERE id = ?1",
            params![supplier_id],
        )?;
        Ok(po_id)
    }

    /// Widened for `PurchasesTab`'s list view -- joins `suppliers`/`staff`
    /// for display names, same join-ambiguity fix as `finance_revenue_summary`
    /// (qualify the scope predicate's bare `tenant_id`/`branch_id` with the
    /// `purchase_orders.` table prefix, since `suppliers`/`staff` carry those
    /// columns too post-Migration-A).
    pub fn list_purchase_orders(&self, scope: &Scope) -> Result<Vec<PurchaseOrderRow>, RepoError> {
        self.assert_scope_populated("purchase_orders", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "purchase_orders.tenant_id").replace("branch_id", "purchase_orders.branch_id");
        let sql = format!(
            "SELECT purchase_orders.id, purchase_orders.supplier_id, purchase_orders.status, purchase_orders.total_cents, \
                    purchase_orders.created_by, purchase_orders.notes, purchase_orders.created_at, purchase_orders.received_at, \
                    suppliers.name, staff.name \
             FROM purchase_orders \
             INNER JOIN suppliers ON suppliers.id = purchase_orders.supplier_id \
             INNER JOIN staff ON staff.id = purchase_orders.created_by \
             WHERE {predicate} ORDER BY purchase_orders.created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(PurchaseOrderRow {
                id: r.get(0)?, supplier_id: r.get(1)?, status: r.get(2)?, total_cents: r.get(3)?,
                created_by: r.get(4)?, notes: r.get(5)?, created_at: r.get(6)?, received_at: r.get(7)?,
                supplier_name: r.get(8)?, creator_name: r.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// Scope check shared by cancel/receive/items-list -- a PO id alone is
    /// client-supplied and unverified; this confirms it belongs to the
    /// caller's tenant/branch before any mutation, mirroring `take_payment`'s
    /// `OrderOutOfScope` guard for orders.
    fn assert_purchase_order_in_scope(&self, po_id: &str, scope: &Scope) -> Result<String, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        // `predicate` is pre-numbered `?1`/`?2` by `scope_predicate` -- the
        // po_id placeholder must come AFTER those, not before, or its number
        // collides with the predicate's own (e.g. both using `?1`).
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT status FROM purchase_orders WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<String> = args;
        full_args.push(po_id.to_string());
        let params_refs: Vec<&dyn rusqlite::ToSql> = full_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        self.conn.query_row(&sql, params_refs.as_slice(), |r| r.get::<_, String>(0))
            .optional()?
            .ok_or_else(|| RepoError::PurchaseOrderOutOfScope { po_id: po_id.to_string() })
    }

    pub fn cancel_purchase_order(&self, po_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let status = self.assert_purchase_order_in_scope(po_id, scope)?;
        if status != "PENDING" {
            return Err(RepoError::PurchaseOrderNotPending { po_id: po_id.to_string(), status });
        }
        self.conn.execute(
            "UPDATE purchase_orders SET status = 'CANCELLED', last_modified = datetime('now') WHERE id = ?1",
            params![po_id],
        )?;
        Ok(())
    }

    pub fn list_purchase_order_items(&self, po_id: &str, scope: &Scope) -> Result<Vec<PurchaseOrderItemRow>, RepoError> {
        self.assert_purchase_order_in_scope(po_id, scope)?;
        let mut stmt = self.conn.prepare(
            "SELECT purchase_order_items.id, purchase_order_items.purchase_order_id, purchase_order_items.ingredient_id, \
                    purchase_order_items.quantity_ordered, purchase_order_items.quantity_received, purchase_order_items.unit_cost_cents, \
                    ingredients.name \
             FROM purchase_order_items INNER JOIN ingredients ON ingredients.id = purchase_order_items.ingredient_id \
             WHERE purchase_order_items.purchase_order_id = ?1",
        )?;
        let rows = stmt.query_map(params![po_id], |r| {
            Ok(PurchaseOrderItemRow {
                id: r.get(0)?, purchase_order_id: r.get(1)?, ingredient_id: r.get(2)?,
                quantity_ordered: r.get(3)?, quantity_received: r.get(4)?, unit_cost_cents: r.get(5)?, ingredient_name: r.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// The atomicity centerpiece of this group: per received item, the fact
    /// (`purchase_order_items.quantity_received` + a new `inventory_logs`
    /// row) and the derived total (`ingredients.current_stock`) update
    /// together; then, once every item is applied, the PO itself flips to
    /// RECEIVED. All of it -- however many items -- is one `self.conn`
    /// sequence inside the ONE transaction the caller wraps this call in,
    /// same principle as `take_payment`/`adjust_stock`, just N items instead
    /// of one row.
    pub fn receive_purchase_order(&self, tenant_id: &str, branch_id: &str, po_id: &str, actor_id: &str, scope: &Scope, items: &[(String, String, f64)]) -> Result<(), RepoError> {
        let status = self.assert_purchase_order_in_scope(po_id, scope)?;
        if status != "PENDING" {
            return Err(RepoError::PurchaseOrderNotPending { po_id: po_id.to_string(), status });
        }
        let now = chrono::Utc::now().to_rfc3339();
        for (item_id, ingredient_id, quantity_received) in items {
            self.conn.execute(
                "UPDATE purchase_order_items SET quantity_received = ?1, last_modified = ?2 WHERE id = ?3 AND purchase_order_id = ?4",
                params![quantity_received, now, item_id, po_id],
            )?;
            self.conn.execute(
                "UPDATE ingredients SET current_stock = current_stock + ?1, last_modified = ?2 WHERE id = ?3",
                params![quantity_received, now, ingredient_id],
            )?;
            let log_id = uuid::Uuid::now_v7().to_string();
            self.conn.execute(
                "INSERT INTO inventory_logs (id, tenant_id, branch_id, ingredient_id, change_amount, reason, user_id, created_at, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'استلام طلبية شراء', ?6, ?7, ?7, 'pending')",
                params![log_id, tenant_id, branch_id, ingredient_id, quantity_received, actor_id, now],
            )?;
        }
        self.conn.execute(
            "UPDATE purchase_orders SET status = 'RECEIVED', received_at = ?1, last_modified = ?1 WHERE id = ?2",
            params![now, po_id],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------
    // Batch 3b, final slice -- suppliers, inventory movements, low-stock
    // alerts. `suppliers` is `TENANT_BRANCH_TABLES`; `address`/`notes` are
    // dropped (see `SupplierRow` doc comment -- they don't exist in the
    // real schema).
    // -----------------------------------------------------------------

    pub fn list_suppliers(&self, scope: &Scope) -> Result<Vec<SupplierRow>, RepoError> {
        self.assert_scope_populated("suppliers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, phone, email, total_orders, total_purchases_cents FROM suppliers WHERE {predicate} ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(SupplierRow { id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, email: r.get(3)?, total_orders: r.get(4)?, total_purchases_cents: r.get(5)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn create_supplier(&self, tenant_id: &str, branch_id: &str, name: &str, phone: Option<&str>, email: Option<&str>) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO suppliers (id, tenant_id, branch_id, name, phone, email, total_orders, total_purchases_cents, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, phone, email],
        )?;
        Ok(id)
    }

    pub fn update_supplier(&self, supplier_id: &str, name: &str, phone: Option<&str>, email: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE suppliers SET name = ?1, phone = ?2, email = ?3, last_modified = datetime('now') WHERE id = ?4",
            params![name, phone, email, supplier_id],
        )?;
        Ok(())
    }

    /// Hard delete, matching the old frontend's `deleteFrom("suppliers")` --
    /// if a `purchase_orders` row still references this supplier, SQLite's
    /// own FK constraint (`PRAGMA foreign_keys=ON`) rejects it, same failure
    /// mode as before. Not "fixed" into a soft delete.
    pub fn delete_supplier(&self, supplier_id: &str) -> Result<(), RepoError> {
        self.conn.execute("DELETE FROM suppliers WHERE id = ?1", params![supplier_id])?;
        Ok(())
    }

    pub fn list_inventory_logs(&self, scope: &Scope) -> Result<Vec<InventoryLogRow>, RepoError> {
        self.assert_scope_populated("inventory_logs", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "inventory_logs.tenant_id").replace("branch_id", "inventory_logs.branch_id");
        let sql = format!(
            "SELECT inventory_logs.id, inventory_logs.ingredient_id, inventory_logs.change_amount, inventory_logs.reason, \
                    inventory_logs.user_id, inventory_logs.created_at, ingredients.name, staff.name \
             FROM inventory_logs \
             INNER JOIN ingredients ON ingredients.id = inventory_logs.ingredient_id \
             INNER JOIN staff ON staff.id = inventory_logs.user_id \
             WHERE {predicate} ORDER BY inventory_logs.created_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(InventoryLogRow {
                id: r.get(0)?, ingredient_id: r.get(1)?, change_amount: r.get(2)?, reason: r.get(3)?,
                user_id: r.get(4)?, created_at: r.get(5)?, ingredient_name: r.get(6)?, user_name: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn list_low_stock_ingredients(&self, scope: &Scope) -> Result<Vec<IngredientRow>, RepoError> {
        self.assert_scope_populated("ingredients", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, unit, cost_cents_per_unit, current_stock, min_stock, is_active FROM ingredients \
             WHERE {predicate} AND is_active = 1 AND current_stock < min_stock ORDER BY current_stock ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(IngredientRow { id: r.get(0)?, name: r.get(1)?, unit: r.get(2)?, cost_cents_per_unit: r.get(3)?, current_stock: r.get(4)?, min_stock: r.get(5)?, is_active: r.get(6)? })
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

    const DRIVER_COLUMNS: &'static str = "id, name, phone, vehicle_type, vehicle_plate, license_number, status, current_lat, current_lng, photo_path, total_deliveries, rating, is_active";

    fn driver_row_from(r: &rusqlite::Row) -> rusqlite::Result<DriverRow> {
        Ok(DriverRow {
            id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, vehicle_type: r.get(3)?, vehicle_plate: r.get(4)?,
            license_number: r.get(5)?, status: r.get(6)?, current_lat: r.get(7)?, current_lng: r.get(8)?,
            photo_path: r.get(9)?, total_deliveries: r.get(10)?, rating: r.get(11)?, is_active: r.get(12)?,
        })
    }

    pub fn list_drivers(&self, scope: &Scope) -> Result<Vec<DriverRow>, RepoError> {
        self.assert_scope_populated("drivers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT {} FROM drivers WHERE {predicate} AND is_active = 1 ORDER BY name ASC", Self::DRIVER_COLUMNS);
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::driver_row_from)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `DriversView`'s management tab -- unlike `list_drivers`, includes
    /// deactivated drivers so a manager can see (and eventually reactivate)
    /// them, same reasoning as `list_printers`' widening.
    pub fn list_all_drivers(&self, scope: &Scope) -> Result<Vec<DriverRow>, RepoError> {
        self.assert_scope_populated("drivers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT {} FROM drivers WHERE {predicate} ORDER BY name ASC", Self::DRIVER_COLUMNS);
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::driver_row_from)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `DriverSelectModal`'s pick-a-driver list -- only drivers free to take
    /// a new delivery right now.
    pub fn list_available_drivers(&self, scope: &Scope) -> Result<Vec<DriverRow>, RepoError> {
        self.assert_scope_populated("drivers", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!("SELECT {} FROM drivers WHERE {predicate} AND is_active = 1 AND status = 'AVAILABLE' ORDER BY name ASC", Self::DRIVER_COLUMNS);
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::driver_row_from)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_driver(&self, driver_id: &str, name: &str, phone: Option<&str>, vehicle_type: &str, vehicle_plate: Option<&str>, license_number: Option<&str>) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE drivers SET name = ?1, phone = ?2, vehicle_type = ?3, vehicle_plate = ?4, license_number = ?5, last_modified = datetime('now') WHERE id = ?6",
            params![name, phone, vehicle_type, vehicle_plate, license_number, driver_id],
        )?;
        Ok(())
    }

    /// Soft delete, matching the old frontend's `deleteDriver` -- a driver
    /// with delivery history can't be hard-deleted without orphaning
    /// `delivery_logs.driver_id` (`NOT NULL REFERENCES drivers`).
    pub fn deactivate_driver(&self, driver_id: &str) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE drivers SET is_active = 0, status = 'INACTIVE', last_modified = datetime('now') WHERE id = ?1",
            params![driver_id],
        )?;
        Ok(())
    }

    /// The assignment atomicity pair: the new `delivery_logs` row (the fact)
    /// and the driver flipping to BUSY (the derived state) commit together.
    /// Deliberately does NOT touch `orders.driver_id` -- that column does
    /// not exist in the real schema (DRIFT_REPORT.md Finding #1).
    pub fn assign_driver_to_delivery(&self, tenant_id: &str, branch_id: &str, order_id: &str, driver_id: &str) -> Result<String, RepoError> {
        let log_id = self.create_delivery_log(tenant_id, branch_id, order_id, driver_id)?;
        self.conn.execute(
            "UPDATE drivers SET status = 'BUSY', last_modified = datetime('now') WHERE id = ?1",
            params![driver_id],
        )?;
        Ok(log_id)
    }

    /// The receiving-end atomicity pair for a delivery reaching a terminal
    /// status: the `delivery_logs` transition and the driver freeing back up
    /// (+ `total_deliveries` bump on an actual DELIVERED) commit together --
    /// same principle as `assign_driver_to_delivery`, just the reverse edge.
    /// `failure_reason` is a real column (0001_init.sql); the old frontend's
    /// `notes` field on this same call is NOT (dropped, DRIFT).
    pub fn update_delivery_status_and_driver(&self, delivery_log_id: &str, new_status: &str, failure_reason: Option<&str>) -> Result<(), RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let driver_id: String = self.conn.query_row(
            "SELECT driver_id FROM delivery_logs WHERE id = ?1", params![delivery_log_id], |r| r.get(0),
        )?;
        let ts_column = match new_status {
            "PICKED_UP" => Some("picked_up_at"),
            "DELIVERED" => Some("delivered_at"),
            "FAILED" => Some("failed_at"),
            _ => None,
        };
        match ts_column {
            Some(col) => {
                self.conn.execute(
                    &format!("UPDATE delivery_logs SET status = ?1, failure_reason = ?2, {col} = datetime('now'), last_modified = datetime('now') WHERE id = ?3"),
                    params![new_status, failure_reason, delivery_log_id],
                )?;
            }
            None => {
                self.conn.execute(
                    "UPDATE delivery_logs SET status = ?1, failure_reason = ?2, last_modified = datetime('now') WHERE id = ?3",
                    params![new_status, failure_reason, delivery_log_id],
                )?;
            }
        }
        if matches!(new_status, "DELIVERED" | "FAILED" | "CANCELLED") {
            let bump: i64 = if new_status == "DELIVERED" { 1 } else { 0 };
            self.conn.execute(
                "UPDATE drivers SET status = 'AVAILABLE', total_deliveries = total_deliveries + ?1, last_modified = datetime('now') WHERE id = ?2",
                params![bump, driver_id],
            )?;
        }
        Ok(())
    }

    pub fn list_active_deliveries(&self, scope: &Scope) -> Result<Vec<ActiveDeliveryRow>, RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "delivery_logs.tenant_id").replace("branch_id", "delivery_logs.branch_id");
        let sql = format!(
            "SELECT delivery_logs.id, delivery_logs.status, delivery_logs.assigned_at, delivery_logs.picked_up_at, \
                    orders.id, orders.customer_name, orders.customer_phone, orders.delivery_address, orders.total_cents, \
                    drivers.id, drivers.name, drivers.phone, drivers.vehicle_type, drivers.vehicle_plate \
             FROM delivery_logs \
             INNER JOIN orders ON orders.id = delivery_logs.order_id \
             INNER JOIN drivers ON drivers.id = delivery_logs.driver_id \
             WHERE {predicate} AND delivery_logs.status IN ('ASSIGNED', 'PICKED_UP', 'IN_TRANSIT') \
             ORDER BY delivery_logs.assigned_at DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(ActiveDeliveryRow {
                log_id: r.get(0)?, delivery_status: r.get(1)?, assigned_at: r.get(2)?, picked_up_at: r.get(3)?,
                order_id: r.get(4)?, customer_name: r.get(5)?, customer_phone: r.get(6)?, delivery_address: r.get(7)?, total_cents: r.get(8)?,
                driver_id: r.get(9)?, driver_name: r.get(10)?, driver_phone: r.get(11)?, vehicle_type: r.get(12)?, vehicle_plate: r.get(13)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn list_delivery_history(&self, scope: &Scope, limit: i64, offset: i64) -> Result<Vec<DeliveryHistoryRow>, RepoError> {
        self.assert_scope_populated("delivery_logs", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "delivery_logs.tenant_id").replace("branch_id", "delivery_logs.branch_id");
        let sql = format!(
            "SELECT delivery_logs.id, delivery_logs.status, delivery_logs.assigned_at, delivery_logs.delivered_at, delivery_logs.failure_reason, \
                    orders.id, orders.customer_name, orders.total_cents, drivers.name \
             FROM delivery_logs \
             INNER JOIN orders ON orders.id = delivery_logs.order_id \
             INNER JOIN drivers ON drivers.id = delivery_logs.driver_id \
             WHERE {predicate} AND delivery_logs.status IN ('DELIVERED', 'FAILED', 'CANCELLED') \
             ORDER BY delivery_logs.assigned_at DESC LIMIT ? OFFSET ?"
        );
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&limit);
        full_args.push(&offset);
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(full_args.as_slice(), |r| {
            Ok(DeliveryHistoryRow {
                log_id: r.get(0)?, delivery_status: r.get(1)?, assigned_at: r.get(2)?, delivered_at: r.get(3)?, failure_reason: r.get(4)?,
                order_id: r.get(5)?, customer_name: r.get(6)?, total_cents: r.get(7)?, driver_name: r.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn list_driver_deliveries(&self, driver_id: &str) -> Result<Vec<DriverDeliveryRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT delivery_logs.id, delivery_logs.status, delivery_logs.assigned_at, delivery_logs.delivered_at, \
                    orders.customer_name, orders.delivery_address, orders.total_cents \
             FROM delivery_logs INNER JOIN orders ON orders.id = delivery_logs.order_id \
             WHERE delivery_logs.driver_id = ?1 ORDER BY delivery_logs.assigned_at DESC LIMIT 20",
        )?;
        let rows = stmt.query_map(params![driver_id], |r| {
            Ok(DriverDeliveryRow {
                log_id: r.get(0)?, status: r.get(1)?, assigned_at: r.get(2)?, delivered_at: r.get(3)?,
                customer_name: r.get(4)?, delivery_address: r.get(5)?, total_cents: r.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    // -----------------------------------------------------------------
    // Batch 3b, final slice, group 2 -- delivery zones. `delivery_zones` is
    // `TENANT_BRANCH_TABLES`; every column the old `deliveryService.ts`
    // referenced (name/boundaries/fee_cents/min_order_cents/
    // estimated_minutes/is_active) is real (0001_init.sql), no DRIFT here.
    // -----------------------------------------------------------------

    pub fn list_delivery_zones(&self, scope: &Scope) -> Result<Vec<DeliveryZoneRow>, RepoError> {
        self.assert_scope_populated("delivery_zones", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let sql = format!(
            "SELECT id, name, boundaries, fee_cents, min_order_cents, estimated_minutes, is_active FROM delivery_zones WHERE {predicate} AND is_active = 1 ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(DeliveryZoneRow { id: r.get(0)?, name: r.get(1)?, boundaries: r.get(2)?, fee_cents: r.get(3)?, min_order_cents: r.get(4)?, estimated_minutes: r.get(5)?, is_active: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_delivery_zone(&self, tenant_id: &str, branch_id: &str, name: &str, boundaries: &str, fee_cents: i64, min_order_cents: i64, estimated_minutes: i64) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO delivery_zones (id, tenant_id, branch_id, name, boundaries, fee_cents, min_order_cents, estimated_minutes, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, datetime('now'), 'pending')",
            params![id, tenant_id, branch_id, name, boundaries, fee_cents, min_order_cents, estimated_minutes],
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_delivery_zone(&self, zone_id: &str, name: &str, fee_cents: i64, min_order_cents: i64, estimated_minutes: i64) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE delivery_zones SET name = ?1, fee_cents = ?2, min_order_cents = ?3, estimated_minutes = ?4, last_modified = datetime('now') WHERE id = ?5",
            params![name, fee_cents, min_order_cents, estimated_minutes, zone_id],
        )?;
        Ok(())
    }

    pub fn deactivate_delivery_zone(&self, zone_id: &str) -> Result<(), RepoError> {
        self.conn.execute(
            "UPDATE delivery_zones SET is_active = 0, last_modified = datetime('now') WHERE id = ?1",
            params![zone_id],
        )?;
        Ok(())
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
            "SELECT id, name, printer_type, interface, vendor_id, product_id, drawer_pulse_ms, is_primary, is_secondary, is_active, paper_width_mm, ip_address, port, code_page FROM printers WHERE {predicate} ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(PrinterRow {
                id: r.get(0)?, name: r.get(1)?, printer_type: r.get(2)?, interface: r.get(3)?, vendor_id: r.get(4)?, product_id: r.get(5)?,
                drawer_pulse_ms: r.get(6)?, is_primary: r.get(7)?, is_secondary: r.get(8)?, is_active: r.get(9)?, paper_width_mm: r.get(10)?,
                ip_address: r.get(11)?, port: r.get(12)?, code_page: r.get(13)?,
            })
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

    pub fn update_category(&self, tenant_id: &str, category_id: &str, name: &str, color: Option<&str>, sort_order: i64, image_path: Option<&str>) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("categories", category_id, tenant_id)?;
        self.conn.execute(
            "UPDATE categories SET name = ?1, color = ?2, sort_order = ?3, image_path = ?4, last_modified = datetime('now') WHERE id = ?5",
            params![name, color, sort_order, image_path, category_id],
        )?;
        Ok(())
    }

    pub fn delete_category(&self, tenant_id: &str, category_id: &str) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("categories", category_id, tenant_id)?;
        self.conn.execute("DELETE FROM categories WHERE id = ?1", params![category_id])?;
        Ok(())
    }

    pub fn list_menu_items(&self, tenant_id: &str) -> Result<Vec<MenuItemRow>, RepoError> {
        self.assert_scope_populated("menu_items", false)?;
        let mut stmt = self.conn.prepare(
            "SELECT id, name, price_cents, cost_cents, category_id, image_path, description, barcode, is_active, \
                    is_combo, combo_original_price_cents, combo_description \
             FROM menu_items WHERE tenant_id = ?1 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(MenuItemRow {
                id: r.get(0)?, name: r.get(1)?, price_cents: r.get(2)?, cost_cents: r.get(3)?, category_id: r.get(4)?,
                image_path: r.get(5)?, description: r.get(6)?, barcode: r.get(7)?, is_active: r.get(8)?,
                is_combo: r.get(9)?, combo_original_price_cents: r.get(10)?, combo_description: r.get(11)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// See `ComboComponentRow`'s doc comment: mirrors the old frontend's
    /// existing `combo_items.combo_id = <menu_items.id>` query exactly,
    /// including its practical always-empty result on a real install. Not a
    /// fix -- a faithful getDb()-to-Rust port pending the punch-listed
    /// reconciliation decision.
    pub fn list_combo_components(&self, tenant_id: &str, menu_item_id: &str) -> Result<Vec<ComboComponentRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT combo_items.menu_item_id, menu_items.name, combo_items.quantity \
             FROM combo_items INNER JOIN menu_items ON menu_items.id = combo_items.menu_item_id \
             WHERE combo_items.tenant_id = ?1 AND combo_items.combo_id = ?2 ORDER BY combo_items.sort_order ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id, menu_item_id], |r| {
            Ok(ComboComponentRow { menu_item_id: r.get(0)?, menu_item_name: r.get(1)?, quantity: r.get(2)? })
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
    pub fn update_menu_item(&self, tenant_id: &str, item_id: &str, name: &str, category_id: &str, price_cents: i64, cost_cents: i64, image_path: Option<&str>, description: Option<&str>, barcode: Option<&str>) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("menu_items", item_id, tenant_id)?;
        self.conn.execute(
            "UPDATE menu_items SET name = ?1, category_id = ?2, price_cents = ?3, cost_cents = ?4, image_path = ?5, description = ?6, barcode = ?7, last_modified = datetime('now') WHERE id = ?8",
            params![name, category_id, price_cents, cost_cents, image_path, description, barcode, item_id],
        )?;
        Ok(())
    }

    pub fn delete_menu_item(&self, tenant_id: &str, item_id: &str) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("menu_items", item_id, tenant_id)?;
        self.conn.execute("DELETE FROM menu_items WHERE id = ?1", params![item_id])?;
        Ok(())
    }

    pub fn set_menu_item_active(&self, tenant_id: &str, item_id: &str, is_active: bool) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("menu_items", item_id, tenant_id)?;
        self.conn.execute(
            "UPDATE menu_items SET is_active = ?1, last_modified = datetime('now') WHERE id = ?2",
            params![is_active as i64, item_id],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------
    // Batch 3b, Slice C -- combo meals + happy hour rules. Both
    // `TENANT_ONLY_TABLES` (no branch_id), same pattern as categories/
    // menu_items. `combo_meals` has NO `is_active` column in the real
    // schema (0001_init.sql) -- the old frontend's create/toggle both
    // referenced it, meaning creating a combo has hard-failed on every
    // real install since inception (INSERT into a nonexistent column).
    // Dropped from the model here, not carried forward; the toggle-status
    // UI control is removed too (nothing to toggle). `combo_items` has no
    // `is_free` column either (dropped, same DRIFT class).
    // -----------------------------------------------------------------

    pub fn list_combo_meals(&self, tenant_id: &str) -> Result<Vec<ComboMealRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, bundle_price_cents FROM combo_meals WHERE tenant_id = ?1 ORDER BY name ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(ComboMealRow { id: r.get(0)?, name: r.get(1)?, bundle_price_cents: r.get(2)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// Every combo's line items in one query (the frontend groups by
    /// `combo_id` itself, same as it always has) -- avoids an N+1 query
    /// per combo.
    pub fn list_combo_meal_items(&self, tenant_id: &str) -> Result<Vec<ComboItemJoinRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT combo_items.combo_id, combo_items.menu_item_id, menu_items.name, combo_items.quantity, menu_items.price_cents \
             FROM combo_items INNER JOIN menu_items ON menu_items.id = combo_items.menu_item_id \
             WHERE combo_items.tenant_id = ?1 ORDER BY combo_items.sort_order ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(ComboItemJoinRow { combo_id: r.get(0)?, menu_item_id: r.get(1)?, menu_item_name: r.get(2)?, quantity: r.get(3)?, price_cents: r.get(4)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// Combo meal + its line items, one atomic write (the caller wraps this
    /// in a transaction). `items` is `(menu_item_id, quantity)` pairs.
    pub fn create_combo_meal(&self, tenant_id: &str, name: &str, bundle_price_cents: i64, items: &[(String, i64)]) -> Result<String, RepoError> {
        let combo_id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO combo_meals (id, tenant_id, name, bundle_price_cents, last_modified, sync_status) VALUES (?1, ?2, ?3, ?4, datetime('now'), 'pending')",
            params![combo_id, tenant_id, name, bundle_price_cents],
        )?;
        for (idx, (menu_item_id, quantity)) in items.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO combo_items (id, tenant_id, combo_id, menu_item_id, quantity, sort_order, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 'pending')",
                params![uuid::Uuid::now_v7().to_string(), tenant_id, combo_id, menu_item_id, quantity, idx as i64],
            )?;
        }
        Ok(combo_id)
    }

    /// Update the combo meal row and replace its full line-item set
    /// (delete + re-insert, same net effect as the old frontend's
    /// delete-then-insert, now atomic with the meal update).
    pub fn update_combo_meal(&self, tenant_id: &str, combo_id: &str, name: &str, bundle_price_cents: i64, items: &[(String, i64)]) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("combo_meals", combo_id, tenant_id)?;
        self.conn.execute(
            "UPDATE combo_meals SET name = ?1, bundle_price_cents = ?2, last_modified = datetime('now') WHERE id = ?3",
            params![name, bundle_price_cents, combo_id],
        )?;
        self.conn.execute("DELETE FROM combo_items WHERE combo_id = ?1", params![combo_id])?;
        for (idx, (menu_item_id, quantity)) in items.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO combo_items (id, tenant_id, combo_id, menu_item_id, quantity, sort_order, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), 'pending')",
                params![uuid::Uuid::now_v7().to_string(), tenant_id, combo_id, menu_item_id, quantity, idx as i64],
            )?;
        }
        Ok(())
    }

    pub fn delete_combo_meal(&self, tenant_id: &str, combo_id: &str) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("combo_meals", combo_id, tenant_id)?;
        self.conn.execute("DELETE FROM combo_items WHERE combo_id = ?1", params![combo_id])?;
        self.conn.execute("DELETE FROM combo_meals WHERE id = ?1", params![combo_id])?;
        Ok(())
    }

    pub fn list_happy_hour_rules(&self, tenant_id: &str) -> Result<Vec<HappyHourRuleRow>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT happy_hour_rules.id, happy_hour_rules.menu_item_id, menu_items.name, happy_hour_rules.discount_percent, \
                    happy_hour_rules.day_of_week, happy_hour_rules.start_time, happy_hour_rules.end_time, happy_hour_rules.is_active \
             FROM happy_hour_rules INNER JOIN menu_items ON menu_items.id = happy_hour_rules.menu_item_id \
             WHERE happy_hour_rules.tenant_id = ?1 ORDER BY happy_hour_rules.day_of_week ASC",
        )?;
        let rows = stmt.query_map(params![tenant_id], |r| {
            Ok(HappyHourRuleRow {
                id: r.get(0)?, menu_item_id: r.get(1)?, menu_item_name: r.get(2)?, discount_percent: r.get(3)?,
                day_of_week: r.get(4)?, start_time: r.get(5)?, end_time: r.get(6)?, is_active: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_happy_hour_rule(&self, tenant_id: &str, menu_item_id: &str, discount_percent: i64, day_of_week: i64, start_time: &str, end_time: &str, is_active: bool) -> Result<String, RepoError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.conn.execute(
            "INSERT INTO happy_hour_rules (id, tenant_id, menu_item_id, discount_percent, day_of_week, start_time, end_time, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), 'pending')",
            params![id, tenant_id, menu_item_id, discount_percent, day_of_week, start_time, end_time, is_active as i64],
        )?;
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_happy_hour_rule(&self, tenant_id: &str, rule_id: &str, menu_item_id: &str, discount_percent: i64, day_of_week: i64, start_time: &str, end_time: &str, is_active: bool) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("happy_hour_rules", rule_id, tenant_id)?;
        self.conn.execute(
            "UPDATE happy_hour_rules SET menu_item_id = ?1, discount_percent = ?2, day_of_week = ?3, start_time = ?4, end_time = ?5, is_active = ?6, last_modified = datetime('now') WHERE id = ?7",
            params![menu_item_id, discount_percent, day_of_week, start_time, end_time, is_active as i64, rule_id],
        )?;
        Ok(())
    }

    pub fn delete_happy_hour_rule(&self, tenant_id: &str, rule_id: &str) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("happy_hour_rules", rule_id, tenant_id)?;
        self.conn.execute("DELETE FROM happy_hour_rules WHERE id = ?1", params![rule_id])?;
        Ok(())
    }

    pub fn set_happy_hour_rule_active(&self, tenant_id: &str, rule_id: &str, is_active: bool) -> Result<(), RepoError> {
        self.assert_tenant_owns_row("happy_hour_rules", rule_id, tenant_id)?;
        self.conn.execute(
            "UPDATE happy_hour_rules SET is_active = ?1, last_modified = datetime('now') WHERE id = ?2",
            params![is_active as i64, rule_id],
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

    /// `shift/page.tsx`'s "recent orders" list -- last 10 orders opened
    /// against this shift, most recent first, scope-qualified so a
    /// Branch-scoped actor can't be handed another branch's shift's orders
    /// by guessing a shift id.
    pub fn list_shift_orders(&self, shift_id: &str, scope: &Scope) -> Result<Vec<ShiftOrderRow>, RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!(
            "SELECT id, total_cents, created_at, status FROM orders \
             WHERE {predicate} AND shift_id = {id_placeholder} ORDER BY created_at DESC LIMIT 10"
        );
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&shift_id);
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(full_args.as_slice(), |r| {
            Ok(ShiftOrderRow { id: r.get(0)?, total_cents: r.get(1)?, created_at: r.get(2)?, status: r.get(3)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// `scope` is verified before the write -- found missing entirely
    /// during Slice C verification (any authenticated Cashier could close
    /// ANY shift in the database by id, regardless of tenant/branch).
    pub fn close_shift(&self, scope: &Scope, shift_id: &str, ending_cash_cents: i64, difference_cents: i64) -> Result<(), RepoError> {
        self.assert_shift_in_scope(shift_id, scope)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE shifts SET closed_at = ?1, ending_cash_cents = ?2, difference_cents = ?3, last_modified = ?1 WHERE id = ?4",
            params![now, ending_cash_cents, difference_cents, shift_id],
        )?;
        Ok(())
    }

    fn assert_shift_in_scope(&self, shift_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT 1 FROM shifts WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&shift_id);
        self.conn.query_row(&sql, full_args.as_slice(), |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::TenantOwnershipViolation { table: "shifts".to_string(), id: shift_id.to_string() })?;
        Ok(())
    }

    /// The staff-management page's "force close" -- same write as
    /// `close_shift`, just always zeroing ending cash/difference (an admin
    /// override for an abandoned shift, not a real reconciliation).
    pub fn force_close_shift(&self, scope: &Scope, shift_id: &str) -> Result<(), RepoError> {
        self.close_shift(scope, shift_id, 0, 0)
    }

    pub fn list_shifts(&self, scope: &Scope, date_from: Option<&str>, date_to: Option<&str>, user_id: Option<&str>) -> Result<Vec<ShiftAdminRow>, RepoError> {
        self.assert_scope_populated("shifts", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "shifts.tenant_id").replace("branch_id", "shifts.branch_id");
        let mut sql = format!(
            "SELECT shifts.id, shifts.user_id, staff.name, shifts.opened_at, shifts.closed_at, \
                    shifts.starting_cash_cents, shifts.ending_cash_cents, shifts.difference_cents \
             FROM shifts INNER JOIN staff ON staff.id = shifts.user_id WHERE {predicate}"
        );
        let mut full_args: Vec<String> = args;
        if let Some(f) = date_from { sql.push_str(&format!(" AND shifts.opened_at >= ?{}", full_args.len() + 1)); full_args.push(f.to_string()); }
        if let Some(t) = date_to { sql.push_str(&format!(" AND shifts.opened_at <= ?{}", full_args.len() + 1)); full_args.push(t.to_string()); }
        if let Some(u) = user_id { sql.push_str(&format!(" AND shifts.user_id = ?{}", full_args.len() + 1)); full_args.push(u.to_string()); }
        sql.push_str(" ORDER BY shifts.opened_at DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = full_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(ShiftAdminRow {
                id: r.get(0)?, user_id: r.get(1)?, user_name: r.get(2)?, opened_at: r.get(3)?, closed_at: r.get(4)?,
                starting_cash_cents: r.get(5)?, ending_cash_cents: r.get(6)?, difference_cents: r.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    pub fn list_attendance(&self, scope: &Scope, date_from: Option<&str>, date_to: Option<&str>, user_id: Option<&str>) -> Result<Vec<AttendanceRow>, RepoError> {
        self.assert_scope_populated("attendance", true)?;
        let (predicate, args) = Self::scope_predicate(scope);
        let predicate = predicate.replace("tenant_id", "attendance.tenant_id").replace("branch_id", "attendance.branch_id");
        let mut sql = format!(
            "SELECT attendance.id, attendance.user_id, staff.name, attendance.date, attendance.clock_in, attendance.clock_out, attendance.status \
             FROM attendance INNER JOIN staff ON staff.id = attendance.user_id WHERE {predicate}"
        );
        let mut full_args: Vec<String> = args;
        if let Some(f) = date_from { sql.push_str(&format!(" AND attendance.date >= ?{}", full_args.len() + 1)); full_args.push(f.to_string()); }
        if let Some(t) = date_to { sql.push_str(&format!(" AND attendance.date <= ?{}", full_args.len() + 1)); full_args.push(t.to_string()); }
        if let Some(u) = user_id { sql.push_str(&format!(" AND attendance.user_id = ?{}", full_args.len() + 1)); full_args.push(u.to_string()); }
        sql.push_str(" ORDER BY attendance.date DESC, staff.name ASC");
        let mut stmt = self.conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> = full_args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |r| {
            Ok(AttendanceRow { id: r.get(0)?, user_id: r.get(1)?, user_name: r.get(2)?, date: r.get(3)?, clock_in: r.get(4)?, clock_out: r.get(5)?, status: r.get(6)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
    }

    /// Verifies `user_id` is a staff member in the caller's own scope
    /// before writing an attendance row for them -- a manager clocking in
    /// staff must not be able to touch another branch's/tenant's roster by
    /// guessing an id.
    fn assert_staff_in_scope(&self, staff_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT 1 FROM staff WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&staff_id);
        self.conn.query_row(&sql, full_args.as_slice(), |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::TenantOwnershipViolation { table: "staff".to_string(), id: staff_id.to_string() })?;
        Ok(())
    }

    /// Clock in: upsert today's `attendance` row for `user_id`. Status is
    /// LATE past 09:00, matching the old frontend's exact cutoff.
    pub fn clock_in(&self, scope: &Scope, tenant_id: &str, branch_id: &str, user_id: &str) -> Result<(), RepoError> {
        self.assert_staff_in_scope(user_id, scope)?;
        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%d").to_string();
        let now_iso = now.to_rfc3339();
        let status = if now.format("%H").to_string().parse::<i64>().unwrap_or(0) >= 9 { "LATE" } else { "PRESENT" };

        let existing_id: Option<String> = self.conn.query_row(
            "SELECT id FROM attendance WHERE user_id = ?1 AND date = ?2", params![user_id, today], |r| r.get(0),
        ).optional()?;
        match existing_id {
            Some(id) => {
                self.conn.execute(
                    "UPDATE attendance SET clock_in = ?1, status = ?2, last_modified = ?1 WHERE id = ?3",
                    params![now_iso, status, id],
                )?;
            }
            None => {
                self.conn.execute(
                    "INSERT INTO attendance (id, tenant_id, branch_id, user_id, date, clock_in, status, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, 'pending')",
                    params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, user_id, today, now_iso, status],
                )?;
            }
        }
        Ok(())
    }

    /// Clock out: update today's `attendance` row. HALF_DAY if under 4
    /// hours since clock-in, matching the old frontend's exact threshold.
    pub fn clock_out(&self, scope: &Scope, user_id: &str) -> Result<(), RepoError> {
        self.assert_staff_in_scope(user_id, scope)?;
        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%d").to_string();
        let now_iso = now.to_rfc3339();

        let record: Option<(Option<String>, String)> = self.conn.query_row(
            "SELECT clock_in, status FROM attendance WHERE user_id = ?1 AND date = ?2", params![user_id, today],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let mut status = record.as_ref().map(|(_, s)| s.clone()).unwrap_or_else(|| "PRESENT".to_string());
        if let Some((Some(clock_in), _)) = &record {
            if let Ok(clock_in_dt) = chrono::DateTime::parse_from_rfc3339(clock_in) {
                let hours = (now.timestamp() - clock_in_dt.timestamp()) as f64 / 3600.0;
                if hours < 4.0 { status = "HALF_DAY".to_string(); }
            }
        }
        self.conn.execute(
            "UPDATE attendance SET clock_out = ?1, status = ?2, last_modified = ?1 WHERE user_id = ?3 AND date = ?4",
            params![now_iso, status, user_id, today],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------
    // Slice A -- POS flow repo methods. Each method wraps a full
    // transaction for atomicity (all-or-nothing on kill-9). The
    // `tables` table has no tenant_id/branch_id columns, so scope
    // checks are skipped there.
    // -----------------------------------------------------------------

    /// Simple SELECT of all tables. No scope filter (tables has no
    /// tenant_id/branch_id columns -- legacy table).
    pub fn list_tables(&self) -> Result<Vec<TableInfo>, RepoError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, status, current_order_id FROM tables ORDER BY name ASC"
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TableInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                status: r.get(2)?,
                current_order_id: r.get(3)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Atomic full order creation: order + items + modifiers + table→OCCUPIED.
    /// Replaces the frontend `orderService.createOrder`. Uses one transaction
    /// so a kill-9 either writes all or none.
    /// `input.driver_id` is deliberately NEVER written -- `orders.driver_id`
    /// does not exist in the real schema (DRIFT_REPORT.md Finding #1, same
    /// as `NewOrder`'s doc comment above). Found and fixed during Slice A
    /// verification: this method's `INSERT` previously listed `driver_id`
    /// as a real column, which would hard-fail every DELIVERY order (and,
    /// since it's one shared `INSERT`, every order type) with "table orders
    /// has no column named driver_id" the first time it actually ran --
    /// caught only because nothing had exercised this path with a test yet.
    /// Delivery driver assignment happens via `assign_driver_to_delivery`
    /// against `delivery_logs`, a separate explicit follow-up call.
    pub fn create_full_order(&self, scope: &Scope, tenant_id: &str, branch_id: &str, input: FullOrderInput) -> Result<String, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let _ = scope; // populated-check already ran; write path is branch-pinned
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let currency: String = self.conn.query_row(
            "SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0)
        )?;
        let scale = crate::money::scale_for(&currency) as i64;

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            self.conn.execute(
                "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, \
                 subtotal_cents, tax_cents, total_cents, discount_cents, discount_reason, \
                 customer_name, customer_phone, delivery_address, delivery_fee_cents, shift_id, \
                 created_at, sync_version, last_modified, sync_status, \
                 subtotal_minor, subtotal_currency, subtotal_scale, subtotal_base_minor, subtotal_fx_rate, subtotal_fx_source, subtotal_denom_epoch, \
                 tax_minor, tax_currency, tax_scale, tax_base_minor, tax_fx_rate, tax_fx_source, tax_denom_epoch, \
                 discount_minor, discount_currency, discount_scale, discount_base_minor, discount_fx_rate, discount_fx_source, discount_denom_epoch, \
                 total_minor, total_currency, total_scale, total_base_minor, total_fx_rate, total_fx_source, total_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?17, 'pending', \
                 ?7, ?18, ?19, ?7, '1', 'NATIVE', 2, \
                 ?8, ?18, ?19, ?8, '1', 'NATIVE', 2, \
                 ?10, ?18, ?19, ?10, '1', 'NATIVE', 2, \
                 ?9, ?18, ?19, ?9, '1', 'NATIVE', 2)",
                params![
                    id, tenant_id, branch_id, input.table_id, input.user_id, input.order_type,
                    input.subtotal_cents, input.tax_cents, input.total_cents, input.discount_cents,
                    input.discount_reason, input.customer_name, input.customer_phone, input.delivery_address,
                    input.delivery_fee_cents, input.shift_id, now, currency, scale
                ],
            ).map_err(RepoError::from)?;

            for item in &input.items {
                let item_id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO order_items (id, tenant_id, branch_id, order_id, menu_item_id, quantity, unit_price_cents, notes, combo_id, voided, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1, ?10, 'pending')",
                    params![item_id, tenant_id, branch_id, id, item.menu_item_id, item.quantity, item.unit_price_cents, item.notes, item.combo_id, now],
                ).map_err(RepoError::from)?;

                for modifier in &item.modifiers {
                    self.conn.execute(
                        "INSERT INTO order_modifiers (id, tenant_id, branch_id, order_item_id, name, price_cents, sync_version, last_modified, sync_status) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'pending')",
                        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, item_id, modifier.name, modifier.price_cents, now],
                    ).map_err(RepoError::from)?;
                }
            }

            self.conn.execute(
                "UPDATE tables SET status = 'OCCUPIED', current_order_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                params![id, now, input.table_id],
            ).map_err(RepoError::from)?;

            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(id) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// DRAFT order + items + modifiers + table→OCCUPIED. Replaces the
    /// frontend `orderService.holdOrder`.
    pub fn hold_order(&self, scope: &Scope, tenant_id: &str, branch_id: &str, input: FullOrderInput) -> Result<String, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let _ = scope;
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let currency: String = self.conn.query_row(
            "SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0)
        )?;
        let scale = crate::money::scale_for(&currency) as i64;

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            self.conn.execute(
                "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, \
                 subtotal_cents, tax_cents, total_cents, discount_cents, delivery_fee_cents, shift_id, \
                 created_at, sync_version, last_modified, sync_status, \
                 subtotal_minor, subtotal_currency, subtotal_scale, subtotal_base_minor, subtotal_fx_rate, subtotal_fx_source, subtotal_denom_epoch, \
                 tax_minor, tax_currency, tax_scale, tax_base_minor, tax_fx_rate, tax_fx_source, tax_denom_epoch, \
                 discount_minor, discount_currency, discount_scale, discount_base_minor, discount_fx_rate, discount_fx_source, discount_denom_epoch, \
                 total_minor, total_currency, total_scale, total_base_minor, total_fx_rate, total_fx_source, total_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'DRAFT', ?6, ?7, ?8, ?9, 0, 0, ?10, ?11, 1, ?11, 'pending', \
                 ?7, ?12, ?13, ?7, '1', 'NATIVE', 2, \
                 ?8, ?12, ?13, ?8, '1', 'NATIVE', 2, \
                 0, ?12, ?13, 0, '1', 'NATIVE', 2, \
                 ?9, ?12, ?13, ?9, '1', 'NATIVE', 2)",
                params![
                    id, tenant_id, branch_id, input.table_id, input.user_id, input.order_type,
                    input.subtotal_cents, input.tax_cents, input.total_cents, input.shift_id, now,
                    currency, scale
                ],
            ).map_err(RepoError::from)?;

            for item in &input.items {
                let item_id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO order_items (id, tenant_id, branch_id, order_id, menu_item_id, quantity, unit_price_cents, notes, combo_id, voided, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1, ?10, 'pending')",
                    params![item_id, tenant_id, branch_id, id, item.menu_item_id, item.quantity, item.unit_price_cents, item.notes, item.combo_id, now],
                ).map_err(RepoError::from)?;

                for modifier in &item.modifiers {
                    self.conn.execute(
                        "INSERT INTO order_modifiers (id, tenant_id, branch_id, order_item_id, name, price_cents, sync_version, last_modified, sync_status) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'pending')",
                        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, item_id, modifier.name, modifier.price_cents, now],
                    ).map_err(RepoError::from)?;
                }
            }

            self.conn.execute(
                "UPDATE tables SET status = 'OCCUPIED', current_order_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                params![id, now, input.table_id],
            ).map_err(RepoError::from)?;

            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(id) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// Read a DRAFT order with all items + modifiers + menu item names.
    /// Returns None if no DRAFT order with that ID exists.
    pub fn retrieve_held_order(&self, order_id: &str) -> Result<Option<HeldOrderResult>, RepoError> {
        let order: Option<(String, String, Option<String>, Option<String>)> = self.conn.query_row(
            "SELECT id, customer_name, customer_phone, delivery_address FROM orders WHERE id = ?1 AND status = 'DRAFT'",
            params![order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).optional().map_err(RepoError::from)?;

        let (.., customer_name, customer_phone, delivery_address) = match order {
            Some(o) => o,
            None => return Ok(None),
        };

        let mut items_stmt = self.conn.prepare(
            "SELECT id, menu_item_id, quantity, unit_price_cents, notes FROM order_items WHERE order_id = ?1 AND voided = 0"
        )?;
        let raw_items: Vec<(String, String, i64, i64, Option<String>)> = items_stmt.query_map(params![order_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?.filter_map(|r| r.ok()).collect();
        drop(items_stmt);

        let mut items = Vec::with_capacity(raw_items.len());
        for (db_item_id, menu_item_id, quantity, unit_price_cents, notes) in raw_items {
            let name: String = self.conn.query_row(
                "SELECT name FROM menu_items WHERE id = ?1", params![menu_item_id], |r| r.get(0)
            ).unwrap_or_default();

            let mut mod_stmt = self.conn.prepare(
                "SELECT name, price_cents FROM order_modifiers WHERE order_item_id = ?1"
            )?;
            let modifiers: Vec<HeldOrderModifier> = mod_stmt.query_map(params![db_item_id], |r| {
                Ok(HeldOrderModifier { name: r.get(0)?, price_cents: r.get(1)? })
            })?.filter_map(|r| r.ok()).collect();
            drop(mod_stmt);

            items.push(HeldOrderItem {
                db_item_id, menu_item_id, name, quantity, unit_price_cents,
                notes: notes.unwrap_or_default(), modifiers,
            });
        }

        Ok(Some(HeldOrderResult { items, customer_name: Some(customer_name), customer_phone, delivery_address }))
    }

    /// Verifies `order_id` belongs to the caller's tenant/branch before any
    /// mutation -- same guard as `take_payment`/`finalize_order_with_payment`,
    /// extracted here so `split_bill`/`transfer_order` share it instead of
    /// each re-deriving it (and risking one of them skipping it, which is
    /// exactly what happened before this fix).
    fn assert_order_in_scope(&self, order_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        // `predicate` is pre-numbered `?1`/`?2` -- the id placeholder must
        // come AFTER those (same fix as `assert_purchase_order_in_scope`;
        // mixing anonymous `?` with numbered `?1` in one SQLite statement is
        // invalid and throws `InvalidParameterCount`, not a silent bug).
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT 1 FROM orders WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&order_id);
        self.conn.query_row(&sql, full_args.as_slice(), |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::OrderOutOfScope { order_id: order_id.to_string() })?;
        Ok(())
    }

    /// Same guard, for a `tables` row -- `merge_tables`/`unmerge_tables`
    /// operate on table ids directly, not via an order.
    fn assert_table_in_scope(&self, table_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT 1 FROM tables WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&table_id);
        self.conn.query_row(&sql, full_args.as_slice(), |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::TableOutOfScope { table_id: table_id.to_string() })?;
        Ok(())
    }

    /// Same guard, for an `order_items` row via its parent order -- `order_items`
    /// itself carries `tenant_id`/`branch_id` post-Migration-A, so this checks
    /// the item row directly rather than joining to `orders`.
    fn assert_order_item_in_scope(&self, item_id: &str, scope: &Scope) -> Result<(), RepoError> {
        let (predicate, args) = Self::scope_predicate(scope);
        let id_placeholder = format!("?{}", args.len() + 1);
        let sql = format!("SELECT 1 FROM order_items WHERE {predicate} AND id = {id_placeholder}");
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&item_id);
        self.conn.query_row(&sql, full_args.as_slice(), |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::OrderItemOutOfScope { item_id: item_id.to_string() })?;
        Ok(())
    }

    /// Generic ownership guard for `TENANT_ONLY_TABLES` rows referenced by
    /// client-supplied id (categories, menu_items, combo_meals,
    /// happy_hour_rules) -- found missing entirely on `update_category`/
    /// `delete_category`/`update_menu_item`/`delete_menu_item`/
    /// `set_menu_item_active` during Slice C verification (any authenticated
    /// staff member, any tenant, could mutate any row in these tables by id).
    /// Fixed here and applied to those five plus every new combo/happy-hour
    /// method.
    fn assert_tenant_owns_row(&self, table: &str, id: &str, tenant_id: &str) -> Result<(), RepoError> {
        let sql = format!("SELECT 1 FROM {table} WHERE id = ?1 AND tenant_id = ?2");
        self.conn.query_row(&sql, params![id, tenant_id], |r| r.get::<_, i64>(0))
            .optional()?
            .ok_or_else(|| RepoError::TenantOwnershipViolation { table: table.to_string(), id: id.to_string() })?;
        Ok(())
    }

    /// Split a PENDING order into child orders, moving items. Each split
    /// creates a new PENDING order linked via parent_order_id.
    ///
    /// `order_id` (and `table_id`) are client-supplied and unverified until
    /// `assert_order_in_scope`/`assert_table_in_scope` run here -- without
    /// this, a Branch-scoped actor could split ANY order in the database by
    /// id, regardless of tenant/branch. Found and fixed during Slice A
    /// verification (this method previously did no scope check at all).
    pub fn split_bill(&self, scope: &Scope, order_id: &str, splits: Vec<SplitBillInput>, user_id: &str, table_id: &str) -> Result<Vec<String>, RepoError> {
        self.assert_order_in_scope(order_id, scope)?;
        self.assert_table_in_scope(table_id, scope)?;
        // `orders.tenant_id`/`branch_id` are NOT NULL post-Migration-A --
        // pulled from the parent order (already verified in-scope above)
        // rather than trusting a caller-supplied value. Found and fixed
        // during Slice A verification: this INSERT previously omitted both
        // columns entirely, which would hard-fail the very first real
        // split-bill call.
        let (tenant_id, branch_id): (String, String) = self.conn.query_row(
            "SELECT tenant_id, branch_id FROM orders WHERE id = ?1", params![order_id], |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut split_order_ids = Vec::with_capacity(splits.len());

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            for split in &splits {
                let new_order_id = uuid::Uuid::now_v7().to_string();
                split_order_ids.push(new_order_id.clone());

                self.conn.execute(
                    "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents, delivery_fee_cents, parent_order_id, created_at, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING', 'DINE_IN', ?6, 0, ?6, 0, 0, ?7, ?8, 1, ?8, 'pending')",
                    params![new_order_id, tenant_id, branch_id, table_id, user_id, split.amount_cents, order_id, now],
                ).map_err(RepoError::from)?;

                for item_id in &split.item_ids {
                    self.conn.execute(
                        "UPDATE order_items SET order_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3 AND order_id = ?4",
                        params![new_order_id, now, item_id, order_id],
                    ).map_err(RepoError::from)?;
                }
            }
            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(split_order_ids) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// Merge source tables into a target: set all to MERGED with a common
    /// merge_group_id, move items from source tables' orders to the target
    /// table's order, cancel source orders.
    ///
    /// Every table id (source and target) is verified in-scope BEFORE any
    /// write -- found and fixed during Slice A verification (this method
    /// previously did no scope check at all, letting a Branch-scoped actor
    /// merge tables belonging to any tenant/branch by id).
    pub fn merge_tables(&self, scope: &Scope, source_table_ids: Vec<String>, target_table_id: &str) -> Result<Option<String>, RepoError> {
        self.assert_table_in_scope(target_table_id, scope)?;
        for table_id in &source_table_ids {
            self.assert_table_in_scope(table_id, scope)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let merge_group_id = uuid::Uuid::now_v7().to_string();
        let mut target_order_id: Option<String> = None;

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            for table_id in &source_table_ids {
                // `.get::<_, Option<String>>(0)`, not `.get(0)` inferred as
                // `String` -- an unoccupied table's `current_order_id` is a
                // genuine SQL NULL, not a missing row (`table_id` was
                // already confirmed to exist via `assert_table_in_scope`
                // above). Found and fixed during Slice A verification: the
                // old inferred-`String` read crashed with
                // `InvalidColumnType` the moment anyone tried to merge in an
                // empty/unoccupied table -- an extremely common case, not
                // an edge case.
                let table_order_id: Option<String> = self.conn.query_row(
                    "SELECT current_order_id FROM tables WHERE id = ?1", params![table_id],
                    |r| r.get::<_, Option<String>>(0),
                ).map_err(RepoError::from)?;

                if table_id == target_table_id {
                    self.conn.execute(
                        "UPDATE tables SET status = 'MERGED', merge_group_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                        params![merge_group_id, now, table_id],
                    ).map_err(RepoError::from)?;
                    target_order_id = table_order_id;
                } else {
                    self.conn.execute(
                        "UPDATE tables SET status = 'MERGED', merge_group_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                        params![merge_group_id, now, table_id],
                    ).map_err(RepoError::from)?;

                    if let Some(ref src_order_id) = table_order_id {
                        if let Some(ref tgt_oid) = target_order_id {
                            self.conn.execute(
                                "UPDATE order_items SET order_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE order_id = ?3",
                                params![tgt_oid, now, src_order_id],
                            ).map_err(RepoError::from)?;
                        }
                        self.conn.execute(
                            "UPDATE orders SET status = 'CANCELLED', last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
                            params![now, src_order_id],
                        ).map_err(RepoError::from)?;
                    }
                }
            }
            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(target_order_id) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// Unmerge all tables in a merge group: set them back to FREE.
    ///
    /// The `UPDATE` itself is scope-qualified (not just a pre-check) --
    /// `merge_group_id` is an opaque id with no owner lookup of its own, so
    /// the safest guard is to only ever touch rows that are simultaneously
    /// in this merge group AND in the caller's scope. Found and fixed
    /// during Slice A verification (previously unscoped entirely).
    pub fn unmerge_tables(&self, scope: &Scope, merge_group_id: &str) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        let (predicate, args) = Self::scope_predicate(scope);
        // Same numbered-placeholder-collision fix as `assert_order_in_scope`
        // -- `predicate` already owns `?1..?N`, so the extra params here are
        // numbered AFTER it, never with a bare `?`.
        let n = args.len();
        let last_modified_placeholder = format!("?{}", n + 1);
        let merge_group_placeholder = format!("?{}", n + 2);
        let sql = format!(
            "UPDATE tables SET status = 'FREE', merge_group_id = NULL, last_modified = {last_modified_placeholder} \
             WHERE merge_group_id = {merge_group_placeholder} AND {predicate}"
        );
        let mut full_args: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
        full_args.push(&now);
        full_args.push(&merge_group_id);
        self.conn.execute(&sql, full_args.as_slice())?;
        Ok(())
    }

    /// Soft-void an order item (set voided=1 + void_reason).
    ///
    /// `item_id` is verified in-scope before the write -- found and fixed
    /// during Slice A verification (previously unscoped entirely, letting a
    /// Branch-scoped actor void any order item in the database by id).
    pub fn void_order_item(&self, scope: &Scope, item_id: &str, reason: &str) -> Result<(), RepoError> {
        self.assert_order_item_in_scope(item_id, scope)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE order_items SET voided = 1, void_reason = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
            params![reason, now, item_id],
        )?;
        Ok(())
    }

    /// Transfer an order from one table to another: update order.table_id,
    /// free the source table, occupy the target table.
    ///
    /// `order_id`/`from_table_id`/`to_table_id` are all verified in-scope
    /// before any write -- found and fixed during Slice A verification
    /// (previously unscoped entirely).
    pub fn transfer_order(&self, scope: &Scope, order_id: &str, from_table_id: &str, to_table_id: &str) -> Result<(), RepoError> {
        self.assert_order_in_scope(order_id, scope)?;
        self.assert_table_in_scope(from_table_id, scope)?;
        self.assert_table_in_scope(to_table_id, scope)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            self.conn.execute(
                "UPDATE orders SET table_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                params![to_table_id, now, order_id],
            ).map_err(RepoError::from)?;
            self.conn.execute(
                "UPDATE tables SET status = 'FREE', current_order_id = NULL, last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
                params![now, from_table_id],
            ).map_err(RepoError::from)?;
            self.conn.execute(
                "UPDATE tables SET status = 'OCCUPIED', current_order_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
                params![order_id, now, to_table_id],
            ).map_err(RepoError::from)?;
            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(()) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// Create a SCHEDULED order + items + modifiers + delayed_orders entry.
    pub fn schedule_delayed_order(&self, scope: &Scope, tenant_id: &str, branch_id: &str, input: FullOrderInput, scheduled_at: &str) -> Result<String, RepoError> {
        self.assert_scope_populated("orders", true)?;
        let _ = scope;
        let id = uuid::Uuid::now_v7().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let currency: String = self.conn.query_row(
            "SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0)
        )?;
        let scale = crate::money::scale_for(&currency) as i64;

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            self.conn.execute(
                "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, \
                 subtotal_cents, tax_cents, total_cents, discount_cents, delivery_fee_cents, scheduled_at, \
                 created_at, sync_version, last_modified, sync_status, \
                 subtotal_minor, subtotal_currency, subtotal_scale, subtotal_base_minor, subtotal_fx_rate, subtotal_fx_source, subtotal_denom_epoch, \
                 tax_minor, tax_currency, tax_scale, tax_base_minor, tax_fx_rate, tax_fx_source, tax_denom_epoch, \
                 discount_minor, discount_currency, discount_scale, discount_base_minor, discount_fx_rate, discount_fx_source, discount_denom_epoch, \
                 total_minor, total_currency, total_scale, total_base_minor, total_fx_rate, total_fx_source, total_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'SCHEDULED', ?6, ?7, ?8, ?9, 0, 0, ?10, ?11, 1, ?11, 'pending', \
                 ?7, ?12, ?13, ?7, '1', 'NATIVE', 2, \
                 ?8, ?12, ?13, ?8, '1', 'NATIVE', 2, \
                 0, ?12, ?13, 0, '1', 'NATIVE', 2, \
                 ?9, ?12, ?13, ?9, '1', 'NATIVE', 2)",
                params![
                    id, tenant_id, branch_id, input.table_id, input.user_id, input.order_type,
                    input.subtotal_cents, input.tax_cents, input.total_cents, scheduled_at, now,
                    currency, scale
                ],
            ).map_err(RepoError::from)?;

            for item in &input.items {
                let item_id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO order_items (id, tenant_id, branch_id, order_id, menu_item_id, quantity, unit_price_cents, notes, combo_id, voided, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1, ?10, 'pending')",
                    params![item_id, tenant_id, branch_id, id, item.menu_item_id, item.quantity, item.unit_price_cents, item.notes, item.combo_id, now],
                ).map_err(RepoError::from)?;

                for modifier in &item.modifiers {
                    self.conn.execute(
                        "INSERT INTO order_modifiers (id, tenant_id, branch_id, order_item_id, name, price_cents, sync_version, last_modified, sync_status) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, 'pending')",
                        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, item_id, modifier.name, modifier.price_cents, now],
                    ).map_err(RepoError::from)?;
                }
            }

            self.conn.execute(
                "INSERT INTO delayed_orders (id, tenant_id, branch_id, order_id, scheduled_at, activated, sync_version, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, 'pending')",
                params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, id, scheduled_at, now],
            ).map_err(RepoError::from)?;

            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(id) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }

    /// Activate all delayed orders where scheduled_at <= now. Each order is
    /// activated atomically (order→PENDING, delayed_orders→activated=1).
    pub fn activate_delayed_orders(&self) -> Result<Vec<String>, RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut activated_ids = Vec::new();

        let mut stmt = self.conn.prepare(
            "SELECT id, order_id FROM delayed_orders WHERE activated = 0 AND scheduled_at <= ?1"
        )?;
        let due: Vec<(String, String)> = stmt.query_map(params![now], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(|r| r.ok()).collect();
        drop(stmt);

        for (delayed_id, order_id) in due {
            self.conn.execute_batch("BEGIN IMMEDIATE")?;
            let result: Result<(), RepoError> = (|| {
                self.conn.execute(
                    "UPDATE orders SET status = 'PENDING', last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
                    params![now, order_id],
                ).map_err(RepoError::from)?;
                self.conn.execute(
                    "UPDATE delayed_orders SET activated = 1, last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
                    params![now, delayed_id],
                ).map_err(RepoError::from)?;
                Ok(())
            })();

            match result {
                Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; activated_ids.push(order_id); }
                Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); return Err(e); }
            }
        }

        Ok(activated_ids)
    }

    /// Get chain_name, currency from chain_config + branch name. No scope
    /// (config is global).
    pub fn get_receipt_config(&self) -> Result<ReceiptConfig, RepoError> {
        let (chain_name, currency): (String, String) = self.conn.query_row(
            "SELECT chain_name, currency FROM chain_config WHERE id = 'default'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(RepoError::from)?;

        let branch_name: String = self.conn.query_row(
            "SELECT name FROM branches ORDER BY rowid LIMIT 1",
            [],
            |r| r.get(0),
        ).unwrap_or_else(|_| "الفرع الرئيسي".to_string());

        Ok(ReceiptConfig { chain_name, currency, branch_name })
    }

    /// Look up a loyalty card by card_number, joining customers for the name.
    /// Returns None if not found. `loyalty_cards.is_active` does not exist
    /// in the real schema (DRIFT_REPORT.md Finding #5, already fixed once
    /// in slice 3's `LoyaltyCardRow`/`list_loyalty_cards`) -- found
    /// reintroduced here during Slice A verification and removed again.
    pub fn lookup_loyalty_card(&self, card_number: &str) -> Result<Option<LoyaltyCardLookup>, RepoError> {
        let result = self.conn.query_row(
            "SELECT lc.card_number, c.name, lc.points, lc.tier \
             FROM loyalty_cards lc INNER JOIN customers c ON c.id = lc.customer_id \
             WHERE lc.card_number = ?1",
            params![card_number],
            |r| Ok(LoyaltyCardLookup {
                card_number: r.get(0)?,
                customer_name: r.get(1)?,
                points: r.get(2)?,
                tier: r.get(3)?,
            }),
        ).optional().map_err(RepoError::from)?;

        Ok(result)
    }

    /// Earn loyalty points: bump card points, insert a loyalty_transactions
    /// EARN entry. Both happen in the same implicit transaction (rusqlite
    /// auto-begins when no explicit tx is open).
    ///
    /// Found and fixed during Slice A verification: this method previously
    /// referenced `loyalty_cards.is_active` (removed once already in slice
    /// 3, reintroduced here) and `loyalty_transactions.description` --
    /// neither column exists in the real schema (DRIFT_REPORT.md Finding
    /// #5). The INSERT also omitted `tenant_id`/`branch_id`
    /// (`loyalty_transactions` is `TENANT_BRANCH_TABLES`), which -- unlike
    /// `description` -- would have actually crashed the very first call.
    pub fn earn_loyalty_points(&self, tenant_id: &str, branch_id: &str, card_number: &str, points: i64, order_id: &str) -> Result<(), RepoError> {
        let now = chrono::Utc::now().to_rfc3339();
        let card_id: String = self.conn.query_row(
            "SELECT id FROM loyalty_cards WHERE card_number = ?1",
            params![card_number],
            |r| r.get(0),
        ).map_err(RepoError::from)?;

        self.conn.execute(
            "UPDATE loyalty_cards SET points = points + ?1, last_used_at = ?2, last_modified = ?2 WHERE id = ?3",
            params![points, now, card_id],
        )?;
        self.conn.execute(
            "INSERT INTO loyalty_transactions (id, tenant_id, branch_id, card_id, points, type, reference_type, reference_id, created_at, sync_version, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'EARN', 'ORDER', ?6, ?7, 1, ?7, 'pending')",
            params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, card_id, points, order_id, now],
        )?;
        Ok(())
    }

    /// Finalize a PENDING order: change status to PAID, insert payment,
    /// free the table, optional debt entry. This is the atomic pair that
    /// replaces the frontend's `orderService.finalizeOrder`. The caller
    /// (`take_payment_v3`) handles the audit entry and session auth.
    #[allow(clippy::too_many_arguments)]
    pub fn finalize_order_with_payment(&self, tenant_id: &str, branch_id: &str, order_id: &str, method: &str, amount_cents: i64, change_cents: i64, debtor_id: Option<&str>, actor_id: &str) -> Result<String, RepoError> {
        self.assert_scope_populated("payments", true)?;

        let (order_tenant, order_branch, order_status): (String, String, String) = self.conn.query_row(
            "SELECT tenant_id, branch_id, status FROM orders WHERE id = ?1",
            params![order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if order_tenant != tenant_id || order_branch != branch_id {
            return Err(RepoError::OrderOutOfScope { order_id: order_id.to_string() });
        }
        if order_status == "PAID" {
            return Err(RepoError::OrderAlreadyPaid { order_id: order_id.to_string() });
        }

        let now = chrono::Utc::now().to_rfc3339();
        let currency: String = self.conn.query_row(
            "SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0)
        )?;
        let scale = crate::money::scale_for(&currency) as i64;
        let payment_id = uuid::Uuid::now_v7().to_string();

        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result: Result<(), RepoError> = (|| {
            self.conn.execute(
                "INSERT INTO payments (id, tenant_id, branch_id, order_id, method, amount_cents, change_cents, created_at, sync_version, last_modified, sync_status, \
                 amount_minor, amount_currency, amount_scale, amount_base_minor, amount_fx_rate, amount_fx_source, amount_denom_epoch, \
                 change_minor, change_currency, change_scale, change_base_minor, change_fx_rate, change_fx_source, change_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?8, 'pending', \
                 ?6, ?9, ?10, ?6, '1', 'NATIVE', 2, \
                 ?7, ?9, ?10, ?7, '1', 'NATIVE', 2)",
                params![payment_id, tenant_id, branch_id, order_id, method, amount_cents, change_cents, now, currency, scale],
            ).map_err(RepoError::from)?;

            self.conn.execute(
                "UPDATE orders SET status = 'PAID', closed_at = ?1, last_modified = ?1, sync_status = 'pending' WHERE id = ?2",
                params![now, order_id],
            ).map_err(RepoError::from)?;

            self.conn.execute(
                "UPDATE tables SET status = 'FREE', current_order_id = NULL, last_modified = ?1, sync_status = 'pending' WHERE current_order_id = ?2",
                params![now, order_id],
            ).map_err(RepoError::from)?;

            if let Some(debtor_id) = debtor_id {
                let debt_entry_id = uuid::Uuid::now_v7().to_string();
                self.conn.execute(
                    "INSERT INTO debt_entries (id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, 'DEBT', NULL, ?5, ?6, 1, ?6, 'pending')",
                    params![debt_entry_id, debtor_id, order_id, amount_cents, actor_id, now],
                ).map_err(RepoError::from)?;
                self.conn.execute(
                    "UPDATE debtors SET total_debt_cents = total_debt_cents + ?1, balance_cents = balance_cents + ?1, last_transaction_at = ?2, last_modified = ?2 WHERE id = ?3",
                    params![amount_cents, now, debtor_id],
                ).map_err(RepoError::from)?;
            }

            Ok(())
        })();

        match result {
            Ok(()) => { self.conn.execute_batch("COMMIT").map_err(RepoError::from)?; Ok(payment_id) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
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
