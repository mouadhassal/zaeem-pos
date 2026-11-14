//! Menu offers, priced by the server: happy hour ("50% off cola, Friday 16:00-18:00") and combo
//! bundles ("burger + fries + cola for 1,000").
//!
//! Until 2026-11-14 both offers existed only in the till's screen. The server re-priced every
//! line at its full menu price (`Repo::price_authoritative_items`), so an order with an offer was
//! stored, reported and charged at the full price: a dine-in tab paid later charged the customer
//! the full price the screen had not shown, a pay-now sale failed with "amount mismatch", and the
//! revenue in the reports did not match the cash. The server now applies the offers itself, with
//! exactly the till's arithmetic (`menuStore.ts` for happy hour, `MenuGridContainer.tsx`
//! `handleAddCombo` for combos: JS doubles and `Math.round`, mirrored with f64 and `round`), so
//! both sides agree to the unit.
//!
//! What stays out of reach of a cashier: the discount is read from the owner's rules, never from
//! the request; a combo price applies only when the lines are exactly the combo's items in the
//! combo's quantities; otherwise the lines keep their full menu price.

use rusqlite::{params, Connection};

/// One happy-hour rule as stored in `happy_hour_rules`.
#[derive(Debug, Clone)]
pub struct HappyHourRule {
    pub menu_item_id: String,
    pub discount_percent: i64,
    /// 0 = Sunday ... 6 = Saturday (JS `Date.getDay()`).
    pub day_of_week: i64,
    /// "HH:MM", both ends included (the till's `time < start || time > end` skips).
    pub start_time: String,
    pub end_time: String,
}

/// The discount in percent that applies to `menu_item_id` at this local weekday and "HH:MM", or 0.
/// The first matching rule wins, as on the till.
pub fn happy_hour_percent(rules: &[HappyHourRule], menu_item_id: &str, weekday_from_sunday: i64, hhmm: &str) -> i64 {
    rules
        .iter()
        .find(|r| r.menu_item_id == menu_item_id && r.day_of_week == weekday_from_sunday && hhmm >= r.start_time.as_str() && hhmm <= r.end_time.as_str())
        .map_or(0, |r| r.discount_percent.clamp(0, 100))
}

/// `Math.round(price * (1 - percent / 100))`.
pub fn happy_hour_price(price_cents: i64, percent: i64) -> i64 {
    if percent <= 0 {
        return price_cents;
    }
    ((price_cents as f64) * (1.0 - (percent as f64) / 100.0)).round() as i64
}

/// One unit of a combo component: `Math.round(price * (bundle / normalTotal))`.
pub fn combo_unit_price(price_cents: i64, bundle_price_cents: i64, normal_total_cents: i64) -> i64 {
    if normal_total_cents <= 0 {
        return price_cents;
    }
    let ratio = (bundle_price_cents as f64) / (normal_total_cents as f64);
    ((price_cents as f64) * ratio).round() as i64
}

/// The combo meal a line belongs to: the till tags every line of one sold combo with
/// `combo-<combo id>-<epoch ms>` (the id itself contains dashes).
pub fn combo_meal_id(line_combo_id: &str) -> Option<&str> {
    let rest = line_combo_id.strip_prefix("combo-")?;
    let (id, stamp) = rest.rsplit_once('-')?;
    if id.is_empty() || stamp.is_empty() || !stamp.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

/// The tenant's active happy-hour rules.
pub fn load_happy_hour_rules(conn: &Connection, tenant_id: &str) -> rusqlite::Result<Vec<HappyHourRule>> {
    let mut stmt = conn.prepare(
        "SELECT menu_item_id, discount_percent, day_of_week, start_time, end_time FROM happy_hour_rules \
         WHERE tenant_id = ?1 AND is_active = 1 ORDER BY day_of_week ASC",
    )?;
    let rows = stmt.query_map(params![tenant_id], |r| {
        Ok(HappyHourRule { menu_item_id: r.get(0)?, discount_percent: r.get(1)?, day_of_week: r.get(2)?, start_time: r.get(3)?, end_time: r.get(4)? })
    })?;
    rows.collect()
}

/// A combo's items as `(menu_item_id, quantity)`.
pub type ComboShape = Vec<(String, i64)>;

/// A combo meal's bundle price and its items, or None if it is not the tenant's.
pub fn load_combo(conn: &Connection, tenant_id: &str, combo_id: &str) -> rusqlite::Result<Option<(i64, ComboShape)>> {
    let bundle: Option<i64> = match conn.query_row(
        "SELECT bundle_price_cents FROM combo_meals WHERE id = ?1 AND tenant_id = ?2",
        params![combo_id, tenant_id],
        |r| r.get(0),
    ) {
        Ok(v) => Some(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(e) => return Err(e),
    };
    let Some(bundle) = bundle else { return Ok(None) };
    let mut stmt = conn.prepare("SELECT menu_item_id, quantity FROM combo_items WHERE combo_id = ?1 AND tenant_id = ?2")?;
    let items = stmt.query_map(params![combo_id, tenant_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some((bundle, items)))
}

/// Whether the lines of one sold combo are exactly the combo: the same items in the same quantities.
pub fn lines_match_combo(lines: &[(String, i64)], combo_items: &[(String, i64)]) -> bool {
    if lines.is_empty() || lines.len() != combo_items.len() {
        return false;
    }
    let mut a: Vec<(String, i64)> = lines.to_vec();
    let mut b: Vec<(String, i64)> = combo_items.to_vec();
    a.sort();
    b.sort();
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(item: &str, pct: i64, day: i64, from: &str, to: &str) -> HappyHourRule {
        HappyHourRule { menu_item_id: item.into(), discount_percent: pct, day_of_week: day, start_time: from.into(), end_time: to.into() }
    }

    #[test]
    fn happy_hour_applies_inside_its_window_only() {
        let rules = vec![rule("cola", 50, 5, "16:00", "18:00")];
        assert_eq!(happy_hour_percent(&rules, "cola", 5, "16:00"), 50);
        assert_eq!(happy_hour_percent(&rules, "cola", 5, "18:00"), 50, "the end minute is included, as on the till");
        assert_eq!(happy_hour_percent(&rules, "cola", 5, "18:01"), 0);
        assert_eq!(happy_hour_percent(&rules, "cola", 5, "15:59"), 0);
        assert_eq!(happy_hour_percent(&rules, "cola", 4, "17:00"), 0, "another weekday");
        assert_eq!(happy_hour_percent(&rules, "burger", 5, "17:00"), 0, "another item");
    }

    #[test]
    fn happy_hour_price_matches_the_tills_rounding() {
        assert_eq!(happy_hour_price(1000, 50), 500);
        assert_eq!(happy_hour_price(45, 10), 41, "Math.round(40.5) = 41");
        assert_eq!(happy_hour_price(333, 33), 223, "Math.round(223.11)");
        assert_eq!(happy_hour_price(1000, 0), 1000);
        assert_eq!(happy_hour_price(1000, 100), 0);
    }

    #[test]
    fn combo_units_are_priced_like_the_till() {
        // burger 500 + fries 200 + cola 300 = 1000 normal, sold for 800.
        let normal = 1000;
        assert_eq!(combo_unit_price(500, 800, normal), 400);
        assert_eq!(combo_unit_price(200, 800, normal), 160);
        assert_eq!(combo_unit_price(300, 800, normal), 240);
        // An awkward ratio: 3 items at 333, bundle 500 -> each Math.round(333 * 0.5005...) = 167.
        assert_eq!(combo_unit_price(333, 500, 999), 167);
    }

    #[test]
    fn combo_id_is_read_from_the_tills_line_tag() {
        assert_eq!(combo_meal_id("combo-0192f3a4-1b2c-7d8e-9f00-112233445566-1731590400000"), Some("0192f3a4-1b2c-7d8e-9f00-112233445566"));
        assert_eq!(combo_meal_id("combo-abc-1"), Some("abc"));
        assert_eq!(combo_meal_id("combo-abc"), None, "no time stamp");
        assert_eq!(combo_meal_id("abc-123"), None);
        assert_eq!(combo_meal_id("combo-abc-12x"), None);
    }

    #[test]
    fn a_combo_price_needs_exactly_the_combos_items() {
        let combo = vec![("burger".to_string(), 1), ("fries".to_string(), 1), ("cola".to_string(), 2)];
        let same = vec![("cola".to_string(), 2), ("burger".to_string(), 1), ("fries".to_string(), 1)];
        assert!(lines_match_combo(&same, &combo));
        let more_cola = vec![("cola".to_string(), 5), ("burger".to_string(), 1), ("fries".to_string(), 1)];
        assert!(!lines_match_combo(&more_cola, &combo), "a cashier cannot raise one line's quantity at the bundle price");
        let missing = vec![("burger".to_string(), 1), ("fries".to_string(), 1)];
        assert!(!lines_match_combo(&missing, &combo));
        assert!(!lines_match_combo(&[], &[]));
    }
}
