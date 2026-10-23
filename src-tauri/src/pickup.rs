//! Phone orders collected later ("سفري — استلام"): the customer calls, the
//! order goes to the kitchen, the customer comes in 20 minutes and pays at
//! the counter. One `order_pickups` row per such order (Migration AF). Plain
//! functions over a `Connection`; `commands/pickup.rs` adds authentication,
//! the manager check and audit.
//!
//! Rules, in one place:
//!  * A pickup is a TAKEAWAY order with the customer's name and a pickup
//!    time. The phone number is optional (asking for it slows the call).
//!  * The pickup time may be up to 10 minutes in the past (the customer is
//!    already standing there) and at most 24 hours ahead.
//!  * The kitchen gets the order right away, unless the pickup is more than
//!    `DEFER_ABOVE_MS` away: then it is held back until `KITCHEN_LEAD_MS`
//!    before the pickup time. `claim_due` hands each order to the kitchen
//!    exactly once, so two tills on one Hub never both print it.
//!  * A customer who arrives early (or pays) sends a held-back order to the
//!    kitchen at once.
//!  * Paying it marks it collected and moves the order into the shift of
//!    whoever took the cash, so the money is counted in the drawer it is in.
//!  * "Never came" cancels the unpaid order, needs a manager and a reason,
//!    and stays on record for the owner (`list_no_shows`).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const KITCHEN_LEAD_MS: i64 = 20 * 60_000;
pub const DEFER_ABOVE_MS: i64 = 30 * 60_000;
pub const EARLIEST_PAST_MS: i64 = 10 * 60_000;
pub const LATEST_AHEAD_MS: i64 = 24 * 60 * 60_000;

/// When the kitchen should get an order picked up at `pickup_at_ms`.
pub fn kitchen_at(now_ms: i64, pickup_at_ms: i64) -> Result<i64, String> {
    if pickup_at_ms < now_ms - EARLIEST_PAST_MS {
        return Err("وقت الاستلام مضى، اختر وقتاً قادماً".to_string());
    }
    if pickup_at_ms > now_ms + LATEST_AHEAD_MS {
        return Err("وقت الاستلام بعيد جداً (أكثر من 24 ساعة)".to_string());
    }
    Ok(if pickup_at_ms - now_ms > DEFER_ABOVE_MS { pickup_at_ms - KITCHEN_LEAD_MS } else { now_ms })
}

/// A pickup needs a name to call out; the phone is optional.
pub fn validate_order(order_type: &str, customer_name: Option<&str>) -> Result<(), String> {
    if order_type != "TAKEAWAY" {
        return Err("وقت الاستلام لطلبات السفري فقط".to_string());
    }
    if customer_name.map(str::trim).unwrap_or("").is_empty() {
        return Err("اكتب اسم الزبون لطلب الاستلام".to_string());
    }
    Ok(())
}

pub fn insert(conn: &Connection, tenant_id: &str, branch_id: &str, order_id: &str, pickup_at_ms: i64, kitchen_at_ms: i64, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO order_pickups (order_id, tenant_id, branch_id, pickup_at_ms, kitchen_at_ms, kitchen_sent, status, created_at_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 'WAITING', ?6)",
        params![order_id, tenant_id, branch_id, pickup_at_ms, kitchen_at_ms, now_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct PickupRow {
    pub order_id: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub pickup_at_ms: i64,
    pub kitchen_at_ms: i64,
    pub kitchen_sent: bool,
    /// The kitchen's progress: PENDING, PREPARING or READY.
    pub kitchen_status: String,
    pub total_cents: i64,
    pub created_at: String,
}

const ROW_SELECT: &str = "SELECT p.order_id, o.customer_name, o.customer_phone, p.pickup_at_ms, p.kitchen_at_ms, p.kitchen_sent, \
     COALESCE(oc.status, 'PENDING'), o.total_cents, o.created_at \
     FROM order_pickups p JOIN orders o ON o.id = p.order_id LEFT JOIN order_current oc ON oc.order_id = p.order_id";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<PickupRow> {
    Ok(PickupRow {
        order_id: r.get(0)?,
        customer_name: r.get(1)?,
        customer_phone: r.get(2)?,
        pickup_at_ms: r.get(3)?,
        kitchen_at_ms: r.get(4)?,
        kitchen_sent: r.get::<_, i64>(5)? != 0,
        kitchen_status: r.get(6)?,
        total_cents: r.get(7)?,
        created_at: r.get(8)?,
    })
}

/// Orders still waiting for their customer, soonest pickup first.
pub fn list_waiting(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<Vec<PickupRow>, String> {
    let sql = format!(
        "{ROW_SELECT} WHERE p.tenant_id = ?1 AND p.branch_id = ?2 AND p.status = 'WAITING' \
         AND o.status NOT IN ('PAID', 'CANCELLED', 'VOIDED') ORDER BY p.pickup_at_ms, p.order_id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![tenant_id, branch_id], map_row).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, tenant_id: &str, order_id: &str) -> Result<Option<PickupRow>, String> {
    let sql = format!("{ROW_SELECT} WHERE p.tenant_id = ?1 AND p.order_id = ?2");
    conn.query_row(&sql, params![tenant_id, order_id], map_row).optional().map_err(|e| e.to_string())
}

/// Hands every due, not-yet-sent order to the kitchen and returns them. Each
/// order is returned by exactly one call ever, whoever asks first.
pub fn claim_due(conn: &Connection, tenant_id: &str, branch_id: &str, now_ms: i64) -> Result<Vec<PickupRow>, String> {
    let mut stmt = conn
        .prepare(
            "UPDATE order_pickups SET kitchen_sent = 1 \
             WHERE tenant_id = ?1 AND branch_id = ?2 AND kitchen_sent = 0 AND status != 'NO_SHOW' AND kitchen_at_ms <= ?3 \
             RETURNING order_id",
        )
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![tenant_id, branch_id, now_ms], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = get(conn, tenant_id, &id)? {
            out.push(row);
        }
    }
    out.sort_by_key(|r| r.pickup_at_ms);
    Ok(out)
}

/// The customer is here: a held-back order goes to the kitchen on the next
/// `claim_due`. No-op once it has been sent.
pub fn send_now(conn: &Connection, tenant_id: &str, order_id: &str, now_ms: i64) -> Result<(), String> {
    let row = get(conn, tenant_id, order_id)?.ok_or_else(not_a_pickup)?;
    if !row.kitchen_sent {
        conn.execute(
            "UPDATE order_pickups SET kitchen_at_ms = MIN(kitchen_at_ms, ?1) WHERE order_id = ?2 AND kitchen_sent = 0",
            params![now_ms, order_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called when the order is paid. Returns `None` for an order that is not a
/// waiting pickup (nothing to do), otherwise the shift the order was taken in
/// before it moved to `payer_shift_id`.
pub fn mark_collected(conn: &Connection, order_id: &str, payer_shift_id: &str, now_ms: i64) -> Result<Option<Option<String>>, String> {
    let changed = conn
        .execute(
            "UPDATE order_pickups SET status = 'COLLECTED', closed_at_ms = ?1, kitchen_at_ms = MIN(kitchen_at_ms, ?1) \
             WHERE order_id = ?2 AND status = 'WAITING'",
            params![now_ms, order_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Ok(None);
    }
    let previous: Option<String> = conn
        .query_row("SELECT shift_id FROM orders WHERE id = ?1", params![order_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE orders SET shift_id = ?1 WHERE id = ?2", params![payer_shift_id, order_id])
        .map_err(|e| e.to_string())?;
    Ok(Some(previous))
}

/// The customer never came. The caller cancels the unpaid order in the same
/// transaction.
pub fn mark_no_show(conn: &Connection, tenant_id: &str, order_id: &str, reason: &str, actor_id: &str, now_ms: i64) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE order_pickups SET status = 'NO_SHOW', closed_at_ms = ?1, no_show_reason = ?2, no_show_by = ?3 \
             WHERE tenant_id = ?4 AND order_id = ?5 AND status = 'WAITING'",
            params![now_ms, reason, actor_id, tenant_id, order_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(not_a_pickup());
    }
    Ok(())
}

fn not_a_pickup() -> String {
    "هذا الطلب ليس طلب استلام بانتظار الزبون".to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct NoShowRow {
    pub order_id: String,
    pub customer_name: Option<String>,
    pub customer_phone: Option<String>,
    pub pickup_at_ms: i64,
    pub closed_at_ms: i64,
    pub reason: Option<String>,
    pub by_name: Option<String>,
    pub total_cents: i64,
}

/// Orders whose customer never came, newest first, closed within [from, to].
pub fn list_no_shows(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, from_ms: i64, to_ms: i64) -> Result<Vec<NoShowRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.order_id, o.customer_name, o.customer_phone, p.pickup_at_ms, p.closed_at_ms, p.no_show_reason, s.name, o.total_cents \
             FROM order_pickups p JOIN orders o ON o.id = p.order_id LEFT JOIN staff s ON s.id = p.no_show_by \
             WHERE p.tenant_id = ?1 AND (?2 IS NULL OR p.branch_id = ?2) AND p.status = 'NO_SHOW' \
             AND p.closed_at_ms BETWEEN ?3 AND ?4 ORDER BY p.closed_at_ms DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, branch_id, from_ms, to_ms], |r| {
            Ok(NoShowRow {
                order_id: r.get(0)?,
                customer_name: r.get(1)?,
                customer_phone: r.get(2)?,
                pickup_at_ms: r.get(3)?,
                closed_at_ms: r.get(4)?,
                reason: r.get(5)?,
                by_name: r.get(6)?,
                total_cents: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const MIN: i64 = 60_000;

    #[test]
    fn a_pickup_within_half_an_hour_goes_to_the_kitchen_now() {
        assert_eq!(kitchen_at(NOW, NOW + 20 * MIN), Ok(NOW));
        assert_eq!(kitchen_at(NOW, NOW + 30 * MIN), Ok(NOW));
        assert_eq!(kitchen_at(NOW, NOW - 5 * MIN), Ok(NOW), "a customer already waiting");
    }

    #[test]
    fn a_later_pickup_reaches_the_kitchen_twenty_minutes_before() {
        assert_eq!(kitchen_at(NOW, NOW + 31 * MIN), Ok(NOW + 11 * MIN));
        assert_eq!(kitchen_at(NOW, NOW + 2 * 60 * MIN), Ok(NOW + 100 * MIN));
    }

    #[test]
    fn a_pickup_time_long_past_or_more_than_a_day_ahead_is_refused() {
        assert!(kitchen_at(NOW, NOW - 11 * MIN).is_err());
        assert!(kitchen_at(NOW, NOW + LATEST_AHEAD_MS + 1).is_err());
        assert!(kitchen_at(NOW, NOW + LATEST_AHEAD_MS).is_ok());
    }

    #[test]
    fn a_pickup_needs_a_takeaway_order_and_a_name_but_no_phone() {
        assert!(validate_order("TAKEAWAY", Some("أحمد")).is_ok());
        assert!(validate_order("TAKEAWAY", Some("   ")).is_err());
        assert!(validate_order("TAKEAWAY", None).is_err());
        assert!(validate_order("DINE_IN", Some("أحمد")).is_err());
        assert!(validate_order("DELIVERY", Some("أحمد")).is_err());
    }
}
