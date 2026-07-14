use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_sql::{Migration, MigrationKind};

use bcrypt::{hash, verify, DEFAULT_COST};

struct Db(Mutex<Connection>);

const SCHEMA_SQL: &str = "
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    manager_pin_hash TEXT,
    role TEXT NOT NULL CHECK(role IN ('CASHIER','MANAGER','ADMIN','OWNER','ACCOUNTANT','KITCHEN')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    image_path TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS menu_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    category_id TEXT NOT NULL REFERENCES categories(id),
    image_path TEXT,
    description TEXT,
    barcode TEXT UNIQUE,
    recipe_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_combo INTEGER NOT NULL DEFAULT 0,
    combo_original_price_cents INTEGER,
    combo_description TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS ingredients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    cost_cents_per_unit INTEGER NOT NULL DEFAULT 0,
    current_stock REAL NOT NULL DEFAULT 0,
    min_stock REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    quantity_needed REAL NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS inventory_logs (
    id TEXT PRIMARY KEY,
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    change_amount REAL NOT NULL,
    reason TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS tables (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'FREE' CHECK(status IN ('FREE','OCCUPIED','MERGED')),
    merge_group_id TEXT,
    current_order_id TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('DRAFT','PENDING','PREPARING','READY','SERVED','PAID','CANCELLED','SCHEDULED','VOIDED')),
    order_type TEXT NOT NULL DEFAULT 'DINE_IN' CHECK(order_type IN ('DINE_IN','TAKEAWAY','DELIVERY','ONLINE')),
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    discount_reason TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    delivery_address TEXT,
    delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
    delivery_zone_id TEXT,
    driver_id TEXT,
    scheduled_at TEXT,
    parent_order_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL,
    notes TEXT,
    combo_id TEXT,
    voided INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS order_modifiers (
    id TEXT PRIMARY KEY,
    order_item_id TEXT NOT NULL REFERENCES order_items(id),
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    method TEXT NOT NULL CHECK(method IN ('CASH','CARD','WALLET','CREDIT')),
    amount_cents INTEGER NOT NULL,
    change_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    starting_cash_cents INTEGER NOT NULL DEFAULT 0,
    ending_cash_cents INTEGER,
    difference_cents INTEGER,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    user_agent TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    record_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    sync_version INTEGER NOT NULL DEFAULT 1,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT,
    error_message TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    printer_type TEXT NOT NULL CHECK(printer_type IN ('RECEIPT','KITCHEN','LABEL')),
    interface TEXT NOT NULL CHECK(interface IN ('USB','NETWORK','BLUETOOTH')),
    vendor_id TEXT,
    product_id TEXT,
    ip_address TEXT,
    port INTEGER DEFAULT 9100,
    paper_width_mm INTEGER NOT NULL DEFAULT 80,
    code_page TEXT NOT NULL DEFAULT 'CP864',
    drawer_pulse_ms INTEGER NOT NULL DEFAULT 200,
    is_primary INTEGER NOT NULL DEFAULT 0,
    is_secondary INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS combo_meals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bundle_price_cents INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS combo_items (
    id TEXT PRIMARY KEY,
    combo_id TEXT NOT NULL REFERENCES menu_items(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL DEFAULT 1,
    is_free INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS happy_hour_rules (
    id TEXT PRIMARY KEY,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    discount_percent INTEGER NOT NULL DEFAULT 0,
    day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS chain_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    chain_name TEXT NOT NULL DEFAULT 'مطعمي',
    tax_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_mode IN ('inclusive','exclusive')),
    tax_rate_cents INTEGER NOT NULL DEFAULT 1500,
    secondary_tax_rate_cents INTEGER NOT NULL DEFAULT 0,
    service_charge_rate_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'SAR',
    default_paper_width INTEGER NOT NULL DEFAULT 80,
    auto_print_receipt INTEGER NOT NULL DEFAULT 1,
    auto_print_kitchen INTEGER NOT NULL DEFAULT 1,
    barcode_prefix TEXT NOT NULL DEFAULT '',
    barcode_suffix TEXT NOT NULL DEFAULT '',
    customer_display_port TEXT,
    customer_display_baud INTEGER NOT NULL DEFAULT 9600,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'synced'
);

INSERT OR IGNORE INTO chain_config (id, last_modified, sync_status)
VALUES ('default', datetime('now'), 'synced');

CREATE TABLE IF NOT EXISTS delayed_orders (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    scheduled_at TEXT NOT NULL,
    activated INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    phone TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    currency TEXT NOT NULL DEFAULT 'SAR',
    tax_rate_cents INTEGER NOT NULL DEFAULT 1500,
    max_tables INTEGER NOT NULL DEFAULT 20,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    address TEXT,
    notes TEXT,
    birthday TEXT,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_spent_cents INTEGER NOT NULL DEFAULT 0,
    last_order_at TEXT,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_purchases_cents INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    branch_id TEXT REFERENCES branches(id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ORDERED','RECEIVED','CANCELLED')),
    total_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    received_at TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL DEFAULT 'default',
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','OVERDUE','CANCELLED')),
    due_date TEXT NOT NULL,
    paid_at TEXT,
    notes TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS operational_costs (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    date TEXT NOT NULL DEFAULT (datetime('now')),
    branch_id TEXT REFERENCES branches(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    notes TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    clock_in TEXT,
    clock_out TEXT,
    status TEXT NOT NULL DEFAULT 'ABSENT' CHECK(status IN ('PRESENT','ABSENT','LATE','HALF_DAY')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    last_sync TEXT,
    version TEXT NOT NULL DEFAULT '1.0.0',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE','OFFLINE')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'INFO' CHECK(type IN ('INFO','WARNING','ERROR','SUCCESS')),
    is_read INTEGER NOT NULL DEFAULT 0,
    link TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS debtors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    address TEXT,
    notes TEXT,
    total_debt_cents INTEGER NOT NULL DEFAULT 0,
    total_paid_cents INTEGER NOT NULL DEFAULT 0,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    last_transaction_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS debt_entries (
    id TEXT PRIMARY KEY,
    debtor_id TEXT NOT NULL,
    order_id TEXT,
    amount_cents INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('DEBT','PAYMENT')),
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS login_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login_time TEXT NOT NULL DEFAULT (datetime('now')),
    logout_time TEXT,
    ip_address TEXT,
    device_info TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    photo_path TEXT,
    vehicle_type TEXT NOT NULL DEFAULT 'CAR' CHECK(vehicle_type IN ('CAR','MOTORCYCLE','BIKE','VAN','TRUCK')),
    vehicle_plate TEXT,
    license_number TEXT,
    status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','BUSY','OFFLINE','INACTIVE')),
    current_lat REAL,
    current_lng REAL,
    total_deliveries INTEGER NOT NULL DEFAULT 0,
    rating REAL NOT NULL DEFAULT 5.0 CHECK(rating BETWEEN 1.0 AND 5.0),
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS delivery_zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    boundaries TEXT NOT NULL DEFAULT '[]',
    fee_cents INTEGER NOT NULL DEFAULT 0,
    min_order_cents INTEGER NOT NULL DEFAULT 0,
    estimated_minutes INTEGER NOT NULL DEFAULT 30,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS delivery_logs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    driver_id TEXT NOT NULL REFERENCES drivers(id),
    status TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK(status IN ('ASSIGNED','PICKED_UP','IN_TRANSIT','DELIVERED','FAILED','CANCELLED')),
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    picked_up_at TEXT,
    delivered_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    notes TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    quantity_ordered REAL NOT NULL DEFAULT 0,
    quantity_received REAL NOT NULL DEFAULT 0,
    unit_cost_cents INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS loyalty_cards (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    card_number TEXT NOT NULL UNIQUE,
    points INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'BRONZE' CHECK(tier IN ('BRONZE','SILVER','GOLD','PLATINUM')),
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES loyalty_cards(id),
    points INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('EARN','REDEEM','ADJUST','EXPIRE')),
    reference_type TEXT,
    reference_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);";

fn db_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_config_dir().expect("failed to resolve app config dir");
    std::fs::create_dir_all(&dir).ok();
    dir.join("zaeem_pos.db")
}

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    for (table, column, col_type) in &[
        ("users", "photo_path", "TEXT"),
        ("users", "cv_path", "TEXT"),
        ("users", "qr_code", "TEXT"),
        ("ingredients", "barcode", "TEXT"),
    ] {
        let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, col_type);
        conn.execute_batch(&sql).ok();
    }
    for (table, column, col_type) in &[
        ("users", "username", "TEXT"),
        ("users", "name_en", "TEXT"),
        ("users", "phone", "TEXT"),
        ("users", "last_login", "TEXT"),
        ("users", "restaurant_id", "TEXT"),
        ("orders", "shift_id", "TEXT"),
        ("menu_items", "is_combo", "INTEGER NOT NULL DEFAULT 0"),
        ("menu_items", "combo_original_price_cents", "INTEGER"),
        ("menu_items", "combo_description", "TEXT"),
        ("combo_items", "is_free", "INTEGER NOT NULL DEFAULT 0"),
        ("combo_items", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
        ("orders", "delivery_fee_cents", "INTEGER NOT NULL DEFAULT 0"),
        ("orders", "delivery_zone_id", "TEXT"),
    ] {
        let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, col_type);
        conn.execute_batch(&sql).ok();
    }
    Ok(())
}

fn seed_default_users(conn: &Connection) -> rusqlite::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE username IS NOT NULL",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    if count > 0 { return Ok(()); }

    let cost = 12;
    let password_hash = hash("admin123", cost).unwrap_or_else(|_| "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.VTtYA.qGZvKG6G".to_string());
    let now = chrono::Utc::now().to_rfc3339();

    let users = [
        ("user-owner-001", "المدير", "owner", "OWNER", "rest-001", "owner@zaeem.com"),
        ("user-mgr-001", "المشرف", "manager", "MANAGER", "rest-001", "manager@zaeem.com"),
        ("user-cash-001", "الكاشير", "cashier", "CASHIER", "rest-001", "cashier@zaeem.com"),
        ("user-kit-001", "المطبخ", "kitchen", "KITCHEN", "rest-001", "kitchen@zaeem.com"),
    ];

    for (id, name, username, role, rest_id, email) in &users {
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO users (id, email, name, username, password_hash, role, is_active, created_at, restaurant_id, sync_version, last_modified, sync_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 1, ?7, 'synced')",
            params![id, email, name, username, &password_hash, role, now, rest_id],
        ).unwrap_or(0);
        if inserted == 0 {
            conn.execute(
                "UPDATE users SET username = ?1, password_hash = ?2, role = ?3 WHERE email = ?4",
                params![username, &password_hash, role, email],
            ).ok();
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Debtor {
    pub id: String,
    pub name: String,
    pub phone: String,
    pub email: Option<String>,
    pub address: Option<String>,
    pub notes: Option<String>,
    pub total_debt_cents: i64,
    pub total_paid_cents: i64,
    pub balance_cents: i64,
    pub last_transaction_at: Option<String>,
    pub is_active: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DebtEntry {
    pub id: String,
    pub debtor_id: String,
    pub order_id: Option<String>,
    pub amount_cents: i64,
    pub r#type: String,
    pub notes: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KitchenOrder {
    pub id: String,
    pub table_name: Option<String>,
    pub order_type: String,
    pub status: String,
    pub items: Vec<KitchenItem>,
    pub created_at: String,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KitchenItem {
    pub name: String,
    pub quantity: i64,
    pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SettingsData {
    pub chain_name: String,
    pub currency: String,
    pub tax_mode: String,
    pub tax_rate_cents: i64,
    pub auto_print_receipt: i64,
    pub auto_print_kitchen: i64,
    pub default_paper_width: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub username: String,
    pub role: String,
    pub photo_path: Option<String>,
    pub restaurant_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub user: Option<AuthUser>,
    pub token: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct AuthCheckResponse {
    pub authenticated: bool,
    pub user: Option<AuthUser>,
}

#[tauri::command]
fn login(state: State<Db>, request: LoginRequest, device_info: String) -> Result<LoginResponse, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;

    let user_result = conn.query_row(
        "SELECT id, name, username, password_hash, role, photo_path, restaurant_id, is_active FROM users WHERE username = ?1",
        [&request.username],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i32>(7)?,
            ))
        },
    );

    let (id, name, username, password_hash, role, photo_path, restaurant_id, is_active) = match user_result {
        Ok(u) => u,
        Err(_) => {
            return Ok(LoginResponse {
                success: false,
                user: None,
                token: None,
                message: "اسم المستخدم أو كلمة المرور غير صحيحة".to_string(),
            });
        }
    };

    if is_active == 0 {
        return Ok(LoginResponse {
            success: false,
            user: None,
            token: None,
            message: "هذا الحساب معطل. تواصل مع المدير.".to_string(),
        });
    }

    let valid = verify(&request.password, &password_hash).map_err(|e| e.to_string())?;
    if !valid {
        return Ok(LoginResponse {
            success: false,
            user: None,
            token: None,
            message: "اسم المستخدم أو كلمة المرور غير صحيحة".to_string(),
        });
    }

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute("UPDATE users SET last_login = ?1 WHERE id = ?2", params![now, id])
        .map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO login_sessions (id, user_id, login_time, device_info, is_active) VALUES (?1, ?2, ?3, ?4, 1)",
        params![session_id, id, now, device_info],
    ).map_err(|e| e.to_string())?;

    let token = format!("zaeem_{}", session_id);

    Ok(LoginResponse {
        success: true,
        user: Some(AuthUser { id, name, username, role, photo_path, restaurant_id }),
        token: Some(token),
        message: "تم تسجيل الدخول بنجاح".to_string(),
    })
}

#[tauri::command]
fn logout(state: State<Db>, user_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE login_sessions SET logout_time = ?1, is_active = 0 WHERE user_id = ?2 AND is_active = 1",
        params![now, user_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn check_auth(state: State<Db>, user_id: String) -> Result<AuthCheckResponse, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let user = conn.query_row(
        "SELECT id, name, username, role, photo_path, restaurant_id FROM users WHERE id = ?1 AND is_active = 1",
        [&user_id],
        |row| {
            Ok(AuthUser {
                id: row.get(0)?,
                name: row.get(1)?,
                username: row.get(2)?,
                role: row.get(3)?,
                photo_path: row.get(4)?,
                restaurant_id: row.get(5)?,
            })
        },
    ).ok();
    Ok(AuthCheckResponse { authenticated: user.is_some(), user })
}

#[tauri::command]
fn change_password(state: State<Db>, user_id: String, old_password: String, new_password: String) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let current_hash: String = conn.query_row(
        "SELECT password_hash FROM users WHERE id = ?1",
        [&user_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    let valid = verify(&old_password, &current_hash).map_err(|e| e.to_string())?;
    if !valid { return Ok(false); }

    let new_hash = hash(&new_password, DEFAULT_COST).map_err(|e| e.to_string())?;
    conn.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![new_hash, user_id])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn get_debtors(state: State<Db>) -> Result<Vec<Debtor>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, last_transaction_at, is_active FROM debtors WHERE is_active = 1 ORDER BY name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Debtor {
                id: row.get(0)?,
                name: row.get(1)?,
                phone: row.get(2)?,
                email: row.get(3)?,
                address: row.get(4)?,
                notes: row.get(5)?,
                total_debt_cents: row.get(6)?,
                total_paid_cents: row.get(7)?,
                balance_cents: row.get(8)?,
                last_transaction_at: row.get(9)?,
                is_active: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut debtors = Vec::new();
    for row in rows {
        debtors.push(row.map_err(|e| e.to_string())?);
    }
    Ok(debtors)
}

#[tauri::command]
fn get_debtor_detail(state: State<Db>, debtor_id: String) -> Result<(Debtor, Vec<DebtEntry>), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let debtor = conn
        .query_row(
            "SELECT id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, last_transaction_at, is_active FROM debtors WHERE id = ?1",
            params![debtor_id],
            |row| {
                Ok(Debtor {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    phone: row.get(2)?,
                    email: row.get(3)?,
                    address: row.get(4)?,
                    notes: row.get(5)?,
                    total_debt_cents: row.get(6)?,
                    total_paid_cents: row.get(7)?,
                    balance_cents: row.get(8)?,
                    last_transaction_at: row.get(9)?,
                    is_active: row.get(10)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at FROM debt_entries WHERE debtor_id = ?1 ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params![debtor_id], |row| {
            Ok(DebtEntry {
                id: row.get(0)?,
                debtor_id: row.get(1)?,
                order_id: row.get(2)?,
                amount_cents: row.get(3)?,
                r#type: row.get(4)?,
                notes: row.get(5)?,
                created_by: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok((debtor, entries))
}

#[tauri::command]
fn create_debtor(state: State<Db>, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>) -> Result<String, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO debtors (id, name, phone, email, address, notes, total_debt_cents, total_paid_cents, balance_cents, is_active, sync_version, last_modified, sync_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, 0, 1, 1, ?7, 'synced')",
        params![id, name, phone, email, address, notes, now],
    ).map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn update_debtor(state: State<Db>, id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE debtors SET name = ?1, phone = ?2, email = ?3, address = ?4, notes = ?5, last_modified = ?6 WHERE id = ?7",
        params![name, phone, email, address, notes, now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_debtor(state: State<Db>, id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE debtors SET is_active = 0, last_modified = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_debt(state: State<Db>, debtor_id: String, amount_cents: i64, notes: Option<String>, created_by: String, order_id: Option<String>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO debt_entries (id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, sync_version, last_modified, sync_status) VALUES (?1, ?2, ?3, ?4, 'DEBT', ?5, ?6, ?7, 1, ?7, 'synced')",
        params![id, debtor_id, order_id, amount_cents, notes, created_by, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE debtors SET total_debt_cents = total_debt_cents + ?1, balance_cents = balance_cents + ?1, last_transaction_at = ?2, last_modified = ?2 WHERE id = ?3",
        params![amount_cents, now, debtor_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn record_debt_payment(state: State<Db>, debtor_id: String, amount_cents: i64, notes: Option<String>, created_by: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO debt_entries (id, debtor_id, order_id, amount_cents, type, notes, created_by, created_at, sync_version, last_modified, sync_status) VALUES (?1, ?2, NULL, ?3, 'PAYMENT', ?4, ?5, ?6, 1, ?6, 'synced')",
        params![id, debtor_id, amount_cents, notes, created_by, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE debtors SET total_paid_cents = total_paid_cents + ?1, balance_cents = balance_cents - ?1, last_transaction_at = ?2, last_modified = ?2 WHERE id = ?3",
        params![amount_cents, now, debtor_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_kitchen_orders(state: State<Db>) -> Result<Vec<KitchenOrder>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT o.id, t.name as table_name, o.status, o.order_type, o.created_at, o.discount_reason as notes
             FROM orders o
             LEFT JOIN tables t ON t.id = o.table_id
             WHERE o.status IN ('PENDING','PREPARING','READY')
             ORDER BY o.created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let order_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut orders = Vec::new();
    for (id, table_name, status, order_type, created_at, notes) in order_rows {
        let mut item_stmt = conn
            .prepare(
                "SELECT mi.name, oi.quantity, oi.notes
                 FROM order_items oi
                 JOIN menu_items mi ON mi.id = oi.menu_item_id
                 WHERE oi.order_id = ?1 AND oi.voided = 0",
            )
            .map_err(|e| e.to_string())?;

        let items = item_stmt
            .query_map(params![id], |row| {
                Ok(KitchenItem {
                    name: row.get(0)?,
                    quantity: row.get(1)?,
                    notes: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        orders.push(KitchenOrder {
            id,
            table_name,
            order_type,
            status,
            items,
            created_at,
            notes,
        });
    }
    Ok(orders)
}

#[tauri::command]
fn update_order_status(state: State<Db>, order_id: String, status: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE orders SET status = ?1, last_modified = ?2 WHERE id = ?3",
        params![status, now, order_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_active_orders(state: State<Db>) -> Result<Vec<serde_json::Value>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT o.id, o.status, o.order_type, o.total_cents, o.created_at, t.name as table_name, o.customer_name
             FROM orders o
             LEFT JOIN tables t ON t.id = o.table_id
             WHERE o.status IN ('PENDING','PREPARING','READY','SERVED')
             ORDER BY o.created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "order_type": row.get::<_, String>(2)?,
                "total_cents": row.get::<_, i64>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "table_name": row.get::<_, Option<String>>(5)?,
                "customer_name": row.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

#[tauri::command]
fn get_settings(state: State<Db>) -> Result<SettingsData, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT chain_name, currency, tax_mode, tax_rate_cents, auto_print_receipt, auto_print_kitchen, default_paper_width FROM chain_config WHERE id = 'default'",
        [],
        |row| {
            Ok(SettingsData {
                chain_name: row.get(0)?,
                currency: row.get(1)?,
                tax_mode: row.get(2)?,
                tax_rate_cents: row.get(3)?,
                auto_print_receipt: row.get(4)?,
                auto_print_kitchen: row.get(5)?,
                default_paper_width: row.get(6)?,
            })
        },
    ).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_settings(state: State<Db>, settings: SettingsData) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE chain_config SET chain_name = ?1, currency = ?2, tax_mode = ?3, tax_rate_cents = ?4, auto_print_receipt = ?5, auto_print_kitchen = ?6, default_paper_width = ?7, last_modified = ?8 WHERE id = 'default'",
        params![settings.chain_name, settings.currency, settings.tax_mode, settings.tax_rate_cents, settings.auto_print_receipt, settings.auto_print_kitchen, settings.default_paper_width, now],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn diagnose_db(app: tauri::AppHandle) -> Result<String, String> {
    let path = db_path(&app);
    let exists = path.exists();
    let path_str = path.to_str().unwrap_or("invalid").to_string();

    let mut tables = Vec::new();
    if exists {
        if let Ok(conn) = Connection::open(&path) {
            if let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") {
                if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                    for row in rows.flatten() {
                        tables.push(row);
                    }
                }
            }
        }
    }

    let table_list = tables.join(", ");
    Ok(format!("DB path: {}\nExists: {}\nTables [{}]: {}", path_str, exists, tables.len(), table_list))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations("sqlite:zaeem_pos.db", vec![
                    Migration {
                        version: 1,
                        description: "initial_schema",
                        sql: SCHEMA_SQL,
                        kind: MigrationKind::Up,
                    },
                ])
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            let db_path = db_path(&app.handle());
            let conn = Connection::open(&db_path).expect("Failed to open database");
            init_db(&conn).expect("Failed to initialize database");
            seed_default_users(&conn).expect("Failed to seed default users");
            app.manage(Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            diagnose_db,
            login,
            logout,
            check_auth,
            change_password,
            get_debtors,
            get_debtor_detail,
            create_debtor,
            update_debtor,
            delete_debtor,
            add_debt,
            record_debt_payment,
            get_kitchen_orders,
            update_order_status,
            get_active_orders,
            get_settings,
            update_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
