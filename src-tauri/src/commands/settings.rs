use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, authorize_scope, Permission};
use crate::Db;
use rusqlite::params;
use serde::Serialize;
use tauri::State;
use super::shared::*;

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 4 -- settings (currency/tax/branch/printer).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_chain_config_v3(state: State<Db>, session_token: String) -> Result<crate::repo::ChainConfigRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_chain_config(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chain_currency_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, currency: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    require_license_not_locked_or_initial_setup(&license, &conn)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_chain_currency(&actor.tenant_id, &currency).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "chain_config", "default", None, Some(&serde_json::json!({ "currency": currency }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_chain_tax_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, tax_rate_cents: i64, tax_mode: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if tax_rate_cents < 0 {
        return Err("negative tax rate is not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_chain_tax(&actor.tenant_id, tax_rate_cents, &tax_mode).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "chain_config", "default", None, Some(&serde_json::json!({ "tax_rate_cents": tax_rate_cents, "tax_mode": tax_mode }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct DiscountCapsResponse {
    pub caps: crate::pricing::DiscountCaps,
    /// The requesting actor's own cap, pre-resolved so the frontend doesn't
    /// need to duplicate the role->cap mapping `pricing.rs` owns.
    pub your_cap_percent: i64,
}

/// No `authorize` beyond being logged in -- every role needs to know its
/// own cap to render the "disable above this" affordance (UI is affordance
/// only, Rust enforces regardless of what this returns).
#[tauri::command]
pub fn get_discount_caps_v3(state: State<Db>, session_token: String) -> Result<DiscountCapsResponse, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let caps = Repo::new(&conn).get_discount_caps(&actor.tenant_id).map_err(|e| e.to_string())?;
    let your_cap_percent = caps.for_role(actor.role);
    Ok(DiscountCapsResponse { caps, your_cap_percent })
}

/// Owner-only (per `Permission::ManageSettings`, same gate as currency/tax):
/// adjusts the per-role discount ceilings future orders are checked
/// against.
#[tauri::command]
pub fn update_discount_caps_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cashier_percent: i64, manager_percent: i64, owner_percent: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if !(0..=100).contains(&cashier_percent) || !(0..=100).contains(&manager_percent) || !(0..=100).contains(&owner_percent) {
        return Err("discount caps must be between 0 and 100 percent".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_discount_caps(&actor.tenant_id, cashier_percent, manager_percent, owner_percent).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SettingsChanged, "chain_config", "default",
        None, Some(&serde_json::json!({ "discount_cap_cashier_percent": cashier_percent, "discount_cap_manager_percent": manager_percent, "discount_cap_owner_percent": owner_percent })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// No `authorize` beyond being logged in -- `VoidItemModal`/the shift-close
/// screen both need this value to render the right label/PIN prompt for
/// every role, same reasoning as `get_discount_caps_v3`. Rust enforces the
/// actual gate server-side regardless of what the frontend does with this.
#[tauri::command]
pub fn get_manager_thresholds_v3(state: State<Db>, session_token: String) -> Result<crate::pricing::ManagerThresholds, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_manager_thresholds(&actor.tenant_id).map_err(|e| e.to_string())
}

/// Manager+ (`Permission::ManageSettings`, same gate as currency/tax/
/// discount caps): lets a real restaurant tune these to their own actual
/// prices instead of living with a number that was never right for them.
#[tauri::command]
pub fn update_manager_thresholds_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, void_threshold_cents: i64, shift_diff_threshold_cents: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if void_threshold_cents < 0 || shift_diff_threshold_cents < 0 {
        return Err("thresholds must not be negative".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_manager_thresholds(&actor.tenant_id, void_threshold_cents, shift_diff_threshold_cents).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SettingsChanged, "chain_config", "default",
        None, Some(&serde_json::json!({ "void_manager_threshold_cents": void_threshold_cents, "shift_diff_manager_threshold_cents": shift_diff_threshold_cents })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// No `authorize` beyond being logged in -- every page that renders the
/// table bar, order-type picker, kitchen ticket flow, or printer-type list
/// needs this on load, and it must never be blocked by a locked license
/// (a dinner service, or a coffee counter, is never interrupted over
/// licensing). See nextphase.md §2 for the full plan this implements.
#[tauri::command]
pub fn get_business_mode_v3(state: State<Db>, session_token: String) -> Result<crate::repo::BusinessMode, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_business_mode(&actor.tenant_id).map_err(|e| e.to_string())
}

/// The one implicit table every branch gets when tables are turned off --
/// `create_table_v3` is `ManageSettings`-gated (Manager+), so a cashier
/// could never create this themselves; ensuring it here, inside the same
/// transaction as the toggle flip, means a counter table is guaranteed to
/// exist by the time anyone next opens the POS. Matched by exact name, so
/// flipping the toggle off and back on never creates duplicates.
pub(crate) const COUNTER_TABLE_NAME: &str = "المنضدة";

pub(crate) fn ensure_counter_tables_exist(tx: &rusqlite::Transaction, tenant_id: &str) -> Result<(), String> {
    let branches = Repo::new(tx).list_branches(tenant_id).map_err(|e| e.to_string())?;
    for (branch_id, _name) in branches {
        let has_counter: bool = tx.query_row(
            "SELECT COUNT(*) > 0 FROM tables WHERE tenant_id = ?1 AND branch_id = ?2 AND name = ?3",
            params![tenant_id, branch_id, COUNTER_TABLE_NAME],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if !has_counter {
            Repo::new(tx).create_table(tenant_id, &branch_id, COUNTER_TABLE_NAME).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Whenever a caller sends an empty `table_id` (currently only possible
/// for non-DINE_IN order types, since DINE_IN's own frontend flow always
/// requires a real table selection first -- see pos/page.tsx's PayKey
/// disabled condition), silently resolve to that branch's counter table
/// instead of failing the NOT NULL / FK constraint on `orders.table_id`.
/// A non-empty table_id is returned unchanged -- this never overrides a
/// real, caller-selected dine-in table. Reuses `ensure_counter_tables_exist`
/// (idempotent, matched by exact name) so this never creates duplicates.
pub(crate) fn resolve_order_table_id(tx: &rusqlite::Transaction, tenant_id: &str, branch_id: &str, table_id: &str) -> Result<String, String> {
    if !table_id.trim().is_empty() {
        return Ok(table_id.to_string());
    }
    ensure_counter_tables_exist(tx, tenant_id)?;
    tx.query_row(
        "SELECT id FROM tables WHERE tenant_id = ?1 AND branch_id = ?2 AND name = ?3",
        params![tenant_id, branch_id, COUNTER_TABLE_NAME],
        |r| r.get(0),
    ).map_err(|e| e.to_string())
}

/// Manager+ (`Permission::ManageSettings`, same gate as currency/tax/
/// discount caps/manager thresholds).
#[tauri::command]
pub fn update_business_mode_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, has_tables: bool, has_kitchen: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    require_license_not_locked_or_initial_setup(&license, &conn)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_business_mode(&actor.tenant_id, has_tables, has_kitchen).map_err(|e| e.to_string())?;
    if !has_tables {
        ensure_counter_tables_exist(&tx, &actor.tenant_id)?;
    }
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SettingsChanged, "chain_config", "default",
        None, Some(&serde_json::json!({ "has_tables": has_tables, "has_kitchen": has_kitchen })),
    ).map_err(|e| e.to_string())?;
    // SetupWizard's own final step -- the exemption
    // `require_license_not_locked_or_initial_setup` grants during initial
    // setup closes here, permanently, the moment setup genuinely
    // completes. A no-op on every later, ordinary Settings edit (the flag
    // is already gone by then).
    tx.execute("DELETE FROM app_settings WHERE key = ?1", params![INITIAL_SETUP_IN_PROGRESS_KEY]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_legacy_branch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Option<crate::repo::LegacyBranchRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_legacy_branch(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_legacy_branch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, existing_id: Option<String>, name: String, address: Option<String>, phone: Option<String>, max_tables: i64, currency: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    require_license_not_locked_or_initial_setup(&license, &conn)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let branch_id = Repo::new(&tx).upsert_legacy_branch(&actor.tenant_id, existing_id.as_deref(), &name, address.as_deref(), phone.as_deref(), max_tables, &currency).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(branch_id)
}

#[tauri::command]
pub fn set_printer_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, printer_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_printer_active(&actor.scope(), &printer_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "printer", &printer_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_printer_paper_width_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, printer_id: String, paper_width_mm: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_printer_paper_width(&actor.scope(), &printer_id, paper_width_mm).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "printer", &printer_id, None, Some(&serde_json::json!({ "paper_width_mm": paper_width_mm }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Binds a printer row to a real OS-registered print queue name (see
/// `print.rs`'s `list_system_printers_v3`) -- required for a USB printer
/// to actually print anything (see `print_raw_bytes_v3`); a no-op for
/// NETWORK printers, which never needed this.
#[tauri::command]
pub fn update_printer_system_name_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, printer_id: String, system_printer_name: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_printer_system_name(&actor.scope(), &printer_id, &system_printer_name).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "printer", &printer_id, None, Some(&serde_json::json!({ "system_printer_name": system_printer_name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// T1.6: two-layer menu price resolution (`override ?? default`), exposed
/// read-only so a client can price an item before/while building an order.
/// Gated on `CreateOrder` (the same permission that lets an actor build an
/// order at all) plus branch scope -- pricing another branch's menu is not a
/// query anyone below Owner/Platform should be able to make.
#[tauri::command]
pub fn resolve_menu_price_v3(state: State<Db>, session_token: String, branch_id: String, item_id: String) -> Result<i64, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tenant_id: String = conn
        .query_row("SELECT tenant_id FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0))
        .map_err(|_| format!("no such branch: {branch_id}"))?;
    authorize_scope(&actor, &tenant_id, Some(branch_id.as_str())).map_err(|e| e.to_string())?;
    Repo::new(&conn).resolve_menu_price(&branch_id, &item_id).map_err(|e| e.to_string())
}

