//! 2026-08-04: the business assistant's data half -- gathers a bounded,
//! real snapshot of this tenant/branch's own numbers (revenue, top items,
//! a daily trend, staff performance, void activity, low stock) for a
//! caller-chosen date range, then hands it to `ai::AiProvider::answer()`
//! alongside the owner's free-text question. Deliberately NOT a
//! multi-step "let the model query the database" tool-calling loop --
//! one bounded read, one LLM call, same "small, explainable, no surprise
//! cost/latency" philosophy as anomaly.rs/forecast.rs, just with a real
//! AI vendor call instead of a local model for the reasoning step (asking
//! for a *recommendation*, not just a number, genuinely needs judgment a
//! hand-rolled rule can't give).
use crate::repo::{Repo, RepoError};
use crate::security::Scope;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TopItemRow {
    pub name: String,
    pub quantity: i64,
    pub revenue_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaySalesRow {
    pub date: String,
    pub total_cents: i64,
    pub order_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaffSalesRow {
    pub name: String,
    pub order_count: i64,
    pub total_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssistantSnapshot {
    pub start_iso: String,
    pub end_iso: String,
    pub total_revenue_cents: i64,
    pub order_count: i64,
    pub avg_order_cents: i64,
    pub cash_cents: i64,
    pub card_cents: i64,
    pub wallet_cents: i64,
    /// Ordered by quantity sold, highest first.
    pub top_items: Vec<TopItemRow>,
    /// Ordered by date, oldest first -- a trend line, not a leaderboard.
    pub sales_by_day: Vec<DaySalesRow>,
    pub staff_performance: Vec<StaffSalesRow>,
    pub void_count: i64,
    pub void_lost_cents: i64,
    pub low_stock_items: Vec<String>,
}

pub fn build_snapshot(
    conn: &Connection,
    scope: &Scope,
    start_iso: &str,
    end_iso: &str,
) -> Result<AssistantSnapshot, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let mut a1 = args.clone();
    a1.push(start_iso.to_string());
    a1.push(end_iso.to_string());

    // Reuses the same, already-tested revenue/payment-method logic every
    // other report reads from -- no separate copy of that query to drift
    // out of sync with it.
    let revenue = Repo::new(conn).finance_revenue_summary(scope, start_iso, end_iso)?;
    let order_count = revenue.order_count;
    let total_revenue_cents = revenue.total;
    let avg_order_cents = if order_count > 0 { total_revenue_cents / order_count } else { 0 };
    let (cash_cents, card_cents, wallet_cents) = (revenue.cash, revenue.card, revenue.wallet);

    // Date-ranged top items -- distinct from Repo::sales_report's
    // top_items, which is deliberately all-time (matches the reports
    // page). A question like "what sold best this week" needs the range
    // actually respected.
    let pred_items = pred.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
    let sql_items = format!(
        "SELECT menu_items.name, SUM(order_items.quantity), SUM(order_items.unit_price_cents * order_items.quantity) \
         FROM order_items \
         INNER JOIN orders ON orders.id = order_items.order_id \
         INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
         WHERE {pred_items} AND orders.status = 'PAID' AND order_items.voided = 0 \
           AND orders.closed_at >= ?{a} AND orders.closed_at <= ?{b} \
         GROUP BY menu_items.name ORDER BY 2 DESC LIMIT 8",
        a = args.len() + 1, b = args.len() + 2,
    );
    let mut stmt = conn.prepare(&sql_items)?;
    let top_items: Vec<TopItemRow> = stmt
        .query_map(params_from_iter(a1.iter()), |r| {
            Ok(TopItemRow { name: r.get(0)?, quantity: r.get(1)?, revenue_cents: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let sql_days = format!(
        "SELECT date(closed_at), COALESCE(SUM(total_cents), 0), COUNT(*) FROM orders \
         WHERE {pred} AND status = 'PAID' AND closed_at >= ?{a} AND closed_at <= ?{b} \
         GROUP BY date(closed_at) ORDER BY 1",
        a = args.len() + 1, b = args.len() + 2,
    );
    let mut stmt = conn.prepare(&sql_days)?;
    let sales_by_day: Vec<DaySalesRow> = stmt
        .query_map(params_from_iter(a1.iter()), |r| {
            Ok(DaySalesRow { date: r.get(0)?, total_cents: r.get(1)?, order_count: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let pred_staff = pred.replace("tenant_id", "orders.tenant_id").replace("branch_id", "orders.branch_id");
    let sql_staff = format!(
        "SELECT staff.name, COUNT(orders.id), COALESCE(SUM(orders.total_cents), 0) FROM orders \
         INNER JOIN staff ON staff.id = orders.user_id \
         WHERE {pred_staff} AND orders.status = 'PAID' AND orders.closed_at >= ?{a} AND orders.closed_at <= ?{b} \
         GROUP BY staff.name ORDER BY 3 DESC",
        a = args.len() + 1, b = args.len() + 2,
    );
    let mut stmt = conn.prepare(&sql_staff)?;
    let staff_performance: Vec<StaffSalesRow> = stmt
        .query_map(params_from_iter(a1.iter()), |r| {
            Ok(StaffSalesRow { name: r.get(0)?, order_count: r.get(1)?, total_cents: r.get(2)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // order_items already carries tenant_id/branch_id directly -- no join
    // back to orders needed for scoping, but the date range still has to
    // go through orders.closed_at (order_items has no timestamp of its
    // own that means "when this sale happened").
    let pred_void = pred.replace("tenant_id", "order_items.tenant_id").replace("branch_id", "order_items.branch_id");
    let sql_void = format!(
        "SELECT COUNT(*), COALESCE(SUM(order_items.unit_price_cents * order_items.quantity), 0) \
         FROM order_items INNER JOIN orders ON orders.id = order_items.order_id \
         WHERE {pred_void} AND order_items.voided = 1 \
           AND orders.closed_at >= ?{a} AND orders.closed_at <= ?{b}",
        a = args.len() + 1, b = args.len() + 2,
    );
    let (void_count, void_lost_cents): (i64, i64) =
        conn.query_row(&sql_void, params_from_iter(a1.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;

    let sql_stock = format!("SELECT name FROM ingredients WHERE {pred} AND current_stock < min_stock LIMIT 15");
    let mut stmt = conn.prepare(&sql_stock)?;
    let low_stock_items: Vec<String> = stmt
        .query_map(params_from_iter(args.iter()), |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AssistantSnapshot {
        start_iso: start_iso.to_string(),
        end_iso: end_iso.to_string(),
        total_revenue_cents,
        order_count,
        avg_order_cents,
        cash_cents,
        card_cents,
        wallet_cents,
        top_items,
        sales_by_day,
        staff_performance,
        void_count,
        void_lost_cents,
        low_stock_items,
    })
}

fn scope_predicate(scope: &Scope) -> (&'static str, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1", vec![]),
        Scope::Tenant { tenant_id } => ("tenant_id = ?1", vec![tenant_id.clone()]),
        Scope::Branch { tenant_id, branch_id } => {
            ("tenant_id = ?1 AND branch_id = ?2", vec![tenant_id.clone(), branch_id.clone()])
        }
    }
}

// Tests live in commands_v3.rs's test module (see
// `assistant_snapshot_reflects_a_real_paid_order`) -- that module already
// has the full migration chain + a proven create-order-and-pay helper;
// duplicating a second, hand-rolled schema setup here risks drifting from
// the real one instead of exercising it.
