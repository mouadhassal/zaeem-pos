-- up
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    checksum TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_purchases_cents INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    supplier_id TEXT NOT NULL REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ORDERED','RECEIVED','CANCELLED')),
    total_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    received_at TEXT,
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

CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    vehicle_type TEXT NOT NULL DEFAULT 'CAR' CHECK(vehicle_type IN ('CAR','MOTORCYCLE','BIKE','VAN','TRUCK')),
    status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','BUSY','OFFLINE','INACTIVE')),
    total_deliveries INTEGER NOT NULL DEFAULT 0,
    rating REAL,
    photo_path TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS delivery_zones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    boundaries TEXT NOT NULL DEFAULT '{}',
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
    status TEXT NOT NULL,
    failure_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS loyalty_cards (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    card_number TEXT UNIQUE NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'BRONZE' CHECK(tier IN ('BRONZE','SILVER','GOLD','PLATINUM')),
    issued_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    period_start TEXT,
    period_end TEXT,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PAID','OVERDUE','CANCELLED')),
    due_date TEXT,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS operational_costs (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL DEFAULT (datetime('now')),
    branch_id TEXT,
    user_id TEXT NOT NULL REFERENCES users(id),
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS debtors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    total_debt_cents INTEGER NOT NULL DEFAULT 0,
    total_paid_cents INTEGER NOT NULL DEFAULT 0,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    last_transaction_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS debt_entries (
    id TEXT PRIMARY KEY,
    debtor_id TEXT NOT NULL REFERENCES debtors(id),
    order_id TEXT,
    amount_cents INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('DEBT','PAYMENT')),
    notes TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS chain_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    chain_name TEXT NOT NULL DEFAULT 'Zaeem POS',
    currency TEXT NOT NULL DEFAULT 'SYP',
    tax_mode TEXT NOT NULL DEFAULT 'exclusive' CHECK(tax_mode IN ('inclusive','exclusive')),
    tax_rate_cents INTEGER NOT NULL DEFAULT 0,
    auto_print_receipt INTEGER NOT NULL DEFAULT 0,
    auto_print_kitchen INTEGER NOT NULL DEFAULT 0,
    default_paper_width INTEGER NOT NULL DEFAULT 80,
    barcode_prefix TEXT NOT NULL DEFAULT '',
    barcode_suffix TEXT NOT NULL DEFAULT '',
    customer_display_enabled INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'synced'
);

CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    phone TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Damascus',
    currency TEXT NOT NULL DEFAULT 'SYP',
    tax_rate_cents INTEGER NOT NULL DEFAULT 0,
    max_tables INTEGER NOT NULL DEFAULT 20,
    open_time TEXT,
    close_time TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    printer_type TEXT NOT NULL DEFAULT 'RECEIPT' CHECK(printer_type IN ('RECEIPT','KITCHEN','LABEL')),
    interface TEXT NOT NULL DEFAULT 'USB' CHECK(interface IN ('USB','NETWORK','BLUETOOTH')),
    ip_address TEXT,
    port INTEGER NOT NULL DEFAULT 9100,
    paper_width_mm INTEGER NOT NULL DEFAULT 80,
    code_page INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS terminals (
    id TEXT PRIMARY KEY,
    branch_id TEXT,
    name TEXT NOT NULL,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE','OFFLINE')),
    last_seen TEXT,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combo_meals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bundle_price_cents INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS combo_items (
    id TEXT PRIMARY KEY,
    combo_id TEXT NOT NULL REFERENCES combo_meals(id),
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS delayed_orders (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    scheduled_at TEXT NOT NULL,
    activated INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_spent_cents INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'info',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS login_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    login_time TEXT NOT NULL DEFAULT (datetime('now')),
    logout_time TEXT,
    device_info TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sync_version INTEGER NOT NULL DEFAULT 1,
    last_modified TEXT NOT NULL DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending'
);
