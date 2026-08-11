//! One-off dev tool, companion to seed_demo_data.rs: fills in every other
//! domain (ingredients/supplies, suppliers, debtors, customers/loyalty,
//! operational costs, shifts) that orders/order_items alone don't touch,
//! so every report/feature screen has real-looking data to test against.
//! Never shipped, never invoked by the app itself.
use chrono::{Duration, Utc};
use rand::Rng;
use rusqlite::{params, Connection};

fn main() {
    let path = std::env::var("DB_PATH").expect("set DB_PATH");
    let mut conn = Connection::open(&path).unwrap();

    let tenant_id: String = conn
        .query_row("SELECT tenant_id FROM staff WHERE id = 'staff-owner-001'", [], |r| r.get(0))
        .unwrap();
    let branch_id: String = conn
        .query_row("SELECT branch_id FROM staff WHERE id = 'staff-cash-001'", [], |r| r.get(0))
        .unwrap();
    let cashier_id = "staff-cash-001".to_string();
    let owner_id = "staff-owner-001".to_string();

    let menu_item_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM menu_items WHERE tenant_id = ?1").unwrap();
        stmt.query_map(params![tenant_id], |r| r.get::<_, String>(0)).unwrap().filter_map(|r| r.ok()).collect()
    };

    let mut rng = rand::thread_rng();
    let today = Utc::now().date_naive();
    let tx = conn.transaction().unwrap();

    // ---------------- Ingredients + recipes + inventory history ----------------
    let ingredient_defs: Vec<(&str, &str, i64, f64, f64)> = vec![
        // name, unit, cost_cents_per_unit, current_stock, min_stock
        ("لحم برجر", "كغ", 25000, 8.0, 15.0),   // below min -- low stock alert
        ("خبز برجر", "قطعة", 1500, 120.0, 100.0),
        ("جبنة شيدر", "كغ", 18000, 4.0, 8.0),    // below min
        ("خس", "كغ", 3000, 12.0, 5.0),
        ("طماطم", "كغ", 4000, 10.0, 6.0),
        ("بصل", "كغ", 2000, 15.0, 5.0),
        ("صلصة خاصة", "لتر", 8000, 6.0, 4.0),
        ("بطاطا مجمدة", "كغ", 6000, 40.0, 30.0),
        ("زيت قلي", "لتر", 12000, 3.0, 10.0),   // below min
        ("أكياس ورقية", "قطعة", 500, 300.0, 200.0),
        ("أكواب مشروبات", "قطعة", 800, 250.0, 150.0),
        ("كاتشب", "لتر", 5000, 8.0, 5.0),
        ("مايونيز", "لتر", 6000, 7.0, 5.0),
        ("فحم شواء", "كغ", 3500, 20.0, 10.0),
        ("مناديل ورقية", "علبة", 2000, 50.0, 30.0),
    ];
    let now_iso = Utc::now().to_rfc3339();
    let mut ingredient_ids = Vec::new();
    for (name, unit, cost, stock, min_stock) in &ingredient_defs {
        let id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO ingredients (id, tenant_id, branch_id, name, unit, cost_cents_per_unit, current_stock, min_stock, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, 'pending')",
            params![id, tenant_id, branch_id, name, unit, cost, stock, min_stock, now_iso],
        ).unwrap();
        ingredient_ids.push(id);
    }

    // Every menu item gets a small, plausible BOM of 2-3 ingredients so
    // forecast.rs's ingredient-consumption tier (and low-stock screens)
    // have something to compute against.
    for mid in &menu_item_ids {
        let n = rng.gen_range(2..=3);
        let mut used = std::collections::HashSet::new();
        for _ in 0..n {
            let idx = rng.gen_range(0..ingredient_ids.len());
            if !used.insert(idx) { continue; }
            let id = uuid::Uuid::now_v7().to_string();
            let qty: f64 = rng.gen_range(1..30) as f64 / 100.0;
            tx.execute(
                "INSERT INTO recipes (id, tenant_id, menu_item_id, ingredient_id, quantity_needed, sync_version, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'pending')",
                params![id, tenant_id, mid, ingredient_ids[idx], qty, now_iso],
            ).unwrap();
        }
    }

    // Purchase/restock history: ~2 restocks per ingredient per month over
    // the last 3 months, so "supplies" has a real, browsable log.
    for ing_id in &ingredient_ids {
        for days_ago in [85, 70, 55, 40, 25, 10] {
            let date = today - Duration::days(days_ago);
            let created_at = date.and_hms_opt(9, 0, 0).unwrap().and_utc().to_rfc3339();
            let id = uuid::Uuid::now_v7().to_string();
            let amount: f64 = rng.gen_range(10..50) as f64;
            tx.execute(
                "INSERT INTO inventory_logs (id, tenant_id, branch_id, ingredient_id, change_amount, reason, user_id, created_at, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'شراء مخزون', ?6, ?7, ?7, 'pending')",
                params![id, tenant_id, branch_id, ing_id, amount, owner_id, created_at],
            ).unwrap();
        }
    }
    println!("ingredients={} recipes linked, {} restock logs", ingredient_ids.len(), ingredient_ids.len() * 6);

    // ---------------- Suppliers ----------------
    let supplier_defs = [
        ("مورد اللحوم الطازجة", "0991234567"),
        ("مورد الخضار والفواكه", "0997654321"),
        ("مورد الألبان والأجبان", "0999112233"),
        ("مورد التعبئة والتغليف", "0993344556"),
        ("مورد المشروبات", "0996677889"),
    ];
    for (name, phone) in supplier_defs {
        let id = uuid::Uuid::now_v7().to_string();
        let orders = rng.gen_range(6..24);
        let purchases = rng.gen_range(500..3000) * 1000;
        let paid = (purchases as f64 * rng.gen_range(0.6..1.0)).round() as i64;
        let owed = purchases - paid;
        tx.execute(
            "INSERT INTO suppliers (id, tenant_id, branch_id, name, phone, email, total_orders, total_purchases_cents, is_active, last_modified, sync_status, total_owed_cents, total_paid_cents, balance_cents) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, 1, ?8, 'pending', ?9, ?10, ?9)",
            params![id, tenant_id, branch_id, name, phone, orders, purchases, now_iso, owed, paid],
        ).unwrap();
    }
    println!("suppliers={}", supplier_defs.len());

    // ---------------- Debtors (credit customers with real running balances) ----------------
    let debtor_defs = [
        "أبو محمد", "أم خالد", "شركة النور للمقاولات", "أبو ياسر", "مطعم الجوار (تبادل)",
        "أبو ريان", "فندق الشام", "أم علي",
    ];
    for name in debtor_defs {
        let debtor_id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO debtors (id, tenant_id, branch_id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, is_active, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, 0, 0, 0, 1, ?5, 'pending')",
            params![debtor_id, tenant_id, branch_id, name, now_iso],
        ).unwrap();

        let mut total_debt = 0i64;
        let mut total_paid = 0i64;
        let charge_count = rng.gen_range(2..6);
        for _ in 0..charge_count {
            let days_ago = rng.gen_range(1..90);
            let created_at = (today - Duration::days(days_ago)).and_hms_opt(13, 0, 0).unwrap().and_utc().to_rfc3339();
            let amount = rng.gen_range(50..400) * 1000;
            total_debt += amount;
            let id = uuid::Uuid::now_v7().to_string();
            tx.execute(
                "INSERT INTO debt_entries (id, tenant_id, branch_id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'DEBT', 'فاتورة آجلة', ?6, ?7, ?7, 'pending')",
                params![id, tenant_id, branch_id, debtor_id, amount, cashier_id, created_at],
            ).unwrap();
        }
        // Partial repayment on most debtors -- a mix of fully paid, partially
        // paid, and untouched balances is more realistic than "everyone owes
        // 100%" or "everyone's settled".
        if rng.gen_bool(0.7) {
            let repay = (total_debt as f64 * rng.gen_range(0.3..0.9)).round() as i64;
            total_paid += repay;
            let days_ago = rng.gen_range(0..30);
            let created_at = (today - Duration::days(days_ago)).and_hms_opt(17, 0, 0).unwrap().and_utc().to_rfc3339();
            let id = uuid::Uuid::now_v7().to_string();
            tx.execute(
                "INSERT INTO debt_entries (id, tenant_id, branch_id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'PAYMENT', 'دفعة جزئية', ?6, ?7, ?7, 'pending')",
                params![id, tenant_id, branch_id, debtor_id, repay, cashier_id, created_at],
            ).unwrap();
        }
        let balance = total_debt - total_paid;
        tx.execute(
            "UPDATE debtors SET total_debt_cents = ?1, total_paid_cents = ?2, balance_cents = ?3, last_transaction_at = ?4 WHERE id = ?5",
            params![total_debt, total_paid, balance, now_iso, debtor_id],
        ).unwrap();
    }
    println!("debtors={}", debtor_defs.len());

    // ---------------- Customers + loyalty ----------------
    let first_names = ["محمد", "أحمد", "علي", "حسن", "يوسف", "عمر", "خالد", "زياد", "سامر", "وائل", "ليلى", "سارة", "رنا", "نور", "هبة", "دانا", "ريم", "ياسمين", "ملك", "جود"];
    let mut customer_ids = Vec::new();
    for (i, name) in first_names.iter().enumerate() {
        let id = uuid::Uuid::now_v7().to_string();
        let phone = format!("09{:08}", 90000000 + i as i32 * 137);
        let orders = rng.gen_range(1..25);
        let spent = orders as i64 * rng.gen_range(20..80) * 1000;
        let points = (spent / 10000).max(0);
        tx.execute(
            "INSERT INTO customers (id, tenant_id, name, phone, email, address, notes, birthday, total_orders, total_spent_cents, loyalty_points, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?6, ?7, ?8, 'pending')",
            params![id, tenant_id, name, phone, orders, spent, points, now_iso],
        ).unwrap();
        customer_ids.push((id, points));
    }
    // Roughly half get an actual loyalty card, tiered by points earned.
    let mut cards_issued = 0;
    for (i, (cust_id, points)) in customer_ids.iter().enumerate() {
        if i % 2 != 0 { continue; }
        let tier = if *points >= 3000 { "PLATINUM" } else if *points >= 1000 { "GOLD" } else if *points >= 300 { "SILVER" } else { "BRONZE" };
        let card_id = uuid::Uuid::now_v7().to_string();
        let card_number = format!("LC{:06}", 100000 + i as i32);
        tx.execute(
            "INSERT INTO loyalty_cards (id, tenant_id, customer_id, card_number, points, tier, issued_at, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'pending')",
            params![card_id, tenant_id, cust_id, card_number, points, tier, now_iso],
        ).unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO loyalty_transactions (id, tenant_id, branch_id, card_id, points, type, reference_type, reference_id, created_at, sync_version, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'EARN', 'order', NULL, ?6, 1, ?6, 'pending')",
            params![id, tenant_id, branch_id, card_id, points, now_iso],
        ).unwrap();
        cards_issued += 1;
    }
    println!("customers={} loyalty_cards={}", customer_ids.len(), cards_issued);

    // ---------------- Operational costs (rent, utilities, salaries) ----------------
    let recurring = [("إيجار", 4_000_000i64), ("كهرباء", 600_000), ("مياه", 150_000), ("رواتب", 3_500_000), ("صيانة", 300_000)];
    for month_start in [60, 30, 0] {
        let date = (today - Duration::days(month_start)).to_string();
        for (category, amount) in recurring {
            let id = uuid::Uuid::now_v7().to_string();
            tx.execute(
                "INSERT INTO operational_costs (id, tenant_id, branch_id, category, amount_cents, date, notes, user_id, last_modified, sync_status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, 'pending')",
                params![id, tenant_id, branch_id, category, amount, date, owner_id, now_iso],
            ).unwrap();
        }
    }
    println!("operational_costs={}", recurring.len() * 3);

    // ---------------- Shifts (one cashier shift per day, last 90 days) ----------------
    let mut shift_count = 0;
    for days_ago in (1..=90).rev() {
        let date = today - Duration::days(days_ago);
        let opened_at = date.and_hms_opt(11, 0, 0).unwrap().and_utc().to_rfc3339();
        let closed_at = date.and_hms_opt(23, 30, 0).unwrap().and_utc().to_rfc3339();
        let starting_cash = 500_000i64;
        // Small, mostly-innocuous over/under so shift reconciliation has
        // something real to show, not a suspiciously perfect zero every day.
        let diff: i64 = if rng.gen_bool(0.75) { 0 } else { rng.gen_range(-20_000..20_000) };
        let ending_cash = starting_cash + rng.gen_range(300_000..1_500_000) + diff;
        let id = uuid::Uuid::now_v7().to_string();
        tx.execute(
            "INSERT INTO shifts (id, tenant_id, branch_id, user_id, opened_at, closed_at, starting_cash_cents, ending_cash_cents, difference_cents, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?6, 'pending')",
            params![id, tenant_id, branch_id, cashier_id, opened_at, closed_at, starting_cash, ending_cash, diff],
        ).unwrap();
        shift_count += 1;
    }
    println!("shifts={shift_count}");

    tx.commit().unwrap();
    println!("done");
}
