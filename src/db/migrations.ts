import Database from "@tauri-apps/plugin-sql";
import schema from "./schema.sql?raw";

let initialized = false;

export async function runMigrations(): Promise<void> {
  if (initialized) return;
  const db = await Database.load("sqlite:zaeem_pos.db");

  const statements = schema
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await db.execute(stmt + ";");
  }

  await db.execute("PRAGMA journal_mode = WAL");
  await db.execute("PRAGMA synchronous = NORMAL");
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute("PRAGMA busy_timeout = 5000");

  const indexStatements = [
    "CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_orders_table_id ON orders(table_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)",
    "CREATE INDEX IF NOT EXISTS idx_orders_order_type ON orders(order_type)",
    "CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_orders_scheduled_at ON orders(scheduled_at)",
    "CREATE INDEX IF NOT EXISTS idx_sync_queue_synced_at ON sync_queue(synced_at)",
    "CREATE INDEX IF NOT EXISTS idx_sync_queue_retry_count ON sync_queue(retry_count)",
    "CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(sync_status)",
    "CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)",
    "CREATE INDEX IF NOT EXISTS idx_menu_items_category_id ON menu_items(category_id)",
    "CREATE INDEX IF NOT EXISTS idx_shifts_user_id ON shifts(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_inventory_logs_ingredient_id ON inventory_logs(ingredient_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)",
    "CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)",
    "CREATE INDEX IF NOT EXISTS idx_printers_type ON printers(printer_type)",
    "CREATE INDEX IF NOT EXISTS idx_combo_items_combo_id ON combo_items(combo_id)",
    "CREATE INDEX IF NOT EXISTS idx_happy_hour_rules_item ON happy_hour_rules(menu_item_id)",
    "CREATE INDEX IF NOT EXISTS idx_delayed_orders_activated ON delayed_orders(activated)",
    "CREATE INDEX IF NOT EXISTS idx_delayed_orders_scheduled ON delayed_orders(scheduled_at)",
    "CREATE INDEX IF NOT EXISTS idx_branches_name ON branches(name)",
    "CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)",
    "CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)",
    "CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name)",
    "CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id)",
    "CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date)",
    "CREATE INDEX IF NOT EXISTS idx_operational_costs_date ON operational_costs(date)",
    "CREATE INDEX IF NOT EXISTS idx_operational_costs_category ON operational_costs(category)",
    "CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)",
    "CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, date)",
    "CREATE INDEX IF NOT EXISTS idx_terminals_branch ON terminals(branch_id)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)",
  ];

  for (const idx of indexStatements) {
    try {
      await db.execute(idx);
    } catch {
      // index may already exist
    }
  }

  initialized = true;
}
