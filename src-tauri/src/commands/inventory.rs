use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;
use super::orders::sync_enqueue_ingredient;

// ---------------------------------------------------------------------------
// Batch 3b, slice 2, group 2 -- inventory: `ingredients` CRUD + stock
// adjustment. Deliberately OUT of scope, stated not hidden: `suppliers`
// CRUD, PO-receiving's stock bump, movements/alerts read tabs.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_ingredients_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::IngredientRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_ingredients(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, unit: String, cost_cents_per_unit: i64, min_stock: f64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ingredient_id = Repo::new(&tx).create_ingredient(&tenant_id, &branch_id, &name, &unit, cost_cents_per_unit, min_stock).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "name": name, "created": true }))).map_err(|e| e.to_string())?;

    let license_status = license.cached_status();
    sync_enqueue_ingredient(&tx, &tenant_id, &branch_id, &ingredient_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(ingredient_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, name: String, unit: String, cost_cents_per_unit: i64, min_stock: f64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_ingredient(&actor.scope(), &ingredient_id, &name, &unit, cost_cents_per_unit, min_stock).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;

    // tenant_id/branch_id come from the ingredient's OWN row, not the
    // actor's scope -- correct regardless of whether the caller is
    // Branch- or Tenant-scoped, same reasoning as `void_order_item_v3`.
    let (ing_tenant_id, ing_branch_id): (String, String) = tx.query_row(
        "SELECT tenant_id, branch_id FROM ingredients WHERE id = ?1", params![ingredient_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_ingredient(&tx, &ing_tenant_id, &ing_branch_id, &ingredient_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One transaction: `ingredients.current_stock` update + the new
/// `inventory_logs` fact + the audit entry, same atomicity principle as
/// `take_payment_v3`.
#[tauri::command]
pub fn adjust_stock_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, change_amount: f64, reason: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::AdjustStock).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let log_id = Repo::new(&tx).adjust_stock(&actor.scope(), &tenant_id, &branch_id, &ingredient_id, change_amount, &reason, &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "change_amount": change_amount, "reason": reason, "log_id": log_id }))).map_err(|e| e.to_string())?;

    let license_status = license.cached_status();
    sync_enqueue_ingredient(&tx, &tenant_id, &branch_id, &ingredient_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(log_id)
}

// ---------------------------------------------------------------------------
// Physical stock counts + COGS variance / margin reporting. Same
// `Permission::AdjustStock` gate as `adjust_stock_v3` -- a physical count is
// a stock-affecting write, same trust boundary. `stock_counts` rows
// themselves are not pushed through `sync::enqueue` (single-branch fact,
// not yet part of the cross-device sync contract) -- only the ingredient's
// reconciled `current_stock` propagates, same as any other adjust_stock.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn record_stock_count_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, counted_stock: f64, note: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::AdjustStock).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let count_id = Repo::new(&tx).record_stock_count(&actor.scope(), &tenant_id, &branch_id, &ingredient_id, counted_stock, &actor.id, note.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "physical_count": counted_stock, "count_id": count_id }))).map_err(|e| e.to_string())?;

    let license_status = license.cached_status();
    sync_enqueue_ingredient(&tx, &tenant_id, &branch_id, &ingredient_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count_id)
}

/// Count history for one ingredient, most recent first -- the "last
/// counted" column on the variance report and the count-log modal.
#[tauri::command]
pub fn list_stock_counts_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String) -> Result<Vec<crate::repo::StockCountRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::AdjustStock).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_stock_counts(&actor.scope(), &ingredient_id).map_err(|e| e.to_string())
}

/// Theoretical-vs-actual COGS variance over `[range_start_iso, range_end_iso)`
/// -- see `Repo::compute_cogs_variance` for the exact semantics.
#[tauri::command]
pub fn get_cogs_variance_report_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, range_start_iso: String, range_end_iso: String) -> Result<Vec<crate::repo::CogsVarianceRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).compute_cogs_variance(&actor.scope(), &range_start_iso, &range_end_iso).map_err(|e| e.to_string())
}

/// Per-item margin over `[range_start_iso, range_end_iso)`, worst margin %
/// first -- see `Repo::menu_margin_report` for the exact semantics.
#[tauri::command]
pub fn get_menu_margin_report_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, range_start_iso: String, range_end_iso: String) -> Result<Vec<crate::repo::MenuMarginRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).menu_margin_report(&actor.scope(), &range_start_iso, &range_end_iso).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 2026-08-20 -- recipe (BOM) management. Same `Permission::ManageMenu` gate
// as menu item create/update -- attaching what an item consumes is part of
// managing the menu, not a separate inventory-only permission.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_recipe_ingredients_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, menu_item_id: String) -> Result<Vec<crate::repo::RecipeIngredientRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_recipe_ingredients(&actor.scope(), &menu_item_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_recipe_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, menu_item_id: String, ingredient_id: String, quantity_needed: f64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if quantity_needed <= 0.0 {
        return Err("الكمية المطلوبة يجب أن تكون أكبر من صفر".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let recipe_id = Repo::new(&tx).add_recipe_ingredient(&actor.scope(), &menu_item_id, &ingredient_id, quantity_needed).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &menu_item_id, None, Some(&serde_json::json!({ "recipe_ingredient_added": ingredient_id, "quantity_needed": quantity_needed }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(recipe_id)
}

#[tauri::command]
pub fn update_recipe_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, recipe_id: String, quantity_needed: f64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if quantity_needed <= 0.0 {
        return Err("الكمية المطلوبة يجب أن تكون أكبر من صفر".to_string());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).update_recipe_ingredient(&actor.scope(), &recipe_id, quantity_needed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_recipe_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, recipe_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let menu_item_id = Repo::new(&tx).delete_recipe_ingredient(&actor.scope(), &recipe_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &menu_item_id, None, Some(&serde_json::json!({ "recipe_ingredient_removed": recipe_id }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

