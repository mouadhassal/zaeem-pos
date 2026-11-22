//! Remote back office: the commands a second till may run on the main till (hub) once the owner
//! allowed that specific device (Settings > الشبكة المحلية). One allowlist, one authoritative gate.
//!
//! * `BACK_OFFICE_REMOTE_COMMANDS` is the list. `src/lib/lan.ts` names exactly the same set
//!   (`lan.test.ts` reads this file to enforce it).
//! * Each command has an arm in `dispatch_remote_office` of the file that owns it (so the argument
//!   types are in scope there); every arm calls the same `_impl` the local `#[tauri::command]`
//!   wraps, so the person's own permission checks, licence gate and audit are the hub's own.
//! * `lan::execute_rpc` refuses the command unless the calling device is allowed
//!   (`lan::back_office_gate`); that check is authoritative, the sidebar is only a courtesy.
//!
//! Left out on purpose: printers, preferences, LAN config, licence, updater, backups, diagnostics,
//! the assistant chat, the supplier market sync (all device-local or network-side work) and the
//! fingerprint reader (hardware on the machine it is plugged into).

use crate::Db;
use crate::license::cloud::CloudLicenseState;

pub const BACK_OFFICE_REMOTE_COMMANDS: &[&str] = &[
    // auth.rs
    "create_branch_v3",
    "create_staff_v3",
    "update_staff_v3",
    "list_branches_v3",
    "list_staff_v3",
    "update_staff_profile_v3",
    "set_staff_active_v3",
    // branches.rs
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
    // customers.rs
    "create_customer_v3",
    "list_customers_v3",
    "update_customer_v3",
    "delete_customer_v3",
    "get_customer_detail_v3",
    // debt.rs
    "update_debtor_v3",
    "deactivate_debtor_v3",
    "list_debt_entries_v3",
    "record_debt_payment_v3",
    // delivery.rs
    "update_delivery_settings_v3",
    "save_delivery_driver_v3",
    // finance.rs
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
    // fingerprint.rs
    "list_fingerprint_enrolments_v3",
    "delete_fingerprint_enrolment_v3",
    "list_punches_v3",
    "get_attendance_settings_v3",
    "set_attendance_settings_v3",
    // inventory.rs
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
    // loyalty.rs
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
    // marketplace.rs
    "get_marketplace_context_v3",
    "receive_marketplace_order_v3",
    // menu.rs
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
    // orders.rs
    "list_recent_paid_orders_v3",
    // order_history.rs
    "save_history_access_v3",
    // payroll.rs
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
    // reports.rs
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
    // restaurant.rs
    "save_option_group_v3",
    "delete_option_group_v3",
    // role_access.rs
    "get_role_access_v3",
    "save_role_access_v3",
    "get_staff_access_v3",
    "save_staff_access_v3",
    // settings.rs
    "update_chain_name_v3",
    "update_chain_currency_v3",
    "update_chain_tax_v3",
    "update_discount_caps_v3",
    "update_manager_thresholds_v3",
    "get_legacy_branch_v3",
    "save_legacy_branch_v3",
    // shifts.rs
    "list_shifts_v3",
    "force_close_shift_v3",
    "list_attendance_v3",
    // staff.rs
    "list_roster_entries_v3",
    "create_roster_entry_v3",
    "update_roster_entry_v3",
    "delete_roster_entry_v3",
    // stockroom.rs
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
    // suppliers.rs
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
    // venue.rs
    "save_delivery_platform_v3",
    "platform_accounts_v3",
    "record_platform_settlement_v3",
    "list_platform_settlements_v3",
    "save_receipt_template_v3",
    "delete_receipt_template_v3",
    // workforce.rs
    "create_worker_v3",
    "update_worker_v3",
    "set_staff_job_title_v3",
];

/// One file's arms: `Ok(None)` when the command is not one of that file's.
type OfficeDispatch = fn(&Db, &CloudLicenseState, &str, &serde_json::Value) -> Result<Option<serde_json::Value>, String>;

/// True for a command a second till may run on the hub only with the owner's permission.
pub fn is_back_office_command(command: &str) -> bool {
    BACK_OFFICE_REMOTE_COMMANDS.contains(&command)
}

/// Runs one allowlisted back-office command. `Err("UNKNOWN_COMMAND")` for anything else.
pub fn dispatch_back_office_rpc(db: &Db, license: &CloudLicenseState, command: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    if !is_back_office_command(command) {
        return Err("UNKNOWN_COMMAND".to_string());
    }
    let tries: [OfficeDispatch; 24] = [
        super::auth::dispatch_remote_office,
        super::branches::dispatch_remote_office,
        super::customers::dispatch_remote_office,
        super::debt::dispatch_remote_office,
        super::delivery::dispatch_remote_office,
        super::finance::dispatch_remote_office,
        super::fingerprint::dispatch_remote_office,
        super::inventory::dispatch_remote_office,
        super::loyalty::dispatch_remote_office,
        super::marketplace::dispatch_remote_office,
        super::menu::dispatch_remote_office,
        super::orders::dispatch_remote_office,
        super::order_history::dispatch_remote_office,
        super::payroll::dispatch_remote_office,
        super::reports::dispatch_remote_office,
        super::restaurant::dispatch_remote_office,
        super::role_access::dispatch_remote_office,
        super::settings::dispatch_remote_office,
        super::shifts::dispatch_remote_office,
        super::staff::dispatch_remote_office,
        super::stockroom::dispatch_remote_office,
        super::suppliers::dispatch_remote_office,
        super::venue::dispatch_remote_office,
        super::workforce::dispatch_remote_office,
    ];
    for dispatch in tries {
        if let Some(v) = dispatch(db, license, command, args)? {
            return Ok(v);
        }
    }
    Err("UNKNOWN_COMMAND".to_string())
}
