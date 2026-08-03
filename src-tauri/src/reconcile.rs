//! 2026-08-02: payment-reconciliation safety net. Every order write that
//! matters (order creation, `finalize_order_with_payment`, `take_payment`)
//! already runs inside one atomic SQLite transaction -- see
//! `finalize_order_with_payment_v3_impl`'s doc comment -- so a mid-write
//! crash can't leave a torn, half-written row. The real gap is a step
//! never being reached at all: an order gets created (a real, committed
//! row) and then the workflow that would finalize it never runs again --
//! app crash, network drop, cashier walking away mid-checkout, whatever.
//! That order just sits there, open, easy to miss during a busy shift.
//! This is a read-only report (no automatic action ever taken on an
//! order) surfaced on-demand to a manager, who decides what actually
//! happened to it.
use crate::security::Scope;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

/// An order open this long with no terminal status is worth a manager's
/// attention -- long enough that it's very unlikely to just be "still
/// being worked on" (a dine-in table open 6 hours is not normal service,
/// a delivery order open 6 hours was not still cooking).
const STALE_THRESHOLD_HOURS: i64 = 6;

#[derive(Debug, Clone, Serialize)]
pub struct UnreconciledOrder {
    pub order_id: String,
    pub table_name: String,
    pub status: String,
    pub total_cents: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReconciliationReport {
    /// Orders stuck in a non-terminal status for longer than
    /// `STALE_THRESHOLD_HOURS` -- most likely an abandoned/crashed
    /// checkout that never got finalized either way (paid or cancelled).
    pub stale_open_orders: Vec<UnreconciledOrder>,
    /// Should be structurally impossible (status flips to PAID in the
    /// same transaction as the payment insert) -- kept as a zero-cost
    /// integrity assertion, the same one `migrate.rs`'s own migration
    /// test already runs once at migration time, just live and ongoing.
    pub paid_orders_missing_payment: Vec<UnreconciledOrder>,
}

fn scope_predicate(scope: &Scope, alias: &str) -> (String, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1".to_string(), vec![]),
        Scope::Tenant { tenant_id } => (format!("{alias}.tenant_id = ?"), vec![tenant_id.clone()]),
        Scope::Branch { tenant_id, branch_id } => {
            (format!("{alias}.tenant_id = ? AND {alias}.branch_id = ?"), vec![tenant_id.clone(), branch_id.clone()])
        }
    }
}

pub fn reconcile(conn: &Connection, scope: &Scope) -> Result<ReconciliationReport, rusqlite::Error> {
    Ok(ReconciliationReport {
        stale_open_orders: stale_open_orders(conn, scope)?,
        paid_orders_missing_payment: paid_orders_missing_payment(conn, scope)?,
    })
}

fn stale_open_orders(conn: &Connection, scope: &Scope) -> Result<Vec<UnreconciledOrder>, rusqlite::Error> {
    let (pred, mut binds) = scope_predicate(scope, "o");
    binds.push(format!("-{STALE_THRESHOLD_HOURS} hours"));
    let sql = format!(
        "SELECT o.id, t.name, o.status, o.total_cents, o.created_at \
         FROM orders o \
         JOIN tables t ON t.id = o.table_id \
         WHERE {pred} AND o.status NOT IN ('PAID', 'CANCELLED', 'VOIDED') \
               AND o.created_at <= datetime('now', ?) \
         ORDER BY o.created_at ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(UnreconciledOrder {
                order_id: r.get(0)?, table_name: r.get(1)?, status: r.get(2)?,
                total_cents: r.get(3)?, created_at: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn paid_orders_missing_payment(conn: &Connection, scope: &Scope) -> Result<Vec<UnreconciledOrder>, rusqlite::Error> {
    let (pred, binds) = scope_predicate(scope, "o");
    let sql = format!(
        "SELECT o.id, t.name, o.status, o.total_cents, o.created_at \
         FROM orders o \
         JOIN tables t ON t.id = o.table_id \
         WHERE {pred} AND o.status = 'PAID' \
               AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id) \
         ORDER BY o.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(UnreconciledOrder {
                order_id: r.get(0)?, table_name: r.get(1)?, status: r.get(2)?,
                total_cents: r.get(3)?, created_at: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
