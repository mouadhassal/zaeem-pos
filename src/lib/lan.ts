import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "./invoke";

/**
 * LAN RPC allowlist -- every command here is sent to the branch's Hub when
 * this terminal is a paired Satellite, and runs against the Hub's SQLite
 * instead of this terminal's own (empty) one. Must match the `"name" =>`
 * arms of `dispatch_lan_rpc` in `src-tauri/src/commands/lan_rpc.rs`
 * (`lan.test.ts` fails if the two drift apart). A command NOT in this set
 * always runs against this terminal's own local SQLite, even on a
 * Satellite: that is deliberate for per-device things (printers, settings,
 * license, backups, LAN config, device id). Back-office work (reports, staff,
 * inventory, menu editing) is relayed through `BACK_OFFICE_REMOTE_COMMANDS`
 * below, only for a device the hub's owner allowed.
 *
 * What IS forwarded is everything the till needs to sell from the Hub's
 * data: the shared menu (items, categories, options, combos, happy hours,
 * photos), tables, open tabs, hold/retrieve, add-to-order, edit/gift of a
 * line, split/merge/transfer, delayed orders, payment, shifts, manager
 * override, the branch's tax/currency/receipt header, debtors, loyalty, and
 * delivery.
 */
export const LAN_REDIRECT_COMMANDS = new Set([
  // session + shift
  "login_pin_v3",
  "logout_v3",
  "get_active_shift_v3",
  "clock_in_v3",
  "clock_out_v3",
  "open_shift_v3",
  "close_shift_v3",
  "get_shift_stats_v3",
  "verify_manager_override_v3",
  "get_manager_thresholds_v3",
  "get_discount_caps_v3",
  "get_business_mode_v3",
  "get_my_access_v3",
  "get_chain_config_v3",
  "get_receipt_config_v3",
  // shared menu (the Hub owns item ids, prices, availability)
  "list_menu_items_v3",
  "list_categories_v3",
  "list_option_groups_v3",
  "list_combo_meals_v3",
  "list_combo_meal_items_v3",
  "list_combo_components_v3",
  "list_happy_hour_rules_v3",
  "get_menu_item_photo_v3",
  "toggle_menu_item_availability_v3",
  // tables and orders
  "list_tables_v3",
  "create_table_v3",
  "rename_table_v3",
  "delete_table_v3",
  "list_kitchen_orders_v3",
  "update_order_status_v3",
  "create_full_order_v3",
  "list_pending_orders_for_table_v3",
  "retrieve_open_order_v3",
  "retrieve_held_order_v3",
  "add_items_to_order_v3",
  "set_order_no_bill_v3",
  "hold_order_v3",
  "edit_order_item_v3",
  "set_order_item_comp_v3",
  "void_order_item_v3",
  "cancel_order_v3",
  "transfer_order_v3",
  "split_bill_v3",
  "merge_tables_v3",
  "merge_orders_v3",
  "list_open_orders_v3",
  "set_order_platform_v3",
  "list_delivery_platforms_v3",
  "list_dining_areas_v3",
  "save_dining_area_v3",
  "delete_dining_area_v3",
  "set_table_area_v3",
  "unmerge_tables_v3",
  "schedule_delayed_order_v3",
  "activate_delayed_orders_v3",
  // payment
  "take_payment_v3",
  "finalize_order_with_payment_v3",
  // customers on the till: debtors and loyalty
  "list_debtors_v3",
  "create_debtor_v3",
  "link_debtor_customer_v3",
  "lookup_loyalty_card_v3",
  "list_loyalty_rewards_v3",
  "redeem_loyalty_reward_v3",
  // delivery
  "get_delivery_settings_v3",
  "list_delivery_drivers_v3",
  "list_deliveries_v3",
  "assign_delivery_driver_v3",
  "set_delivery_status_v3",
  "settle_driver_v3",
  "get_driver_statement_v3",
  "list_driver_settlements_v3",
  // pickup queue (phone orders collected later)
  "list_pickup_orders_v3",
  "claim_due_pickup_kitchen_v3",
  "send_pickup_to_kitchen_now_v3",
  "mark_pickup_no_show_v3",
  // order history, daily numbers, refunds
  "get_order_numbers_v3",
  "list_order_history_v3",
  "get_order_history_detail_v3",
  "record_receipt_reprint_v3",
  "refund_order_v3",
]);

/**
 * Commands that have a Hub arm in `dispatch_lan_rpc` but are NOT redirected
 * for every caller: they are only ever asked of the Hub on purpose, through
 * `invokeOnHub`. Everything else on a Satellite stays local. (The Rust arm
 * `__resolve_actor_v3` is a third kind -- called by the Hub-fallback in
 * `authenticate_actor`, never by the frontend.)
 */
export const HUB_ONLY_HELPERS = new Set(["list_active_printers_v3", "list_printer_categories_v3", "list_receipt_templates_v3"]);

/**
 * Back-office commands a second till relays to the main till (the hub) when the owner allowed THIS
 * device to open the back office (Settings > الشبكة المحلية on the hub). Must be exactly the names in
 * `BACK_OFFICE_REMOTE_COMMANDS` in `src-tauri/src/commands/lan_rpc_office.rs` (`lan.test.ts` fails if
 * they drift). The hub is the authority: it refuses a device that is not allowed, whatever this
 * list says, and the signed-in person's own permissions still apply there.
 *
 * Not here on purpose: printers, preferences, LAN config, licence, updater, backups, diagnostics,
 * the assistant chat and the supplier market sync (per-device or network-side work).
 */
export const BACK_OFFICE_REMOTE_COMMANDS = new Set([
  // auth
  "create_branch_v3",
  "create_staff_v3",
  "update_staff_v3",
  "list_branches_v3",
  "list_staff_v3",
  "update_staff_profile_v3",
  "set_staff_active_v3",
  // branches
  "list_branches_full_v3",
  "create_branch_full_v3",
  "update_branch_full_v3",
  "set_branch_full_active_v3",
  "update_branch_detail_field_v3",
  "list_terminals_v3",
  "get_tenant_today_stats_v3",
  "get_branch_today_stats_v3",
  "get_staff_counts_by_branch_v3",
  "get_terminal_counts_by_branch_v3",
  // customers
  "get_customer_debt_v3",
  "create_customer_v3",
  "list_customers_v3",
  "update_customer_v3",
  "delete_customer_v3",
  "get_customer_detail_v3",
  // debt
  "get_debt_statement_v3",
  "unlink_debtor_customer_v3",
  "update_debtor_v3",
  "deactivate_debtor_v3",
  "list_debt_entries_v3",
  "record_debt_payment_v3",
  // delivery
  "update_delivery_settings_v3",
  "save_delivery_driver_v3",
  // finance
  "get_cost_report_v3",
  "get_finance_settings_v3",
  "save_finance_settings_v3",
  "list_rent_contracts_v3",
  "save_rent_contract_v3",
  "record_rent_payment_v3",
  "upload_cost_attachment_v3",
  "get_cost_attachment_v3",
  "set_category_cost_class_v3",
  "get_cost_of_sales_v3",
  // fingerprint
  "list_fingerprint_enrolments_v3",
  "delete_fingerprint_enrolment_v3",
  "list_punches_v3",
  "get_attendance_settings_v3",
  "set_attendance_settings_v3",
  // inventory
  "list_ingredients_v3",
  "create_ingredient_v3",
  "update_ingredient_v3",
  "adjust_stock_v3",
  "record_stock_count_v3",
  "list_stock_counts_v3",
  "get_cogs_variance_report_v3",
  "get_menu_margin_report_v3",
  "list_recipe_ingredients_v3",
  "add_recipe_ingredient_v3",
  "update_recipe_ingredient_v3",
  "delete_recipe_ingredient_v3",
  "list_units_v3",
  "list_ingredient_units_v3",
  "save_ingredient_unit_v3",
  "delete_ingredient_unit_v3",
  "list_batch_recipes_v3",
  "save_batch_recipe_v3",
  "produce_batch_v3",
  "list_production_runs_v3",
  "record_waste_v3",
  "list_waste_v3",
  "get_stock_report_v3",
  // loyalty
  "list_loyalty_cards_v3",
  "issue_loyalty_card_v3",
  "list_loyalty_transactions_v3",
  "list_loyalty_tiers_v3",
  "create_loyalty_tier_v3",
  "update_loyalty_tier_v3",
  "delete_loyalty_tier_v3",
  "create_loyalty_reward_v3",
  "set_loyalty_reward_active_v3",
  "delete_loyalty_reward_v3",
  // marketplace
  "get_marketplace_context_v3",
  "receive_marketplace_order_v3",
  // menu
  "create_category_v3",
  "update_category_v3",
  "delete_category_v3",
  "upload_category_photo_v3",
  "delete_category_photo_v3",
  "get_category_photo_v3",
  "upload_menu_item_photo_v3",
  "delete_menu_item_photo_v3",
  "create_menu_item_v3",
  "update_menu_item_v3",
  "set_menu_item_sold_by_v3",
  "delete_menu_item_v3",
  "set_menu_item_active_v3",
  "create_combo_meal_v3",
  "update_combo_meal_v3",
  "delete_combo_meal_v3",
  "create_happy_hour_rule_v3",
  "update_happy_hour_rule_v3",
  "delete_happy_hour_rule_v3",
  "set_happy_hour_rule_active_v3",
  // orders
  "list_recent_paid_orders_v3",
  // order_history
  "save_history_access_v3",
  // payroll
  "add_payroll_day_deduction_v3",
  "delete_payroll_day_deduction_v3",
  "get_attendance_review_v3",
  "set_attendance_day_v3",
  "clear_attendance_day_v3",
  "set_attendance_approval_v3",
  "get_worker_statement_v3",
  "get_payroll_access_v3",
  "get_payroll_settings_v3",
  "save_payroll_settings_v3",
  "list_payroll_employees_v3",
  "save_payroll_employee_v3",
  "payroll_month_v3",
  "get_payslip_v3",
  "approve_payslip_v3",
  "pay_payslip_v3",
  "reopen_payslip_v3",
  "add_payroll_adjustment_v3",
  "delete_payroll_adjustment_v3",
  "add_payroll_advance_v3",
  "list_payroll_advances_v3",
  "cancel_payroll_advance_v3",
  "set_paid_leave_v3",
  "add_manual_punch_v3",
  // reports
  "get_sales_breakdown_v3",
  "list_breakdown_orders_v3",
  "get_cancellations_report_v3",
  "get_customers_report_v3",
  "get_kitchen_delivery_report_v3",
  "get_menu_engineering_v3",
  "list_activity_log_v3",
  "list_activity_kinds_v3",
  "get_finance_revenue_v3",
  "get_dashboard_summary_v3",
  "get_profit_trend_v3",
  "get_tax_collected_v3",
  "list_operational_costs_v3",
  "create_operational_cost_v3",
  "update_operational_cost_v3",
  "list_invoices_v3",
  "create_invoice_v3",
  "mark_invoice_paid_v3",
  "gifts_report_v3",
  "get_sales_report_v3",
  "get_sales_strip_v3",
  "assistant_insights_v3",
  "detect_anomalies_v3",
  "forecast_demand_v3",
  "reconcile_orders_v3",
  // restaurant
  "save_option_group_v3",
  "delete_option_group_v3",
  // role_access
  "get_role_access_v3",
  "save_role_access_v3",
  "get_staff_access_v3",
  "save_staff_access_v3",
  // settings
  "update_chain_name_v3",
  "update_chain_currency_v3",
  "update_chain_tax_v3",
  "update_discount_caps_v3",
  "update_manager_thresholds_v3",
  "get_legacy_branch_v3",
  "save_legacy_branch_v3",
  // shifts
  "list_shifts_v3",
  "force_close_shift_v3",
  "list_attendance_v3",
  // staff
  "list_roster_entries_v3",
  "create_roster_entry_v3",
  "update_roster_entry_v3",
  "delete_roster_entry_v3",
  // stockroom
  "list_product_stock_v3",
  "set_product_tracking_v3",
  "adjust_product_stock_v3",
  "count_product_stock_v3",
  "receive_products_v3",
  "list_product_stock_log_v3",
  "import_products_v3",
  "list_product_barcodes_v3",
  "add_product_barcode_v3",
  "delete_product_barcode_v3",
  "generate_product_barcode_v3",
  "get_retail_settings_v3",
  "save_retail_settings_v3",
  // suppliers
  "create_purchase_order_v3",
  "create_purchase_order_and_bump_supplier_v3",
  "create_purchase_order_with_items_v3",
  "create_purchase_order_with_units_v3",
  "list_purchase_orders_v3",
  "cancel_purchase_order_v3",
  "list_purchase_order_items_v3",
  "receive_purchase_order_v3",
  "record_supplier_payment_v3",
  "list_supplier_payments_v3",
  "list_suppliers_v3",
  "create_supplier_v3",
  "update_supplier_v3",
  "delete_supplier_v3",
  "list_inventory_logs_v3",
  "list_reorder_suggestions_v3",
  "list_low_stock_ingredients_v3",
  // venue
  "save_delivery_platform_v3",
  "platform_accounts_v3",
  "record_platform_settlement_v3",
  "list_platform_settlements_v3",
  "save_receipt_template_v3",
  "delete_receipt_template_v3",
  // workforce
  "create_worker_v3",
  "update_worker_v3",
  "set_staff_job_title_v3",
]);

/** What the hub says to a device that is not allowed (the hub's own sentence; kept here for the tests and the UI). */
export const BACK_OFFICE_REFUSED = "هذا الجهاز غير مسموح له بفتح الإدارة. اسمح له من الجهاز الرئيسي > الشبكة المحلية";

/**
 * Edits refused on a Satellite because they act on hardware or settings of the machine they run
 * on: the fingerprint reader (enrolling, punching) and the printer routing of this machine. The
 * rest of the former menu-edit list is relayed now (see `BACK_OFFICE_REMOTE_COMMANDS`).
 */
export const HUB_ONLY_WRITES = new Set([
  "enrol_fingerprint_v3",
  "fingerprint_punch_v3",
  "set_printer_categories_v3",
  "set_printer_template_v3",
]);

export const HUB_ONLY_WRITE_ERROR = "هذا الإجراء يتم من الجهاز الرئيسي فقط";

/** True when this terminal is a paired Satellite (cached; see `invalidateLanTargetCache`). */
export async function isSatellite(): Promise<boolean> {
  return (await getLanTarget()) !== null;
}


interface LanRelayResult<T> {
  redirected: boolean;
  data?: T;
  error?: string | null;
}

/**
 * Called by `invoke.ts` for every command on `LAN_REDIRECT_COMMANDS`
 * before it would otherwise run locally. Returns `{ redirected: false }`
 * for the overwhelming majority of calls (standalone and Hub terminals,
 * which never redirect) -- the caller falls through to the normal local
 * `invoke` in that case, at the cost of one extra cheap round-trip to a
 * synchronous file read on the Rust side.
 */
export async function relayIfSatellite<T>(command: string, args?: Record<string, unknown>): Promise<LanRelayResult<T>> {
  return tauriInvoke<LanRelayResult<T>>("lan_relay_v3", { command, args: args ?? {} });
}

/**
 * Runs `command` on the Hub when this terminal is a paired Satellite, and
 * locally otherwise -- without putting the command on
 * `LAN_REDIRECT_COMMANDS`. Used by the kitchen-ticket path: the kitchen
 * network printers and their category routing are configured on the Hub, so
 * a Satellite must read them from there, while the same screens' settings
 * pages (and receipt printing, often a USB printer on this very machine)
 * keep reading this terminal's own printer list.
 *
 * `viaHub` tells the caller which side the answer came from. If the relay
 * probe itself cannot run (no Tauri runtime, e.g. unit tests or the browser
 * preview) this behaves as a standalone terminal. A relayed call that
 * fails (Hub unreachable) is an error, never a silent local fallback: the
 * local answer would be a different, wrong printer list.
 */
export async function invokeOnHub<T>(command: string, args?: Record<string, unknown>): Promise<{ data: T; viaHub: boolean }> {
  let relayed: LanRelayResult<T> | null = null;
  try {
    relayed = await relayIfSatellite<T>(command, args);
  } catch {
    relayed = null;
  }
  if (relayed?.redirected) {
    if (relayed.error) throw new Error(relayed.error);
    return { data: relayed.data as T, viaHub: true };
  }
  return { data: await invoke<T>(command, args), viaHub: false };
}

/**
 * `hubAddr` is empty for a till that joined over the internet (no LAN
 * address); `cloud` says the internet route is on for it.
 */
interface LanTarget {
  hubAddr: string;
  cloud: boolean;
}

let cachedTarget: LanTarget | null | undefined;

async function getLanTarget(): Promise<LanTarget | null> {
  if (cachedTarget !== undefined) return cachedTarget;
  try {
    const target = await tauriInvoke<{ hubAddr?: string | null; cloud?: boolean } | null>("get_lan_redirect_target_v3");
    cachedTarget = target ? { hubAddr: target.hubAddr ?? "", cloud: target.cloud ?? false } : null;
  } catch {
    cachedTarget = null;
  }
  return cachedTarget;
}

/** Call after pairing/forgetting so the next `connectLanChangeSocket` picks up the new role without an app restart. */
export function invalidateLanTargetCache(): void {
  cachedTarget = undefined;
}

/** The Tauri event the Rust side emits for a "something changed" nudge that arrived over the internet. */
export const LAN_CHANGE_EVENT = "lan-change";

/**
 * Opens a WebSocket to the paired Hub's "something changed" broadcast
 * (see `broadcast_change` in `lan.rs`) and calls `onChange` for every
 * message -- the payload itself carries no data, it's just a nudge to
 * re-fetch, so callers should already have a working `fetchX()` to re-run.
 * No-op (returns a no-op cleanup) on standalone/Hub terminals. Reconnects
 * with a fixed backoff on drop (bad Wi-Fi, Hub restart) since this exists
 * to survive exactly that.
 */
export function connectLanChangeSocket(onChange: () => void): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | null = null;

  async function connect() {
    if (stopped) return;
    const target = await getLanTarget();
    if (!target || stopped) return;
    // Nudges that arrive through the internet route (the Hub is not on this
    // till's LAN, or the LAN is down). Harmless when the LAN socket works too.
    if (target.cloud && !unlisten) {
      try {
        const off = await listen(LAN_CHANGE_EVENT, () => onChange());
        if (stopped) off();
        else unlisten = off;
      } catch {
        // no Tauri event bridge (tests, browser preview): LAN socket + polling remain
      }
    }
    if (!target.hubAddr || stopped) return;
    try {
      socket = new WebSocket(`ws://${target.hubAddr}/ws`);
      socket.onmessage = () => onChange();
      socket.onclose = scheduleRetry;
      socket.onerror = () => socket?.close();
    } catch {
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, 5000);
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
    unlisten?.();
  };
}
