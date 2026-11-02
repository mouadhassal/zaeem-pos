//! The business assistant's data half -- gathers a bounded, real snapshot of
//! this tenant/branch's own numbers for a caller-chosen date range, then hands
//! it to `ai::AiProvider::answer()` alongside the owner's free-text question.
//! Deliberately NOT a multi-step "let the model query the database"
//! tool-calling loop -- one bounded read, one LLM call, same "small,
//! explainable, no surprise cost/latency" philosophy as anomaly.rs/forecast.rs.
//!
//! 2026-11-01 rework (the bot used to know only revenue, 8 top items, a daily
//! trend, staff totals, void count and low-stock *names*):
//!   * Everything is counted by `closed_at` (when the sale was paid). The old
//!     revenue figure used `created_at` while top items / days used
//!     `closed_at`, so one answer could disagree with itself.
//!   * Days and hours are grouped in the till's LOCAL time (the caller sends
//!     its UTC offset); they used to be grouped by UTC date.
//!   * New sections: sales by hour / order type / category, profit per top
//!     item, weighed items in kilos, slow sellers, discounts / gifts / refunds,
//!     operating costs, stock levels, and named comparison periods (today,
//!     yesterday, last 7 days, the 7 before, ...) so "compare with last week"
//!     and "last Thursday" are answerable from one call.
//!   * `build_insights` turns the same numbers into plain rule-based findings
//!     the page can show with no AI call at all.
use crate::repo::RepoError;
use crate::security::Scope;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};

/// A named comparison window the page computes in the user's local time.
#[derive(Debug, Clone, Deserialize)]
pub struct PeriodWindow {
    pub label: String,
    pub start_iso: String,
    pub end_iso: String,
}

#[derive(Debug, Clone, Default)]
pub struct SnapshotContext {
    /// Minutes east of UTC (Damascus in winter = 120).
    pub tz_offset_minutes: i64,
    /// A human line such as "2026-11-01 (الأحد) 14:30" so the model knows what "today" is.
    pub now_local: String,
    pub periods: Vec<PeriodWindow>,
}

/// Most windows a caller may ask for, so a bad client cannot make the till grind.
pub const MAX_PERIODS: usize = 10;

#[derive(Debug, Clone, Serialize)]
pub struct TopItemRow {
    pub name: String,
    pub quantity: i64,
    pub revenue_cents: i64,
    /// What the ingredients/purchase cost. 0 means the owner never entered a cost.
    pub cost_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaySalesRow {
    pub date: String,
    pub total_cents: i64,
    pub order_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HourSalesRow {
    pub hour: i64,
    pub total_cents: i64,
    pub order_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderTypeRow {
    pub order_type: String,
    pub total_cents: i64,
    pub order_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategorySalesRow {
    pub name: String,
    pub quantity: i64,
    pub revenue_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeighedRow {
    pub name: String,
    pub kilograms: f64,
    pub revenue_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostRow {
    pub category: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LowStockRow {
    pub name: String,
    pub current: f64,
    pub minimum: f64,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaffSalesRow {
    pub name: String,
    pub order_count: i64,
    pub total_cents: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PeriodSummary {
    pub label: String,
    pub start_iso: String,
    pub end_iso: String,
    pub order_count: i64,
    pub total_cents: i64,
    pub avg_order_cents: i64,
    pub discount_cents: i64,
    pub refunded_cents: i64,
    pub void_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssistantSnapshot {
    pub now_local: String,
    pub start_iso: String,
    pub end_iso: String,
    pub total_revenue_cents: i64,
    pub order_count: i64,
    pub avg_order_cents: i64,
    pub cash_cents: i64,
    pub card_cents: i64,
    pub wallet_cents: i64,
    pub discount_cents: i64,
    pub refunded_cents: i64,
    pub gift_count: i64,
    pub gift_value_cents: i64,
    /// Ordered by quantity sold, highest first.
    pub top_items: Vec<TopItemRow>,
    /// Active menu items that sold nothing in the range.
    pub slow_items: Vec<String>,
    pub sales_by_category: Vec<CategorySalesRow>,
    pub sales_by_order_type: Vec<OrderTypeRow>,
    /// Local hour of day (0-23) -- when the rush is.
    pub sales_by_hour: Vec<HourSalesRow>,
    /// Ordered by local date, oldest first -- a trend line, not a leaderboard.
    pub sales_by_day: Vec<DaySalesRow>,
    pub weighed_items: Vec<WeighedRow>,
    pub staff_performance: Vec<StaffSalesRow>,
    pub void_count: i64,
    pub void_lost_cents: i64,
    pub operating_costs: Vec<CostRow>,
    pub low_stock: Vec<LowStockRow>,
    /// Named comparison windows (today, yesterday, last 7 days, ...).
    pub periods: Vec<PeriodSummary>,
    /// Net sales, cost of goods, both profit lines and the margin for the main range.
    pub profit: crate::profit::ProfitSummary,
}

pub(crate) fn tenant_of(scope: &Scope) -> Option<&str> {
    match scope {
        Scope::Platform => None,
        Scope::Tenant { tenant_id } | Scope::Branch { tenant_id, .. } => Some(tenant_id),
    }
}

pub(crate) fn scope_predicate(scope: &Scope) -> (&'static str, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1", vec![]),
        Scope::Tenant { tenant_id } => ("tenant_id = ?1", vec![tenant_id.clone()]),
        Scope::Branch { tenant_id, branch_id } => {
            ("tenant_id = ?1 AND branch_id = ?2", vec![tenant_id.clone(), branch_id.clone()])
        }
    }
}

/// Prefixes the scope columns with a table name ("tenant_id" -> "orders.tenant_id").
pub(crate) fn qualify(pred: &str, table: &str) -> String {
    pred.replace("tenant_id", &format!("{table}.tenant_id")).replace("branch_id", &format!("{table}.branch_id"))
}

fn clamp_offset(m: i64) -> i64 {
    m.clamp(-14 * 60, 14 * 60)
}

/// `+120` / `-60` / `+0` -- the SQLite date modifier for a whole-minute shift.
pub(crate) fn modifier(minutes: i64) -> String {
    format!("{:+} minutes", clamp_offset(minutes))
}

/// The snapshot for one range with no comparison periods (tests that only have a range).
#[cfg(test)]
pub fn build_snapshot(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<AssistantSnapshot, RepoError> {
    build_rich_snapshot(conn, scope, start_iso, end_iso, &SnapshotContext::default())
}

pub fn build_rich_snapshot(
    conn: &Connection,
    scope: &Scope,
    start_iso: &str,
    end_iso: &str,
    ctx: &SnapshotContext,
) -> Result<AssistantSnapshot, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let n = args.len();
    let (ia, ib) = (n + 1, n + 2);
    let mut a1 = args.clone();
    a1.push(start_iso.to_string());
    a1.push(end_iso.to_string());
    let off = modifier(ctx.tz_offset_minutes);
    let p_orders = qualify(pred, "orders");
    let p_items = qualify(pred, "order_items");

    // ---- totals (by closed_at, the day the sale was paid) ----
    let (order_count, gross_sales_cents, discount_cents): (i64, i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0), COALESCE(SUM(discount_cents), 0) \
             FROM orders WHERE {pred} AND status = 'PAID' AND closed_at >= ?{ia} AND closed_at <= ?{ib}"
        ),
        params_from_iter(a1.iter()),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    // Refunds count on the day the money went back; sales are net of them.
    let refunded_cents: i64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE {pred} AND created_at >= ?{ia} AND created_at <= ?{ib}"),
        params_from_iter(a1.iter()),
        |r| r.get(0),
    )?;
    let total_revenue_cents = gross_sales_cents - refunded_cents;
    let profit = crate::profit::summary(conn, scope, start_iso, end_iso, ctx.tz_offset_minutes)?;
    let avg_order_cents = if order_count > 0 { total_revenue_cents / order_count } else { 0 };

    let (mut cash_cents, mut card_cents, mut wallet_cents) = (0i64, 0i64, 0i64);
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT payments.method, COALESCE(SUM(payments.amount_cents - COALESCE(payments.change_cents, 0)), 0) FROM payments \
             INNER JOIN orders ON orders.id = payments.order_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib} \
             GROUP BY payments.method"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (method, amount) = row?;
            match method.as_str() {
                "CASH" => cash_cents += amount,
                "CARD" => card_cents += amount,
                "WALLET" => wallet_cents += amount,
                _ => {}
            }
        }
    }

    let (gift_count, gift_value_cents): (i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(order_items.comp_value_cents), 0) FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.comped = 1 AND order_items.voided = 0 \
               AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib}"
        ),
        params_from_iter(a1.iter()),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    // ---- items ----
    // A weighed line is quantity 1 with unit_price = the portion price and its
    // cost is the kilo cost scaled by grams.
    let top_items: Vec<TopItemRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT menu_items.name, SUM(order_items.quantity), \
                    SUM(CASE WHEN order_items.comped = 1 THEN 0 ELSE order_items.unit_price_cents * order_items.quantity END), \
                    SUM(CASE WHEN order_items.weight_grams IS NOT NULL THEN COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) * order_items.weight_grams / 1000 \
                             ELSE COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) * order_items.quantity END) \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
               AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib} \
             GROUP BY menu_items.name ORDER BY 2 DESC LIMIT 10"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok(TopItemRow { name: r.get(0)?, quantity: r.get(1)?, revenue_cents: r.get(2)?, cost_cents: r.get(3)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let slow_items: Vec<String> = match tenant_of(scope) {
        None => vec![],
        Some(tenant) => {
            let mut args = a1.clone();
            args.push(tenant.to_string());
            let it = n + 3;
            let mut stmt = conn.prepare(&format!(
                "SELECT menu_items.name FROM menu_items WHERE menu_items.tenant_id = ?{it} AND menu_items.is_active = 1 \
                 AND menu_items.id NOT IN ( \
                   SELECT order_items.menu_item_id FROM order_items INNER JOIN orders ON orders.id = order_items.order_id \
                   WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
                     AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib}) \
                 ORDER BY menu_items.name LIMIT 10"
            ))?;
            let rows = stmt.query_map(params_from_iter(args.iter()), |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        }
    };

    let sales_by_category: Vec<CategorySalesRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(categories.name, '—'), SUM(order_items.quantity), \
                    SUM(CASE WHEN order_items.comped = 1 THEN 0 ELSE order_items.unit_price_cents * order_items.quantity END) \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             LEFT JOIN categories ON categories.id = menu_items.category_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
               AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib} \
             GROUP BY 1 ORDER BY 3 DESC LIMIT 10"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok(CategorySalesRow { name: r.get(0)?, quantity: r.get(1)?, revenue_cents: r.get(2)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let weighed_items: Vec<WeighedRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT menu_items.name, SUM(order_items.weight_grams) / 1000.0, \
                    SUM(CASE WHEN order_items.comped = 1 THEN 0 ELSE order_items.unit_price_cents * order_items.quantity END) \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 AND order_items.weight_grams IS NOT NULL \
               AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib} \
             GROUP BY menu_items.name ORDER BY 3 DESC LIMIT 8"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok(WeighedRow { name: r.get(0)?, kilograms: r.get(1)?, revenue_cents: r.get(2)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // ---- when / how ----
    let sales_by_day: Vec<DaySalesRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT date(closed_at, '{off}'), COALESCE(SUM(total_cents), 0), COUNT(*) FROM orders \
             WHERE {pred} AND status = 'PAID' AND closed_at >= ?{ia} AND closed_at <= ?{ib} \
             GROUP BY 1 ORDER BY 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (date, total_cents, order_count) = row?;
            if let Some(date) = date {
                out.push(DaySalesRow { date, total_cents, order_count });
            }
        }
        out
    };

    let sales_by_hour: Vec<HourSalesRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT CAST(strftime('%H', closed_at, '{off}') AS INTEGER), COALESCE(SUM(total_cents), 0), COUNT(*) FROM orders \
             WHERE {pred} AND status = 'PAID' AND closed_at >= ?{ia} AND closed_at <= ?{ib} \
             GROUP BY 1 ORDER BY 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (hour, total_cents, order_count) = row?;
            if let Some(hour) = hour {
                out.push(HourSalesRow { hour, total_cents, order_count });
            }
        }
        out
    };

    let sales_by_order_type: Vec<OrderTypeRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT order_type, COALESCE(SUM(total_cents), 0), COUNT(*) FROM orders \
             WHERE {pred} AND status = 'PAID' AND closed_at >= ?{ia} AND closed_at <= ?{ib} \
             GROUP BY order_type ORDER BY 2 DESC"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok(OrderTypeRow { order_type: r.get(0)?, total_cents: r.get(1)?, order_count: r.get(2)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // ---- people ----
    let staff_performance: Vec<StaffSalesRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT staff.name, COUNT(orders.id), COALESCE(SUM(orders.total_cents), 0) FROM orders \
             INNER JOIN staff ON staff.id = orders.user_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib} \
             GROUP BY staff.name ORDER BY 3 DESC LIMIT 15"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| {
            Ok(StaffSalesRow { name: r.get(0)?, order_count: r.get(1)?, total_cents: r.get(2)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // order_items carries tenant_id/branch_id directly, but the date range
    // still goes through orders.closed_at.
    let (void_count, void_lost_cents): (i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(order_items.unit_price_cents * order_items.quantity), 0) \
             FROM order_items INNER JOIN orders ON orders.id = order_items.order_id \
             WHERE {p_items} AND order_items.voided = 1 AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib}"
        ),
        params_from_iter(a1.iter()),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    // ---- money out and stock ----
    // operational_costs.date is a plain date; compare on the date part only.
    let operating_costs: Vec<CostRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT category, COALESCE(SUM(amount_cents), 0) FROM operational_costs \
             WHERE {pred} AND substr(date, 1, 10) >= substr(?{ia}, 1, 10) AND substr(date, 1, 10) <= substr(?{ib}, 1, 10) \
             GROUP BY category ORDER BY 2 DESC LIMIT 10"
        ))?;
        let rows = stmt.query_map(params_from_iter(a1.iter()), |r| Ok(CostRow { category: r.get(0)?, amount_cents: r.get(1)? }))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let low_stock: Vec<LowStockRow> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT name, current_stock, min_stock, unit FROM ingredients \
             WHERE {pred} AND current_stock < min_stock \
             ORDER BY current_stock * 1.0 / MAX(min_stock, 0.000001) LIMIT 15"
        ))?;
        let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
            Ok(LowStockRow { name: r.get(0)?, current: r.get(1)?, minimum: r.get(2)?, unit: r.get(3)? })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    // ---- comparison windows ----
    let mut periods = Vec::new();
    for w in ctx.periods.iter().take(MAX_PERIODS) {
        periods.push(period_summary(conn, scope, &w.label, &w.start_iso, &w.end_iso)?);
    }

    Ok(AssistantSnapshot {
        now_local: ctx.now_local.clone(),
        start_iso: start_iso.to_string(),
        end_iso: end_iso.to_string(),
        total_revenue_cents,
        order_count,
        avg_order_cents,
        cash_cents,
        card_cents,
        wallet_cents,
        discount_cents,
        refunded_cents,
        gift_count,
        gift_value_cents,
        top_items,
        slow_items,
        sales_by_category,
        sales_by_order_type,
        sales_by_hour,
        sales_by_day,
        weighed_items,
        staff_performance,
        void_count,
        void_lost_cents,
        operating_costs,
        low_stock,
        periods,
        profit,
    })
}

pub fn period_summary(conn: &Connection, scope: &Scope, label: &str, start_iso: &str, end_iso: &str) -> Result<PeriodSummary, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let n = args.len();
    let (ia, ib) = (n + 1, n + 2);
    let mut a = args;
    a.push(start_iso.to_string());
    a.push(end_iso.to_string());
    let (order_count, gross_cents, discount_cents): (i64, i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0), COALESCE(SUM(discount_cents), 0) \
             FROM orders WHERE {pred} AND status = 'PAID' AND closed_at >= ?{ia} AND closed_at <= ?{ib}"
        ),
        params_from_iter(a.iter()),
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let refunded_cents: i64 = conn.query_row(
        &format!("SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE {pred} AND created_at >= ?{ia} AND created_at <= ?{ib}"),
        params_from_iter(a.iter()),
        |r| r.get(0),
    )?;
    let total_cents = gross_cents - refunded_cents;
    let p_items = qualify(pred, "order_items");
    let void_count: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM order_items INNER JOIN orders ON orders.id = order_items.order_id \
             WHERE {p_items} AND order_items.voided = 1 AND orders.closed_at >= ?{ia} AND orders.closed_at <= ?{ib}"
        ),
        params_from_iter(a.iter()),
        |r| r.get(0),
    )?;
    Ok(PeriodSummary {
        label: label.to_string(),
        start_iso: start_iso.to_string(),
        end_iso: end_iso.to_string(),
        order_count,
        total_cents,
        avg_order_cents: if order_count > 0 { total_cents / order_count } else { 0 },
        discount_cents,
        refunded_cents,
        void_count,
    })
}

// ---------------------------------------------------------------------------
// Rule-based insights: no AI call, no network -- the page shows these on open.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Insight {
    /// "up" | "down" | "warn" | "info"
    pub kind: String,
    /// What the owner reads.
    pub text: String,
    /// The question to send to the assistant if they tap it.
    pub question: String,
}

fn pct_change(now: i64, before: i64) -> Option<i64> {
    if before <= 0 {
        return None;
    }
    Some((now - before) * 100 / before)
}

fn find<'a>(periods: &'a [PeriodSummary], label: &str) -> Option<&'a PeriodSummary> {
    periods.iter().find(|p| p.label == label)
}

/// Pure so it can be tested without a database. `low_stock_count` is the
/// number of ingredients under their minimum right now.
pub fn insights_from(periods: &[PeriodSummary], low_stock_count: usize) -> Vec<Insight> {
    let mut out = Vec::new();

    if let (Some(w), Some(p)) = (find(periods, "last_7_days"), find(periods, "previous_7_days")) {
        if let Some(c) = pct_change(w.total_cents, p.total_cents) {
            if c >= 15 {
                out.push(Insight { kind: "up".into(), text: format!("المبيعات ارتفعت {c}% عن الأسبوع الذي قبله"), question: "ما سبب ارتفاع المبيعات هذا الأسبوع مقارنة بالأسبوع الماضي؟ وما الأصناف التي ساهمت؟".into() });
            } else if c <= -15 {
                out.push(Insight { kind: "down".into(), text: format!("المبيعات انخفضت {}% عن الأسبوع الذي قبله", -c), question: "لماذا انخفضت المبيعات هذا الأسبوع مقارنة بالأسبوع الماضي؟ وماذا أفعل؟".into() });
            }
        }
        // The share of sales taken back by voids.
        if w.order_count >= 20 {
            let rate = w.void_count * 100 / w.order_count;
            if rate >= 8 {
                out.push(Insight { kind: "warn".into(), text: format!("الإلغاءات مرتفعة: {} إلغاء مقابل {} طلب في آخر 7 أيام", w.void_count, w.order_count), question: "تحليل الإلغاءات في آخر 7 أيام: أي الأصناف والموظفين الأكثر إلغاءً وما الذي يجب أن أراقبه؟".into() });
            }
        }
        if w.total_cents > 0 {
            let leak = (w.discount_cents + w.refunded_cents) * 100 / (w.total_cents + w.discount_cents + w.refunded_cents);
            if leak >= 10 {
                out.push(Insight { kind: "warn".into(), text: format!("الخصومات والمرتجعات تساوي {leak}% من المبيعات في آخر 7 أيام"), question: "الخصومات والمرتجعات مرتفعة هذا الأسبوع؛ حلّل أسبابها وأين أستطيع تقليلها؟".into() });
            }
        }
    }

    if let (Some(t), Some(y)) = (find(periods, "today"), find(periods, "yesterday")) {
        if t.order_count > 0 {
            out.push(Insight {
                kind: "info".into(),
                text: match pct_change(t.total_cents, y.total_cents) {
                    Some(c) if c >= 0 => format!("اليوم حتى الآن: {} طلب، وهو أعلى بـ {c}% من مبيعات أمس كاملةً", t.order_count),
                    Some(c) => format!("اليوم حتى الآن: {} طلب، وهو أقل بـ {}% من مبيعات أمس كاملةً", t.order_count, -c),
                    None => format!("اليوم حتى الآن: {} طلب", t.order_count),
                },
                question: "كيف يسير اليوم مقارنةً بأمس وبنفس اليوم من الأسبوع الماضي؟".into(),
            });
        }
    }

    if low_stock_count > 0 {
        out.push(Insight { kind: "warn".into(), text: format!("{low_stock_count} مادة تحت الحد الأدنى في المخزون"), question: "ما المواد التي أوشكت على النفاد وما الذي يجب أن أشتريه أولاً؟".into() });
    }

    out
}

pub fn build_insights(conn: &Connection, scope: &Scope, ctx: &SnapshotContext) -> Result<Vec<Insight>, RepoError> {
    let mut periods = Vec::new();
    for w in ctx.periods.iter().take(MAX_PERIODS) {
        periods.push(period_summary(conn, scope, &w.label, &w.start_iso, &w.end_iso)?);
    }
    let (pred, args) = scope_predicate(scope);
    let low: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM ingredients WHERE {pred} AND current_stock < min_stock"),
        params_from_iter(args.iter()),
        |r| r.get(0),
    )?;
    Ok(insights_from(&periods, low as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(label: &str, orders: i64, total: i64) -> PeriodSummary {
        PeriodSummary {
            label: label.into(), start_iso: String::new(), end_iso: String::new(), order_count: orders, total_cents: total,
            avg_order_cents: if orders > 0 { total / orders } else { 0 }, discount_cents: 0, refunded_cents: 0, void_count: 0,
        }
    }

    #[test]
    fn a_big_weekly_drop_is_flagged_with_the_percentage() {
        let ins = insights_from(&[p("last_7_days", 100, 70_000), p("previous_7_days", 100, 100_000)], 0);
        assert_eq!(ins.len(), 1);
        assert_eq!(ins[0].kind, "down");
        assert!(ins[0].text.contains("30%"), "{}", ins[0].text);
    }

    #[test]
    fn a_big_weekly_rise_is_flagged() {
        let ins = insights_from(&[p("last_7_days", 100, 130_000), p("previous_7_days", 100, 100_000)], 0);
        assert_eq!(ins[0].kind, "up");
        assert!(ins[0].text.contains("30%"));
    }

    #[test]
    fn a_small_change_and_an_empty_previous_week_say_nothing() {
        assert!(insights_from(&[p("last_7_days", 100, 105_000), p("previous_7_days", 100, 100_000)], 0).is_empty());
        assert!(insights_from(&[p("last_7_days", 100, 105_000), p("previous_7_days", 0, 0)], 0).is_empty());
    }

    #[test]
    fn high_voids_and_leaks_and_low_stock_warn() {
        let mut w = p("last_7_days", 50, 100_000);
        w.void_count = 10;
        w.discount_cents = 20_000;
        let ins = insights_from(&[w, p("previous_7_days", 50, 100_000)], 3);
        let kinds: Vec<_> = ins.iter().map(|i| i.text.as_str()).collect();
        assert!(kinds.iter().any(|t| t.contains("الإلغاءات مرتفعة")), "{kinds:?}");
        assert!(kinds.iter().any(|t| t.contains("الخصومات")), "{kinds:?}");
        assert!(kinds.iter().any(|t| t.contains("3 مادة")), "{kinds:?}");
    }

    #[test]
    fn today_line_compares_with_yesterday() {
        let ins = insights_from(&[p("today", 12, 60_000), p("yesterday", 40, 120_000)], 0);
        assert_eq!(ins.len(), 1);
        assert!(ins[0].text.contains("أقل بـ 50%"), "{}", ins[0].text);
        assert!(insights_from(&[p("today", 0, 0), p("yesterday", 40, 120_000)], 0).is_empty());
    }

    #[test]
    fn the_sql_modifier_is_a_clean_signed_minute_count() {
        assert_eq!(modifier(120), "+120 minutes");
        assert_eq!(modifier(-90), "-90 minutes");
        assert_eq!(modifier(0), "+0 minutes");
        assert_eq!(modifier(99_999), "+840 minutes", "an absurd offset is clamped");
    }
}

// The database-backed behaviour is tested in commands_v3.rs's test module
// (`assistant_snapshot_*`) -- it already has the full migration chain and a
// proven create-order-and-pay helper.
