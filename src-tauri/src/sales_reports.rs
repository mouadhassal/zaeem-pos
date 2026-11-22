//! Restaurant reports beyond the sales strip: where the sales came from (hour, table, dining area,
//! cashier, order source, payment method), who gave discounts and why, what was cancelled or voided,
//! the customers (best, gone quiet, how often they come, who owes and for how long), how fast the
//! kitchen and the drivers are, and which dishes earn their place on the menu.
//!
//! Same counting rules as `sales_strip.rs`: an order counts on the day it was paid (`closed_at`), only
//! `PAID` orders are sales, money is whole pounds in `*_cents` columns. Each function is plain SQL over a
//! connection, so it is tested on its own; the Tauri commands in `commands/reports.rs` only authorize.
//!
//! Hours and days are the till's local ones: the page sends `tz_offset_minutes` (minutes east of UTC).

use crate::assistant::{modifier, qualify, scope_predicate};
use crate::order_history::{label, row_from, HistoryRow, ROW_SELECT};
use crate::profit::LINE_COST_SQL;
use crate::security::Scope;
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params_from_iter, Connection};
use std::collections::{BTreeMap, HashMap};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Reads an instant written either as RFC 3339 (`2026-11-05T10:30:00Z`) or as SQLite's own
/// `2026-11-05 10:30:00`.
pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Some(t.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(n.and_utc());
        }
    }
    None
}

fn minutes_between(from: &str, to: &str) -> Option<f64> {
    let (a, b) = (parse_ts(from)?, parse_ts(to)?);
    Some((b - a).num_seconds() as f64 / 60.0)
}

/// Average, median and the largest of a list of minutes (all 0 for an empty list).
pub fn spread(values: &[f64]) -> (f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let avg = v.iter().sum::<f64>() / v.len() as f64;
    let mid = v.len() / 2;
    let median = if v.len() % 2 == 1 { v[mid] } else { (v[mid - 1] + v[mid]) / 2.0 };
    (avg, median, *v.last().unwrap_or(&0.0))
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// The scope predicate on `alias`, its arguments, and the two window placeholders' numbers.
fn scoped(scope: &Scope, alias: &str, start_iso: &str, end_iso: &str) -> (String, Vec<String>, usize, usize) {
    let (pred, mut args) = scope_predicate(scope);
    let n = args.len();
    args.push(start_iso.to_string());
    args.push(end_iso.to_string());
    (qualify(pred, alias), args, n + 1, n + 2)
}

/// When an order counts: the day it was paid (else the day it was taken).
fn when_sql(alias: &str) -> String {
    format!("COALESCE({alias}.closed_at, {alias}.created_at)")
}

fn window_sql(alias: &str, ia: usize, ib: usize) -> String {
    let w = when_sql(alias);
    format!("julianday({w}) >= julianday(?{ia}) AND julianday({w}) <= julianday(?{ib})")
}

fn method_label(method: &str) -> String {
    match method {
        "CASH" => "نقداً",
        "CARD" => "بطاقة",
        "WALLET" => "محفظة",
        "CREDIT" => "دين (آجل)",
        other => return other.to_string(),
    }
    .to_string()
}

fn number_label(series: Option<String>, seq: Option<i64>) -> Option<String> {
    match (series, seq) {
        (Some(s), Some(n)) => Some(label(&s, n)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 1. Sales breakdowns
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct BreakdownRow {
    /// What the drill-down filters on (a table id, an hour, a payment method...).
    pub key: String,
    pub label: String,
    pub count: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Breakdown {
    pub kind: String,
    pub rows: Vec<BreakdownRow>,
    /// Orders behind the rows (an order paid by two methods counts once).
    pub total_count: i64,
    pub total_cents: i64,
}

/// How an order-based breakdown groups: SQL over `o` (orders), `t` (tables), `da` (dining areas),
/// `s` (staff) and `dp` (delivery apps).
struct Spec {
    key: String,
    label: &'static str,
    value: &'static str,
    extra: &'static str,
}

fn spec(kind: &str, off: &str) -> Option<Spec> {
    let when = when_sql("o");
    Some(match kind {
        "hour" => Spec {
            key: format!("CAST(strftime('%H', datetime({when}, '{off}')) AS INTEGER)"),
            label: "''",
            value: "o.total_cents",
            extra: "",
        },
        "table" => Spec { key: "COALESCE(t.id, '')".into(), label: "COALESCE(t.name, 'بدون طاولة')", value: "o.total_cents", extra: "AND o.order_type = 'DINE_IN'" },
        "area" => Spec { key: "COALESCE(da.id, '')".into(), label: "COALESCE(da.name, 'بدون منطقة')", value: "o.total_cents", extra: "AND o.order_type = 'DINE_IN'" },
        "cashier" => Spec { key: "COALESCE(o.user_id, '')".into(), label: "COALESCE(s.name, 'غير معروف')", value: "o.total_cents", extra: "" },
        "source" => Spec {
            key: "CASE WHEN COALESCE(o.platform_id, '') <> '' THEN 'P:' || o.platform_id ELSE o.order_type END".into(),
            label: "CASE WHEN COALESCE(o.platform_id, '') <> '' THEN COALESCE(dp.name, 'تطبيق توصيل') \
                    WHEN o.order_type = 'DINE_IN' THEN 'صالة' WHEN o.order_type = 'TAKEAWAY' THEN 'سفري' \
                    WHEN o.order_type = 'DELIVERY' THEN 'توصيل (مباشر)' WHEN o.order_type = 'ONLINE' THEN 'أونلاين' ELSE o.order_type END",
            value: "o.total_cents",
            extra: "",
        },
        "discount_user" => Spec { key: "COALESCE(o.user_id, '')".into(), label: "COALESCE(s.name, 'غير معروف')", value: "o.discount_cents", extra: "AND COALESCE(o.discount_cents, 0) > 0" },
        "discount_reason" => Spec {
            key: "COALESCE(TRIM(o.discount_reason), '')".into(),
            label: "COALESCE(NULLIF(TRIM(o.discount_reason), ''), 'بدون سبب')",
            value: "o.discount_cents",
            extra: "AND COALESCE(o.discount_cents, 0) > 0",
        },
        _ => return None,
    })
}

/// Kinds `breakdown` understands.
#[cfg(test)]
pub const BREAKDOWN_KINDS: &[&str] = &["hour", "table", "area", "cashier", "source", "payment", "discount_user", "discount_reason"];

const ORDER_JOINS: &str = "FROM orders o \
    LEFT JOIN tables t ON t.id = o.table_id \
    LEFT JOIN dining_areas da ON da.id = t.area_id \
    LEFT JOIN staff s ON s.id = o.user_id \
    LEFT JOIN delivery_platforms dp ON dp.id = o.platform_id";

pub fn breakdown(conn: &Connection, scope: &Scope, kind: &str, start_iso: &str, end_iso: &str, tz_offset_minutes: i64) -> Result<Breakdown, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let (pred, args, ia, ib) = scoped(scope, "o", start_iso, end_iso);
    let window = window_sql("o", ia, ib);
    let off = modifier(tz_offset_minutes);
    let mut out = Breakdown { kind: kind.to_string(), ..Default::default() };

    if kind == "payment" {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT p.method, COUNT(DISTINCT o.id), COALESCE(SUM(p.amount_cents - COALESCE(p.change_cents, 0)), 0) \
                 FROM payments p INNER JOIN orders o ON o.id = p.order_id \
                 WHERE {pred} AND o.status = 'PAID' AND {window} GROUP BY p.method ORDER BY 3 DESC, 1"
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                let m: String = r.get(0)?;
                Ok(BreakdownRow { label: method_label(&m), key: m, count: r.get(1)?, amount_cents: r.get(2)? })
            })
            .map_err(e)?;
        out.rows = rows.collect::<Result<Vec<_>, _>>().map_err(e)?;
        out.total_count = conn
            .query_row(&format!("SELECT COUNT(*) FROM orders o WHERE {pred} AND o.status = 'PAID' AND {window}"), params_from_iter(args.iter()), |r| r.get(0))
            .map_err(e)?;
        out.total_cents = out.rows.iter().map(|r| r.amount_cents).sum();
        return Ok(out);
    }

    let sp = spec(kind, &off).ok_or_else(|| format!("نوع تقرير غير معروف: {kind}"))?;
    let label_sql = if kind == "hour" { "printf('%02d:00', k)".to_string() } else { sp.label.to_string() };
    let sql = if kind == "hour" {
        format!(
            "SELECT CAST(k AS TEXT), {label_sql}, COUNT(*), COALESCE(SUM(v), 0) FROM \
             (SELECT {key} AS k, {value} AS v {ORDER_JOINS} WHERE {pred} AND o.status = 'PAID' AND {window} {extra}) GROUP BY k",
            key = sp.key, value = sp.value, extra = sp.extra
        )
    } else {
        format!(
            "SELECT CAST(({key}) AS TEXT), MIN({label}), COUNT(*), COALESCE(SUM({value}), 0) {ORDER_JOINS} \
             WHERE {pred} AND o.status = 'PAID' AND {window} {extra} GROUP BY 1",
            key = sp.key, label = sp.label, value = sp.value, extra = sp.extra
        )
    };
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| Ok(BreakdownRow { key: r.get(0)?, label: r.get(1)?, count: r.get(2)?, amount_cents: r.get(3)? }))
        .map_err(e)?;
    out.rows = rows.collect::<Result<Vec<_>, _>>().map_err(e)?;
    if kind == "hour" {
        // The business day starts at 05:00, so the hours run 05, 06 ... 23, 00 ... 04.
        out.rows.sort_by_key(|r| (r.key.parse::<i64>().unwrap_or(0) - crate::order_history::DAY_START_HOUR as i64).rem_euclid(24));
    } else {
        out.rows.sort_by(|a, b| b.amount_cents.cmp(&a.amount_cents).then_with(|| a.label.cmp(&b.label)));
    }
    out.total_count = out.rows.iter().map(|r| r.count).sum();
    out.total_cents = out.rows.iter().map(|r| r.amount_cents).sum();
    Ok(out)
}

/// The orders behind one row of a breakdown, in the order history's own row shape so the same list
/// and detail screens show them.
pub fn breakdown_orders(conn: &Connection, scope: &Scope, kind: &str, key: &str, start_iso: &str, end_iso: &str, tz_offset_minutes: i64) -> Result<Vec<HistoryRow>, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let (pred, mut args, ia, ib) = scoped(scope, "o", start_iso, end_iso);
    let window = window_sql("o", ia, ib);
    let ik = args.len() + 1;
    args.push(key.to_string());
    let filter = if kind == "payment" {
        format!("AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.method = ?{ik})")
    } else {
        let sp = spec(kind, &modifier(tz_offset_minutes)).ok_or_else(|| format!("نوع تقرير غير معروف: {kind}"))?;
        format!("AND CAST(({}) AS TEXT) = ?{ik} {}", sp.key, sp.extra)
    };
    let sql = format!(
        "{ROW_SELECT} LEFT JOIN dining_areas da ON da.id = t.area_id \
         WHERE {pred} AND o.status = 'PAID' AND {window} {filter} ORDER BY julianday({}) DESC LIMIT 1000",
        when_sql("o")
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), row_from).map_err(e)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(e)
}

// ---------------------------------------------------------------------------
// 1b. Cancelled orders and voided items: who, why, how much
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CancelledOrder {
    pub order_id: String,
    pub number: Option<String>,
    pub when: String,
    /// Who cancelled it, from the audit log (None for an order cancelled before the log existed).
    pub who: Option<String>,
    pub reason: Option<String>,
    pub value_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VoidedItem {
    pub order_id: String,
    pub number: Option<String>,
    pub name: String,
    pub quantity: i64,
    pub value_cents: i64,
    pub when: String,
    pub who: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Cancellations {
    pub cancelled: Vec<CancelledOrder>,
    pub voided: Vec<VoidedItem>,
    pub cancelled_total_cents: i64,
    pub voided_total_cents: i64,
}

/// The latest audit entry of `entity` whose payload says `action`: (who, when, payload).
fn audit_entry(conn: &Connection, entity_type: &str, entity_id: &str, action: &str) -> Option<(Option<String>, String, serde_json::Value)> {
    let mut stmt = conn
        .prepare(
            "SELECT st.name, a.ts, a.after_json FROM audit_log a LEFT JOIN staff st ON st.id = a.actor_id \
             WHERE a.entity_type = ?1 AND a.entity_id = ?2 AND a.action = 'OrderStatusChanged' ORDER BY a.ts DESC",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![entity_type, entity_id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
        .ok()?;
    for row in rows.flatten() {
        let json: serde_json::Value = row.2.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or(serde_json::Value::Null);
        if json.get("action").and_then(|a| a.as_str()) == Some(action) {
            return Some((row.0, row.1, json));
        }
    }
    None
}

pub fn cancellations(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<Cancellations, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let (pred, args, ia, ib) = scoped(scope, "o", start_iso, end_iso);
    let window = window_sql("o", ia, ib);
    let mut out = Cancellations::default();

    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT o.id, n.series, n.seq, {when}, o.cancel_reason, COALESCE(o.total_cents, 0), COALESCE(o.subtotal_cents, 0) \
                 FROM orders o LEFT JOIN order_numbers n ON n.order_id = o.id \
                 WHERE {pred} AND o.status = 'CANCELLED' AND {window} ORDER BY julianday({when}) DESC LIMIT 500",
                when = when_sql("o")
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)?, r.get::<_, i64>(6)?))
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        for (id, series, seq, when, cancel_reason, total, subtotal) in rows {
            let audit = audit_entry(conn, "order", &id, "cancel_order");
            let (who, reason, value) = match &audit {
                Some((who, _, json)) => (
                    who.clone(),
                    json.get("reason").and_then(|v| v.as_str()).map(str::to_string).filter(|s| !s.trim().is_empty()).or(cancel_reason.clone()),
                    json.get("value_cents").and_then(|v| v.as_i64()).unwrap_or(total.max(subtotal)),
                ),
                None => (None, cancel_reason.clone(), total.max(subtotal)),
            };
            out.cancelled_total_cents += value;
            out.cancelled.push(CancelledOrder { order_id: id, number: number_label(series, seq), when, who, reason, value_cents: value });
        }
    }

    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT oi.id, o.id, n.series, n.seq, COALESCE(m.name, '?'), oi.quantity, oi.void_reason, {when}, \
                        (oi.unit_price_cents + COALESCE((SELECT SUM(md.price_cents) FROM order_modifiers md WHERE md.order_item_id = oi.id), 0)) * oi.quantity \
                 FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id \
                 LEFT JOIN menu_items m ON m.id = oi.menu_item_id LEFT JOIN order_numbers n ON n.order_id = o.id \
                 WHERE {pred} AND o.status <> 'DRAFT' AND oi.voided = 1 AND {window} ORDER BY julianday({when}) DESC LIMIT 500",
                when = when_sql("o")
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<i64>>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?, r.get::<_, Option<String>>(6)?, r.get::<_, String>(7)?, r.get::<_, i64>(8)?))
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        for (item_id, order_id, series, seq, name, quantity, void_reason, order_when, value) in rows {
            let audit = audit_entry(conn, "order_item", &item_id, "void");
            let (who, when, reason) = match &audit {
                Some((who, ts, json)) => (
                    who.clone(),
                    ts.clone(),
                    json.get("reason").and_then(|v| v.as_str()).map(str::to_string).filter(|s| !s.trim().is_empty()).or(void_reason.clone()),
                ),
                None => (None, order_when, void_reason.clone()),
            };
            out.voided_total_cents += value;
            out.voided.push(VoidedItem { order_id, number: number_label(series, seq), name, quantity, value_cents: value, when, who, reason: reason.filter(|s| !s.trim().is_empty()) });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 5. Customers and debts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TopCustomer {
    pub name: String,
    pub phone: String,
    pub visits: i64,
    pub spent_cents: i64,
    pub avg_cents: i64,
    pub last_visit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct InactiveCustomer {
    pub name: String,
    pub phone: String,
    pub last_visit: String,
    pub days_since: i64,
    pub visits: i64,
    pub spent_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FrequencyBucket {
    pub label: String,
    pub customers: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DebtBucket {
    pub label: String,
    pub debtors: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DebtorAge {
    pub name: String,
    pub phone: String,
    pub balance_cents: i64,
    /// Age in days of the oldest part still owed.
    pub oldest_days: i64,
    /// Owed amount per age bucket: 0-30, 31-60, 61-90, over 90 days.
    pub buckets: [i64; 4],
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct CustomersReport {
    pub top: Vec<TopCustomer>,
    pub inactive: Vec<InactiveCustomer>,
    pub inactive_days: i64,
    pub frequency: Vec<FrequencyBucket>,
    /// Different customers (by phone, else name) who ordered in the period.
    pub customers_in_period: i64,
    pub avg_visits: f64,
    /// Paid orders in the period with no customer attached.
    pub unidentified_orders: i64,
    pub debt_buckets: Vec<DebtBucket>,
    pub debtors: Vec<DebtorAge>,
}

pub const DEBT_BUCKET_LABELS: [&str; 4] = ["0 - 30 يوماً", "31 - 60 يوماً", "61 - 90 يوماً", "أكثر من 90 يوماً"];

fn bucket_of(age_days: i64) -> usize {
    match age_days {
        i64::MIN..=30 => 0,
        31..=60 => 1,
        61..=90 => 2,
        _ => 3,
    }
}

/// What is still owed, split by how old each debt is. Payments settle the oldest debts first.
/// `entries` are (when in seconds, is a debt, amount); returns the four buckets and the age in days
/// of the oldest part still owed (0 when nothing is owed).
pub fn age_buckets(entries: &[(i64, bool, i64)], now_secs: i64) -> ([i64; 4], i64) {
    let mut sorted = entries.to_vec();
    sorted.sort_by_key(|e| e.0);
    let mut paid: i64 = sorted.iter().filter(|e| !e.1).map(|e| e.2).sum();
    let mut buckets = [0i64; 4];
    let mut oldest = 0;
    for (ts, is_debt, amount) in sorted {
        if !is_debt {
            continue;
        }
        let used = paid.min(amount);
        paid -= used;
        let left = amount - used;
        if left > 0 {
            let age = ((now_secs - ts) / 86_400).max(0);
            buckets[bucket_of(age)] += left;
            oldest = oldest.max(age);
        }
    }
    (buckets, oldest)
}

fn frequency_buckets(visits: &[i64]) -> Vec<FrequencyBucket> {
    let mut b = [0i64; 4];
    for &v in visits {
        let i = match v {
            i64::MIN..=1 => 0,
            2..=3 => 1,
            4..=9 => 2,
            _ => 3,
        };
        b[i] += 1;
    }
    ["زيارة واحدة", "2 - 3 زيارات", "4 - 9 زيارات", "10 زيارات فأكثر"].iter().zip(b).map(|(l, c)| FrequencyBucket { label: l.to_string(), customers: c }).collect()
}

pub fn customers_report(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str, inactive_days: i64, now_iso: &str) -> Result<CustomersReport, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let inactive_days = inactive_days.clamp(1, 3650);
    let now = parse_ts(now_iso).ok_or("وقت غير صالح")?;
    let (pred, args, ia, ib) = scoped(scope, "o", start_iso, end_iso);
    let window = window_sql("o", ia, ib);
    let mut out = CustomersReport { inactive_days, ..Default::default() };
    // A customer is the phone number on the order, else the name.
    let ident = "COALESCE(NULLIF(TRIM(o.customer_phone), ''), NULLIF(TRIM(o.customer_name), ''))";

    // In the period.
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {ident}, MAX(COALESCE(NULLIF(TRIM(o.customer_name), ''), '')), COALESCE(MAX(NULLIF(TRIM(o.customer_phone), '')), ''), \
                        COUNT(*), COALESCE(SUM(o.total_cents), 0), MAX({when}) \
                 FROM orders o WHERE {pred} AND o.status = 'PAID' AND {window} AND {ident} IS NOT NULL GROUP BY 1",
                when = when_sql("o")
            ))
            .map_err(e)?;
        let mut all: Vec<TopCustomer> = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                let ident: String = r.get(0)?;
                let name: String = r.get(1)?;
                let phone: String = r.get(2)?;
                let visits: i64 = r.get(3)?;
                let spent: i64 = r.get(4)?;
                Ok(TopCustomer { name: if name.is_empty() { ident } else { name }, phone, visits, spent_cents: spent, avg_cents: if visits > 0 { spent / visits } else { 0 }, last_visit: r.get(5)? })
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        out.customers_in_period = all.len() as i64;
        let visits: Vec<i64> = all.iter().map(|c| c.visits).collect();
        out.avg_visits = if visits.is_empty() { 0.0 } else { round1(visits.iter().sum::<i64>() as f64 / visits.len() as f64) };
        out.frequency = frequency_buckets(&visits);
        all.sort_by(|a, b| b.spent_cents.cmp(&a.spent_cents).then_with(|| a.name.cmp(&b.name)));
        all.truncate(20);
        out.top = all;
        out.unidentified_orders = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM orders o WHERE {pred} AND o.status = 'PAID' AND {window} AND {ident} IS NULL"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(e)?;
    }

    // Gone quiet: customers on file whose last paid order (any time) is older than N days.
    {
        let (tenant_pred, targs) = match scope {
            Scope::Platform => ("1=1".to_string(), vec![]),
            Scope::Tenant { tenant_id } | Scope::Branch { tenant_id, .. } => ("c.tenant_id = ?1".to_string(), vec![tenant_id.clone()]),
        };
        // The orders' own scope may be a single branch; its argument follows the tenant's.
        let mut a = targs;
        let order_scope = match scope {
            Scope::Branch { branch_id, .. } => {
                a.push(branch_id.clone());
                "o2.tenant_id = c.tenant_id AND o2.branch_id = ?2".to_string()
            }
            _ => "o2.tenant_id = c.tenant_id".to_string(),
        };
        let mut stmt = conn
            .prepare(&format!(
                "SELECT c.name, COALESCE(c.phone, ''), c.last_order_at, COALESCE(c.total_orders, 0), COALESCE(c.total_spent_cents, 0), \
                        (SELECT MAX(COALESCE(o2.closed_at, o2.created_at)) FROM orders o2 WHERE {order_scope} AND o2.status = 'PAID' AND TRIM(o2.customer_phone) = TRIM(c.phone)), \
                        (SELECT COUNT(*) FROM orders o2 WHERE {order_scope} AND o2.status = 'PAID' AND TRIM(o2.customer_phone) = TRIM(c.phone)), \
                        (SELECT COALESCE(SUM(o2.total_cents), 0) FROM orders o2 WHERE {order_scope} AND o2.status = 'PAID' AND TRIM(o2.customer_phone) = TRIM(c.phone)) \
                 FROM customers c WHERE {tenant_pred} AND c.deleted_at IS NULL AND COALESCE(TRIM(c.phone), '') <> ''"
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(a.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, i64>(6)?, r.get::<_, i64>(7)?))
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        let mut list = Vec::new();
        for (name, phone, last_on_file, total_orders, total_spent, last_paid, visits, spent) in rows {
            let last = [last_paid, last_on_file].into_iter().flatten().filter_map(|s| parse_ts(&s).map(|t| (t, s))).max_by_key(|(t, _)| *t);
            let Some((t, raw)) = last else { continue };
            let days = (now - t).num_days();
            if days >= inactive_days {
                list.push(InactiveCustomer { name, phone, last_visit: raw, days_since: days, visits: visits.max(total_orders), spent_cents: spent.max(total_spent) });
            }
        }
        list.sort_by(|a, b| b.spent_cents.cmp(&a.spent_cents).then_with(|| b.days_since.cmp(&a.days_since)));
        list.truncate(200);
        out.inactive = list;
    }

    // Debts by age.
    {
        let (dpred, dargs) = scope_predicate(scope);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, name, COALESCE(phone, ''), COALESCE(balance_cents, 0), last_transaction_at FROM debtors \
                 WHERE {dpred} AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1 AND COALESCE(balance_cents, 0) > 0"
            ))
            .map_err(e)?;
        let debtors = stmt
            .query_map(params_from_iter(dargs.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, Option<String>>(4)?)))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        let mut entries_by: HashMap<String, Vec<(i64, bool, i64)>> = HashMap::new();
        {
            let mut stmt = conn
                .prepare(&format!("SELECT debtor_id, type, amount_cents, created_at FROM debt_entries WHERE {dpred} AND deleted_at IS NULL"))
                .map_err(e)?;
            let rows = stmt
                .query_map(params_from_iter(dargs.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)))
                .map_err(e)?;
            for row in rows.flatten() {
                if let Some(t) = parse_ts(&row.3) {
                    entries_by.entry(row.0).or_default().push((t.timestamp(), row.1 == "DEBT", row.2));
                }
            }
        }
        let mut totals = [0i64; 4];
        let mut counts = [0i64; 4];
        for (id, name, phone, balance, last_tx) in debtors {
            let (mut buckets, mut oldest) = age_buckets(entries_by.get(&id).map(|v| v.as_slice()).unwrap_or(&[]), now.timestamp());
            if buckets.iter().sum::<i64>() == 0 {
                // No entries to age (an old balance): count it from the last transaction.
                let age = last_tx.as_deref().and_then(parse_ts).map(|t| (now - t).num_days().max(0)).unwrap_or(0);
                buckets[bucket_of(age)] = balance;
                oldest = age;
            }
            for i in 0..4 {
                totals[i] += buckets[i];
                if buckets[i] > 0 {
                    counts[i] += 1;
                }
            }
            out.debtors.push(DebtorAge { name, phone, balance_cents: balance, oldest_days: oldest, buckets });
        }
        out.debtors.sort_by(|a, b| b.oldest_days.cmp(&a.oldest_days).then_with(|| b.balance_cents.cmp(&a.balance_cents)));
        out.debt_buckets = DEBT_BUCKET_LABELS.iter().enumerate().map(|(i, l)| DebtBucket { label: l.to_string(), debtors: counts[i], amount_cents: totals[i] }).collect();
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 6. Kitchen and delivery times
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct PrepStats {
    pub count: i64,
    pub avg_minutes: f64,
    pub median_minutes: f64,
    pub max_minutes: f64,
    pub late_count: i64,
    pub late_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LateOrder {
    pub order_id: String,
    pub number: Option<String>,
    pub order_type: String,
    pub created_at: String,
    pub minutes: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct StationPrep {
    pub name: String,
    pub count: i64,
    pub avg_minutes: f64,
    pub late_count: i64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct DeliveryTimes {
    pub count: i64,
    pub avg_minutes: f64,
    pub median_minutes: f64,
    pub max_minutes: f64,
    pub failed: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DriverTime {
    pub name: String,
    pub count: i64,
    pub avg_minutes: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AppOrders {
    pub name: String,
    pub count: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct KitchenDelivery {
    pub prep: PrepStats,
    pub late_orders: Vec<LateOrder>,
    pub stations: Vec<StationPrep>,
    pub delivery: DeliveryTimes,
    pub drivers: Vec<DriverTime>,
    pub apps: Vec<AppOrders>,
}

pub fn kitchen_delivery(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str, late_minutes: i64) -> Result<KitchenDelivery, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let late_minutes = late_minutes.clamp(1, 600);
    let (pred, args, ia, ib) = scoped(scope, "o", start_iso, end_iso);
    let mut out = KitchenDelivery::default();
    out.prep.late_minutes = late_minutes;

    // Preparation: from the order reaching the kitchen (its first status event) to the first READY.
    // Phone pick-ups wait for their hour, so they would only show the waiting; they are left out.
    let mut prep_by_order: HashMap<String, f64> = HashMap::new();
    {
        let created_window = format!("julianday(o.created_at) >= julianday(?{ia}) AND julianday(o.created_at) <= julianday(?{ib})");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT o.id, n.series, n.seq, o.order_type, o.created_at, \
                        (SELECT MIN(e.ts) FROM order_status_event e WHERE e.order_id = o.id AND e.status = 'PENDING'), \
                        (SELECT MIN(e.ts) FROM order_status_event e WHERE e.order_id = o.id AND e.status = 'READY') \
                 FROM orders o LEFT JOIN order_numbers n ON n.order_id = o.id \
                 WHERE {pred} AND o.status IN ('READY', 'SERVED', 'PAID') AND {created_window} \
                   AND NOT EXISTS (SELECT 1 FROM order_pickups pk WHERE pk.order_id = o.id)"
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?))
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        let mut minutes = Vec::new();
        let mut late = Vec::new();
        for (id, series, seq, order_type, created_at, first, ready) in rows {
            let Some(ready) = ready else { continue };
            let start = first.unwrap_or_else(|| created_at.clone());
            let Some(m) = minutes_between(&start, &ready) else { continue };
            if m < 0.0 {
                continue;
            }
            minutes.push(m);
            prep_by_order.insert(id.clone(), m);
            if m > late_minutes as f64 {
                late.push(LateOrder { order_id: id, number: number_label(series, seq), order_type, created_at, minutes: round1(m) });
            }
        }
        let (avg, median, max) = spread(&minutes);
        out.prep = PrepStats { count: minutes.len() as i64, avg_minutes: round1(avg), median_minutes: round1(median), max_minutes: round1(max), late_count: late.len() as i64, late_minutes };
        late.sort_by(|a, b| b.minutes.partial_cmp(&a.minutes).unwrap_or(std::cmp::Ordering::Equal));
        late.truncate(30);
        out.late_orders = late;
    }

    // Per station: the kitchen printers that print chosen categories. An order counts for every
    // station that had an item in it (a station only sees its own dishes, so this is approximate).
    if !prep_by_order.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT oi.order_id, p.name FROM order_items oi \
                 INNER JOIN menu_items mi ON mi.id = oi.menu_item_id \
                 INNER JOIN printer_categories pc ON pc.category_id = mi.category_id \
                 INNER JOIN printers p ON p.id = pc.printer_id \
                 WHERE p.printer_type = 'KITCHEN' AND COALESCE(p.is_active, 1) = 1 AND oi.voided = 0",
            )
            .map_err(e)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        let mut by_station: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for (order_id, station) in rows.flatten() {
            if let Some(m) = prep_by_order.get(&order_id) {
                by_station.entry(station).or_default().push(*m);
            }
        }
        out.stations = by_station
            .into_iter()
            .map(|(name, v)| StationPrep { name, count: v.len() as i64, avg_minutes: round1(spread(&v).0), late_count: v.iter().filter(|m| **m > late_minutes as f64).count() as i64 })
            .collect();
        out.stations.sort_by(|a, b| b.avg_minutes.partial_cmp(&a.avg_minutes).unwrap_or(std::cmp::Ordering::Equal));
    }

    // Delivery: from leaving the shop to the customer's door.
    {
        let delivered_window = format!("julianday(od.delivered_at) >= julianday(?{ia}) AND julianday(od.delivered_at) <= julianday(?{ib})");
        let od_pred = qualify(scope_predicate(scope).0, "od");
        let mut stmt = conn
            .prepare(&format!(
                "SELECT od.out_at, od.delivered_at, COALESCE(d.name, '') FROM order_deliveries od LEFT JOIN delivery_drivers d ON d.id = od.driver_id \
                 WHERE {od_pred} AND od.status = 'DELIVERED' AND od.out_at IS NOT NULL AND od.delivered_at IS NOT NULL AND {delivered_window}"
            ))
            .map_err(e)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
        let mut all = Vec::new();
        let mut by_driver: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        for (out_at, delivered_at, driver) in rows {
            if let Some(m) = minutes_between(&out_at, &delivered_at).filter(|m| *m >= 0.0) {
                all.push(m);
                by_driver.entry(if driver.is_empty() { "بدون سائق".to_string() } else { driver }).or_default().push(m);
            }
        }
        let (avg, median, max) = spread(&all);
        out.delivery = DeliveryTimes { count: all.len() as i64, avg_minutes: round1(avg), median_minutes: round1(median), max_minutes: round1(max), failed: 0 };
        out.drivers = by_driver.into_iter().map(|(name, v)| DriverTime { name, count: v.len() as i64, avg_minutes: round1(spread(&v).0) }).collect();
        out.drivers.sort_by(|a, b| a.avg_minutes.partial_cmp(&b.avg_minutes).unwrap_or(std::cmp::Ordering::Equal));
        let created_window = format!("julianday(o.created_at) >= julianday(?{ia}) AND julianday(o.created_at) <= julianday(?{ib})");
        out.delivery.failed = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM order_deliveries od INNER JOIN orders o ON o.id = od.order_id WHERE {od_pred} AND od.status = 'FAILED' AND {created_window}"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(e)?;
    }

    // Orders per delivery app (paid in the period).
    {
        let window = window_sql("o", ia, ib);
        let mut stmt = conn
            .prepare(&format!(
                "SELECT COALESCE(dp.name, 'تطبيق محذوف'), COUNT(*), COALESCE(SUM(o.total_cents), 0) FROM orders o \
                 LEFT JOIN delivery_platforms dp ON dp.id = o.platform_id \
                 WHERE {pred} AND o.status = 'PAID' AND COALESCE(o.platform_id, '') <> '' AND {window} GROUP BY o.platform_id ORDER BY 3 DESC"
            ))
            .map_err(e)?;
        out.apps = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok(AppOrders { name: r.get(0)?, count: r.get(1)?, amount_cents: r.get(2)? }))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 7. Menu engineering
// ---------------------------------------------------------------------------

/// The classic four boxes: popularity against profit per piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Quadrant {
    /// Popular and profitable: keep, protect, show first.
    Star,
    /// Popular but earns little per piece: raise the price a little or cut its cost.
    Workhorse,
    /// Profitable but few order it: show it better, tell the waiters to suggest it.
    Puzzle,
    /// Neither: rework it or take it off.
    Dog,
    /// No cost price entered, so its profit cannot be judged.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MenuItemStat {
    pub item_id: String,
    pub name: String,
    pub category: String,
    pub quantity: i64,
    pub revenue_cents: i64,
    pub cost_cents: i64,
    pub profit_cents: i64,
    /// Profit per piece sold.
    pub unit_profit_cents: i64,
    pub cost_known: bool,
    pub quadrant: Quadrant,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CategoryProfit {
    pub name: String,
    pub quantity: i64,
    pub revenue_cents: i64,
    pub cost_cents: i64,
    pub profit_cents: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AddonUse {
    pub name: String,
    /// Times it was chosen (pieces of the dishes it came with).
    pub times: i64,
    pub revenue_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MenuEngineering {
    pub items: Vec<MenuItemStat>,
    pub categories: Vec<CategoryProfit>,
    pub addons: Vec<AddonUse>,
    /// An item is popular when its pieces are at least this many (70% of an even share of the menu).
    pub popularity_threshold: f64,
    /// An item is profitable when its profit per piece is at least this (the menu's average per piece).
    pub unit_profit_threshold_cents: i64,
    pub items_without_cost: i64,
}

/// Sorts each item into its box. Popular = at least 70% of an even share of all pieces sold (the
/// usual rule); profitable = profit per piece at or above the average per piece of the items whose
/// cost is known.
pub fn classify(items: &mut [MenuItemStat]) -> (f64, i64) {
    let known: Vec<usize> = (0..items.len()).filter(|&i| items[i].cost_known && items[i].quantity > 0).collect();
    let total_qty: i64 = items.iter().filter(|i| i.quantity > 0).map(|i| i.quantity).sum();
    let n = items.iter().filter(|i| i.quantity > 0).count() as f64;
    let popularity = if n > 0.0 { total_qty as f64 / n * 0.7 } else { 0.0 };
    let known_qty: i64 = known.iter().map(|&i| items[i].quantity).sum();
    let known_profit: i64 = known.iter().map(|&i| items[i].profit_cents).sum();
    let unit_threshold = if known_qty > 0 { known_profit / known_qty } else { 0 };
    for i in items.iter_mut() {
        i.unit_profit_cents = if i.quantity > 0 { i.profit_cents / i.quantity } else { 0 };
        i.quadrant = if !i.cost_known {
            Quadrant::Unknown
        } else {
            let popular = i.quantity as f64 >= popularity;
            let profitable = i.unit_profit_cents >= unit_threshold;
            match (popular, profitable) {
                (true, true) => Quadrant::Star,
                (true, false) => Quadrant::Workhorse,
                (false, true) => Quadrant::Puzzle,
                (false, false) => Quadrant::Dog,
            }
        };
    }
    (popularity, unit_threshold)
}

pub fn menu_engineering(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<MenuEngineering, String> {
    let e = |e: rusqlite::Error| e.to_string();
    let (pred, args, ia, ib) = scoped(scope, "orders", start_iso, end_iso);
    let window = window_sql("orders", ia, ib);
    let mut out = MenuEngineering::default();

    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT order_items.menu_item_id, COALESCE(menu_items.name, '?'), COALESCE(categories.name, ''), COALESCE(SUM(order_items.quantity), 0), \
                        COALESCE(SUM(CASE WHEN COALESCE(order_items.comped, 0) = 0 THEN \
                            (order_items.unit_price_cents + COALESCE((SELECT SUM(m.price_cents) FROM order_modifiers m WHERE m.order_item_id = order_items.id), 0)) * order_items.quantity \
                            ELSE 0 END), 0), \
                        COALESCE(SUM({LINE_COST_SQL}), 0), \
                        MIN(CASE WHEN COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) > 0 THEN 1 ELSE 0 END) \
                 FROM order_items \
                 INNER JOIN orders ON orders.id = order_items.order_id \
                 LEFT JOIN menu_items ON menu_items.id = order_items.menu_item_id \
                 LEFT JOIN categories ON categories.id = menu_items.category_id \
                 WHERE {pred} AND orders.status = 'PAID' AND order_items.voided = 0 AND {window} \
                 GROUP BY order_items.menu_item_id"
            ))
            .map_err(e)?;
        out.items = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                let revenue: i64 = r.get(4)?;
                let cost: i64 = r.get(5)?;
                Ok(MenuItemStat {
                    item_id: r.get(0)?,
                    name: r.get(1)?,
                    category: r.get(2)?,
                    quantity: r.get(3)?,
                    revenue_cents: revenue,
                    cost_cents: cost,
                    profit_cents: revenue - cost,
                    unit_profit_cents: 0,
                    cost_known: r.get::<_, i64>(6)? == 1,
                    quadrant: Quadrant::Unknown,
                })
            })
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
    }
    out.items_without_cost = out.items.iter().filter(|i| !i.cost_known).count() as i64;
    let (pop, unit) = classify(&mut out.items);
    out.popularity_threshold = (pop * 10.0).round() / 10.0;
    out.unit_profit_threshold_cents = unit;
    out.items.sort_by(|a, b| b.quantity.cmp(&a.quantity).then_with(|| a.name.cmp(&b.name)));

    // Category profit, from the same lines.
    {
        let mut by: BTreeMap<String, CategoryProfit> = BTreeMap::new();
        for i in &out.items {
            let name = if i.category.is_empty() { "بدون فئة".to_string() } else { i.category.clone() };
            let c = by.entry(name.clone()).or_insert_with(|| CategoryProfit { name, quantity: 0, revenue_cents: 0, cost_cents: 0, profit_cents: 0 });
            c.quantity += i.quantity;
            c.revenue_cents += i.revenue_cents;
            c.cost_cents += i.cost_cents;
            c.profit_cents += i.profit_cents;
        }
        let mut v: Vec<CategoryProfit> = by.into_values().collect();
        v.sort_by(|a, b| b.profit_cents.cmp(&a.profit_cents).then_with(|| a.name.cmp(&b.name)));
        out.categories = v;
    }

    // Add-ons (option choices): how often each was picked, and what it brought in.
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT order_modifiers.name, COALESCE(SUM(order_items.quantity), 0), COALESCE(SUM(order_modifiers.price_cents * order_items.quantity), 0) \
                 FROM order_modifiers \
                 INNER JOIN order_items ON order_items.id = order_modifiers.order_item_id \
                 INNER JOIN orders ON orders.id = order_items.order_id \
                 WHERE {pred} AND orders.status = 'PAID' AND order_items.voided = 0 AND {window} \
                 GROUP BY order_modifiers.name ORDER BY 2 DESC, 1 LIMIT 100"
            ))
            .map_err(e)?;
        out.addons = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok(AddonUse { name: r.get(0)?, times: r.get(1)?, revenue_cents: r.get(2)? }))
            .map_err(e)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(e)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE dining_areas (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE tables (id TEXT PRIMARY KEY, name TEXT, area_id TEXT);
             CREATE TABLE delivery_platforms (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE delivery_drivers (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE menu_items (id TEXT PRIMARY KEY, name TEXT, category_id TEXT, cost_cents INTEGER DEFAULT 0);
             CREATE TABLE printers (id TEXT PRIMARY KEY, name TEXT, printer_type TEXT, is_active INTEGER DEFAULT 1);
             CREATE TABLE printer_categories (printer_id TEXT, category_id TEXT);
             CREATE TABLE orders (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, table_id TEXT, user_id TEXT, status TEXT, order_type TEXT,
                subtotal_cents INTEGER DEFAULT 0, total_cents INTEGER DEFAULT 0, discount_cents INTEGER DEFAULT 0, discount_reason TEXT, platform_id TEXT,
                customer_name TEXT, customer_phone TEXT, cancel_reason TEXT, created_at TEXT, closed_at TEXT, parent_order_id TEXT, refunded_cents INTEGER DEFAULT 0);
             CREATE TABLE order_numbers (order_id TEXT PRIMARY KEY, series TEXT, seq INTEGER);
             CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, quantity INTEGER, unit_price_cents INTEGER,
                voided INTEGER DEFAULT 0, void_reason TEXT, comped INTEGER DEFAULT 0, unit_cost_cents INTEGER, weight_grams INTEGER);
             CREATE TABLE order_modifiers (id TEXT PRIMARY KEY, order_item_id TEXT, name TEXT, price_cents INTEGER);
             CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT, method TEXT, amount_cents INTEGER, change_cents INTEGER DEFAULT 0, created_at TEXT);
             CREATE TABLE order_status_event (id TEXT PRIMARY KEY, order_id TEXT, status TEXT, ts TEXT);
             CREATE TABLE order_pickups (order_id TEXT PRIMARY KEY);
             CREATE TABLE order_deliveries (order_id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, driver_id TEXT, status TEXT, out_at TEXT, delivered_at TEXT);
             CREATE TABLE audit_log (device_id TEXT, seq INTEGER, id TEXT, ts TEXT, tenant_id TEXT, actor_id TEXT, action TEXT, entity_type TEXT, entity_id TEXT, before_json TEXT, after_json TEXT);
             CREATE TABLE customers (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, phone TEXT, total_orders INTEGER DEFAULT 0, total_spent_cents INTEGER DEFAULT 0, last_order_at TEXT, deleted_at TEXT);
             CREATE TABLE debtors (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, name TEXT, phone TEXT, balance_cents INTEGER, last_transaction_at TEXT, is_active INTEGER DEFAULT 1, deleted_at TEXT);
             CREATE TABLE debt_entries (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, debtor_id TEXT, type TEXT, amount_cents INTEGER, created_at TEXT, deleted_at TEXT);

             INSERT INTO staff VALUES ('u1', 'ليلى'), ('u2', 'عمر'), ('boss', 'المالك');
             INSERT INTO dining_areas VALUES ('a1', 'الصالة'), ('a2', 'التراس');
             INSERT INTO tables VALUES ('t1', 'طاولة 1', 'a1'), ('t2', 'طاولة 2', 'a2'), ('t3', 'طاولة 3', NULL), ('tw', 'سفري', NULL);
             INSERT INTO delivery_platforms VALUES ('p1', 'طلبات');
             INSERT INTO delivery_drivers VALUES ('d1', 'سامر'), ('d2', 'رامي');
             INSERT INTO categories VALUES ('c1', 'وجبات'), ('c2', 'مشروبات');
             INSERT INTO menu_items VALUES ('burger', 'برغر', 'c1', 2000), ('cola', 'كولا', 'c2', 300), ('cake', 'كيك', 'c1', 0), ('soup', 'شوربة', 'c1', 1500), ('tea', 'شاي', 'c2', 100);
             INSERT INTO printers VALUES ('k1', 'المشويات', 'KITCHEN', 1), ('k2', 'البار', 'KITCHEN', 1);
             INSERT INTO printer_categories VALUES ('k1', 'c1'), ('k2', 'c2');

             -- 2026-11-05 (UTC): o1 dine-in t1 10:30 ليلى cash, o2 dine-in t2 14:10 عمر card with a discount, o3 delivery via طلبات 14:50, o4 takeaway 21:45 (23:45 local at +120)
             INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, subtotal_cents, total_cents, discount_cents, discount_reason, platform_id, customer_name, customer_phone, created_at, closed_at) VALUES
              ('o1', 't', 'b', 't1', 'u1', 'PAID', 'DINE_IN', 11000, 11000, 0, NULL, NULL, NULL, NULL, '2026-11-05T10:00:00Z', '2026-11-05T10:30:00Z'),
              ('o2', 't', 'b', 't2', 'u2', 'PAID', 'DINE_IN', 10000, 9000, 1000, 'صديق', NULL, NULL, NULL, '2026-11-05T14:00:00Z', '2026-11-05T14:10:00Z'),
              ('o3', 't', 'b', 'tw', 'u1', 'PAID', 'DELIVERY', 5000, 5000, 0, NULL, 'p1', 'سعاد', '0911', '2026-11-05T14:30:00Z', '2026-11-05T14:50:00Z'),
              ('o4', 't', 'b', 'tw', 'u2', 'PAID', 'TAKEAWAY', 3000, 2500, 500, '', NULL, 'سعاد', '0911', '2026-11-05T21:30:00Z', '2026-11-05T21:45:00Z'),
              ('o5', 't', 'b', 't3', 'u1', 'CANCELLED', 'DINE_IN', 4000, 4000, 0, NULL, NULL, NULL, NULL, '2026-11-05T12:00:00Z', '2026-11-05T12:05:00Z'),
              ('o6', 't', 'b', 't1', 'u1', 'PAID', 'DINE_IN', 700, 700, 0, NULL, NULL, NULL, NULL, '2026-11-04T10:00:00Z', '2026-11-04T10:30:00Z'),
              ('x1', 'other', 'bx', 't1', 'u1', 'PAID', 'DINE_IN', 99999, 99999, 0, NULL, NULL, NULL, NULL, '2026-11-05T10:00:00Z', '2026-11-05T10:30:00Z');
             INSERT INTO order_numbers VALUES ('o1', 'B', 1), ('o2', 'B', 2), ('o3', 'C', 1), ('o4', 'A', 1), ('o5', 'B', 3);
             INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price_cents, voided, void_reason, comped, unit_cost_cents) VALUES
              ('i1', 'o1', 'burger', 2, 4000, 0, NULL, 0, NULL), ('i2', 'o1', 'cola', 3, 1000, 0, NULL, 0, NULL),
              ('i3', 'o2', 'burger', 1, 4000, 0, NULL, 0, NULL), ('i4', 'o2', 'cake', 2, 3000, 0, NULL, 0, NULL), ('i5', 'o2', 'cola', 1, 1000, 1, 'غلط', 0, NULL),
              ('i6', 'o3', 'soup', 1, 5000, 0, NULL, 0, NULL), ('i7', 'o4', 'tea', 3, 1000, 0, NULL, 0, NULL),
              ('i8', 'o5', 'burger', 1, 4000, 1, 'ألغي الطلب', 0, NULL), ('i9', 'o6', 'cola', 1, 700, 0, NULL, 0, NULL);
             INSERT INTO order_modifiers VALUES ('m1', 'i1', 'جبنة زيادة', 500), ('m2', 'i3', 'جبنة زيادة', 500), ('m3', 'i7', 'سكر', 0);
             INSERT INTO payments VALUES ('p1', 'o1', 'CASH', 12000, 1000, '2026-11-05T10:30:00Z'), ('p2', 'o2', 'CARD', 9000, 0, '2026-11-05T14:10:00Z'),
              ('p3', 'o3', 'CARD', 5000, 0, '2026-11-05T14:50:00Z'), ('p4', 'o4', 'CASH', 1500, 0, '2026-11-05T21:45:00Z'), ('p5', 'o4', 'WALLET', 1000, 0, '2026-11-05T21:45:00Z');
             INSERT INTO audit_log VALUES
              ('dev', 1, 'a1', '2026-11-05T12:05:00Z', 't', 'boss', 'OrderStatusChanged', 'order', 'o5', NULL, '{\"action\":\"cancel_order\",\"reason\":\"الزبون غادر\",\"value_cents\":4000}'),
              ('dev', 2, 'a2', '2026-11-05T14:05:00Z', 't', 'u2', 'OrderStatusChanged', 'order_item', 'i5', NULL, '{\"action\":\"void\",\"reason\":\"طلب بالخطأ\"}');",
        )
        .unwrap();
        conn
    }

    fn scope() -> Scope {
        Scope::Branch { tenant_id: "t".into(), branch_id: "b".into() }
    }

    const START: &str = "2026-11-05T00:00:00Z";
    const END: &str = "2026-11-05T23:59:59Z";

    #[test]
    fn hours_run_from_the_start_of_the_business_day_and_follow_the_local_clock() {
        let b = breakdown(&db(), &scope(), "hour", START, END, 120).unwrap();
        let keys: Vec<&str> = b.rows.iter().map(|r| r.key.as_str()).collect();
        // Local time is UTC+2: 12:30, 16:10, 16:50, 23:45.
        assert_eq!(keys, vec!["12", "16", "23"]);
        assert_eq!(b.rows[1].count, 2, "the two paid around 16:xx");
        assert_eq!(b.rows[1].amount_cents, 14_000);
        assert_eq!(b.rows[1].label, "16:00");
        assert_eq!(b.total_count, 4);
        assert_eq!(b.total_cents, 27_500, "11000 + 9000 + 5000 + 2500");
        // After midnight comes after the evening, not first.
        let late = breakdown(&db(), &scope(), "hour", START, END, 240).unwrap();
        assert_eq!(late.rows.last().unwrap().key, "1", "21:45 UTC is 01:45 local: the end of the business day");
    }

    #[test]
    fn tables_and_areas_only_count_dine_in_and_name_the_missing_ones() {
        let t = breakdown(&db(), &scope(), "table", START, END, 0).unwrap();
        assert_eq!(t.rows.len(), 2);
        assert_eq!((t.rows[0].label.as_str(), t.rows[0].amount_cents), ("طاولة 1", 11_000));
        let a = breakdown(&db(), &scope(), "area", START, END, 0).unwrap();
        assert_eq!(a.rows.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), vec!["الصالة", "التراس"]);
    }

    #[test]
    fn cashiers_sources_and_payments() {
        let c = breakdown(&db(), &scope(), "cashier", START, END, 0).unwrap();
        let layla = c.rows.iter().find(|r| r.label == "ليلى").unwrap();
        assert_eq!((layla.count, layla.amount_cents), (2, 16_000));
        let s = breakdown(&db(), &scope(), "source", START, END, 0).unwrap();
        let labels: Vec<&str> = s.rows.iter().map(|r| r.label.as_str()).collect();
        assert!(labels.contains(&"صالة") && labels.contains(&"سفري") && labels.contains(&"طلبات"), "{labels:?}");
        assert!(!labels.contains(&"توصيل (مباشر)"), "the delivery order went through an app");
        let p = breakdown(&db(), &scope(), "payment", START, END, 0).unwrap();
        let cash = p.rows.iter().find(|r| r.key == "CASH").unwrap();
        assert_eq!(cash.amount_cents, 11_000 + 1_500, "handed over minus the change given back");
        assert_eq!(cash.label, "نقداً");
        assert_eq!(p.total_count, 4, "the order paid by cash and wallet counts once");
    }

    #[test]
    fn discounts_by_user_and_by_reason() {
        let u = breakdown(&db(), &scope(), "discount_user", START, END, 0).unwrap();
        assert_eq!(u.total_cents, 1_500);
        assert_eq!(u.rows.iter().find(|r| r.label == "عمر").unwrap().count, 2);
        let r = breakdown(&db(), &scope(), "discount_reason", START, END, 0).unwrap();
        assert_eq!(r.rows.iter().find(|x| x.label == "صديق").unwrap().amount_cents, 1_000);
        assert_eq!(r.rows.iter().find(|x| x.label == "بدون سبب").unwrap().amount_cents, 500);
    }

    #[test]
    fn one_shop_never_sees_another_and_unknown_kinds_are_refused() {
        let b = breakdown(&db(), &scope(), "cashier", START, END, 0).unwrap();
        assert!(b.rows.iter().all(|r| r.amount_cents < 90_000), "the other tenant's 99,999 is not here");
        assert!(breakdown(&db(), &scope(), "nonsense", START, END, 0).is_err());
        for k in BREAKDOWN_KINDS {
            breakdown(&db(), &scope(), k, START, END, 0).unwrap();
        }
    }

    #[test]
    fn drill_down_lists_exactly_the_orders_of_a_row() {
        let conn = db();
        for kind in BREAKDOWN_KINDS {
            let b = breakdown(&conn, &scope(), kind, START, END, 120).unwrap();
            for row in &b.rows {
                let orders = breakdown_orders(&conn, &scope(), kind, &row.key, START, END, 120).unwrap();
                assert_eq!(orders.len() as i64, row.count, "{kind} / {}", row.label);
                if kind != &"payment" && !kind.starts_with("discount") {
                    assert_eq!(orders.iter().map(|o| o.total_cents).sum::<i64>(), row.amount_cents, "{kind} / {}", row.label);
                }
            }
        }
        let by_app = breakdown_orders(&conn, &scope(), "source", "P:p1", START, END, 0).unwrap();
        assert_eq!(by_app.len(), 1);
        assert_eq!(by_app[0].number.as_deref(), Some("C-0001"));
    }

    #[test]
    fn cancellations_say_who_why_and_how_much() {
        let c = cancellations(&db(), &scope(), START, END).unwrap();
        assert_eq!(c.cancelled.len(), 1);
        let o = &c.cancelled[0];
        assert_eq!((o.number.as_deref(), o.who.as_deref(), o.reason.as_deref(), o.value_cents), (Some("B-0003"), Some("المالك"), Some("الزبون غادر"), 4_000));
        assert_eq!(c.voided.len(), 2, "the voided cola and the voided burger of the cancelled order");
        let cola = c.voided.iter().find(|v| v.name == "كولا").unwrap();
        assert_eq!((cola.who.as_deref(), cola.reason.as_deref(), cola.value_cents), (Some("عمر"), Some("طلب بالخطأ"), 1_000));
        let burger = c.voided.iter().find(|v| v.name == "برغر").unwrap();
        assert_eq!((burger.who.as_deref(), burger.reason.as_deref()), (None, Some("ألغي الطلب")), "no audit entry: the order's own reason is kept");
        assert_eq!(c.voided_total_cents, 5_000);
        assert_eq!(c.cancelled_total_cents, 4_000);
    }

    #[test]
    fn debts_age_oldest_first_and_payments_settle_the_oldest() {
        let day = 86_400;
        let now = 200 * day;
        // 100 owed 100 days ago, 50 owed 40 days ago, 30 owed 5 days ago, 70 paid.
        let (b, oldest) = age_buckets(&[(now - 100 * day, true, 100), (now - 40 * day, true, 50), (now - 5 * day, true, 30), (now - 2 * day, false, 70)], now);
        assert_eq!(b, [30, 50, 0, 30], "the 70 paid settles 70 of the 100-day-old debt");
        assert_eq!(oldest, 100);
        let (none, zero) = age_buckets(&[(now - day, true, 10), (now, false, 10)], now);
        assert_eq!((none, zero), ([0; 4], 0));
        assert_eq!(bucket_of(30), 0);
        assert_eq!(bucket_of(31), 1);
        assert_eq!(bucket_of(90), 2);
        assert_eq!(bucket_of(91), 3);
    }

    #[test]
    fn customers_top_inactive_frequency_and_debts() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO customers VALUES ('c1', 't', 'سعاد', '0911', 0, 0, NULL, NULL),
                                          ('c2', 't', 'خالد', '0922', 5, 90000, '2026-09-01T10:00:00Z', NULL),
                                          ('c3', 't', 'قديم', '0933', 1, 1000, '2026-05-01T10:00:00Z', NULL),
                                          ('c4', 't', 'جديد بلا طلبات', '0944', 0, 0, NULL, NULL);
             INSERT INTO debtors VALUES ('d1', 't', 'b', 'أبو علي', '0955', 80, '2026-10-30T10:00:00Z', 1, NULL), ('d2', 't', 'b', 'أم سامر', '0966', 40, '2026-08-01T10:00:00Z', 1, NULL);
             INSERT INTO debt_entries VALUES ('e1', 't', 'b', 'd1', 'DEBT', 100, '2026-10-01T10:00:00Z', NULL), ('e2', 't', 'b', 'd1', 'PAYMENT', 20, '2026-10-20T10:00:00Z', NULL),
                                             ('e3', 't', 'b', 'd2', 'DEBT', 40, '2026-08-01T10:00:00Z', NULL);",
        )
        .unwrap();
        let r = customers_report(&conn, &scope(), START, END, 30, "2026-11-10T00:00:00Z").unwrap();
        assert_eq!(r.top.len(), 1, "only سعاد ordered in the period");
        let s = &r.top[0];
        assert_eq!((s.name.as_str(), s.visits, s.spent_cents, s.avg_cents), ("سعاد", 2, 7_500, 3_750));
        assert_eq!(r.customers_in_period, 1);
        assert_eq!(r.unidentified_orders, 2, "o1 and o2 have no customer");
        assert_eq!(r.frequency[1].customers, 1, "2 - 3 visits");
        let names: Vec<&str> = r.inactive.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["خالد", "قديم"], "most spent first; سعاد came 5 days ago, the new one never ordered");
        assert_eq!(r.inactive[0].days_since, 69, "whole days: 69 days and 14 hours");
        let r7 = customers_report(&conn, &scope(), START, END, 100, "2026-11-10T00:00:00Z").unwrap();
        assert_eq!(r7.inactive.len(), 1, "only the one silent for 100+ days");
        // Debts: d1 owes 80 (100 - 20), all from 40 days ago; d2 owes 40 from 101 days ago.
        assert_eq!(r.debt_buckets.iter().map(|b| b.amount_cents).collect::<Vec<_>>(), vec![0, 80, 0, 40]);
        assert_eq!(r.debtors[0].name, "أم سامر");
        assert_eq!(r.debtors[0].oldest_days, 100, "whole days since 1 August 10:00");
    }

    #[test]
    fn kitchen_prep_late_orders_stations_and_delivery_times() {
        let conn = db();
        conn.execute_batch(
            "INSERT INTO order_status_event VALUES
              ('e1', 'o1', 'PENDING', '2026-11-05T10:00:00Z'), ('e2', 'o1', 'READY', '2026-11-05T10:10:00Z'),
              ('e3', 'o2', 'PENDING', '2026-11-05T14:00:00Z'), ('e4', 'o2', 'READY', '2026-11-05T14:35:00Z'),
              ('e5', 'o3', 'PENDING', '2026-11-05T14:30:00Z'), ('e6', 'o3', 'READY', '2026-11-05T14:40:00Z'),
              ('e7', 'o4', 'PENDING', '2026-11-05T21:30:00Z');
             INSERT INTO order_deliveries VALUES ('o3', 't', 'b', 'd1', 'DELIVERED', '2026-11-05T14:45:00Z', '2026-11-05T15:05:00Z');
             INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, total_cents, platform_id, created_at, closed_at) VALUES
              ('o7', 't', 'b', 'tw', 'u1', 'PAID', 'DELIVERY', 4000, NULL, '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z');
             INSERT INTO order_deliveries VALUES ('o7', 't', 'b', 'd2', 'DELIVERED', '2026-11-05T15:30:00Z', '2026-11-05T15:40:00Z');",
        )
        .unwrap();
        let k = kitchen_delivery(&conn, &scope(), START, END, 20).unwrap();
        assert_eq!(k.prep.count, 3, "o4 never reached READY, o7 has no events");
        assert_eq!(k.prep.late_count, 1);
        assert_eq!(k.late_orders[0].number.as_deref(), Some("B-0002"));
        assert_eq!(k.late_orders[0].minutes, 35.0);
        assert!((k.prep.avg_minutes - 18.3).abs() < 0.05, "{}", k.prep.avg_minutes);
        assert_eq!(k.prep.median_minutes, 10.0);
        assert_eq!(k.prep.max_minutes, 35.0);
        let strict = kitchen_delivery(&conn, &scope(), START, END, 5).unwrap();
        assert_eq!(strict.prep.late_count, 3, "the owner's threshold decides what is late");
        // Stations: c1 (burger, cake, soup) -> المشويات on all three orders; c2 (cola) -> البار on o1 only (o2's cola was voided).
        let grill = k.stations.iter().find(|s| s.name == "المشويات").unwrap();
        assert_eq!(grill.count, 3);
        let bar = k.stations.iter().find(|s| s.name == "البار").unwrap();
        assert_eq!((bar.count, bar.avg_minutes), (1, 10.0));
        assert_eq!(k.delivery.count, 2);
        assert_eq!(k.delivery.avg_minutes, 15.0);
        assert_eq!(k.drivers[0].name, "رامي");
        assert_eq!(k.apps.len(), 1);
        assert_eq!((k.apps[0].name.as_str(), k.apps[0].count), ("طلبات", 1));
    }

    #[test]
    fn spread_handles_empty_odd_and_even_lists() {
        assert_eq!(spread(&[]), (0.0, 0.0, 0.0));
        assert_eq!(spread(&[5.0, 1.0, 3.0]), (3.0, 3.0, 5.0));
        assert_eq!(spread(&[1.0, 2.0, 3.0, 10.0]), (4.0, 2.5, 10.0));
    }

    #[test]
    fn menu_engineering_sorts_items_into_the_four_boxes() {
        let conn = db();
        let m = menu_engineering(&conn, &scope(), START, END).unwrap();
        let get = |n: &str| m.items.iter().find(|i| i.name == n).unwrap();
        // burger: 3 pieces, revenue 2x(4000+500)+1x(4000+500)=13,500, cost 3x2000=6000
        assert_eq!((get("برغر").quantity, get("برغر").revenue_cents, get("برغر").cost_cents), (3, 13_500, 6_000));
        assert_eq!(get("كيك").quadrant, Quadrant::Unknown, "no cost price entered");
        assert_eq!(m.items_without_cost, 1);
        // Everything else is judged against the others'.
        assert_eq!(get("برغر").quadrant, Quadrant::Star);
        assert!(m.popularity_threshold > 0.0);
        assert_eq!(m.categories[0].name, "وجبات");
        let cheese = m.addons.iter().find(|a| a.name == "جبنة زيادة").unwrap();
        assert_eq!((cheese.times, cheese.revenue_cents), (3, 1_500), "2 burgers on o1 + 1 on o2");
    }

    #[test]
    fn classification_boxes_follow_popularity_and_profit_per_piece() {
        let mk = |q: i64, profit: i64| MenuItemStat {
            item_id: String::new(), name: String::new(), category: String::new(), quantity: q, revenue_cents: profit, cost_cents: 0,
            profit_cents: profit, unit_profit_cents: 0, cost_known: true, quadrant: Quadrant::Unknown,
        };
        // 100 sold at 10 each (star), 100 at 2 (workhorse), 5 at 30 (puzzle), 5 at 1 (dog).
        let mut items = vec![mk(100, 1000), mk(100, 200), mk(5, 150), mk(5, 5)];
        let (pop, unit) = classify(&mut items);
        assert!((pop - 36.75).abs() < 1e-9, "{pop}");
        assert_eq!(unit, 6);
        let q: Vec<Quadrant> = items.iter().map(|i| i.quadrant).collect();
        assert_eq!(q, vec![Quadrant::Star, Quadrant::Workhorse, Quadrant::Puzzle, Quadrant::Dog]);
    }

    #[test]
    fn timestamps_parse_in_both_formats() {
        assert!(parse_ts("2026-11-05T10:30:00Z").is_some());
        assert!(parse_ts("2026-11-05T10:30:00.123456+00:00").is_some());
        assert!(parse_ts("2026-11-05 10:30:00").is_some());
        assert!(parse_ts("garbage").is_none());
        assert_eq!(minutes_between("2026-11-05 10:00:00", "2026-11-05T10:20:00Z"), Some(20.0));
    }
}
