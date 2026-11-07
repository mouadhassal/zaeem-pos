//! The sales report as a long strip for the receipt printer: everything that was sold in a period
//! (every item with its quantity and money), the totals, how the money came in (cash, card...),
//! what went back to customers, and what was cancelled or given away.
//!
//! Same counting rules as `profit.rs` (orders paid in the period by `closed_at`, refunds on the day
//! they were made), so the strip, the dashboard and the finance page agree to the last unit.

use crate::assistant::{qualify, scope_predicate};
use crate::repo::RepoError;
use crate::security::Scope;
use rusqlite::{params_from_iter, Connection};

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct StripItem {
    pub name: String,
    pub category: String,
    /// Pieces, or kilograms for an item sold by weight.
    pub quantity: f64,
    pub by_weight: bool,
    /// What the customers were charged for it (options included, gifts not).
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct StripGroup {
    pub name: String,
    pub count: i64,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct SalesStrip {
    pub order_count: i64,
    pub gross_cents: i64,
    pub refunds_cents: i64,
    pub net_cents: i64,
    pub discounts_cents: i64,
    pub tax_cents: i64,
    pub delivery_fees_cents: i64,
    /// Gifts: lines given on the house, at their value.
    pub gifts_count: i64,
    pub gifts_cents: i64,
    /// Lines cancelled before payment.
    pub cancelled_lines: i64,
    pub cancelled_orders: i64,
    pub items: Vec<StripItem>,
    pub categories: Vec<StripGroup>,
    pub payments: Vec<StripGroup>,
    pub order_types: Vec<StripGroup>,
}

pub fn strip(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str) -> Result<SalesStrip, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let n = args.len();
    let (ia, ib) = (n + 1, n + 2);
    let mut a = args;
    a.push(start_iso.to_string());
    a.push(end_iso.to_string());
    let p_orders = qualify(pred, "orders");
    let window = format!("COALESCE(orders.closed_at, orders.created_at) >= ?{ia} AND COALESCE(orders.closed_at, orders.created_at) <= ?{ib}");
    let mut out = SalesStrip::default();

    // Totals of the orders paid in the period.
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT COUNT(*), COALESCE(SUM(total_cents), 0), COALESCE(SUM(discount_cents), 0), COALESCE(SUM(tax_cents), 0), COALESCE(SUM(delivery_fee_cents), 0) \
             FROM orders WHERE {p_orders} AND status = 'PAID' AND {window}"
        ))?;
        let row = stmt.query_row(params_from_iter(a.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))?;
        out.order_count = row.0;
        out.gross_cents = row.1;
        out.discounts_cents = row.2;
        out.tax_cents = row.3;
        out.delivery_fees_cents = row.4;
    }

    // Refunds on the day the money went back.
    {
        let pred_refunds = pred;
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE {pred_refunds} AND created_at >= ?{ia} AND created_at <= ?{ib}"
        ))?;
        out.refunds_cents = stmt.query_row(params_from_iter(a.iter()), |r| r.get(0))?;
    }
    out.net_cents = out.gross_cents - out.refunds_cents;

    // Every item sold: the quantity and what it was charged. Weighed lines count kilograms.
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(menu_items.name, '?'), COALESCE(categories.name, ''), \
                    COALESCE(SUM(CASE WHEN order_items.weight_grams IS NOT NULL THEN order_items.weight_grams / 1000.0 ELSE order_items.quantity END), 0), \
                    MAX(CASE WHEN order_items.weight_grams IS NOT NULL THEN 1 ELSE 0 END), \
                    COALESCE(SUM(CASE WHEN COALESCE(order_items.comped, 0) = 0 THEN \
                        (order_items.unit_price_cents + COALESCE((SELECT SUM(m.price_cents) FROM order_modifiers m WHERE m.order_item_id = order_items.id), 0)) * order_items.quantity \
                        ELSE 0 END), 0) \
             FROM order_items \
             INNER JOIN orders ON orders.id = order_items.order_id \
             LEFT JOIN menu_items ON menu_items.id = order_items.menu_item_id \
             LEFT JOIN categories ON categories.id = menu_items.category_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 AND {window} \
             GROUP BY order_items.menu_item_id ORDER BY 5 DESC, 1"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| {
            Ok(StripItem { name: r.get(0)?, category: r.get(1)?, quantity: r.get(2)?, by_weight: r.get::<_, i64>(3)? != 0, amount_cents: r.get(4)? })
        })?;
        out.items = rows.collect::<Result<Vec<_>, _>>()?;
    }

    // The same items rolled up by category.
    {
        let mut by: std::collections::BTreeMap<String, StripGroup> = std::collections::BTreeMap::new();
        for i in &out.items {
            let key = if i.category.is_empty() { "بدون فئة".to_string() } else { i.category.clone() };
            let g = by.entry(key.clone()).or_insert_with(|| StripGroup { name: key, ..Default::default() });
            g.count += if i.by_weight { 1 } else { i.quantity.round() as i64 };
            g.amount_cents += i.amount_cents;
        }
        let mut v: Vec<StripGroup> = by.into_values().collect();
        v.sort_by(|x, y| y.amount_cents.cmp(&x.amount_cents).then_with(|| x.name.cmp(&y.name)));
        out.categories = v;
    }

    // How the money came in (what the customer handed over minus the change given back).
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT payments.method, COUNT(*), COALESCE(SUM(payments.amount_cents - COALESCE(payments.change_cents, 0)), 0) \
             FROM payments INNER JOIN orders ON orders.id = payments.order_id \
             WHERE {p_orders} AND orders.status = 'PAID' AND {window} GROUP BY payments.method ORDER BY 3 DESC"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| Ok(StripGroup { name: r.get(0)?, count: r.get(1)?, amount_cents: r.get(2)? }))?;
        out.payments = rows.collect::<Result<Vec<_>, _>>()?;
    }

    // Dine-in, takeaway, delivery.
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT order_type, COUNT(*), COALESCE(SUM(total_cents), 0) FROM orders WHERE {p_orders} AND status = 'PAID' AND {window} GROUP BY order_type ORDER BY 3 DESC"
        ))?;
        let rows = stmt.query_map(params_from_iter(a.iter()), |r| Ok(StripGroup { name: r.get(0)?, count: r.get(1)?, amount_cents: r.get(2)? }))?;
        out.order_types = rows.collect::<Result<Vec<_>, _>>()?;
    }

    // Gifts, and lines cancelled before payment (information: neither is in the totals above).
    {
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(SUM(CASE WHEN COALESCE(order_items.comped, 0) = 1 AND order_items.voided = 0 THEN 1 ELSE 0 END), 0), \
                    COALESCE(SUM(CASE WHEN COALESCE(order_items.comped, 0) = 1 AND order_items.voided = 0 THEN COALESCE(order_items.comp_value_cents, 0) ELSE 0 END), 0), \
                    COALESCE(SUM(CASE WHEN order_items.voided = 1 THEN 1 ELSE 0 END), 0) \
             FROM order_items INNER JOIN orders ON orders.id = order_items.order_id \
             WHERE {p_orders} AND orders.status IN ('PAID', 'CANCELLED') AND {window}"
        ))?;
        let row = stmt.query_row(params_from_iter(a.iter()), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?;
        out.gifts_count = row.0;
        out.gifts_cents = row.1;
        out.cancelled_lines = row.2;
        let mut stmt = conn.prepare(&format!("SELECT COUNT(*) FROM orders WHERE {p_orders} AND status = 'CANCELLED' AND {window}"))?;
        out.cancelled_orders = stmt.query_row(params_from_iter(a.iter()), |r| r.get(0))?;
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE menu_items (id TEXT PRIMARY KEY, name TEXT, category_id TEXT);
             CREATE TABLE orders (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, status TEXT, order_type TEXT, total_cents INTEGER,
                discount_cents INTEGER DEFAULT 0, tax_cents INTEGER DEFAULT 0, delivery_fee_cents INTEGER DEFAULT 0, created_at TEXT, closed_at TEXT);
             CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, quantity INTEGER, unit_price_cents INTEGER,
                voided INTEGER DEFAULT 0, comped INTEGER DEFAULT 0, comp_value_cents INTEGER DEFAULT 0, weight_grams INTEGER);
             CREATE TABLE order_modifiers (id TEXT PRIMARY KEY, order_item_id TEXT, price_cents INTEGER);
             CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT, method TEXT, amount_cents INTEGER, change_cents INTEGER DEFAULT 0);
             CREATE TABLE refunds (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, amount_cents INTEGER, created_at TEXT);
             INSERT INTO categories VALUES ('c1', 'وجبات'), ('c2', 'مشروبات');
             INSERT INTO menu_items VALUES ('burger', 'برغر', 'c1'), ('cola', 'كولا', 'c2'), ('cheese', 'جبنة', 'c1');
             INSERT INTO orders VALUES ('o1', 't1', 'b1', 'PAID', 'DINE_IN', 11000, 0, 0, 0, '2026-11-05T10:00:00Z', '2026-11-05T10:30:00Z');
             INSERT INTO orders VALUES ('o2', 't1', 'b1', 'PAID', 'DELIVERY', 9000, 500, 0, 1000, '2026-11-05T11:00:00Z', '2026-11-05T11:20:00Z');
             INSERT INTO orders VALUES ('o3', 't1', 'b1', 'CANCELLED', 'DINE_IN', 0, 0, 0, 0, '2026-11-05T12:00:00Z', '2026-11-05T12:05:00Z');
             INSERT INTO orders VALUES ('o4', 't1', 'b1', 'PAID', 'DINE_IN', 700, 0, 0, 0, '2026-11-04T10:00:00Z', '2026-11-04T10:30:00Z');
             INSERT INTO orders VALUES ('x1', 't2', 'b9', 'PAID', 'DINE_IN', 99999, 0, 0, 0, '2026-11-05T10:00:00Z', '2026-11-05T10:30:00Z');
             INSERT INTO order_items VALUES ('i1', 'o1', 'burger', 2, 4000, 0, 0, 0, NULL);
             INSERT INTO order_items VALUES ('i2', 'o1', 'cola', 3, 1000, 0, 0, 0, NULL);
             INSERT INTO order_items VALUES ('i3', 'o2', 'burger', 2, 4000, 0, 0, 0, NULL);
             INSERT INTO order_items VALUES ('i4', 'o2', 'cheese', 1, 1500, 0, 0, 0, 750);
             INSERT INTO order_items VALUES ('i5', 'o2', 'cola', 1, 1000, 0, 1, 1000, NULL);
             INSERT INTO order_items VALUES ('i6', 'o2', 'cola', 1, 1000, 1, 0, 0, NULL);
             INSERT INTO order_items VALUES ('i7', 'o3', 'burger', 1, 4000, 1, 0, 0, NULL);
             INSERT INTO order_items VALUES ('i8', 'o4', 'cola', 1, 700, 0, 0, 0, NULL);
             INSERT INTO order_items VALUES ('y1', 'x1', 'burger', 9, 4000, 0, 0, 0, NULL);
             INSERT INTO order_modifiers VALUES ('m1', 'i1', 500);
             INSERT INTO payments VALUES ('p1', 'o1', 'CASH', 12000, 1000);
             INSERT INTO payments VALUES ('p2', 'o2', 'CARD', 9000, 0);
             INSERT INTO refunds VALUES ('r1', 't1', 'b1', 1000, '2026-11-05T15:00:00Z');
             INSERT INTO refunds VALUES ('r0', 't1', 'b1', 777, '2026-11-04T15:00:00Z');",
        )
        .unwrap();
        conn
    }

    fn scope() -> Scope {
        Scope::Branch { tenant_id: "t1".into(), branch_id: "b1".into() }
    }

    #[test]
    fn totals_use_the_paid_orders_of_the_day_and_this_shop_only() {
        let s = strip(&db(), &scope(), "2026-11-05T00:00:00Z", "2026-11-05T23:59:59Z").unwrap();
        assert_eq!(s.order_count, 2, "the cancelled order and yesterday's order are not sales");
        assert_eq!(s.gross_cents, 20_000);
        assert_eq!(s.refunds_cents, 1_000, "only the refund made today");
        assert_eq!(s.net_cents, 19_000);
        assert_eq!(s.discounts_cents, 500);
        assert_eq!(s.delivery_fees_cents, 1_000);
    }

    #[test]
    fn every_item_is_listed_with_quantity_and_money() {
        let s = strip(&db(), &scope(), "2026-11-05T00:00:00Z", "2026-11-05T23:59:59Z").unwrap();
        let burger = s.items.iter().find(|i| i.name == "برغر").unwrap();
        // o1: 2 x (4000 + 500 option) = 9000; o2: 2 x 4000 = 8000.
        assert_eq!((burger.quantity, burger.amount_cents), (4.0, 17_000));
        let cola = s.items.iter().find(|i| i.name == "كولا").unwrap();
        assert_eq!(cola.quantity, 4.0, "3 + the gifted one; the cancelled line is not counted");
        assert_eq!(cola.amount_cents, 3_000, "the gift is not charged");
        let cheese = s.items.iter().find(|i| i.name == "جبنة").unwrap();
        assert!(cheese.by_weight);
        assert!((cheese.quantity - 0.75).abs() < 1e-9, "750 g is 0.75 kg");
        assert_eq!(s.items[0].name, "برغر", "biggest earner first");
        assert!(s.items.iter().all(|i| i.name != "?"), "another shop's items are not mixed in");
    }

    #[test]
    fn payments_categories_types_gifts_and_cancellations() {
        let s = strip(&db(), &scope(), "2026-11-05T00:00:00Z", "2026-11-05T23:59:59Z").unwrap();
        let cash = s.payments.iter().find(|p| p.name == "CASH").unwrap();
        assert_eq!(cash.amount_cents, 11_000, "handed over 12,000 minus 1,000 change");
        assert_eq!(s.payments.iter().map(|p| p.amount_cents).sum::<i64>(), 20_000);
        assert_eq!(s.order_types.iter().find(|t| t.name == "DELIVERY").unwrap().count, 1);
        assert_eq!(s.categories.first().unwrap().name, "وجبات");
        assert_eq!((s.gifts_count, s.gifts_cents), (1, 1_000));
        assert_eq!(s.cancelled_lines, 2, "the voided cola and the voided burger of the cancelled order");
        assert_eq!(s.cancelled_orders, 1);
    }
}
