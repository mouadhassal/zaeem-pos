//! 2026-08-02: fully-offline demand forecasting -- no AI vendor call,
//! same philosophy as anomaly.rs (see its module doc). A simple,
//! explainable model beats a sophisticated one nobody on staff can
//! sanity-check: predicted quantity for a menu item on a given future
//! date is just that item's average quantity sold on the same weekday
//! over the last 8 weeks. `LOOKBACK_DAYS` is deliberately a multiple of
//! 7 -- every weekday then occurs in the window exactly `LOOKBACK_WEEKS`
//! times regardless of what day "today" is, so the average's divisor is
//! a constant instead of a second query.
use crate::security::Scope;
use chrono::{Datelike, Duration, Utc};
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::collections::HashMap;

const LOOKBACK_WEEKS: i64 = 8;
const LOOKBACK_DAYS: i64 = LOOKBACK_WEEKS * 7;
const FORECAST_DAYS: i64 = 7;
/// Total quantity sold across the whole lookback window, below which a
/// day-of-week average is noise, not signal (a special/rarely-ordered
/// item shouldn't get a confident-looking forecast off 2 sales).
const MIN_TOTAL_QUANTITY: i64 = 5;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemForecast {
    pub menu_item_id: String,
    pub menu_item_name: String,
    pub date: String,
    pub predicted_quantity: f64,
    pub confidence: Confidence,
    /// How many of the last `LOOKBACK_WEEKS` occurrences of this weekday
    /// actually had a sale -- the number behind the confidence label.
    pub weeks_with_a_sale: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngredientForecast {
    pub ingredient_id: String,
    pub ingredient_name: String,
    pub unit: String,
    /// Total predicted consumption across the whole `FORECAST_DAYS` window.
    pub predicted_consumption: f64,
    pub current_stock: f64,
    pub will_run_short: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DemandForecast {
    pub items: Vec<ItemForecast>,
    /// Only populated for items that already have a `recipes` row -- an
    /// owner who never bothered with recipes/BOM still gets the item
    /// forecast above, just not this tier. No setup required, none
    /// assumed either.
    pub ingredients: Vec<IngredientForecast>,
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

/// `menu_items`/`recipes` are tenant-only (a chain's menu/BOM is shared
/// across branches, per SCHEMA_V3.md §9) -- they have no `branch_id`
/// column at all, so the generic `scope_predicate` above (which emits
/// `AND alias.branch_id = ?` for a Branch scope) would break on them.
fn tenant_only_predicate(scope: &Scope, alias: &str) -> (String, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1".to_string(), vec![]),
        Scope::Tenant { tenant_id } | Scope::Branch { tenant_id, .. } => {
            (format!("{alias}.tenant_id = ?"), vec![tenant_id.clone()])
        }
    }
}

struct DowStats {
    menu_item_id: String,
    menu_item_name: String,
    dow: i64,
    total_qty: i64,
    days_with_sale: i64,
}

pub fn forecast_demand(conn: &Connection, scope: &Scope) -> Result<DemandForecast, rusqlite::Error> {
    let (pred, mut binds) = scope_predicate(scope, "o");
    binds.push(format!("-{LOOKBACK_DAYS} days"));
    let sql = format!(
        "SELECT oi.menu_item_id, mi.name, CAST(strftime('%w', o.created_at) AS INTEGER) as dow, \
                SUM(oi.quantity) as total_qty, COUNT(DISTINCT date(o.created_at)) as days_with_sale \
         FROM order_items oi \
         JOIN orders o ON o.id = oi.order_id \
         JOIN menu_items mi ON mi.id = oi.menu_item_id \
         WHERE oi.voided = 0 AND {pred} AND o.created_at >= datetime('now', ?) \
         GROUP BY oi.menu_item_id, dow"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<DowStats> = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(DowStats {
                menu_item_id: r.get(0)?, menu_item_name: r.get(1)?, dow: r.get(2)?,
                total_qty: r.get(3)?, days_with_sale: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    // menu_item_id -> (name, total qty across ALL weekdays, dow -> (qty, days_with_sale))
    #[allow(clippy::type_complexity)]
    let mut by_item: HashMap<String, (String, i64, HashMap<i64, (i64, i64)>)> = HashMap::new();
    for row in rows {
        let entry = by_item.entry(row.menu_item_id.clone()).or_insert_with(|| (row.menu_item_name.clone(), 0, HashMap::new()));
        entry.1 += row.total_qty;
        entry.2.insert(row.dow, (row.total_qty, row.days_with_sale));
    }

    let today = Utc::now().date_naive();
    let mut items = Vec::new();
    for (menu_item_id, (name, total_qty_all, by_dow)) in &by_item {
        if *total_qty_all < MIN_TOTAL_QUANTITY {
            continue;
        }
        for d in 1..=FORECAST_DAYS {
            let date = today + Duration::days(d);
            // chrono's `num_days_from_sunday` (0=Sunday..6=Saturday) matches
            // SQLite's `strftime('%w', ...)` used in the query above.
            let dow = date.weekday().num_days_from_sunday() as i64;
            let Some(&(qty, days_with_sale)) = by_dow.get(&dow) else { continue };
            if qty == 0 {
                continue;
            }
            let predicted = qty as f64 / LOOKBACK_WEEKS as f64;
            let confidence = if days_with_sale >= 6 {
                Confidence::High
            } else if days_with_sale >= 3 {
                Confidence::Medium
            } else {
                Confidence::Low
            };
            items.push(ItemForecast {
                menu_item_id: menu_item_id.clone(),
                menu_item_name: name.clone(),
                date: date.to_string(),
                predicted_quantity: (predicted * 10.0).round() / 10.0,
                confidence,
                weeks_with_a_sale: days_with_sale,
            });
        }
    }
    items.sort_by(|a, b| a.date.cmp(&b.date).then(b.predicted_quantity.partial_cmp(&a.predicted_quantity).unwrap()));

    let ingredients = forecast_ingredients(conn, scope, &items)?;
    Ok(DemandForecast { items, ingredients })
}

fn forecast_ingredients(conn: &Connection, scope: &Scope, items: &[ItemForecast]) -> Result<Vec<IngredientForecast>, rusqlite::Error> {
    let mut item_totals: HashMap<String, f64> = HashMap::new();
    for it in items {
        *item_totals.entry(it.menu_item_id.clone()).or_insert(0.0) += it.predicted_quantity;
    }
    if item_totals.is_empty() {
        return Ok(vec![]);
    }

    let (recipes_pred, recipes_binds) = tenant_only_predicate(scope, "r");
    let (ing_pred, ing_binds) = scope_predicate(scope, "i");
    let sql = format!(
        "SELECT r.menu_item_id, i.id, i.name, i.unit, r.quantity_needed, i.current_stock \
         FROM recipes r \
         JOIN ingredients i ON i.id = r.ingredient_id \
         WHERE {recipes_pred} AND {ing_pred}"
    );
    let mut binds = recipes_binds;
    binds.extend(ing_binds);
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(String, String, String, String, f64, f64)> = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut by_ingredient: HashMap<String, (String, String, f64, f64)> = HashMap::new();
    for (menu_item_id, ing_id, ing_name, unit, qty_needed, current_stock) in rows {
        let Some(predicted_item_qty) = item_totals.get(&menu_item_id) else { continue };
        let entry = by_ingredient.entry(ing_id).or_insert_with(|| (ing_name, unit, 0.0, current_stock));
        entry.2 += predicted_item_qty * qty_needed;
    }

    let mut out: Vec<IngredientForecast> = by_ingredient
        .into_iter()
        .map(|(ingredient_id, (name, unit, predicted_consumption, current_stock))| IngredientForecast {
            ingredient_id,
            ingredient_name: name,
            unit,
            predicted_consumption: (predicted_consumption * 100.0).round() / 100.0,
            current_stock,
            will_run_short: current_stock < predicted_consumption,
        })
        .collect();
    out.sort_by(|a, b| b.will_run_short.cmp(&a.will_run_short).then(a.ingredient_name.cmp(&b.ingredient_name)));
    Ok(out)
}
