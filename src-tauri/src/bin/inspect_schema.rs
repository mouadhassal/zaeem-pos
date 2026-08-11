use rusqlite::Connection;

fn main() {
    let path = std::env::var("DB_PATH").expect("set DB_PATH");
    let conn = Connection::open(&path).unwrap();
    for table in ["orders", "order_items", "menu_items", "categories", "tables", "staff", "chain_config", "branches", "branch",
        "ingredients", "recipes", "inventory_logs", "suppliers", "invoices", "invoice_items",
        "debtors", "debt_entries", "customers", "loyalty_cards", "loyalty_transactions",
        "operational_costs", "shifts", "combo_meals", "combo_items"] {
        println!("== {table} ==");
        let mut stmt = match conn.prepare(&format!("PRAGMA table_info({table})")) {
            Ok(s) => s,
            Err(e) => { println!("  (error: {e})"); continue; }
        };
        let cols: Vec<(String, String, i64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        if cols.is_empty() {
            println!("  (no such table)");
        }
        for (name, ty, notnull) in cols {
            println!("  {name}: {ty} notnull={notnull}");
        }
        let count: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(-1);
        println!("  rows: {count}");
    }

    println!("== sample menu_items ==");
    if let Ok(mut stmt) = conn.prepare("SELECT id, name, price_cents, tenant_id, category_id FROM menu_items LIMIT 20") {
        let rows: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("{:?} {:?} {:?} {:?} {:?}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        }).unwrap().filter_map(|r| r.ok()).collect();
        for r in rows { println!("  {r}"); }
    }

    println!("== sample tables ==");
    if let Ok(mut stmt) = conn.prepare("SELECT id, name, tenant_id, branch_id FROM tables LIMIT 20") {
        let rows: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("{:?} {:?} {:?} {:?}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
        }).unwrap().filter_map(|r| r.ok()).collect();
        for r in rows { println!("  {r}"); }
    }

    println!("== sample staff ==");
    if let Ok(mut stmt) = conn.prepare("SELECT id, name, role, tenant_id, branch_id FROM staff LIMIT 20") {
        let rows: Vec<String> = stmt.query_map([], |r| {
            Ok(format!("{:?} {:?} {:?} {:?} {:?}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
        }).unwrap().filter_map(|r| r.ok()).collect();
        for r in rows { println!("  {r}"); }
    };
}
