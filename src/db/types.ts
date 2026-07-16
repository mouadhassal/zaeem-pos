import type { ColumnType } from "kysely";

export type UserRole = "CASHIER" | "MANAGER" | "ADMIN" | "OWNER" | "ACCOUNTANT" | "KITCHEN";
export type DriverStatus = "AVAILABLE" | "BUSY" | "OFFLINE" | "INACTIVE";
export type VehicleType = "CAR" | "MOTORCYCLE" | "BIKE" | "VAN" | "TRUCK";
export type DeliveryStatus = "ASSIGNED" | "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "CANCELLED";
export type TableStatus = "FREE" | "OCCUPIED" | "MERGED";
export type OrderStatus = "DRAFT" | "PENDING" | "PREPARING" | "READY" | "SERVED" | "PAID" | "CANCELLED" | "SCHEDULED" | "VOIDED";
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "ONLINE";
export type PaymentMethod = "CASH" | "CARD" | "WALLET" | "CREDIT";
export type SyncOp = "INSERT" | "UPDATE" | "DELETE";
export type PrinterType = "RECEIPT" | "KITCHEN" | "LABEL";
export type PrinterInterface = "USB" | "NETWORK" | "BLUETOOTH";
export type TaxMode = "inclusive" | "exclusive";

interface SyncFields {
  sync_version: ColumnType<number, number | undefined, number>;
  last_modified: ColumnType<string, string | undefined, string>;
  sync_status: ColumnType<string, string | undefined, string>;
}

export interface UsersTable extends SyncFields {
  id: string;
  email: string;
  name: string;
  username: string | null;
  password_hash: string;
  manager_pin_hash: string | null;
  role: UserRole;
  is_active: number;
  created_at: string;
  photo_path: string | null;
  cv_path: string | null;
  qr_code: string | null;
  name_en: string | null;
  phone: string | null;
  last_login: string | null;
  restaurant_id: string | null;
}

/// `staff` (T1.1's Migration A) replaced `users` (dropped by Decision A,
/// 2026-07-16) as the sole identity table. Minimal Kysely type -- just
/// enough for the read-only joins the frontend still does directly (shifts/
/// attendance/purchase_orders/inventory_logs by `.user_id`/`.created_by`);
/// full staff CRUD goes through `create_staff_v3`/`update_staff_v3`
/// (different shape entirely: no email/phone/photo/cv/qr_code columns, a
/// `role_rank` + branch_id/tenant_id scope, and hashed server-side), not a
/// direct Kysely insert/update against this table.
export interface StaffTable extends SyncFields {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  role: string;
  role_rank: number;
  name: string;
  email: string | null;
  pin_hash: string | null;
  password_hash: string | null;
  is_active: number;
  created_at: string;
}

export interface CategoriesTable extends SyncFields {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  image_path: string | null;
  is_active: number;
}

export interface MenuItemsTable extends SyncFields {
  id: string;
  name: string;
  price_cents: number;
  cost_cents: number;
  category_id: string;
  image_path: string | null;
  description: string | null;
  barcode: string | null;
  recipe_id: string | null;
  is_active: number;
  is_combo: number;
  combo_original_price_cents: number | null;
  combo_description: string | null;
}

export interface IngredientsTable extends SyncFields {
  id: string;
  name: string;
  unit: string;
  cost_cents_per_unit: number;
  current_stock: number;
  min_stock: number;
  is_active: number;
}

export interface RecipesTable extends SyncFields {
  id: string;
  menu_item_id: string;
  ingredient_id: string;
  quantity_needed: number;
}

export interface InventoryLogsTable extends SyncFields {
  id: string;
  ingredient_id: string;
  change_amount: number;
  reason: string;
  user_id: string;
  created_at: string;
}

export interface TablesTable extends SyncFields {
  id: string;
  name: string;
  status: TableStatus;
  merge_group_id: string | null;
  current_order_id: string | null;
}

export interface OrdersTable extends SyncFields {
  id: string;
  table_id: string;
  user_id: string;
  shift_id: string | null;
  status: OrderStatus;
  order_type: OrderType;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  discount_cents: number;
  discount_reason: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_fee_cents: number;
  delivery_zone_id: string | null;
  driver_id: string | null;
  scheduled_at: string | null;
  parent_order_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface OrderItemsTable extends SyncFields {
  id: string;
  order_id: string;
  menu_item_id: string;
  quantity: number;
  unit_price_cents: number;
  notes: string | null;
  combo_id: string | null;
  voided: number;
  void_reason: string | null;
}

export interface OrderModifiersTable extends SyncFields {
  id: string;
  order_item_id: string;
  name: string;
  price_cents: number;
}

export interface PaymentsTable extends SyncFields {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  change_cents: number;
  created_at: string;
}

export interface ShiftsTable extends SyncFields {
  id: string;
  user_id: string;
  opened_at: string;
  closed_at: string | null;
  starting_cash_cents: number;
  ending_cash_cents: number | null;
  difference_cents: number | null;
}

export interface SyncQueueTable {
  id: string;
  table_name: string;
  operation: SyncOp;
  record_id: string;
  payload: string;
  sync_version: ColumnType<number, number | undefined, number>;
  retry_count: ColumnType<number, number | undefined, number>;
  created_at: ColumnType<string, string | undefined, string>;
  synced_at: string | null;
  error_message: string | null;
  sync_status: ColumnType<string, string | undefined, string>;
}

export interface AuditLogsTable {
  id: string;
  user_id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  old_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  user_agent: string | null;
  timestamp: string;
  sync_version: number;
  last_modified: string;
  sync_status: string;
}

export interface PrintersTable extends SyncFields {
  id: string;
  name: string;
  printer_type: PrinterType;
  interface: PrinterInterface;
  vendor_id: string | null;
  product_id: string | null;
  ip_address: string | null;
  port: number;
  paper_width_mm: number;
  code_page: string;
  drawer_pulse_ms: number;
  is_primary: number;
  is_secondary: number;
  is_active: number;
}

export interface ComboMealsTable extends SyncFields {
  id: string;
  name: string;
  bundle_price_cents: number;
  is_active: number;
}

export interface ComboItemsTable extends SyncFields {
  id: string;
  combo_id: string;
  menu_item_id: string;
  quantity: number;
  is_free: number;
  sort_order: number;
}

export interface HappyHourRulesTable extends SyncFields {
  id: string;
  menu_item_id: string;
  discount_percent: number;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: number;
}

export interface ChainConfigTable extends SyncFields {
  id: string;
  chain_name: string;
  tax_mode: TaxMode;
  tax_rate_cents: number;
  secondary_tax_rate_cents: number;
  service_charge_rate_cents: number;
  currency: string;
  default_paper_width: number;
  auto_print_receipt: number;
  auto_print_kitchen: number;
  barcode_prefix: string;
  barcode_suffix: string;
  customer_display_port: string | null;
  customer_display_baud: number;
}

export interface DelayedOrdersTable extends SyncFields {
  id: string;
  order_id: string;
  scheduled_at: string;
  activated: number;
}

export interface BranchesTable extends SyncFields {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  timezone: string;
  currency: string;
  tax_rate_cents: number;
  max_tables: number;
  is_active: number;
}

export interface CustomersTable extends SyncFields {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  birthday: string | null;
  total_orders: number;
  total_spent_cents: number;
  last_order_at: string | null;
  loyalty_points: number;
}

export interface SuppliersTable extends SyncFields {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  total_orders: number;
  total_purchases_cents: number;
}

export interface PurchaseOrdersTable extends SyncFields {
  id: string;
  supplier_id: string;
  branch_id: string | null;
  status: string;
  total_cents: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  received_at: string | null;
}

export interface InvoicesTable extends SyncFields {
  id: string;
  chain_id: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  status: string;
  due_date: string;
  paid_at: string | null;
  notes: string | null;
}

export interface OperationalCostsTable extends SyncFields {
  id: string;
  category: string;
  amount_cents: number;
  description: string | null;
  date: string;
  branch_id: string | null;
  user_id: string;
  notes: string | null;
}

export interface AttendanceTable extends SyncFields {
  id: string;
  user_id: string;
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  status: string;
}

export interface TerminalsTable extends SyncFields {
  id: string;
  branch_id: string;
  name: string;
  last_sync: string | null;
  version: string;
  status: string;
}

export interface DebtorsTable extends SyncFields {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  total_debt_cents: number;
  total_paid_cents: number;
  balance_cents: number;
  last_transaction_at: string | null;
  is_active: number;
}

export interface DebtEntriesTable extends SyncFields {
  id: string;
  debtor_id: string;
  order_id: string | null;
  amount_cents: number;
  type: "DEBT" | "PAYMENT";
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface LoginSessionsTable {
  id: string;
  user_id: string;
  login_time: string;
  logout_time: string | null;
  ip_address: string | null;
  device_info: string | null;
  is_active: number;
}

export interface AppSettingsTable {
  key: string;
  value: string;
}

export interface NotificationsTable {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  is_read: number;
  link: string | null;
  created_at: string;
}

export interface DriversTable extends SyncFields {
  id: string;
  name: string;
  phone: string;
  photo_path: string | null;
  vehicle_type: VehicleType;
  vehicle_plate: string | null;
  license_number: string | null;
  status: DriverStatus;
  current_lat: number | null;
  current_lng: number | null;
  total_deliveries: number;
  rating: number;
  is_active: number;
}

export interface DeliveryZonesTable extends SyncFields {
  id: string;
  name: string;
  boundaries: string;
  fee_cents: number;
  min_order_cents: number;
  estimated_minutes: number;
  is_active: number;
}

export interface DeliveryLogsTable extends SyncFields {
  id: string;
  order_id: string;
  driver_id: string;
  status: DeliveryStatus;
  assigned_at: string;
  picked_up_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  notes: string | null;
}

export interface PurchaseOrderItemsTable extends SyncFields {
  id: string;
  purchase_order_id: string;
  ingredient_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_cost_cents: number;
}

export interface LoyaltyCardsTable extends SyncFields {
  id: string;
  customer_id: string;
  card_number: string;
  points: number;
  tier: string;
  issued_at: string;
  last_used_at: string | null;
  is_active: number;
}

export interface LoyaltyTransactionsTable extends SyncFields {
  id: string;
  card_id: string;
  points: number;
  type: string;
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  created_at: string;
}

export interface Database {
  audit_logs: AuditLogsTable;
  users: UsersTable;
  staff: StaffTable;
  categories: CategoriesTable;
  menu_items: MenuItemsTable;
  ingredients: IngredientsTable;
  recipes: RecipesTable;
  inventory_logs: InventoryLogsTable;
  tables: TablesTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  order_modifiers: OrderModifiersTable;
  payments: PaymentsTable;
  shifts: ShiftsTable;
  sync_queue: SyncQueueTable;
  printers: PrintersTable;
  combo_meals: ComboMealsTable;
  combo_items: ComboItemsTable;
  happy_hour_rules: HappyHourRulesTable;
  chain_config: ChainConfigTable;
  delayed_orders: DelayedOrdersTable;
  branches: BranchesTable;
  customers: CustomersTable;
  suppliers: SuppliersTable;
  purchase_orders: PurchaseOrdersTable;
  invoices: InvoicesTable;
  operational_costs: OperationalCostsTable;
  attendance: AttendanceTable;
  terminals: TerminalsTable;
  debtors: DebtorsTable;
  debt_entries: DebtEntriesTable;
  login_sessions: LoginSessionsTable;
  app_settings: AppSettingsTable;
  notifications: NotificationsTable;
  drivers: DriversTable;
  delivery_zones: DeliveryZonesTable;
  delivery_logs: DeliveryLogsTable;
  purchase_order_items: PurchaseOrderItemsTable;
  loyalty_cards: LoyaltyCardsTable;
  loyalty_transactions: LoyaltyTransactionsTable;
}
