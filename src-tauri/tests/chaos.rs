use rand::Rng;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn schema() -> &'static str {
    "
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, manager_pin_hash TEXT,
        role TEXT NOT NULL CHECK(role IN ('CASHIER','MANAGER','ADMIN','OWNER','ACCOUNTANT','KITCHEN')),
        is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
        image_path TEXT, is_active INTEGER NOT NULL DEFAULT 1,
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS menu_items (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
        cost_cents INTEGER NOT NULL DEFAULT 0, category_id TEXT NOT NULL REFERENCES categories(id),
        image_path TEXT, description TEXT, barcode TEXT UNIQUE, recipe_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1, is_combo INTEGER NOT NULL DEFAULT 0,
        combo_original_price_cents INTEGER, combo_description TEXT,
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'FREE' CHECK(status IN ('FREE','OCCUPIED','MERGED')),
        merge_group_id TEXT, current_order_id TEXT,
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('DRAFT','PENDING','PREPARING','READY','SERVED','PAID','CANCELLED','SCHEDULED','VOIDED')),
        order_type TEXT NOT NULL DEFAULT 'DINE_IN' CHECK(order_type IN ('DINE_IN','TAKEAWAY','DELIVERY','ONLINE')),
        subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
        discount_reason TEXT, customer_name TEXT, customer_phone TEXT, delivery_address TEXT,
        delivery_fee_cents INTEGER NOT NULL DEFAULT 0, delivery_zone_id TEXT, driver_id TEXT,
        scheduled_at TEXT, parent_order_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT, sync_version INTEGER NOT NULL DEFAULT 1,
        last_modified TEXT NOT NULL DEFAULT (datetime('now')), sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS order_items (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
        menu_item_id TEXT NOT NULL REFERENCES menu_items(id), quantity INTEGER NOT NULL DEFAULT 1,
        unit_price_cents INTEGER NOT NULL, notes TEXT, combo_id TEXT, voided INTEGER NOT NULL DEFAULT 0,
        void_reason TEXT, sync_version INTEGER NOT NULL DEFAULT 1,
        last_modified TEXT NOT NULL DEFAULT (datetime('now')), sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
        method TEXT NOT NULL CHECK(method IN ('CASH','CARD','WALLET','CREDIT')),
        amount_cents INTEGER NOT NULL, change_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS loyalty_cards (
        id TEXT PRIMARY KEY, customer_id TEXT, card_number TEXT UNIQUE NOT NULL,
        points INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'BRONZE',
        issued_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT,
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES loyalty_cards(id),
        points INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('EARN','REDEEM','ADJUST','EXPIRE')),
        reference_type TEXT, reference_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER NOT NULL DEFAULT 1, last_modified TEXT NOT NULL DEFAULT (datetime('now')),
        sync_status TEXT NOT NULL DEFAULT 'pending'
    );
    "
}

fn make_conn(path: &PathBuf) -> Connection {
    let conn = Connection::open(path).expect("Failed to open temp DB");
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .expect("Failed to set pragmas");
    conn.execute_batch(schema()).expect("Failed to apply schema");
    conn
}

fn seed_fixtures(conn: &Connection) {
    conn.execute_batch(
        "
        INSERT OR IGNORE INTO users (id, email, name, password_hash, role, is_active)
            VALUES ('user-test', 'test@zaeem.local', 'Test', 'hash', 'CASHIER', 1);
        INSERT OR IGNORE INTO categories (id, name, sort_order)
            VALUES ('cat-test', 'Test Category', 0);
        INSERT OR IGNORE INTO menu_items (id, name, price_cents, cost_cents, category_id)
            VALUES ('item-1', 'Test Item 1', 2500, 800, 'cat-test'),
                   ('item-2', 'Test Item 2', 3500, 1200, 'cat-test'),
                   ('item-3', 'Test Item 3', 1500, 500, 'cat-test');
        INSERT OR IGNORE INTO tables (id, name, status)
            VALUES ('table-1', 'طاولة 1', 'FREE'),
                   ('table-2', 'طاولة 2', 'FREE'),
                   ('table-3', 'طاولة 3', 'FREE');
        INSERT OR IGNORE INTO loyalty_cards (id, card_number, points, tier)
            VALUES ('lcard-1', '00001', 500, 'SILVER');
        ",
    )
    .expect("Failed to seed fixtures");
}

struct PaymentResult {
    #[allow(dead_code)]
    order_id: String,
    payment_id: Option<String>,
    #[allow(dead_code)]
    order_total: i64,
}

fn simulate_payment_flow(
    conn: &Connection,
    rng: &mut impl Rng,
    order_num: usize,
    should_crash: bool,
    crash_after: &str,
) -> Result<PaymentResult, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let order_id = format!("order-chaos-{}", order_num);
    let table_id = format!("table-{}", rng.gen_range(1..=3));

    let total = rng.gen_range(1000..10000);
    let subtotal = total - 500;
    let tax = 500;

    // Step 1: Insert order (no transaction wrapping — mimics frontend bug)
    conn.execute(
        "INSERT INTO orders (id, table_id, user_id, status, order_type, subtotal_cents, tax_cents, total_cents, created_at, last_modified)
         VALUES (?1, ?2, 'user-test', 'PENDING', 'DINE_IN', ?3, ?4, ?5, ?6, ?6)",
        params![order_id, table_id, subtotal, tax, total, now],
    )
    .map_err(|e| format!("Step 1 (create order) failed: {}", e))?;

    if should_crash && crash_after == "order" {
        return Err("CRASH after order insert".to_string());
    }

    // Step 2: Insert order items
    let item_count = rng.gen_range(1..=3);
    for i in 0..item_count {
        let item_id = format!("item-{}", rng.gen_range(1..=3));
        let qty = rng.gen_range(1..=5);
        let unit_price = rng.gen_range(500..5000);
        conn.execute(
            "INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_price_cents, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, '')",
            params![format!("oi-{}-{}", order_num, i), order_id, item_id, qty, unit_price],
        )
        .map_err(|e| format!("Step 2 (insert items) failed: {}", e))?;
    }

    if should_crash && crash_after == "items" {
        return Err("CRASH after items insert".to_string());
    }

    // Step 3: Mark order as PAID
    conn.execute(
        "UPDATE orders SET status = 'PAID', closed_at = ?1, last_modified = ?1 WHERE id = ?2",
        params![now, order_id],
    )
    .map_err(|e| format!("Step 3 (mark paid) failed: {}", e))?;

    if should_crash && crash_after == "order_paid" {
        return Err("CRASH after order paid".to_string());
    }

    // Step 4: Insert payment record
    let payment_id = format!("pay-chaos-{}", order_num);
    let method = match rng.gen_range(0..4) {
        0 => "CASH",
        1 => "CARD",
        2 => "WALLET",
        _ => "CREDIT",
    };
    conn.execute(
        "INSERT INTO payments (id, order_id, method, amount_cents, change_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        params![payment_id, order_id, method, total, now],
    )
    .map_err(|e| format!("Step 4 (insert payment) failed: {}", e))?;

    if should_crash && crash_after == "payment" {
        return Err("CRASH after payment insert".to_string());
    }

    // Step 5: Free the table
    conn.execute(
        "UPDATE tables SET status = 'FREE', current_order_id = NULL, last_modified = ?1 WHERE id = ?2",
        params![now, table_id],
    )
    .map_err(|e| format!("Step 5 (free table) failed: {}", e))?;

    if should_crash && crash_after == "table_freed" {
        return Err("CRASH after table freed".to_string());
    }

    // Step 6: Award loyalty points
    let points_earned = total / 100;
    conn.execute(
        "UPDATE loyalty_cards SET points = points + ?1, last_used_at = ?2 WHERE id = 'lcard-1'",
        params![points_earned, now],
    )
    .map_err(|e| format!("Step 6 (loyalty points) failed: {}", e))?;
    conn.execute(
        "INSERT INTO loyalty_transactions (id, card_id, points, type, reference_type, reference_id, created_at)
         VALUES (?1, 'lcard-1', ?2, 'EARN', 'order', ?3, ?4)",
        params![format!("lt-chaos-{}", order_num), points_earned, order_id, now],
    )
    .map_err(|e| format!("Step 6b (loyalty tx) failed: {}", e))?;

    Ok(PaymentResult {
        order_id,
        payment_id: Some(payment_id),
        order_total: total,
    })
}

fn verify_consistency(conn: &Connection, successful_payments: &[String]) -> Vec<String> {
    let mut errors = Vec::new();

    // Integrity check
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap_or_else(|_| "error".to_string());
    if integrity != "ok" {
        errors.push(format!("INTEGRITY: {}", integrity));
    }

    // Orphan payments (payment but no parent order)
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payments p LEFT JOIN orders o ON p.order_id = o.id WHERE o.id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if orphans > 0 {
        errors.push(format!("ORPHAN_PAYMENTS: {}", orphans));
    }

    // Paid orders with no payment
    let paid_no_pay: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM orders o LEFT JOIN payments p ON o.id = p.order_id WHERE o.status = 'PAID' AND p.id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if paid_no_pay > 0 {
        errors.push(format!("PAID_NO_PAYMENT: {}", paid_no_pay));
    }

    // Payments reported as successful but missing on recovery
    for pid in successful_payments {
        let exists: bool = conn
            .query_row("SELECT COUNT(*) > 0 FROM payments WHERE id = ?1", params![pid], |row| {
                row.get(0)
            })
            .unwrap_or(false);
        if !exists {
            errors.push(format!("LOST_PAYMENT: {}", pid));
        }
    }

    errors
}

/// Chaos test: 200 randomized order+payment cycles with simulated crashes.
/// Marked #[ignore] because it always FAILS — the payment flow has no transaction
/// wrapping (mimics the frontend bug at pos/page.tsx:190-306).
/// Run with: cargo test --test chaos -- --ignored
/// Or:       pnpm test:chaos
#[test]
#[ignore]
fn chaos_order_payment_cycles() {
    let n_cycles = 200;
    let temp_dir = std::env::temp_dir().join(format!("zaeem_chaos_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp_dir);
    std::fs::create_dir_all(&temp_dir).expect("Failed to create temp dir");

    let db_path = temp_dir.join("chaos.db");
    let conn = make_conn(&db_path);
    seed_fixtures(&conn);
    drop(conn);

    let successful_payments: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let total_crashes = Arc::new(AtomicUsize::new(0));
    let integrity_fails = Arc::new(AtomicUsize::new(0));
    let orphan_fails = Arc::new(AtomicUsize::new(0));
    let paid_no_pay_fails = Arc::new(AtomicUsize::new(0));
    let lost_payment_fails = Arc::new(AtomicUsize::new(0));

    let start = Instant::now();

    for cycle in 0..n_cycles {
        let conn = make_conn(&db_path);
        let mut rng = rand::thread_rng();

        let should_crash = rng.gen_bool(0.3);
        let crash_points = ["order", "items", "order_paid", "payment", "table_freed", "loyalty"];
        let crash_after = crash_points[rng.gen_range(0..crash_points.len())];

        match simulate_payment_flow(&conn, &mut rng, cycle, should_crash, crash_after) {
            Ok(pr) => {
                if let Some(pid) = pr.payment_id {
                    successful_payments.lock().unwrap().push(pid);
                }
            }
            Err(_) => {
                total_crashes.fetch_add(1, Ordering::SeqCst);
            }
        }

        drop(conn);
        let conn = make_conn(&db_path);

        let sp = successful_payments.lock().unwrap();
        let errors = verify_consistency(&conn, &sp);
        drop(sp);

        for err in &errors {
            if err.starts_with("INTEGRITY") {
                integrity_fails.fetch_add(1, Ordering::SeqCst);
            }
            if err.starts_with("ORPHAN") {
                orphan_fails.fetch_add(1, Ordering::SeqCst);
            }
            if err.starts_with("PAID_NO_PAYMENT") {
                paid_no_pay_fails.fetch_add(1, Ordering::SeqCst);
            }
            if err.starts_with("LOST_PAYMENT") {
                lost_payment_fails.fetch_add(1, Ordering::SeqCst);
            }
        }

        drop(conn);
    }

    let elapsed = start.elapsed();
    let _ = std::fs::remove_dir_all(&temp_dir);

    let crashes = total_crashes.load(Ordering::SeqCst);
    let i_f = integrity_fails.load(Ordering::SeqCst);
    let o_f = orphan_fails.load(Ordering::SeqCst);
    let p_f = paid_no_pay_fails.load(Ordering::SeqCst);
    let l_f = lost_payment_fails.load(Ordering::SeqCst);

    println!();
    println!("═══════════════════════════════════════");
    println!("       CHAOS TEST — FAILURE REPORT");
    println!("═══════════════════════════════════════");
    println!("  Cycles:                  {}", n_cycles);
    println!("  Simulated crashes:       {}", crashes);
    println!("  Duration:                {:?}", elapsed);
    println!("  ───────────────────────────────────");
    println!("  DB integrity violations: {}", i_f);
    println!("  Orphan payments:         {}", o_f);
    println!("  Paid orders, no payment: {}", p_f);
    println!("  Reported payments lost:  {}", l_f);
    println!("  ───────────────────────────────────");
    println!("  Root cause: payment flow at pos/page.tsx:190-306");
    println!("  has no transaction wrapping. Each step is a");
    println!("  sequential await with no rollback on failure.");
    println!("  Fix target: Sprint 02.");
    println!("═══════════════════════════════════════");
    println!();

    let total_fails = i_f + o_f + p_f + l_f;
    let rate = if n_cycles > 0 {
        (total_fails as f64 / n_cycles as f64) * 100.0
    } else {
        0.0
    };

    // Always panic — red test that tells the truth
    panic!(
        "CHAOS TEST: {:.1}% failure rate across {} cycles (integrity={}, orphan={}, paid_no_pay={}, lost={})",
        rate, n_cycles, i_f, o_f, p_f, l_f
    );
}
