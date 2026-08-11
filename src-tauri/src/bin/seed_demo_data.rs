//! One-off dev tool: backfills ~90 days of realistic PAID orders so
//! forecast.rs (which needs 8 weeks of history per weekday) and the
//! finance/reports screens have something real to show. Never shipped,
//! never invoked by the app itself -- run manually with DB_PATH set to
//! the real terminal's sqlite file. Mirrors repo.rs's own INSERT shapes
//! (money `_minor`/`_currency`/`_scale` columns etc.) exactly so this
//! data is indistinguishable from orders the app itself would have written.
use chrono::{Datelike, Duration, TimeZone, Timelike, Utc};
use rand::Rng;
use rusqlite::{params, Connection};

fn main() {
    let path = std::env::var("DB_PATH").expect("set DB_PATH");
    let mut conn = Connection::open(&path).unwrap();

    let tenant_id: String = conn
        .query_row("SELECT tenant_id FROM staff WHERE id = 'staff-owner-001'", [], |r| r.get(0))
        .expect("expected the seeded owner staff row to find tenant_id");
    let branch_id: String = conn
        .query_row("SELECT branch_id FROM staff WHERE id = 'staff-cash-001'", [], |r| r.get(0))
        .expect("expected the seeded cashier staff row to find branch_id");
    let currency: String = conn
        .query_row("SELECT currency FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0))
        .unwrap_or_else(|_| "SYP".to_string());
    let scale: i64 = match currency.as_str() {
        "SYP" | "IQD" => 0,
        "KWD" | "BHD" | "OMR" | "JOD" => 3,
        _ => 2,
    };
    let tax_rate_cents: i64 = conn
        .query_row("SELECT tax_rate_cents FROM chain_config LIMIT 1", [], |r| r.get(0))
        .unwrap_or(0);

    let mut menu_items: Vec<(String, i64)> = {
        let mut stmt = conn.prepare("SELECT id, price_cents FROM menu_items WHERE tenant_id = ?1 AND is_active = 1").unwrap();
        stmt.query_map(params![tenant_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    if menu_items.is_empty() {
        panic!("no active menu_items for this tenant -- add a menu first");
    }
    menu_items.sort_by_key(|(id, _)| id.clone());
    println!("tenant={tenant_id} branch={branch_id} currency={currency} scale={scale} tax_rate_cents={tax_rate_cents} menu_items={}", menu_items.len());

    let existing_tables: i64 = conn.query_row("SELECT COUNT(*) FROM tables WHERE branch_id = ?1", params![branch_id], |r| r.get(0)).unwrap();
    let table_ids: Vec<String> = if existing_tables > 0 {
        let mut stmt = conn.prepare("SELECT id FROM tables WHERE branch_id = ?1").unwrap();
        stmt.query_map(params![branch_id], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
    } else {
        let now = Utc::now().to_rfc3339();
        let mut ids = Vec::new();
        for n in 1..=8 {
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO tables (id, tenant_id, branch_id, name, status, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, 'FREE', ?5, 'pending')",
                params![id, tenant_id, branch_id, format!("طاولة {n}"), now],
            ).unwrap();
            ids.push(id);
        }
        println!("created {} table rows (none existed)", ids.len());
        ids
    };

    let cashier_id = "staff-cash-001".to_string();
    let manager_id = "staff-mgr-001".to_string();

    let mut rng = rand::thread_rng();
    let today = Utc::now().date_naive();
    let tx = conn.transaction().unwrap();

    let mut total_orders = 0i64;
    let mut total_items = 0i64;

    for days_ago in (1..=90).rev() {
        let date = today - Duration::days(days_ago);
        // chrono: Mon=0..Sun=6. Fri/Sat is the real weekend in Syria.
        let is_weekend = matches!(date.weekday(), chrono::Weekday::Fri | chrono::Weekday::Sat);
        // Mild upward trend over the 90-day window (~+35% end vs start) so
        // charts/forecast have a visible signal, not flat noise.
        let trend = 1.0 + (0.35 * (90 - days_ago) as f64 / 90.0);
        let base = if is_weekend { rng.gen_range(28..45) } else { rng.gen_range(14..28) };
        let order_count = ((base as f64) * trend).round() as i64;

        for _ in 0..order_count {
            // Lunch (12-15) and dinner (18-23) peaks, matching real
            // restaurant traffic shape rather than a flat 24h spread.
            let (hour, minute) = if rng.gen_bool(0.4) {
                (rng.gen_range(12..15), rng.gen_range(0..60))
            } else {
                (rng.gen_range(18..23), rng.gen_range(0..60))
            };
            let created_at = Utc
                .with_ymd_and_hms(date.year(), date.month(), date.day(), 0, 0, 0)
                .unwrap()
                .with_hour(hour).unwrap()
                .with_minute(minute).unwrap()
                .with_second(rng.gen_range(0..60)).unwrap();
            let created_at_str = created_at.to_rfc3339();

            let item_count = rng.gen_range(1..=4);
            let mut lines: Vec<(String, i64, i64)> = Vec::new(); // (menu_item_id, qty, unit_price_cents)
            let mut subtotal: i64 = 0;
            for _ in 0..item_count {
                let (mid, price) = &menu_items[rng.gen_range(0..menu_items.len())];
                let qty = rng.gen_range(1..=3);
                subtotal += price * qty;
                lines.push((mid.clone(), qty, *price));
            }

            let tax = (subtotal * tax_rate_cents) / 10000;
            let discount = if rng.gen_bool(0.08) { (subtotal as f64 * 0.1).round() as i64 } else { 0 };
            let total = subtotal + tax - discount;

            let order_id = uuid::Uuid::now_v7().to_string();
            let table_id = &table_ids[rng.gen_range(0..table_ids.len())];
            let user_id = if rng.gen_bool(0.85) { &cashier_id } else { &manager_id };
            let order_type = if rng.gen_bool(0.75) { "DINE_IN" } else if rng.gen_bool(0.6) { "TAKEAWAY" } else { "DELIVERY" };

            tx.execute(
                "INSERT INTO orders (id, tenant_id, branch_id, table_id, user_id, status, order_type, \
                 subtotal_cents, tax_cents, total_cents, discount_cents, created_at, closed_at, sync_version, last_modified, sync_status, \
                 subtotal_minor, subtotal_currency, subtotal_scale, subtotal_base_minor, subtotal_fx_rate, subtotal_fx_source, subtotal_denom_epoch, \
                 tax_minor, tax_currency, tax_scale, tax_base_minor, tax_fx_rate, tax_fx_source, tax_denom_epoch, \
                 discount_minor, discount_currency, discount_scale, discount_base_minor, discount_fx_rate, discount_fx_source, discount_denom_epoch, \
                 total_minor, total_currency, total_scale, total_base_minor, total_fx_rate, total_fx_source, total_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'PAID', ?6, ?7, ?8, ?9, ?10, ?11, ?11, 1, ?11, 'pending', \
                 ?7, ?12, ?13, ?7, '1', 'NATIVE', 2, \
                 ?8, ?12, ?13, ?8, '1', 'NATIVE', 2, \
                 ?10, ?12, ?13, ?10, '1', 'NATIVE', 2, \
                 ?9, ?12, ?13, ?9, '1', 'NATIVE', 2)",
                params![order_id, tenant_id, branch_id, table_id, user_id, order_type, subtotal, tax, total, discount, created_at_str, currency, scale],
            ).unwrap();

            for (mid, qty, price) in &lines {
                let item_id = uuid::Uuid::now_v7().to_string();
                tx.execute(
                    "INSERT INTO order_items (id, tenant_id, branch_id, order_id, menu_item_id, quantity, unit_price_cents, voided, sync_version, last_modified, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 1, ?8, 'pending')",
                    params![item_id, tenant_id, branch_id, order_id, mid, qty, price, created_at_str],
                ).unwrap();
                total_items += 1;
            }

            let payment_id = uuid::Uuid::now_v7().to_string();
            let method = if rng.gen_bool(0.55) { "CASH" } else { "CARD" };
            tx.execute(
                "INSERT INTO payments (id, tenant_id, branch_id, order_id, method, amount_cents, change_cents, created_at, sync_version, last_modified, sync_status, \
                 amount_minor, amount_currency, amount_scale, amount_base_minor, amount_fx_rate, amount_fx_source, amount_denom_epoch, \
                 change_minor, change_currency, change_scale, change_base_minor, change_fx_rate, change_fx_source, change_denom_epoch) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, 1, ?7, 'pending', \
                 ?6, ?8, ?9, ?6, '1', 'NATIVE', 2, \
                 0, ?8, ?9, 0, '1', 'NATIVE', 2)",
                params![payment_id, tenant_id, branch_id, order_id, method, total, created_at_str, currency, scale],
            ).unwrap();

            total_orders += 1;
        }
    }

    tx.commit().unwrap();
    println!("done: {total_orders} orders, {total_items} order_items across 90 days");
}
