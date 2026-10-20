//! Delivery: drivers, who took which order, what each driver is owed and what
//! cash he is carrying. Plain functions over a `Connection` (the command layer
//! in `commands/delivery.rs` adds authentication, audit and the payment step).
//! Tables: Migration AE (`delivery_drivers`, `order_deliveries`,
//! `delivery_settlements`).
//!
//! Money rules, in one place:
//!  * Driver pay is a setting the owner chooses: a fixed amount per delivery,
//!    or a percentage of the delivery fee. A driver may have his own value.
//!  * Pay is fixed (copied onto the delivery) at the moment it is marked
//!    delivered, so changing the rate later never rewrites history.
//!  * A failed delivery earns nothing and carries no cash.
//!  * Cash due is the order total when the customer pays the driver; an order
//!    that was already paid at the till carries none.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const PAY_PER_DELIVERY: &str = "PER_DELIVERY";
pub const PAY_PERCENT_OF_FEE: &str = "PERCENT_OF_FEE";

const KEY_MODE: &str = "delivery_pay_mode";
const KEY_VALUE: &str = "delivery_pay_value";

#[derive(Debug, Clone, Serialize)]
pub struct DeliverySettings {
    /// 'PER_DELIVERY' (value = amount per delivery) or 'PERCENT_OF_FEE' (value = percent, 0-100).
    pub pay_mode: String,
    pub pay_value: i64,
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0)).optional().ok().flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_settings(conn: &Connection) -> DeliverySettings {
    let mode = read_setting(conn, KEY_MODE).filter(|m| m == PAY_PER_DELIVERY || m == PAY_PERCENT_OF_FEE).unwrap_or_else(|| PAY_PER_DELIVERY.to_string());
    let value = read_setting(conn, KEY_VALUE).and_then(|v| v.parse().ok()).unwrap_or(0);
    DeliverySettings { pay_mode: mode, pay_value: value }
}

pub fn set_settings(conn: &Connection, mode: &str, value: i64) -> Result<(), String> {
    validate_pay(mode, value)?;
    write_setting(conn, KEY_MODE, mode)?;
    write_setting(conn, KEY_VALUE, &value.to_string())
}

fn validate_pay(mode: &str, value: i64) -> Result<(), String> {
    match mode {
        PAY_PER_DELIVERY if value >= 0 => Ok(()),
        PAY_PER_DELIVERY => Err("أجرة التوصيل لا يمكن أن تكون سالبة".to_string()),
        PAY_PERCENT_OF_FEE if (0..=100).contains(&value) => Ok(()),
        PAY_PERCENT_OF_FEE => Err("النسبة يجب أن تكون بين 0 و 100".to_string()),
        _ => Err("طريقة احتساب أجرة السائق غير معروفة".to_string()),
    }
}

/// What a driver earns for one delivered order.
pub fn compute_pay(mode: &str, default_value: i64, driver_value: Option<i64>, fee_cents: i64) -> i64 {
    let value = driver_value.unwrap_or(default_value).max(0);
    match mode {
        PAY_PERCENT_OF_FEE => fee_cents.max(0) * value.min(100) / 100,
        _ => value,
    }
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Driver {
    pub id: String,
    pub name: String,
    pub phone: Option<String>,
    /// This driver's own rate (same unit as the setting), or None to use the default.
    pub pay_value: Option<i64>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DriverInput {
    pub id: Option<String>,
    pub name: String,
    pub phone: Option<String>,
    pub pay_value: Option<i64>,
    pub is_active: bool,
}

pub fn list_drivers(conn: &Connection, tenant_id: &str, include_inactive: bool) -> Result<Vec<Driver>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, phone, pay_value, is_active FROM delivery_drivers \
             WHERE tenant_id = ?1 AND (?2 = 1 OR is_active = 1) ORDER BY is_active DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, include_inactive as i64], |r| {
            Ok(Driver { id: r.get(0)?, name: r.get(1)?, phone: r.get(2)?, pay_value: r.get(3)?, is_active: r.get::<_, i64>(4)? != 0 })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn save_driver(conn: &Connection, tenant_id: &str, input: &DriverInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("اسم السائق مطلوب".to_string());
    }
    if let Some(v) = input.pay_value {
        if v < 0 {
            return Err("أجرة السائق لا يمكن أن تكون سالبة".to_string());
        }
        // A driver's own value is read in the unit of the current mode.
        validate_pay(&get_settings(conn).pay_mode, v)?;
    }
    let phone = input.phone.as_deref().map(str::trim).filter(|p| !p.is_empty());
    match &input.id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE delivery_drivers SET name = ?1, phone = ?2, pay_value = ?3, is_active = ?4 WHERE id = ?5 AND tenant_id = ?6",
                    params![name, phone, input.pay_value, input.is_active as i64, id, tenant_id],
                )
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("السائق غير موجود".to_string());
            }
            Ok(id.clone())
        }
        None => {
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO delivery_drivers (id, tenant_id, name, phone, pay_value, is_active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, tenant_id, name, phone, input.pay_value, input.is_active as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryRow {
    pub order_id: String,
    pub created_at: String,
    pub status: String,
    pub driver_id: Option<String>,
    pub driver_name: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub address: Option<String>,
    pub total_cents: i64,
    pub fee_cents: i64,
    /// Where the order itself stands (PENDING... PAID, CANCELLED).
    pub order_status: String,
    pub pay_cents: i64,
    pub cash_due_cents: i64,
    pub pay_settled: bool,
    pub cash_settled: bool,
    pub assigned_at: Option<String>,
    pub out_at: Option<String>,
    pub delivered_at: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DeliveryFilter {
    pub driver_id: Option<String>,
    /// Only these statuses (empty = all).
    #[serde(default)]
    pub statuses: Vec<String>,
    /// Inclusive date range on the order date, 'YYYY-MM-DD'.
    pub from: Option<String>,
    pub to: Option<String>,
}

/// Called whenever an order of type DELIVERY is created, so it shows up in the
/// delivery list from the first minute.
pub fn ensure_delivery_row(conn: &Connection, tenant_id: &str, branch_id: &str, order_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO order_deliveries (order_id, tenant_id, branch_id, status) VALUES (?1, ?2, ?3, 'NEW')",
        params![order_id, tenant_id, branch_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

const ROW_SELECT: &str = "SELECT d.order_id, o.created_at, d.status, d.driver_id, dr.name, o.customer_name, o.customer_phone, o.delivery_address, \
        o.total_cents, o.delivery_fee_cents, o.status, d.pay_cents, d.cash_due_cents, d.pay_settled, d.cash_settled, \
        d.assigned_at, d.out_at, d.delivered_at, d.note \
    FROM order_deliveries d \
    JOIN orders o ON o.id = d.order_id \
    LEFT JOIN delivery_drivers dr ON dr.id = d.driver_id";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<DeliveryRow> {
    Ok(DeliveryRow {
        order_id: r.get(0)?, created_at: r.get(1)?, status: r.get(2)?, driver_id: r.get(3)?, driver_name: r.get(4)?,
        customer_name: r.get(5)?, customer_phone: r.get(6)?, address: r.get(7)?, total_cents: r.get(8)?, fee_cents: r.get(9)?,
        order_status: r.get(10)?, pay_cents: r.get(11)?, cash_due_cents: r.get(12)?,
        pay_settled: r.get::<_, i64>(13)? != 0, cash_settled: r.get::<_, i64>(14)? != 0,
        assigned_at: r.get(15)?, out_at: r.get(16)?, delivered_at: r.get(17)?, note: r.get(18)?,
    })
}

pub fn list_deliveries(conn: &Connection, tenant_id: &str, filter: &DeliveryFilter) -> Result<Vec<DeliveryRow>, String> {
    let mut sql = format!("{ROW_SELECT} WHERE d.tenant_id = ?1");
    let mut args: Vec<String> = vec![tenant_id.to_string()];
    if let Some(driver) = &filter.driver_id {
        args.push(driver.clone());
        sql.push_str(&format!(" AND d.driver_id = ?{}", args.len()));
    }
    if !filter.statuses.is_empty() {
        let marks: Vec<String> = filter
            .statuses
            .iter()
            .map(|s| {
                args.push(s.clone());
                format!("?{}", args.len())
            })
            .collect();
        sql.push_str(&format!(" AND d.status IN ({})", marks.join(",")));
    }
    if let Some(from) = &filter.from {
        args.push(from.clone());
        sql.push_str(&format!(" AND date(o.created_at, 'localtime') >= ?{}", args.len()));
    }
    if let Some(to) = &filter.to {
        args.push(to.clone());
        sql.push_str(&format!(" AND date(o.created_at, 'localtime') <= ?{}", args.len()));
    }
    sql.push_str(" ORDER BY o.created_at DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), map_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get_delivery(conn: &Connection, tenant_id: &str, order_id: &str) -> Result<DeliveryRow, String> {
    conn.query_row(&format!("{ROW_SELECT} WHERE d.tenant_id = ?1 AND d.order_id = ?2"), params![tenant_id, order_id], map_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "طلب التوصيل غير موجود".to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Gives the delivery to a driver (or takes it back with `None`). Allowed until
/// the order is delivered; a driver who is already out can be replaced.
pub fn assign_driver(conn: &Connection, tenant_id: &str, order_id: &str, driver_id: Option<&str>) -> Result<DeliveryRow, String> {
    let current = get_delivery(conn, tenant_id, order_id)?;
    if matches!(current.status.as_str(), "DELIVERED" | "FAILED") {
        return Err("لا يمكن تغيير السائق بعد إغلاق التوصيل".to_string());
    }
    match driver_id {
        Some(id) => {
            let active: bool = conn
                .query_row("SELECT is_active FROM delivery_drivers WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id], |r| Ok(r.get::<_, i64>(0)? != 0))
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "السائق غير موجود".to_string())?;
            if !active {
                return Err("السائق متوقف".to_string());
            }
            // A driver already on the road stays "OUT" when swapped.
            let status = if current.status == "OUT" { "OUT" } else { "ASSIGNED" };
            conn.execute(
                "UPDATE order_deliveries SET driver_id = ?1, status = ?2, assigned_at = ?3 WHERE order_id = ?4",
                params![id, status, now(), order_id],
            )
            .map_err(|e| e.to_string())?;
        }
        None => {
            if current.status == "OUT" {
                return Err("السائق خرج بالطلب، اختر سائقاً آخر بدلاً من إزالته".to_string());
            }
            conn.execute(
                "UPDATE order_deliveries SET driver_id = NULL, status = 'NEW', assigned_at = NULL WHERE order_id = ?1",
                params![order_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    get_delivery(conn, tenant_id, order_id)
}

/// Moves a delivery along: ASSIGNED -> OUT -> DELIVERED, or FAILED from any
/// open state. Delivered copies the driver's pay onto the delivery and works
/// out the cash he is carrying.
pub fn set_status(conn: &Connection, tenant_id: &str, order_id: &str, new_status: &str, note: Option<&str>) -> Result<DeliveryRow, String> {
    let d = get_delivery(conn, tenant_id, order_id)?;
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    let allowed = match (d.status.as_str(), new_status) {
        ("ASSIGNED", "OUT") | ("OUT", "DELIVERED") | ("NEW" | "ASSIGNED" | "OUT", "FAILED") => true,
        // Short trip: handed over without a separate "out" step.
        ("ASSIGNED", "DELIVERED") => true,
        _ => false,
    };
    if !allowed {
        return Err(format!("لا يمكن الانتقال من {} إلى {}", d.status, new_status));
    }
    if new_status == "FAILED" && note.is_none() {
        return Err("سبب فشل التوصيل مطلوب".to_string());
    }
    if d.order_status == "CANCELLED" {
        return Err("الطلب ملغى".to_string());
    }
    let ts = now();
    match new_status {
        "OUT" => {
            conn.execute("UPDATE order_deliveries SET status = 'OUT', out_at = ?1 WHERE order_id = ?2", params![ts, order_id]).map_err(|e| e.to_string())?;
        }
        "DELIVERED" => {
            let driver_id = d.driver_id.clone().ok_or("لا يوجد سائق لهذا الطلب")?;
            let own: Option<i64> = conn
                .query_row("SELECT pay_value FROM delivery_drivers WHERE id = ?1", params![driver_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
            let s = get_settings(conn);
            let pay = compute_pay(&s.pay_mode, s.pay_value, own, d.fee_cents);
            // Cash is only carried when the customer pays the driver.
            let cash = if d.order_status == "PAID" { 0 } else { d.total_cents };
            conn.execute(
                "UPDATE order_deliveries SET status = 'DELIVERED', delivered_at = ?1, out_at = COALESCE(out_at, ?1), pay_cents = ?2, cash_due_cents = ?3, note = COALESCE(?4, note) WHERE order_id = ?5",
                params![ts, pay, cash, note, order_id],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {
            conn.execute(
                "UPDATE order_deliveries SET status = 'FAILED', delivered_at = ?1, pay_cents = 0, cash_due_cents = 0, note = ?2 WHERE order_id = ?3",
                params![ts, note, order_id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    get_delivery(conn, tenant_id, order_id)
}

// ---------------------------------------------------------------------------
// Statement and settlement
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct StatementTotals {
    pub deliveries: i64,
    pub delivered: i64,
    pub failed: i64,
    /// Sum of delivered orders' totals.
    pub orders_total_cents: i64,
    pub fees_cents: i64,
    /// Everything he earned in the period.
    pub pay_cents: i64,
    /// What is still unpaid to him.
    pub pay_unsettled_cents: i64,
    /// Cash he is carrying that he has not handed in yet.
    pub cash_unsettled_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Statement {
    pub driver: Driver,
    pub rows: Vec<DeliveryRow>,
    pub totals: StatementTotals,
}

pub fn driver_statement(conn: &Connection, tenant_id: &str, driver_id: &str, from: Option<&str>, to: Option<&str>) -> Result<Statement, String> {
    let driver = list_drivers(conn, tenant_id, true)?
        .into_iter()
        .find(|d| d.id == driver_id)
        .ok_or_else(|| "السائق غير موجود".to_string())?;
    let rows = list_deliveries(
        conn,
        tenant_id,
        &DeliveryFilter {
            driver_id: Some(driver_id.to_string()),
            statuses: vec!["DELIVERED".to_string(), "FAILED".to_string(), "OUT".to_string(), "ASSIGNED".to_string()],
            from: from.map(str::to_string),
            to: to.map(str::to_string),
        },
    )?;
    let mut t = StatementTotals { deliveries: rows.len() as i64, delivered: 0, failed: 0, orders_total_cents: 0, fees_cents: 0, pay_cents: 0, pay_unsettled_cents: 0, cash_unsettled_cents: 0 };
    for r in &rows {
        match r.status.as_str() {
            "DELIVERED" => {
                t.delivered += 1;
                t.orders_total_cents += r.total_cents;
                t.fees_cents += r.fee_cents;
                t.pay_cents += r.pay_cents;
                if !r.pay_settled {
                    t.pay_unsettled_cents += r.pay_cents;
                }
                if !r.cash_settled {
                    t.cash_unsettled_cents += r.cash_due_cents;
                }
            }
            "FAILED" => t.failed += 1,
            _ => {}
        }
    }
    Ok(Statement { driver, rows, totals: t })
}

/// Delivered orders of this driver whose pay or cash is still open.
pub fn unsettled(conn: &Connection, tenant_id: &str, driver_id: &str) -> Result<Vec<DeliveryRow>, String> {
    Ok(list_deliveries(
        conn,
        tenant_id,
        &DeliveryFilter { driver_id: Some(driver_id.to_string()), statuses: vec!["DELIVERED".to_string()], from: None, to: None },
    )?
    .into_iter()
    .filter(|r| !r.pay_settled || (!r.cash_settled && r.cash_due_cents > 0))
    .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct SettlementRecord {
    pub id: String,
    pub driver_id: String,
    pub created_at: String,
    pub deliveries_count: i64,
    pub pay_cents: i64,
    pub cash_cents: i64,
    pub note: Option<String>,
}

/// Records that these deliveries were settled: his pay handed over and his cash
/// taken in. The caller has already taken each order's payment.
pub fn record_settlement(
    conn: &Connection,
    tenant_id: &str,
    branch_id: Option<&str>,
    driver_id: &str,
    order_ids: &[String],
    created_by: &str,
    note: Option<&str>,
) -> Result<SettlementRecord, String> {
    let mut count = 0;
    let mut pay = 0;
    let mut cash = 0;
    for oid in order_ids {
        let d = get_delivery(conn, tenant_id, oid)?;
        if d.driver_id.as_deref() != Some(driver_id) || d.status != "DELIVERED" {
            return Err("طلب لا يخص هذا السائق أو لم يُسلَّم".to_string());
        }
        if !d.pay_settled {
            pay += d.pay_cents;
        }
        if !d.cash_settled {
            cash += d.cash_due_cents;
        }
        count += 1;
    }
    let id = uuid::Uuid::now_v7().to_string();
    let created_at = now();
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    conn.execute(
        "INSERT INTO delivery_settlements (id, tenant_id, branch_id, driver_id, created_at, created_by, deliveries_count, pay_cents, cash_cents, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, tenant_id, branch_id, driver_id, created_at, created_by, count, pay, cash, note],
    )
    .map_err(|e| e.to_string())?;
    for oid in order_ids {
        conn.execute("UPDATE order_deliveries SET pay_settled = 1, cash_settled = 1 WHERE order_id = ?1", params![oid]).map_err(|e| e.to_string())?;
    }
    Ok(SettlementRecord { id, driver_id: driver_id.to_string(), created_at, deliveries_count: count, pay_cents: pay, cash_cents: cash, note: note.map(str::to_string) })
}

pub fn list_settlements(conn: &Connection, tenant_id: &str, driver_id: &str, limit: i64) -> Result<Vec<SettlementRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, driver_id, created_at, deliveries_count, pay_cents, cash_cents, note FROM delivery_settlements \
             WHERE tenant_id = ?1 AND driver_id = ?2 ORDER BY created_at DESC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, driver_id, limit], |r| {
            Ok(SettlementRecord { id: r.get(0)?, driver_id: r.get(1)?, created_at: r.get(2)?, deliveries_count: r.get(3)?, pay_cents: r.get(4)?, cash_cents: r.get(5)?, note: r.get(6)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT NOT NULL DEFAULT 'PENDING',
                customer_name TEXT, customer_phone TEXT, delivery_address TEXT, total_cents INTEGER NOT NULL DEFAULT 0, delivery_fee_cents INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE delivery_drivers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, pay_value INTEGER, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
             CREATE TABLE order_deliveries (order_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT, driver_id TEXT,
                status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ASSIGNED','OUT','DELIVERED','FAILED')),
                assigned_at TEXT, out_at TEXT, delivered_at TEXT, pay_cents INTEGER NOT NULL DEFAULT 0, cash_due_cents INTEGER NOT NULL DEFAULT 0,
                pay_settled INTEGER NOT NULL DEFAULT 0, cash_settled INTEGER NOT NULL DEFAULT 0, note TEXT);
             CREATE TABLE delivery_settlements (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT, driver_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
                created_by TEXT, deliveries_count INTEGER NOT NULL DEFAULT 0, pay_cents INTEGER NOT NULL DEFAULT 0, cash_cents INTEGER NOT NULL DEFAULT 0, note TEXT);",
        )
        .unwrap();
        c
    }

    fn order(c: &Connection, id: &str, total: i64, fee: i64, status: &str) {
        c.execute(
            "INSERT INTO orders (id, status, customer_name, customer_phone, delivery_address, total_cents, delivery_fee_cents) VALUES (?1, ?2, 'أحمد', '0933', 'المزة', ?3, ?4)",
            params![id, status, total, fee],
        )
        .unwrap();
        ensure_delivery_row(c, "t1", "b1", id).unwrap();
    }

    fn driver(c: &Connection, name: &str, own: Option<i64>) -> String {
        save_driver(c, "t1", &DriverInput { id: None, name: name.to_string(), phone: None, pay_value: own, is_active: true }).unwrap()
    }

    #[test]
    fn pay_per_delivery_is_a_fixed_amount_whatever_the_order() {
        assert_eq!(compute_pay(PAY_PER_DELIVERY, 5_000, None, 0), 5_000);
        assert_eq!(compute_pay(PAY_PER_DELIVERY, 5_000, None, 99_999), 5_000);
        assert_eq!(compute_pay(PAY_PER_DELIVERY, 5_000, Some(7_000), 0), 7_000, "the driver's own rate wins");
    }

    #[test]
    fn percent_of_fee_follows_the_fee_the_customer_paid() {
        assert_eq!(compute_pay(PAY_PERCENT_OF_FEE, 50, None, 10_000), 5_000);
        assert_eq!(compute_pay(PAY_PERCENT_OF_FEE, 50, Some(100), 10_000), 10_000);
        assert_eq!(compute_pay(PAY_PERCENT_OF_FEE, 50, None, 0), 0, "no fee, no percentage");
        assert_eq!(compute_pay(PAY_PERCENT_OF_FEE, 250, None, 1_000), 1_000, "never more than the fee");
    }

    #[test]
    fn settings_default_and_validate() {
        let c = db();
        let s = get_settings(&c);
        assert_eq!((s.pay_mode.as_str(), s.pay_value), (PAY_PER_DELIVERY, 0));
        set_settings(&c, PAY_PERCENT_OF_FEE, 60).unwrap();
        let s = get_settings(&c);
        assert_eq!((s.pay_mode.as_str(), s.pay_value), (PAY_PERCENT_OF_FEE, 60));
        assert!(set_settings(&c, PAY_PERCENT_OF_FEE, 101).is_err());
        assert!(set_settings(&c, PAY_PER_DELIVERY, -1).is_err());
        assert!(set_settings(&c, "WHATEVER", 5).is_err());
        assert_eq!(get_settings(&c).pay_value, 60, "a rejected change leaves the old setting");
    }

    #[test]
    fn drivers_are_scoped_to_their_tenant_and_can_be_switched_off() {
        let c = db();
        let id = driver(&c, "علي", None);
        assert_eq!(list_drivers(&c, "t1", false).unwrap().len(), 1);
        assert!(list_drivers(&c, "t2", true).unwrap().is_empty());
        assert!(save_driver(&c, "t2", &DriverInput { id: Some(id.clone()), name: "x".into(), phone: None, pay_value: None, is_active: true }).is_err());
        save_driver(&c, "t1", &DriverInput { id: Some(id), name: "علي".into(), phone: None, pay_value: None, is_active: false }).unwrap();
        assert!(list_drivers(&c, "t1", false).unwrap().is_empty());
        assert_eq!(list_drivers(&c, "t1", true).unwrap().len(), 1);
        assert!(save_driver(&c, "t1", &DriverInput { id: None, name: "  ".into(), phone: None, pay_value: None, is_active: true }).is_err());
    }

    #[test]
    fn a_delivery_goes_new_assigned_out_delivered_and_freezes_the_pay() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 5_000).unwrap();
        let ali = driver(&c, "علي", None);
        order(&c, "o1", 30_000, 5_000, "PENDING");
        assert_eq!(get_delivery(&c, "t1", "o1").unwrap().status, "NEW");

        assert!(set_status(&c, "t1", "o1", "OUT", None).is_err(), "cannot go out without a driver");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        assert_eq!(get_delivery(&c, "t1", "o1").unwrap().status, "ASSIGNED");
        set_status(&c, "t1", "o1", "OUT", None).unwrap();
        let d = set_status(&c, "t1", "o1", "DELIVERED", None).unwrap();
        assert_eq!((d.pay_cents, d.cash_due_cents), (5_000, 30_000), "unpaid order: the driver carries its cash");

        // The owner raises the rate afterwards: history does not change.
        set_settings(&c, PAY_PER_DELIVERY, 9_000).unwrap();
        assert_eq!(get_delivery(&c, "t1", "o1").unwrap().pay_cents, 5_000);
    }

    #[test]
    fn an_order_already_paid_at_the_till_carries_no_cash() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 4_000).unwrap();
        let ali = driver(&c, "علي", None);
        order(&c, "o1", 30_000, 5_000, "PAID");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        let d = set_status(&c, "t1", "o1", "DELIVERED", None).unwrap();
        assert_eq!((d.pay_cents, d.cash_due_cents), (4_000, 0));
    }

    #[test]
    fn a_failed_delivery_needs_a_reason_and_earns_nothing() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 4_000).unwrap();
        let ali = driver(&c, "علي", None);
        order(&c, "o1", 30_000, 5_000, "PENDING");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        set_status(&c, "t1", "o1", "OUT", None).unwrap();
        assert!(set_status(&c, "t1", "o1", "FAILED", None).is_err());
        let d = set_status(&c, "t1", "o1", "FAILED", Some("العميل لم يرد")).unwrap();
        assert_eq!((d.status.as_str(), d.pay_cents, d.cash_due_cents), ("FAILED", 0, 0));
        assert_eq!(d.note.as_deref(), Some("العميل لم يرد"));
        assert!(set_status(&c, "t1", "o1", "DELIVERED", None).is_err(), "a closed delivery stays closed");
        assert!(assign_driver(&c, "t1", "o1", None).is_err());
    }

    #[test]
    fn the_driver_can_be_swapped_until_delivered_but_not_removed_once_out() {
        let c = db();
        let ali = driver(&c, "علي", None);
        let omar = driver(&c, "عمر", None);
        order(&c, "o1", 10_000, 1_000, "PENDING");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        assign_driver(&c, "t1", "o1", Some(&omar)).unwrap();
        assert_eq!(get_delivery(&c, "t1", "o1").unwrap().driver_name.as_deref(), Some("عمر"));
        set_status(&c, "t1", "o1", "OUT", None).unwrap();
        assert!(assign_driver(&c, "t1", "o1", None).is_err(), "he is on the road");
        let swapped = assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        assert_eq!(swapped.status, "OUT", "swapping the driver does not pull the order back");
        // A switched-off driver cannot be given work.
        save_driver(&c, "t1", &DriverInput { id: Some(omar.clone()), name: "عمر".into(), phone: None, pay_value: None, is_active: false }).unwrap();
        order(&c, "o2", 1, 0, "PENDING");
        assert!(assign_driver(&c, "t1", "o2", Some(&omar)).is_err());
    }

    #[test]
    fn a_driver_with_his_own_rate_is_paid_that_rate() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 5_000).unwrap();
        let vip = driver(&c, "سائق خاص", Some(8_000));
        order(&c, "o1", 10_000, 1_000, "PENDING");
        assign_driver(&c, "t1", "o1", Some(&vip)).unwrap();
        assert_eq!(set_status(&c, "t1", "o1", "DELIVERED", None).unwrap().pay_cents, 8_000);
    }

    #[test]
    fn the_statement_adds_up_pay_cash_and_what_is_still_owed() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 5_000).unwrap();
        let ali = driver(&c, "علي", None);
        for (id, total, status) in [("o1", 20_000, "PENDING"), ("o2", 30_000, "PENDING"), ("o3", 10_000, "PAID"), ("o4", 15_000, "PENDING")] {
            order(&c, id, total, 2_000, status);
            assign_driver(&c, "t1", id, Some(&ali)).unwrap();
        }
        for id in ["o1", "o2", "o3"] {
            set_status(&c, "t1", id, "DELIVERED", None).unwrap();
        }
        set_status(&c, "t1", "o4", "FAILED", Some("ألغى")).unwrap();

        let st = driver_statement(&c, "t1", &ali, None, None).unwrap();
        let t = &st.totals;
        assert_eq!((t.deliveries, t.delivered, t.failed), (4, 3, 1));
        assert_eq!(t.orders_total_cents, 60_000);
        assert_eq!(t.fees_cents, 6_000);
        assert_eq!(t.pay_cents, 15_000);
        assert_eq!(t.pay_unsettled_cents, 15_000);
        assert_eq!(t.cash_unsettled_cents, 50_000, "o3 was paid at the till, so only o1 + o2 are in his pocket");
    }

    #[test]
    fn settling_clears_what_was_owed_and_records_the_handover() {
        let c = db();
        set_settings(&c, PAY_PER_DELIVERY, 5_000).unwrap();
        let ali = driver(&c, "علي", None);
        for (id, total) in [("o1", 20_000), ("o2", 30_000)] {
            order(&c, id, total, 2_000, "PENDING");
            assign_driver(&c, "t1", id, Some(&ali)).unwrap();
            set_status(&c, "t1", id, "DELIVERED", None).unwrap();
        }
        assert_eq!(unsettled(&c, "t1", &ali).unwrap().len(), 2);
        let rec = record_settlement(&c, "t1", Some("b1"), &ali, &["o1".to_string(), "o2".to_string()], "cashier-1", Some("نهاية الوردية")).unwrap();
        assert_eq!((rec.deliveries_count, rec.pay_cents, rec.cash_cents), (2, 10_000, 50_000));

        let st = driver_statement(&c, "t1", &ali, None, None).unwrap();
        assert_eq!((st.totals.pay_unsettled_cents, st.totals.cash_unsettled_cents), (0, 0));
        assert!(unsettled(&c, "t1", &ali).unwrap().is_empty());
        assert_eq!(list_settlements(&c, "t1", &ali, 10).unwrap().len(), 1);

        // Settling the same orders again moves no money.
        let again = record_settlement(&c, "t1", Some("b1"), &ali, &["o1".to_string()], "cashier-1", None).unwrap();
        assert_eq!((again.pay_cents, again.cash_cents), (0, 0));
    }

    #[test]
    fn nobody_can_settle_another_drivers_or_an_undelivered_order() {
        let c = db();
        let ali = driver(&c, "علي", None);
        let omar = driver(&c, "عمر", None);
        order(&c, "o1", 10_000, 1_000, "PENDING");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        assert!(record_settlement(&c, "t1", None, &ali, &["o1".to_string()], "c", None).is_err(), "not delivered yet");
        set_status(&c, "t1", "o1", "DELIVERED", None).unwrap();
        assert!(record_settlement(&c, "t1", None, &omar, &["o1".to_string()], "c", None).is_err(), "belongs to Ali");
        assert!(get_delivery(&c, "t2", "o1").is_err(), "another tenant sees nothing");
    }

    #[test]
    fn the_list_filters_by_driver_status_and_date() {
        let c = db();
        let ali = driver(&c, "علي", None);
        order(&c, "o1", 1, 0, "PENDING");
        order(&c, "o2", 1, 0, "PENDING");
        assign_driver(&c, "t1", "o1", Some(&ali)).unwrap();
        let by_driver = list_deliveries(&c, "t1", &DeliveryFilter { driver_id: Some(ali.clone()), ..Default::default() }).unwrap();
        assert_eq!(by_driver.len(), 1);
        let new_only = list_deliveries(&c, "t1", &DeliveryFilter { statuses: vec!["NEW".into()], ..Default::default() }).unwrap();
        assert_eq!(new_only.iter().map(|r| r.order_id.as_str()).collect::<Vec<_>>(), vec!["o2"]);
        let nothing = list_deliveries(&c, "t1", &DeliveryFilter { from: Some("2999-01-01".into()), ..Default::default() }).unwrap();
        assert!(nothing.is_empty());
        let today = list_deliveries(&c, "t1", &DeliveryFilter { from: Some("2000-01-01".into()), to: Some("2999-01-01".into()), ..Default::default() }).unwrap();
        assert_eq!(today.len(), 2);
    }
}
