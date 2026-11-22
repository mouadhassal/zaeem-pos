//! Net sales and the two ways to count profit.
//!
//! One place answers "how much did we sell and how much did we make", so the
//! dashboard, the finance page, the reports and the AI assistant can never
//! disagree again.
//!
//! * **Net sales** = what was sold (orders paid in the period, by `closed_at`)
//!   minus discounts, minus what was refunded in the period (by the refund's
//!   own day), all EXCLUDING tax. Tax collected is the state's money: it has
//!   its own line and is never income or profit. A refund made today lowers
//!   today's sales; a closed past day never changes.
//!
//!   An order stores `total = subtotal + tax - discount + delivery_fee`, so
//!   what the shop earned before tax is `total - tax`, and the sales before
//!   discounts are `total - tax + discount` (items plus delivery fee).
//! * **Margin profit** = net sales minus the cost price of what was sold. It
//!   needs each item's cost price. A refunded dish still cost the food, so the
//!   cost of a refunded line stays in.
//! * **Expense profit** = net sales minus every expense that was entered
//!   (chicken, oil, rent, salaries, ...).
//! * **Net profit** = margin profit minus the *running* expenses only (rent,
//!   salaries, bills). Ingredient purchases are left out here because their
//!   cost is already inside the margin; counting them again would count the
//!   chicken twice.
//!
//! Days are the till's local days: the page sends `tz_offset_minutes`
//! (minutes east of UTC).

use crate::assistant::{modifier, qualify, scope_predicate};
use crate::finance;
use crate::repo::RepoError;
use crate::security::Scope;
use rusqlite::{params_from_iter, Connection};
use std::collections::BTreeMap;

/// Expense categories that are buying food and drink to sell. The cost of what
/// was sold is already in the margin, so these are not counted again in net profit.
pub const FOOD_PURCHASE_CATEGORIES: &[&str] = &["مشتريات مواد", "مشتريات من الموردين"];

/// The category payroll writes its expense under.
pub const SALARY_CATEGORY: &str = "رواتب";

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct DayProfit {
    /// Local calendar day, `YYYY-MM-DD`.
    pub date: String,
    pub order_count: i64,
    /// Sales before discounts and before tax (items plus delivery fee).
    pub gross_sales_cents: i64,
    /// Discounts given on those orders.
    pub discounts_cents: i64,
    /// Money refunded in the period, without the tax part (that is `tax_refunded_cents`).
    pub refunds_cents: i64,
    /// `gross - discounts - refunds`, no tax in it.
    pub net_sales_cents: i64,
    /// Tax (and service charge) collected on the orders paid in the period. Not income.
    pub tax_cents: i64,
    /// The tax part of the refunds made in the period.
    pub tax_refunded_cents: i64,
    /// What the items sold cost us (their cost prices).
    pub cogs_cents: i64,
    pub margin_profit_cents: i64,
    /// Every expense that was entered.
    pub expenses_cents: i64,
    /// The part of the expenses that is buying ingredients.
    pub food_purchases_cents: i64,
    /// Rent, salaries, bills ... everything that is not ingredient buying.
    pub operating_expenses_cents: i64,
    pub salaries_cents: i64,
    /// Net sales minus all expenses.
    pub expense_profit_cents: i64,
    /// Margin profit minus the running expenses.
    pub net_profit_cents: i64,
}

impl DayProfit {
    fn finish(&mut self) {
        self.net_sales_cents = self.gross_sales_cents - self.discounts_cents - self.refunds_cents;
        self.margin_profit_cents = self.net_sales_cents - self.cogs_cents;
        self.operating_expenses_cents = self.expenses_cents - self.food_purchases_cents;
        self.expense_profit_cents = self.net_sales_cents - self.expenses_cents;
        self.net_profit_cents = self.margin_profit_cents - self.operating_expenses_cents;
    }

    fn add(&mut self, o: &DayProfit) {
        self.order_count += o.order_count;
        self.gross_sales_cents += o.gross_sales_cents;
        self.discounts_cents += o.discounts_cents;
        self.refunds_cents += o.refunds_cents;
        self.tax_cents += o.tax_cents;
        self.tax_refunded_cents += o.tax_refunded_cents;
        self.cogs_cents += o.cogs_cents;
        self.expenses_cents += o.expenses_cents;
        self.food_purchases_cents += o.food_purchases_cents;
        self.salaries_cents += o.salaries_cents;
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct ProfitSummary {
    #[serde(flatten)]
    pub totals: DayProfit,
    /// Margin profit as a share of net sales, in basis points (5000 = 50.00%). 0 when nothing was sold.
    pub margin_bp: i64,
    /// Different items sold in the period whose cost price was never entered:
    /// they make the margin look better than it is.
    pub items_without_cost: i64,
}

/// What one order line cost us: the cost recorded when it was sold, else the item's current cost
/// price. Weighed lines: the kilo cost scaled by grams. Needs `order_items` and `menu_items` in the query.
pub(crate) const LINE_COST_SQL: &str = "CASE WHEN order_items.weight_grams IS NOT NULL \
    THEN COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) * order_items.weight_grams / 1000 \
    ELSE COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) * order_items.quantity END";

fn clamp_tz(m: i64) -> i64 {
    m.clamp(-14 * 60, 14 * 60)
}

/// The local calendar day of an ISO instant, e.g. `2026-11-01T22:00:00Z` at +120 is `2026-11-02`.
pub fn local_day(iso: &str, tz_offset_minutes: i64) -> Option<String> {
    let t = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    let shifted = t.with_timezone(&chrono::Utc) + chrono::Duration::minutes(clamp_tz(tz_offset_minutes));
    Some(shifted.format("%Y-%m-%d").to_string())
}

fn food_list_sql() -> String {
    FOOD_PURCHASE_CATEGORIES.iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(", ")
}

fn day_mut(days: &mut BTreeMap<String, DayProfit>, date: String) -> &mut DayProfit {
    days.entry(date.clone()).or_insert_with(|| DayProfit { date, ..Default::default() })
}

/// Profit for each local day in `[start_iso, end_iso]` that has any sale, refund or expense.
pub fn daily(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str, tz_offset_minutes: i64) -> Result<Vec<DayProfit>, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let n = args.len();
    let (ia, ib) = (n + 1, n + 2);
    let mut a = args.clone();
    a.push(start_iso.to_string());
    a.push(end_iso.to_string());
    let off = modifier(tz_offset_minutes);
    let p_orders = qualify(pred, "orders");
    let mut days: BTreeMap<String, DayProfit> = BTreeMap::new();

    // Sales: orders paid in the period, by the day they were paid. `total - tax` is what the shop
    // earned before tax; adding the discount back gives the sales before discounts.
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT date(COALESCE(closed_at, created_at), '{off}'), COUNT(*), \
                    COALESCE(SUM(total_cents - COALESCE(tax_cents, 0) + COALESCE(discount_cents, 0)), 0), \
                    COALESCE(SUM(COALESCE(discount_cents, 0)), 0), COALESCE(SUM(COALESCE(tax_cents, 0)), 0) FROM orders \
             WHERE {pred} AND status = 'PAID' AND COALESCE(closed_at, created_at) >= ?{ia} AND COALESCE(closed_at, created_at) <= ?{ib} \
             GROUP BY 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))?;
        let found = rows.collect::<Result<Vec<_>, _>>()?;
        for (date, count, gross, discounts, tax) in found {
            if let Some(date) = date {
                let d = day_mut(&mut days, date);
                d.order_count += count;
                d.gross_sales_cents += gross;
                d.discounts_cents += discounts;
                d.tax_cents += tax;
            }
        }
    }

    // Refunds: on the day the money went back. A refund hands back tax too, in the order's own
    // proportion, so the tax part is split off: it lowers the tax owed, not the sales.
    {
        let p_refunds = qualify(pred, "refunds");
        let mut stmt = conn.prepare(&format!(
            "SELECT date(refunds.created_at, '{off}'), COALESCE(SUM(refunds.amount_cents), 0), \
                    COALESCE(SUM(CASE WHEN COALESCE(orders.total_cents, 0) > 0 \
                        THEN CAST(ROUND(refunds.amount_cents * 1.0 * COALESCE(orders.tax_cents, 0) / orders.total_cents) AS INTEGER) ELSE 0 END), 0) \
             FROM refunds LEFT JOIN orders ON orders.id = refunds.order_id \
             WHERE {p_refunds} AND refunds.created_at >= ?{ia} AND refunds.created_at <= ?{ib} GROUP BY 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?;
        let found = rows.collect::<Result<Vec<_>, _>>()?;
        for (date, total, tax_part) in found {
            if let Some(date) = date {
                let d = day_mut(&mut days, date);
                d.refunds_cents += total - tax_part;
                d.tax_refunded_cents += tax_part;
            }
        }
    }

    // Cost of what was sold. A line's cost is the one recorded when it was sold,
    // else the item's current cost price. Weighed lines: the kilo cost scaled by grams.
    // Gifts and refunded dishes cost the food too, so they stay in; voided lines were never made.
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT date(COALESCE(orders.closed_at, orders.created_at), '{off}'), \
                    COALESCE(SUM({LINE_COST_SQL}), 0) \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
               AND COALESCE(orders.closed_at, orders.created_at) >= ?{ia} AND COALESCE(orders.closed_at, orders.created_at) <= ?{ib} \
             GROUP BY 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)))?;
        let found = rows.collect::<Result<Vec<_>, _>>()?;
        for (date, total) in found {
            if let Some(date) = date {
                day_mut(&mut days, date).cogs_cents += total;
            }
        }
    }

    // Expenses. Counted on the day they were entered, except a cost that names the month it belongs
    // to (rent for October paid in November): by default that cost is spread over the days of its
    // own month, so it lands in the right period whenever it was paid. The owner can switch to
    // counting by the day the money went out (`finance::CostBasis`).
    {
        let (from_day, to_day) = (local_day(start_iso, tz_offset_minutes), local_day(end_iso, tz_offset_minutes));
        if let (Some(from_day), Some(to_day)) = (from_day, to_day) {
            let basis = finance::cost_basis(conn);
            let (accrued, day) = (basis.accrued_sql(), basis.day_sql());
            let mut ea = args.clone();
            ea.push(from_day.clone());
            ea.push(to_day.clone());
            let food = food_list_sql();
            let mut stmt = conn.prepare(&format!(
                "SELECT {day}, COALESCE(SUM(amount_cents), 0), \
                        COALESCE(SUM(CASE WHEN category IN ({food}) THEN amount_cents ELSE 0 END), 0), \
                        COALESCE(SUM(CASE WHEN category = '{SALARY_CATEGORY}' THEN amount_cents ELSE 0 END), 0) \
                 FROM operational_costs WHERE {pred} AND NOT ({accrued}) AND {day} >= ?{ia} AND {day} <= ?{ib} GROUP BY 1"
            ))?;
            let rows = stmt.query_map(params_from_iter(ea.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))?;
            let found = rows.collect::<Result<Vec<_>, _>>()?;
            for (date, all, food, salaries) in found {
                let d = day_mut(&mut days, date);
                d.expenses_cents += all;
                d.food_purchases_cents += food;
                d.salaries_cents += salaries;
            }

            if basis == finance::CostBasis::Accrual {
                let mut ma = args.clone();
                ma.push(from_day[..7].to_string());
                ma.push(to_day[..7].to_string());
                let mut stmt = conn.prepare(&format!(
                    "SELECT category, amount_cents, accrual_period FROM operational_costs \
                     WHERE {pred} AND ({accrued}) AND accrual_period >= ?{ia} AND accrual_period <= ?{ib}"
                ))?;
                let rows = stmt.query_map(params_from_iter(ma.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
                let found = rows.collect::<Result<Vec<_>, _>>()?;
                for (category, amount, month) in found {
                    for (date, share) in finance::spread_month(amount, &month) {
                        if date < from_day || date > to_day {
                            continue;
                        }
                        let d = day_mut(&mut days, date);
                        d.expenses_cents += share;
                        if FOOD_PURCHASE_CATEGORIES.contains(&category.as_str()) {
                            d.food_purchases_cents += share;
                        }
                        if category == SALARY_CATEGORY {
                            d.salaries_cents += share;
                        }
                    }
                }
            }
        }
    }

    Ok(days
        .into_values()
        .map(|mut d| {
            d.finish();
            d
        })
        .collect())
}

/// The whole period at once, plus how many sold items have no cost price.
pub fn summary(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str, tz_offset_minutes: i64) -> Result<ProfitSummary, RepoError> {
    let mut totals = DayProfit::default();
    for d in daily(conn, scope, start_iso, end_iso, tz_offset_minutes)? {
        totals.add(&d);
    }
    totals.finish();
    let margin_bp = if totals.net_sales_cents > 0 { totals.margin_profit_cents * 10_000 / totals.net_sales_cents } else { 0 };
    let items_without_cost = items_without_cost(conn, scope, start_iso, end_iso)?;
    Ok(ProfitSummary { totals, margin_bp, items_without_cost })
}

/// Different items sold in the period whose cost price is missing (0 or never entered).
pub fn items_without_cost(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<i64, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let (ia, ib) = (args.len() + 1, args.len() + 2);
    let mut a = args;
    a.push(start_iso.to_string());
    a.push(end_iso.to_string());
    let p_orders = qualify(pred, "orders");
    let n: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(DISTINCT order_items.menu_item_id) FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
               AND COALESCE(orders.closed_at, orders.created_at) >= ?{ia} AND COALESCE(orders.closed_at, orders.created_at) <= ?{ib} \
               AND COALESCE(order_items.unit_cost_cents, menu_items.cost_cents, 0) <= 0"
        ),
        params_from_iter(a.iter()),
        |r| r.get(0),
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_day_follows_the_offset() {
        assert_eq!(local_day("2026-11-01T22:00:00.000Z", 120).as_deref(), Some("2026-11-02"));
        assert_eq!(local_day("2026-11-01T22:00:00.000Z", 0).as_deref(), Some("2026-11-01"));
        assert_eq!(local_day("2026-11-02T01:00:00Z", -180).as_deref(), Some("2026-11-01"));
        assert_eq!(local_day("nonsense", 0), None);
    }

    #[test]
    fn finishing_a_day_derives_every_profit_line() {
        let mut d = DayProfit {
            gross_sales_cents: 500,
            refunds_cents: 15,
            cogs_cents: 200,
            expenses_cents: 300,
            food_purchases_cents: 120,
            ..Default::default()
        };
        d.finish();
        assert_eq!(d.net_sales_cents, 485);
        assert_eq!(d.margin_profit_cents, 285);
        assert_eq!(d.operating_expenses_cents, 180);
        assert_eq!(d.expense_profit_cents, 185);
        assert_eq!(d.net_profit_cents, 105);
    }
}
