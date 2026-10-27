//! POS Lite (licence plan `pos_lite`): the till only -- selling, tables,
//! item options, kitchen slips and screen, menu, pickup, delivery and
//! drivers, customers, cashiers, shifts, order history and refunds,
//! settings. No reports, finance, inventory or suppliers, debt book,
//! loyalty, HR (attendance, roster), branches, AI, supplier marketplace,
//! and no cloud upload (decided by the owner 2026-10-26).
//!
//! The gate is ONE list checked in the invoke handler (lib.rs) before any
//! command runs, so a Full-only command can't be forgotten in a body; the
//! older per-command `require_plan_includes_management` calls stay as a
//! second check. A plan read from a verified licence decides it; `Invalid`
//! has no plan and is left to the licence gates (fail open, as
//! `require_plan_includes_management` explains).

use crate::license::signed::LicenseStatus;

pub const LITE_PLAN: &str = "pos_lite";

pub const LITE_REFUSED: &str = "هذه الميزة غير متوفرة في POS Lite -- تواصل معنا للترقية إلى الباقة الكاملة";

/// Every command a `pos_lite` till refuses. Anything not listed is allowed,
/// so a new Full-only command must be added here (the tests below check
/// each name is a real registered command).
pub const FULL_ONLY_COMMANDS: &[&str] = &[
    // branches
    "list_branches_full_v3", "create_branch_full_v3", "update_branch_full_v3", "set_branch_full_active_v3",
    "update_branch_detail_field_v3", "list_terminals_v3", "get_tenant_today_stats_v3", "get_branch_today_stats_v3",
    "get_staff_counts_by_branch_v3", "get_terminal_counts_by_branch_v3",
    // inventory and recipes
    "list_ingredients_v3", "create_ingredient_v3", "update_ingredient_v3", "adjust_stock_v3", "record_stock_count_v3",
    "list_stock_counts_v3", "get_cogs_variance_report_v3", "get_menu_margin_report_v3", "list_recipe_ingredients_v3",
    "add_recipe_ingredient_v3", "update_recipe_ingredient_v3", "delete_recipe_ingredient_v3",
    // suppliers and purchasing
    "create_purchase_order_v3", "create_purchase_order_and_bump_supplier_v3", "create_purchase_order_with_items_v3",
    "list_purchase_orders_v3", "cancel_purchase_order_v3", "list_purchase_order_items_v3", "receive_purchase_order_v3",
    "record_supplier_payment_v3", "list_supplier_payments_v3", "list_suppliers_v3", "create_supplier_v3",
    "update_supplier_v3", "delete_supplier_v3", "list_inventory_logs_v3", "list_reorder_suggestions_v3",
    "list_low_stock_ingredients_v3",
    // supplier marketplace
    "get_marketplace_context_v3", "list_marketplace_receipts_v3", "receive_marketplace_order_v3",
    // dashboard, finance, reports
    "get_finance_revenue_v3", "get_dashboard_summary_v3", "get_tax_collected_v3", "list_operational_costs_v3",
    "create_operational_cost_v3", "list_invoices_v3", "create_invoice_v3", "mark_invoice_paid_v3",
    "gifts_report_v3", "get_sales_report_v3", "detect_anomalies_v3", "forecast_demand_v3", "reconcile_orders_v3",
    "list_pickup_no_shows_v3",
    // HR
    "list_attendance_v3", "clock_in_v3", "clock_out_v3", "list_roster_entries_v3", "create_roster_entry_v3",
    "update_roster_entry_v3", "delete_roster_entry_v3",
    // debt book
    "list_debtors_v3", "create_debtor_v3", "update_debtor_v3", "deactivate_debtor_v3", "list_debt_entries_v3",
    "record_debt_payment_v3",
    // loyalty
    "list_loyalty_cards_v3", "issue_loyalty_card_v3", "list_loyalty_transactions_v3", "list_loyalty_tiers_v3",
    "create_loyalty_tier_v3", "update_loyalty_tier_v3", "delete_loyalty_tier_v3", "list_loyalty_rewards_v3",
    "create_loyalty_reward_v3", "set_loyalty_reward_active_v3", "delete_loyalty_reward_v3", "redeem_loyalty_reward_v3",
    "lookup_loyalty_card_v3",
    // AI assistant and AI menu setup
    "ask_assistant_v3", "queue_media", "list_uploads", "process_queue", "reset_failed_uploads", "clear_uploads",
    "delete_upload", "apply_draft",
];

pub fn is_pos_lite(status: &LicenseStatus) -> bool {
    match status {
        LicenseStatus::Active { plan, .. }
        | LicenseStatus::Grace { plan, .. }
        | LicenseStatus::LockedBackOffice { plan, .. } => plan == LITE_PLAN,
        LicenseStatus::Invalid { .. } => false,
    }
}

/// The invoke handler's check: true when this till must refuse `command`.
pub fn refuses(command: &str, status: &LicenseStatus) -> bool {
    is_pos_lite(status) && FULL_ONLY_COMMANDS.contains(&command)
}

/// A Lite till keeps its sales on the device: the sync outbox still fills
/// (in the sale's own transaction, as always) but nothing is sent, so an
/// upgrade to Full uploads the history it missed.
pub fn uploads_to_cloud(status: &LicenseStatus) -> bool {
    !is_pos_lite(status)
}

/// Selling on credit is the debt book: a Lite till takes cash, card or
/// wallet only. Checked in the payment impls, which a LAN satellite's
/// payment also reaches.
pub fn require_payment_allowed(status: &LicenseStatus, method: &str, debtor_id: Option<&str>) -> Result<(), String> {
    let on_credit = method.eq_ignore_ascii_case("CREDIT") || method.eq_ignore_ascii_case("DEBT") || debtor_id.is_some();
    if is_pos_lite(status) && on_credit {
        return Err(LITE_REFUSED.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_plan(plan: &str) -> LicenseStatus {
        LicenseStatus::Active { days_remaining: 10, plan: plan.into(), expires_at: 0 }
    }

    /// The command names registered in lib.rs's `generate_handler!`.
    fn registered_commands() -> Vec<String> {
        let src = include_str!("lib.rs");
        let start = src.find("tauri::generate_handler![").expect("generate_handler! in lib.rs");
        let body = &src[start..];
        let body = &body[..body.find("])").expect("end of generate_handler!")];
        body.split(|c: char| c == ',' || c == '[' || c.is_whitespace())
            .map(|s| s.rsplit("::").next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty() && !s.starts_with("//") && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
            .collect()
    }

    #[test]
    fn every_full_only_name_is_a_registered_command() {
        let registered = registered_commands();
        for name in FULL_ONLY_COMMANDS {
            assert!(registered.iter().any(|r| r == name), "{name} is not in generate_handler! -- typo or renamed command");
        }
    }

    #[test]
    fn the_till_itself_stays_open_on_lite() {
        for name in [
            "login_pin_v3", "create_full_order_v3", "add_items_to_order_v3", "finalize_order_with_payment_v3",
            "take_payment_v3", "refund_order_v3", "list_menu_items_v3", "create_menu_item_v3", "list_option_groups_v3",
            "list_kitchen_orders_v3", "list_deliveries_v3", "settle_driver_v3", "list_customers_v3", "create_staff_v3",
            "open_shift_v3", "close_shift_v3", "list_shifts_v3", "list_order_history_v3", "list_pickup_orders_v3",
            "create_printer_v3", "list_printers_v3", "backup_database_v3", "activate_license_v3",
            "get_cached_license_status_v3",
        ] {
            assert!(!refuses(name, &with_plan(LITE_PLAN)), "{name} must work on POS Lite");
        }
    }

    #[test]
    fn lite_refuses_full_only_commands_and_full_refuses_nothing() {
        assert!(refuses("get_sales_report_v3", &with_plan(LITE_PLAN)));
        assert!(refuses("list_debtors_v3", &with_plan(LITE_PLAN)));
        assert!(!refuses("get_sales_report_v3", &with_plan("full")));
        assert!(!refuses("list_debtors_v3", &with_plan("enterprise")));
        assert!(!refuses("get_sales_report_v3", &LicenseStatus::Invalid { reason: "none".into() }));
    }

    #[test]
    fn lite_never_uploads_full_does() {
        assert!(!uploads_to_cloud(&with_plan(LITE_PLAN)));
        assert!(uploads_to_cloud(&with_plan("full")));
        let grace = LicenseStatus::Grace { days_left_in_grace: 2, plan: LITE_PLAN.into(), expires_at: 0 };
        assert!(!uploads_to_cloud(&grace));
    }

    #[test]
    fn lite_cannot_sell_on_credit() {
        let lite = with_plan(LITE_PLAN);
        assert!(require_payment_allowed(&lite, "CASH", None).is_ok());
        assert!(require_payment_allowed(&lite, "CARD", None).is_ok());
        assert!(require_payment_allowed(&lite, "CREDIT", None).is_err());
        assert!(require_payment_allowed(&lite, "DEBT", None).is_err());
        assert!(require_payment_allowed(&lite, "CASH", Some("debtor-1")).is_err());
        assert!(require_payment_allowed(&with_plan("full"), "CREDIT", Some("debtor-1")).is_ok());
    }
}
