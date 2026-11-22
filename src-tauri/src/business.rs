//! The kind of business (restaurant, café, shop, supplier) and the modules the owner switched on.
//!
//! One app serves all four. The type only picks a starting set of modules (the till sends the
//! preset, `src/lib/businessModules.ts`); every module can then be turned on or off by the owner in
//! Settings > نوع النشاط والوحدات. A module that is off disappears from the screens AND its commands
//! are refused here, in the invoke wrapper (lib.rs `gate_by_plan`), the same way POS Lite refuses
//! Full-only commands -- a hidden button is never the only thing in the way.
//!
//! Tables and the kitchen keep their old switches (`chain_config.has_tables / has_kitchen`); this
//! file holds the rest. No row = everything on, so a shop that never opened the screen keeps
//! today's behaviour.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::RwLock;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS business_profile (
    tenant_id        TEXT PRIMARY KEY,
    business_type    TEXT NOT NULL,
    disabled_modules TEXT NOT NULL DEFAULT ''
);
";

pub const BUSINESS_TYPES: [&str; 4] = ["restaurant", "cafe", "shop", "supplier"];

/// The modules this file switches (tables and kitchen live in chain_config).
pub const MODULES: [&str; 9] = ["delivery", "pickup", "debt", "loyalty", "inventory", "marketplace", "offers", "hr", "ai"];

pub const MODULE_OFF: &str = "هذه الوحدة متوقفة في إعدادات نوع النشاط -- يشغّلها المالك من الإعدادات";

/// Commands that belong to one module. Selling, paying, the menu, shifts and the stockroom of
/// products are never here: a module only adds to the till.
pub fn module_of(command: &str) -> Option<&'static str> {
    MODULE_COMMANDS.iter().find(|(_, list)| list.contains(&command)).map(|(m, _)| *m)
}

const DELIVERY: &[&str] = &[
        "get_delivery_settings_v3", "update_delivery_settings_v3", "list_delivery_drivers_v3", "save_delivery_driver_v3",
        "list_deliveries_v3", "assign_delivery_driver_v3", "set_delivery_status_v3", "get_driver_statement_v3",
        "list_driver_settlements_v3", "settle_driver_v3",
    ];
const PICKUP: &[&str] = &["list_pickup_orders_v3", "claim_due_pickup_kitchen_v3", "send_pickup_to_kitchen_now_v3", "mark_pickup_no_show_v3", "list_pickup_no_shows_v3"];
const DEBT: &[&str] = &["list_debtors_v3", "create_debtor_v3", "update_debtor_v3", "deactivate_debtor_v3", "list_debt_entries_v3", "record_debt_payment_v3"];
const LOYALTY: &[&str] = &[
        "list_loyalty_cards_v3", "issue_loyalty_card_v3", "list_loyalty_transactions_v3", "list_loyalty_tiers_v3", "create_loyalty_tier_v3",
        "update_loyalty_tier_v3", "delete_loyalty_tier_v3", "list_loyalty_rewards_v3", "create_loyalty_reward_v3", "set_loyalty_reward_active_v3",
        "delete_loyalty_reward_v3", "redeem_loyalty_reward_v3", "lookup_loyalty_card_v3",
    ];
const INVENTORY: &[&str] = &[
        "list_ingredients_v3", "create_ingredient_v3", "update_ingredient_v3", "adjust_stock_v3", "record_stock_count_v3", "list_stock_counts_v3",
        "get_cogs_variance_report_v3", "list_recipe_ingredients_v3", "add_recipe_ingredient_v3", "update_recipe_ingredient_v3",
        "delete_recipe_ingredient_v3", "create_purchase_order_v3", "create_purchase_order_and_bump_supplier_v3", "create_purchase_order_with_items_v3",
        "list_purchase_orders_v3", "cancel_purchase_order_v3", "list_purchase_order_items_v3", "receive_purchase_order_v3", "record_supplier_payment_v3",
        "list_supplier_payments_v3", "list_suppliers_v3", "create_supplier_v3", "update_supplier_v3", "delete_supplier_v3", "list_inventory_logs_v3",
        "list_reorder_suggestions_v3", "list_low_stock_ingredients_v3",
        "list_units_v3", "list_ingredient_units_v3", "save_ingredient_unit_v3", "delete_ingredient_unit_v3", "list_batch_recipes_v3", "save_batch_recipe_v3", "produce_batch_v3", "list_production_runs_v3", "record_waste_v3", "list_waste_v3", "get_stock_report_v3", "create_purchase_order_with_units_v3",
    ];
const MARKETPLACE: &[&str] = &[
        "get_marketplace_context_v3", "list_marketplace_receipts_v3", "receive_marketplace_order_v3", "supplier_market_state_v3",
        "link_supplier_product_v3", "apply_supplier_order_v3", "supplier_market_sync_v3",
    ];
const OFFERS: &[&str] = &["create_combo_meal_v3", "update_combo_meal_v3", "delete_combo_meal_v3", "create_happy_hour_rule_v3", "update_happy_hour_rule_v3", "delete_happy_hour_rule_v3", "set_happy_hour_rule_active_v3"];
const HR: &[&str] = &[
        "list_attendance_v3", "clock_in_v3", "clock_out_v3", "fingerprint_status_v3", "list_fingerprint_enrolments_v3", "enrol_fingerprint_v3",
        "delete_fingerprint_enrolment_v3", "fingerprint_punch_v3", "list_punches_v3", "get_attendance_settings_v3", "set_attendance_settings_v3",
        "list_roster_entries_v3", "create_roster_entry_v3", "update_roster_entry_v3", "delete_roster_entry_v3", "get_payroll_access_v3",
        "get_payroll_settings_v3", "save_payroll_settings_v3", "list_payroll_employees_v3", "save_payroll_employee_v3", "payroll_month_v3",
        "get_payslip_v3", "approve_payslip_v3", "pay_payslip_v3", "reopen_payslip_v3", "add_payroll_adjustment_v3", "delete_payroll_adjustment_v3",
        "add_payroll_advance_v3", "list_payroll_advances_v3", "cancel_payroll_advance_v3", "set_paid_leave_v3", "add_manual_punch_v3",
    ];
const AI: &[&str] = &["ask_assistant_v3", "assistant_insights_v3", "queue_media", "list_uploads", "process_queue", "reset_failed_uploads", "clear_uploads", "delete_upload", "apply_draft"];

/// Every module with its commands.
pub const MODULE_COMMANDS: [(&str, &[&str]); 9] = [("delivery", DELIVERY), ("pickup", PICKUP), ("debt", DEBT), ("loyalty", LOYALTY), ("inventory", INVENTORY), ("marketplace", MARKETPLACE), ("offers", OFFERS), ("hr", HR), ("ai", AI)];

/// What the owner chose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// None = never chosen (the till shows a type worked out from tables/kitchen).
    pub business_type: Option<String>,
    /// Every module in `MODULES` with whether it is on.
    pub modules: BTreeMap<String, bool>,
}

fn parse_disabled(s: &str) -> BTreeSet<String> {
    s.split(',').map(str::trim).filter(|m| MODULES.contains(m)).map(str::to_string).collect()
}

pub fn load(conn: &Connection, tenant_id: &str) -> Result<Profile, String> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT business_type, disabled_modules FROM business_profile WHERE tenant_id = ?1", params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let disabled = row.as_ref().map(|(_, d)| parse_disabled(d)).unwrap_or_default();
    Ok(Profile {
        business_type: row.map(|(t, _)| t),
        modules: MODULES.iter().map(|m| (m.to_string(), !disabled.contains(*m))).collect(),
    })
}

pub fn save(conn: &Connection, tenant_id: &str, profile: &Profile) -> Result<(), String> {
    let t = profile.business_type.as_deref().unwrap_or("restaurant");
    if !BUSINESS_TYPES.contains(&t) {
        return Err(format!("نوع نشاط غير معروف: {t}"));
    }
    for k in profile.modules.keys() {
        if !MODULES.contains(&k.as_str()) {
            return Err(format!("وحدة غير معروفة: {k}"));
        }
    }
    let disabled: Vec<&str> = MODULES.iter().copied().filter(|m| profile.modules.get(*m) == Some(&false)).collect();
    conn.execute(
        "INSERT INTO business_profile (tenant_id, business_type, disabled_modules) VALUES (?1, ?2, ?3) \
         ON CONFLICT(tenant_id) DO UPDATE SET business_type = ?2, disabled_modules = ?3",
        params![tenant_id, t, disabled.join(",")],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The modules switched off on this device's shop, kept in memory for the invoke wrapper.
static DISABLED: RwLock<BTreeSet<String>> = RwLock::new(BTreeSet::new());

/// Reads the switched-off modules into memory (at start-up and after the owner saves).
pub fn refresh_cache(conn: &Connection) {
    let disabled = conn
        .query_row("SELECT disabled_modules FROM business_profile LIMIT 1", [], |r| r.get::<_, String>(0))
        .map(|d| parse_disabled(&d))
        .unwrap_or_default();
    if let Ok(mut w) = DISABLED.write() {
        *w = disabled;
    }
}

pub fn set_cache(profile: &Profile) {
    if let Ok(mut w) = DISABLED.write() {
        *w = profile.modules.iter().filter(|(_, on)| !**on).map(|(m, _)| m.clone()).collect();
    }
}

pub fn is_on(module: &str) -> bool {
    DISABLED.read().map(|d| !d.contains(module)).unwrap_or(true)
}

/// Whether the invoke wrapper must refuse this command (its module is off).
pub fn refuses(command: &str) -> bool {
    module_of(command).is_some_and(|m| !is_on(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    #[test]
    fn an_untouched_shop_has_every_module() {
        let conn = db();
        let p = load(&conn, "t1").unwrap();
        assert_eq!(p.business_type, None);
        assert!(p.modules.values().all(|on| *on));
        assert_eq!(p.modules.len(), MODULES.len());
    }

    #[test]
    fn the_owners_choice_round_trips_and_stays_in_its_shop() {
        let conn = db();
        let mut modules: BTreeMap<String, bool> = MODULES.iter().map(|m| (m.to_string(), true)).collect();
        modules.insert("pickup".into(), false);
        modules.insert("marketplace".into(), false);
        save(&conn, "t1", &Profile { business_type: Some("shop".into()), modules }).unwrap();
        let p = load(&conn, "t1").unwrap();
        assert_eq!(p.business_type.as_deref(), Some("shop"));
        assert_eq!(p.modules.get("pickup"), Some(&false));
        assert_eq!(p.modules.get("delivery"), Some(&true));
        assert!(load(&conn, "t2").unwrap().modules.values().all(|on| *on));
    }

    #[test]
    fn nonsense_is_refused() {
        let conn = db();
        assert!(save(&conn, "t1", &Profile { business_type: Some("casino".into()), modules: BTreeMap::new() }).is_err());
        let modules = BTreeMap::from([("nuclear".to_string(), false)]);
        assert!(save(&conn, "t1", &Profile { business_type: Some("shop".into()), modules }).is_err());
    }

    #[test]
    fn a_module_that_is_off_refuses_its_commands_only() {
        let profile = Profile { business_type: Some("shop".into()), modules: MODULES.iter().map(|m| (m.to_string(), *m != "debt")).collect() };
        set_cache(&profile);
        assert!(refuses("record_debt_payment_v3"));
        assert!(!refuses("create_full_order_v3"), "selling is never a module");
        assert!(!refuses("list_deliveries_v3"));
        set_cache(&Profile { business_type: None, modules: MODULES.iter().map(|m| (m.to_string(), true)).collect() });
        assert!(!refuses("record_debt_payment_v3"));
    }

    #[test]
    fn every_module_command_is_a_real_command() {
        let lib = include_str!("lib.rs");
        for (module, list) in MODULE_COMMANDS {
            assert!(MODULES.contains(&module));
            for cmd in list {
                assert!(lib.contains(&format!("::{cmd},")) || lib.contains(&format!("::{cmd}
")), "{cmd} ({module}) is not a registered command");
            }
        }
    }
}
