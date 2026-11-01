//! Items sold by weight ("give me 10,000 of shawarma", "285 g of kibbeh").
//!
//! The catalogue price of a weighed item is the price of ONE KILOGRAM. A
//! weighed order line keeps `quantity = 1` and stores the real price of the
//! portion in `unit_price_cents`, so every total, refund and report that
//! multiplies price by quantity stays correct. What was actually weighed is
//! recorded next to it (`weight_grams`, `price_per_kg_cents`).
//!
//! Two ways to ring one up, and the server accepts both without trusting the
//! client for money:
//! - by weight: the till sends grams, the server prices them;
//! - by amount: the customer says "10,000", the till converts that to grams
//!   (rounded to 1 g) and ALSO sends the amount. The server accepts the amount
//!   only if it is the amount whose nearest gram is the weight sent, so the
//!   customer pays exactly what they asked for and a tampered amount is refused.
//!
//! Integer arithmetic only (i128 inside): no float ever touches money.

use serde::Deserialize;

/// Heaviest single portion a till may ring up: 50 kg.
pub const MAX_GRAMS: i64 = 50_000;

pub const SOLD_BY_UNIT: &str = "unit";
pub const SOLD_BY_WEIGHT: &str = "weight";

/// What the till sends for a weighed line. `price_per_kg_cents` is filled in by
/// the server from the catalogue; whatever the client puts there is ignored.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LineWeight {
    pub grams: i64,
    /// The exact amount the customer asked for, when the cashier typed an amount.
    #[serde(default)]
    pub amount_cents: Option<i64>,
    #[serde(default, skip_deserializing)]
    pub price_per_kg_cents: i64,
    /// Set by the server for a line that is already on the order: it keeps the
    /// weight, rate and price it was sold at even if the menu changed since
    /// (the same rule as a locked option). Never read from the client.
    #[serde(default, skip_deserializing)]
    pub locked: bool,
}

/// Price of `grams` at `price_per_kg_cents` per kilogram, half rounded up.
pub fn price_for_grams(price_per_kg_cents: i64, grams: i64) -> i64 {
    let p = price_per_kg_cents as i128 * grams as i128;
    ((p + 500) / 1000) as i64
}

/// The whole gram that `amount_cents` buys, half rounded up. 0 when the item has no price.
#[cfg(test)]
pub fn grams_for_amount(price_per_kg_cents: i64, amount_cents: i64) -> i64 {
    if price_per_kg_cents <= 0 || amount_cents <= 0 {
        return 0;
    }
    let num = amount_cents as i128 * 1000 * 2 + price_per_kg_cents as i128;
    (num / (2 * price_per_kg_cents as i128)) as i64
}

/// "285 غ" / "1.25 كغ": how a weighed portion reads on a slip or a screen.
/// The till's TypeScript (`src/lib/weight.ts`) formats it the same way.
#[cfg(test)]
pub fn weight_label(grams: i64) -> String {
    if grams < 1000 {
        format!("{grams} غ")
    } else if grams % 1000 == 0 {
        format!("{} كغ", grams / 1000)
    } else {
        let kg = format!("{:.3}", grams as f64 / 1000.0);
        format!("{} كغ", kg.trim_end_matches('0'))
    }
}

/// SQL for " — 285 غ" (or nothing) from an order line's `weight_grams` column,
/// so a query that lists names can show what was weighed.
pub fn weight_suffix_sql(weight_col: &str) -> String {
    format!(
        "COALESCE(CASE WHEN {w} IS NULL THEN '' WHEN {w} < 1000 THEN ' — ' || {w} || ' غ' \
         WHEN {w} % 1000 = 0 THEN ' — ' || ({w} / 1000) || ' كغ' \
         ELSE ' — ' || rtrim(printf('%.3f', {w} / 1000.0), '0') || ' كغ' END, '')",
        w = weight_col
    )
}

/// A checked weighed line: the weight and the price the customer pays for it.
#[derive(Debug, Clone, PartialEq)]
pub struct PricedWeight {
    pub grams: i64,
    pub line_cents: i64,
    pub price_per_kg_cents: i64,
}

/// Validates what the till sent against the catalogue rate and returns the
/// authoritative weight and line price.
pub fn price_line(price_per_kg_cents: i64, quantity: i64, w: &LineWeight) -> Result<PricedWeight, String> {
    if quantity != 1 {
        return Err("a weighed item is one line: use the weight, not the quantity".to_string());
    }
    if w.locked {
        let line_cents = w.amount_cents.filter(|a| *a >= 0).ok_or("a weighed line already on the order lost its price")?;
        return Ok(PricedWeight { grams: w.grams, line_cents, price_per_kg_cents: w.price_per_kg_cents });
    }
    if w.grams <= 0 {
        return Err("the weight must be more than zero".to_string());
    }
    if w.grams > MAX_GRAMS {
        return Err(format!("the weight is too large (maximum {} kg)", MAX_GRAMS / 1000));
    }
    let line_cents = match w.amount_cents {
        None => price_for_grams(price_per_kg_cents, w.grams),
        Some(amount) => {
            if amount <= 0 {
                return Err("the amount must be more than zero".to_string());
            }
            // The amount must be the one whose nearest gram is the weight sent.
            let off = (amount as i128 * 1000 - price_per_kg_cents as i128 * w.grams as i128).abs();
            if off * 2 > price_per_kg_cents as i128 {
                return Err("the amount does not match the weight at this item's price".to_string());
            }
            amount
        }
    };
    Ok(PricedWeight { grams: w.grams, line_cents, price_per_kg_cents })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_weight(grams: i64) -> LineWeight {
        LineWeight { grams, amount_cents: None, price_per_kg_cents: 0, locked: false }
    }

    fn by_amount(grams: i64, amount: i64) -> LineWeight {
        LineWeight { grams, amount_cents: Some(amount), price_per_kg_cents: 0, locked: false }
    }

    #[test]
    fn weights_read_naturally() {
        assert_eq!(weight_label(285), "285 غ");
        assert_eq!(weight_label(1000), "1 كغ");
        assert_eq!(weight_label(1250), "1.25 كغ");
        assert_eq!(weight_label(2005), "2.005 كغ");
    }

    #[test]
    fn the_sql_suffix_matches_the_rust_label() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let sql = format!("SELECT {} FROM (SELECT ?1 AS g)", weight_suffix_sql("g"));
        for g in [285i64, 999, 1000, 1250, 2005, 3000] {
            let s: String = conn.query_row(&sql, [g], |r| r.get(0)).unwrap();
            assert_eq!(s, format!(" — {}", weight_label(g)), "grams {g}");
        }
        let none: String = conn.query_row(&format!("SELECT {} FROM (SELECT NULL AS g)", weight_suffix_sql("g")), [], |r| r.get(0)).unwrap();
        assert_eq!(none, "", "a piece item gets no suffix");
    }

    #[test]
    fn price_for_grams_rounds_half_up() {
        assert_eq!(price_for_grams(120_000, 285), 34_200);
        assert_eq!(price_for_grams(120_000, 1000), 120_000);
        assert_eq!(price_for_grams(100_001, 1), 100); // 100.001 -> 100
        assert_eq!(price_for_grams(500, 1), 1); // 0.5 -> 1
        assert_eq!(price_for_grams(499, 1), 0);
    }

    #[test]
    fn grams_for_amount_rounds_to_nearest_gram() {
        // 10,000 at 120,000/kg = 83.33 g
        assert_eq!(grams_for_amount(120_000, 10_000), 83);
        // 20,000 at 120,000/kg = 166.67 g
        assert_eq!(grams_for_amount(120_000, 20_000), 167);
        assert_eq!(grams_for_amount(120_000, 120_000), 1000);
        assert_eq!(grams_for_amount(0, 10_000), 0);
        assert_eq!(grams_for_amount(120_000, 0), 0);
    }

    #[test]
    fn by_weight_is_priced_by_the_server() {
        let p = price_line(120_000, 1, &by_weight(285)).unwrap();
        assert_eq!(p, PricedWeight { grams: 285, line_cents: 34_200, price_per_kg_cents: 120_000 });
    }

    #[test]
    fn by_amount_charges_exactly_the_amount_asked_for() {
        let grams = grams_for_amount(120_000, 10_000);
        let p = price_line(120_000, 1, &by_amount(grams, 10_000)).unwrap();
        assert_eq!(p.line_cents, 10_000, "the customer asked for 10,000 and pays 10,000, not the gram-rounded 9,960");
        assert_eq!(p.grams, 83);
    }

    #[test]
    fn every_amount_round_trips_through_its_own_gram() {
        for ppk in [1_000, 7_777, 120_000, 333_333, 2_500_000] {
            for amount in [1, 7, 500, 999, 10_000, 34_200, 123_457, 987_654] {
                let g = grams_for_amount(ppk, amount);
                if g == 0 || g > MAX_GRAMS {
                    continue;
                }
                let p = price_line(ppk, 1, &by_amount(g, amount));
                assert!(p.is_ok(), "ppk {ppk} amount {amount} grams {g}: {p:?}");
            }
        }
    }

    #[test]
    fn a_tampered_amount_is_refused() {
        // 83 g at 120,000/kg is about 9,960; claiming 1,000 for it is a lie.
        assert!(price_line(120_000, 1, &by_amount(83, 1_000)).is_err());
        assert!(price_line(120_000, 1, &by_amount(83, 20_000)).is_err());
        assert!(price_line(120_000, 1, &by_amount(83, -5)).is_err());
        assert!(price_line(120_000, 1, &by_amount(83, 0)).is_err());
    }

    #[test]
    fn weight_limits_and_quantity_are_enforced() {
        assert!(price_line(120_000, 1, &by_weight(0)).is_err());
        assert!(price_line(120_000, 1, &by_weight(-5)).is_err());
        assert!(price_line(120_000, 1, &by_weight(MAX_GRAMS + 1)).is_err());
        assert!(price_line(120_000, 1, &by_weight(MAX_GRAMS)).is_ok());
        assert!(price_line(120_000, 2, &by_weight(100)).is_err(), "a weighed line is quantity 1");
        assert!(price_line(120_000, 0, &by_weight(100)).is_err());
    }

    #[test]
    fn huge_values_do_not_overflow() {
        let p = price_line(i64::MAX / 100_000, 1, &by_weight(MAX_GRAMS)).unwrap();
        assert!(p.line_cents > 0);
    }

    #[test]
    fn a_locked_line_keeps_the_price_it_was_sold_at() {
        let w = LineWeight { grams: 83, amount_cents: Some(10_000), price_per_kg_cents: 90_000, locked: true };
        // The menu now says 120,000/kg; the line already on the order does not move.
        let p = price_line(120_000, 1, &w).unwrap();
        assert_eq!(p, PricedWeight { grams: 83, line_cents: 10_000, price_per_kg_cents: 90_000 });
        let bad = LineWeight { amount_cents: None, ..w };
        assert!(price_line(120_000, 1, &bad).is_err());
    }

    #[test]
    fn client_cannot_set_the_catalogue_rate() {
        let w: LineWeight = serde_json::from_str(r#"{"grams":100,"price_per_kg_cents":1,"locked":true}"#).unwrap();
        assert_eq!(w.price_per_kg_cents, 0);
        assert!(!w.locked, "a client cannot lock its own line to skip pricing");
        let w: LineWeight = serde_json::from_str(r#"{"grams":100}"#).unwrap();
        assert_eq!(w.amount_cents, None);
    }
}
