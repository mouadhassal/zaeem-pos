//! Daily order numbers and the order history screen.
//!
//! Every new order gets a short number that starts again each business day,
//! one series per order type, so staff can call it out and a customer can
//! read it off the receipt: A-0001 takeaway (phone pickups included), B-0001
//! dine-in (debt sales are stored as dine-in), C-0001 delivery. The business
//! day changes at 05:00 local time, not midnight, so a restaurant open past
//! midnight never restarts its count mid-service. Numbers are handed out by
//! whichever database writes the order -- on a LAN that is always the hub --
//! inside the same transaction, so two tills can never get the same number.
//!
//! The history read model joins each order with its number, table, cashier,
//! payment and refunds for one business day at a time.

use crate::repo::HeldOrderModifier;
use chrono::{Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Hour (local) at which a new business day starts.
pub const DAY_START_HOUR: u32 = 5;

pub fn series_for(order_type: &str) -> &'static str {
    match order_type {
        "TAKEAWAY" => "A",
        "DINE_IN" => "B",
        "DELIVERY" => "C",
        _ => "D",
    }
}

pub fn label(series: &str, seq: i64) -> String {
    format!("{series}-{seq:04}")
}

/// The business day a local moment belongs to: before 05:00 it is still the
/// day before.
pub fn business_date(local: NaiveDateTime) -> String {
    (local - Duration::hours(DAY_START_HOUR as i64)).date().format("%Y-%m-%d").to_string()
}

pub fn today() -> String {
    business_date(Local::now().naive_local())
}

fn local_to_utc_text(t: NaiveDateTime) -> String {
    let local = Local
        .from_local_datetime(&t)
        .earliest()
        .unwrap_or_else(|| Utc.from_utc_datetime(&t).with_timezone(&Local));
    local.with_timezone(&Utc).format("%Y-%m-%d %H:%M:%S").to_string()
}

/// [start, end) of a business day in UTC, as text SQLite's `julianday` reads.
pub fn day_bounds_utc(date: &str) -> Result<(String, String), String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| format!("تاريخ غير صالح: {date}"))?;
    let start = d.and_hms_opt(DAY_START_HOUR, 0, 0).ok_or("تاريخ غير صالح")?;
    Ok((local_to_utc_text(start), local_to_utc_text(start + Duration::days(1))))
}

/// Gives `order_id` the next number of its series for `business_date`. Runs
/// inside the caller's transaction, right after the order row is written.
pub fn assign(conn: &Connection, order_id: &str, tenant_id: &str, branch_id: &str, order_type: &str, business_date: &str) -> rusqlite::Result<String> {
    let series = series_for(order_type);
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM order_numbers WHERE branch_id = ?1 AND business_date = ?2 AND series = ?3",
        params![branch_id, business_date, series],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO order_numbers (order_id, tenant_id, branch_id, business_date, series, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![order_id, tenant_id, branch_id, business_date, series, seq],
    )?;
    Ok(label(series, seq))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OrderNumber {
    pub label: String,
    pub business_date: String,
}

fn own_number(conn: &Connection, order_id: &str) -> rusqlite::Result<Option<OrderNumber>> {
    conn.query_row(
        "SELECT series, seq, business_date FROM order_numbers WHERE order_id = ?1",
        params![order_id],
        |r| Ok(OrderNumber { label: label(&r.get::<_, String>(0)?, r.get(1)?), business_date: r.get(2)? }),
    )
    .optional()
}

/// Numbers for the given orders of this tenant. A part of a split bill
/// carries the number of the order it was split from. Orders from before
/// numbering existed are simply absent (the caller falls back to the old
/// short code).
pub fn numbers_for(conn: &Connection, tenant_id: &str, order_ids: &[String]) -> rusqlite::Result<HashMap<String, OrderNumber>> {
    let mut out = HashMap::new();
    for id in order_ids.iter().take(500) {
        let parent: Option<Option<String>> = conn
            .query_row("SELECT parent_order_id FROM orders WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id], |r| r.get(0))
            .optional()?;
        let Some(parent) = parent else { continue };
        let number = match own_number(conn, id)? {
            Some(n) => Some(n),
            None => match parent {
                Some(p) => own_number(conn, &p)?,
                None => None,
            },
        };
        if let Some(n) = number {
            out.insert(id.clone(), n);
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryRow {
    pub id: String,
    /// A-0001 style, or None for an order from before daily numbers.
    pub number: Option<String>,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub order_type: String,
    pub status: String,
    pub table_name: Option<String>,
    pub cashier_name: Option<String>,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub item_count: i64,
    pub total_cents: i64,
    pub refunded_cents: i64,
    pub payment_method: Option<String>,
    pub parent_order_id: Option<String>,
}

const ROW_SELECT: &str = "SELECT o.id, COALESCE(n.series, pn.series), COALESCE(n.seq, pn.seq), o.created_at, o.closed_at, o.order_type, o.status, \
     t.name, s.name, o.customer_name, o.customer_phone, \
     (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id AND voided = 0), \
     o.total_cents, COALESCE(o.refunded_cents, 0), \
     (SELECT method FROM payments WHERE order_id = o.id ORDER BY created_at LIMIT 1), o.parent_order_id \
     FROM orders o \
     LEFT JOIN order_numbers n ON n.order_id = o.id \
     LEFT JOIN order_numbers pn ON pn.order_id = o.parent_order_id \
     LEFT JOIN tables t ON t.id = o.table_id \
     LEFT JOIN staff s ON s.id = o.user_id";

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<HistoryRow> {
    let series: Option<String> = r.get(1)?;
    let seq: Option<i64> = r.get(2)?;
    Ok(HistoryRow {
        id: r.get(0)?,
        number: match (series, seq) {
            (Some(s), Some(n)) => Some(label(&s, n)),
            _ => None,
        },
        created_at: r.get(3)?,
        closed_at: r.get(4)?,
        order_type: r.get(5)?,
        status: r.get(6)?,
        table_name: r.get(7)?,
        cashier_name: r.get(8)?,
        customer_name: r.get(9)?,
        customer_phone: r.get(10)?,
        item_count: r.get(11)?,
        total_cents: r.get(12)?,
        refunded_cents: r.get(13)?,
        payment_method: r.get(14)?,
        parent_order_id: r.get(15)?,
    })
}

/// Every order of one business day at this branch, newest first. Held
/// drafts are not orders yet and are left out. `only_user` limits it to the
/// orders one cashier took.
pub fn list_day(conn: &Connection, tenant_id: &str, branch_id: &str, business_date: &str, only_user: Option<&str>) -> Result<Vec<HistoryRow>, String> {
    let (start, end) = day_bounds_utc(business_date)?;
    let sql = format!(
        "{ROW_SELECT} WHERE o.tenant_id = ?1 AND o.branch_id = ?2 AND o.status <> 'DRAFT' \
         AND julianday(o.created_at) >= julianday(?3) AND julianday(o.created_at) < julianday(?4) \
         AND (?5 IS NULL OR o.user_id = ?5) \
         ORDER BY julianday(o.created_at) DESC LIMIT 3000"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, branch_id, start, end, only_user], row_from)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryItem {
    pub id: String,
    pub name: String,
    pub quantity: i64,
    pub unit_price_cents: i64,
    pub modifiers: Vec<HeldOrderModifier>,
    pub notes: Option<String>,
    pub comped: bool,
    pub comp_reason: Option<String>,
    /// How many of this line were already refunded.
    pub refunded_quantity: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CancelledLine {
    pub name: String,
    pub quantity: i64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentLine {
    pub method: String,
    pub amount_cents: i64,
    pub change_cents: i64,
    pub created_at: String,
    pub reference_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefundedLine {
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefundLine {
    pub id: String,
    pub amount_cents: i64,
    pub reason: Option<String>,
    pub by_name: Option<String>,
    pub created_at: String,
    pub method: Option<String>,
    pub manager_pin_used: bool,
    /// Empty for a whole-order refund made before item refunds existed.
    pub lines: Vec<RefundedLine>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryDetail {
    #[serde(flatten)]
    pub row: HistoryRow,
    pub business_date: Option<String>,
    pub subtotal_cents: i64,
    pub tax_cents: i64,
    pub discount_cents: i64,
    pub discount_reason: Option<String>,
    pub delivery_fee_cents: i64,
    pub delivery_address: Option<String>,
    pub items: Vec<HistoryItem>,
    pub cancelled: Vec<CancelledLine>,
    pub payments: Vec<PaymentLine>,
    pub refunds: Vec<RefundLine>,
}

/// One order in full, for the history screen's detail panel and a receipt
/// reprint. None when it is not an order of this branch (or, with
/// `only_user`, not one this cashier took).
pub fn detail(conn: &Connection, tenant_id: &str, branch_id: &str, order_id: &str, only_user: Option<&str>) -> Result<Option<HistoryDetail>, String> {
    let sql = format!("{ROW_SELECT} WHERE o.id = ?1 AND o.tenant_id = ?2 AND o.branch_id = ?3 AND (?4 IS NULL OR o.user_id = ?4)");
    let row = conn
        .query_row(&sql, params![order_id, tenant_id, branch_id, only_user], row_from)
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(None) };
    let e = |e: rusqlite::Error| e.to_string();

    #[allow(clippy::type_complexity)]
    let (subtotal_cents, tax_cents, discount_cents, discount_reason, delivery_fee_cents, delivery_address): (i64, i64, i64, Option<String>, i64, Option<String>) = conn
        .query_row(
            "SELECT subtotal_cents, tax_cents, discount_cents, discount_reason, COALESCE(delivery_fee_cents, 0), delivery_address FROM orders WHERE id = ?1",
            params![order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(e)?;

    let mut items = Vec::new();
    let mut cancelled = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT oi.id, COALESCE(m.name, ''), oi.quantity, oi.unit_price_cents, oi.notes, COALESCE(oi.comped, 0), oi.comp_reason, oi.voided, oi.void_reason, \
                 (SELECT COALESCE(SUM(ri.quantity), 0) FROM refund_items ri WHERE ri.order_item_id = oi.id) \
                 FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.menu_item_id WHERE oi.order_id = ?1 ORDER BY oi.rowid",
            )
            .map_err(e)?;
        #[allow(clippy::type_complexity)]
        let raw: Vec<(String, String, i64, i64, Option<String>, i64, Option<String>, i64, Option<String>, i64)> = stmt
            .query_map(params![order_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        for (id, name, quantity, unit_price_cents, notes, comped, comp_reason, voided, void_reason, refunded_quantity) in raw {
            if voided != 0 {
                cancelled.push(CancelledLine { name, quantity, reason: void_reason });
                continue;
            }
            let mut mod_stmt = conn.prepare("SELECT name, price_cents FROM order_modifiers WHERE order_item_id = ?1").map_err(e)?;
            let modifiers = mod_stmt
                .query_map(params![id], |r| Ok(HeldOrderModifier { name: r.get(0)?, price_cents: r.get(1)? }))
                .map_err(e)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(e)?;
            items.push(HistoryItem {
                id,
                name,
                quantity,
                unit_price_cents,
                modifiers,
                notes: notes.filter(|n| !n.is_empty()),
                comped: comped != 0,
                comp_reason,
                refunded_quantity,
            });
        }
    }

    let payments = {
        let mut stmt = conn
            .prepare("SELECT method, amount_cents, COALESCE(change_cents, 0), created_at, reference_code FROM payments WHERE order_id = ?1 ORDER BY created_at")
            .map_err(e)?;
        let rows = stmt
            .query_map(params![order_id], |r| {
                Ok(PaymentLine { method: r.get(0)?, amount_cents: r.get(1)?, change_cents: r.get(2)?, created_at: r.get(3)?, reference_code: r.get(4)? })
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        rows
    };

    let mut refunds = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.amount_cents, r.reason, s.name, r.created_at, r.method, COALESCE(r.manager_pin_used, 0) \
                 FROM refunds r LEFT JOIN staff s ON s.id = r.refunded_by WHERE r.order_id = ?1 ORDER BY r.created_at",
            )
            .map_err(e)?;
        #[allow(clippy::type_complexity)]
        let raw: Vec<(String, i64, Option<String>, Option<String>, String, Option<String>, i64)> = stmt
            .query_map(params![order_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        for (id, amount_cents, reason, by_name, created_at, method, pin) in raw {
            let mut line_stmt = conn
                .prepare(
                    "SELECT COALESCE(m.name, ''), ri.quantity FROM refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id \
                     LEFT JOIN menu_items m ON m.id = oi.menu_item_id WHERE ri.refund_id = ?1 ORDER BY ri.rowid",
                )
                .map_err(e)?;
            let lines = line_stmt
                .query_map(params![id], |r| Ok(RefundedLine { name: r.get(0)?, quantity: r.get(1)? }))
                .map_err(e)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(e)?;
            refunds.push(RefundLine { id, amount_cents, reason, by_name, created_at, method, manager_pin_used: pin != 0, lines });
        }
    }

    let business_date = numbers_for(conn, tenant_id, std::slice::from_ref(&row.id))
        .map_err(e)?
        .remove(&row.id)
        .map(|n| n.business_date);

    Ok(Some(HistoryDetail {
        row,
        business_date,
        subtotal_cents,
        tax_cents,
        discount_cents,
        discount_reason,
        delivery_fee_cents,
        delivery_address,
        items,
        cancelled,
        payments,
        refunds,
    }))
}

/// One line the customer is refunded for: `quantity` of an order item.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RefundLineInput {
    pub order_item_id: String,
    pub quantity: i64,
}

/// What a refund of some lines is worth. Each line's share is its charged
/// value (options included, gifts are free) scaled to what the customer
/// actually paid for the items (discount, tax and service included,
/// delivery fee excluded), rounded half up. When the refund takes the last
/// chargeable item, it is everything still unrefunded instead, so rounding
/// never leaves a few liras behind and the delivery fee goes back too.
/// Never more than what is left.
pub fn refund_amount(lines_value: i64, gross_items_value: i64, total_cents: i64, delivery_fee_cents: i64, already_refunded: i64, takes_last_item: bool) -> i64 {
    let remaining = (total_cents - already_refunded).max(0);
    if takes_last_item {
        return remaining;
    }
    if gross_items_value <= 0 {
        return 0;
    }
    let paid_for_items = (total_cents - delivery_fee_cents).max(0) as i128;
    let share = ((lines_value as i128) * paid_for_items * 2 + gross_items_value as i128) / (2 * gross_items_value as i128);
    (share as i64).min(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn series_and_label() {
        assert_eq!(series_for("TAKEAWAY"), "A");
        assert_eq!(series_for("DINE_IN"), "B");
        assert_eq!(series_for("DELIVERY"), "C");
        assert_eq!(series_for("ONLINE"), "D");
        assert_eq!(label("A", 1), "A-0001");
        assert_eq!(label("C", 1234), "C-1234");
        assert_eq!(label("B", 12345), "B-12345");
    }

    #[test]
    fn business_day_starts_at_five() {
        assert_eq!(business_date(at("2026-10-25 04:59")), "2026-10-24", "past midnight is still last night's service");
        assert_eq!(business_date(at("2026-10-25 05:00")), "2026-10-25");
        assert_eq!(business_date(at("2026-10-25 23:59")), "2026-10-25");
        assert_eq!(business_date(at("2026-10-26 00:30")), "2026-10-25");
    }

    #[test]
    fn day_bounds_cover_24_hours_from_five_local() {
        let (start, end) = day_bounds_utc("2026-10-25").unwrap();
        let s = NaiveDateTime::parse_from_str(&start, "%Y-%m-%d %H:%M:%S").unwrap();
        let e = NaiveDateTime::parse_from_str(&end, "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(e - s, Duration::hours(24));
        let local_start = Utc.from_utc_datetime(&s).with_timezone(&Local).naive_local();
        assert_eq!(local_start, at("2026-10-25 05:00"));
        assert!(day_bounds_utc("25/10/2026").is_err());
    }

    fn numbers_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE orders (id TEXT PRIMARY KEY, tenant_id TEXT, parent_order_id TEXT, created_at TEXT);
             CREATE TABLE order_numbers (order_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, business_date TEXT NOT NULL,
               series TEXT NOT NULL, seq INTEGER NOT NULL CHECK (seq > 0), UNIQUE (branch_id, business_date, series, seq));",
        )
        .unwrap();
        conn
    }

    #[test]
    fn each_type_counts_on_its_own_and_restarts_each_day_and_branch() {
        let conn = numbers_db();
        let a = |id: &str, branch: &str, ty: &str, day: &str| assign(&conn, id, "t1", branch, ty, day).unwrap();
        assert_eq!(a("o1", "b1", "TAKEAWAY", "2026-10-25"), "A-0001");
        assert_eq!(a("o2", "b1", "TAKEAWAY", "2026-10-25"), "A-0002");
        assert_eq!(a("o3", "b1", "DINE_IN", "2026-10-25"), "B-0001");
        assert_eq!(a("o4", "b1", "DELIVERY", "2026-10-25"), "C-0001");
        assert_eq!(a("o5", "b1", "TAKEAWAY", "2026-10-26"), "A-0001", "a new day starts again");
        assert_eq!(a("o6", "b2", "TAKEAWAY", "2026-10-25"), "A-0001", "another branch has its own count");
        assert_eq!(a("o7", "b1", "TAKEAWAY", "2026-10-25"), "A-0003");
        assert!(assign(&conn, "o1", "t1", "b1", "TAKEAWAY", "2026-10-25").is_err(), "an order is numbered once");
    }

    #[test]
    fn a_split_part_carries_its_parent_number_and_other_tenants_see_nothing() {
        let conn = numbers_db();
        conn.execute_batch(
            "INSERT INTO orders VALUES ('p', 't1', NULL, '2026-10-25T10:00:00+00:00');
             INSERT INTO orders VALUES ('c', 't1', 'p', '2026-10-25T10:05:00+00:00');
             INSERT INTO orders VALUES ('old', 't1', NULL, '2026-01-01T10:00:00+00:00');",
        )
        .unwrap();
        assign(&conn, "p", "t1", "b1", "DINE_IN", "2026-10-25").unwrap();
        let ids = vec!["p".to_string(), "c".to_string(), "old".to_string()];
        let got = numbers_for(&conn, "t1", &ids).unwrap();
        assert_eq!(got["p"].label, "B-0001");
        assert_eq!(got["c"].label, "B-0001");
        assert_eq!(got["c"].business_date, "2026-10-25");
        assert!(!got.contains_key("old"), "orders from before numbering have none");
        assert!(numbers_for(&conn, "t2", &ids).unwrap().is_empty(), "another tenant's orders are invisible");
    }

    #[test]
    fn julianday_reads_both_created_at_formats() {
        let conn = Connection::open_in_memory().unwrap();
        let rfc: f64 = conn.query_row("SELECT julianday('2026-10-25T02:30:11.123456789+00:00')", [], |r| r.get(0)).unwrap();
        let plain: f64 = conn.query_row("SELECT julianday('2026-10-25 02:30:11')", [], |r| r.get(0)).unwrap();
        assert!((rfc - plain).abs() < 1e-5, "rfc3339 with nanoseconds and the plain SQLite format must compare");
        let shifted: f64 = conn.query_row("SELECT julianday('2026-10-25T05:30:11+03:00')", [], |r| r.get(0)).unwrap();
        assert!((shifted - plain).abs() < 1e-5, "an offset is honoured");
    }

    #[test]
    fn refund_amount_shares_discount_and_tax_and_closes_exactly() {
        // 3 lines of 1000 + 1000 + 1000, 10% discount, 500 delivery: paid 3200.
        assert_eq!(refund_amount(1000, 3000, 3200, 500, 0, false), 900, "a third of the 2700 paid for items");
        // Second line, then the last one takes everything left (incl. delivery fee and rounding).
        assert_eq!(refund_amount(1000, 3000, 3200, 500, 900, false), 900);
        assert_eq!(refund_amount(1000, 3000, 3200, 500, 1800, true), 1400);
        // Odd split rounds half up and never exceeds what is left.
        assert_eq!(refund_amount(1, 3, 100, 0, 0, false), 33);
        assert_eq!(refund_amount(2, 3, 100, 0, 0, false), 67);
        assert_eq!(refund_amount(2, 3, 100, 0, 90, false), 10);
        // Nothing chargeable: nothing to refund.
        assert_eq!(refund_amount(0, 0, 100, 0, 0, false), 0);
    }
}
