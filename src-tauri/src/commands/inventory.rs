use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use rusqlite::params;
use tauri::State;
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
    let unit = crate::inventory_ops::canonical_unit_text(&unit);
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
    let unit = crate::inventory_ops::canonical_unit_text(&unit);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_ingredient(&actor.scope(), &ingredient_id, &name, &unit, cost_cents_per_unit, min_stock).map_err(|e| e.to_string())?;
    // A recipe written in another unit (150 g for kg stock) must still convert after the unit changed.
    crate::inventory_ops::after_ingredient_unit_change(&tx, &actor.scope(), &ingredient_id)?;
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
pub fn add_recipe_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, menu_item_id: String, ingredient_id: String, quantity_needed: f64, unit: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if quantity_needed <= 0.0 {
        return Err("الكمية المطلوبة يجب أن تكون أكبر من صفر".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let recipe_id = Repo::new(&tx).add_recipe_ingredient(&actor.scope(), &menu_item_id, &ingredient_id, quantity_needed).map_err(|e| e.to_string())?;
    // The unit of the line (None = the ingredient's own); a unit of another kind is refused here and nothing is saved.
    crate::inventory_ops::set_recipe_unit(&tx, &actor.scope(), &recipe_id, unit.as_deref())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &menu_item_id, None, Some(&serde_json::json!({ "recipe_ingredient_added": ingredient_id, "quantity_needed": quantity_needed, "unit": unit }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(recipe_id)
}

#[tauri::command]
pub fn update_recipe_ingredient_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, recipe_id: String, quantity_needed: f64, unit: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if quantity_needed <= 0.0 {
        return Err("الكمية المطلوبة يجب أن تكون أكبر من صفر".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_recipe_ingredient(&actor.scope(), &recipe_id, quantity_needed).map_err(|e| e.to_string())?;
    crate::inventory_ops::set_recipe_unit(&tx, &actor.scope(), &recipe_id, unit.as_deref())?;
    tx.commit().map_err(|e| e.to_string())
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



// ---------------------------------------------------------------------------
// 2026-11-22 -- units, packs, production of base products, waste, stock report.
// All back-office (Full plan, inventory module), permission ManageIngredients (the inventory feature).
// The logic and its tests are in `inventory_ops.rs`; these check who is asking, audit, sync and call it.
// ---------------------------------------------------------------------------

use crate::inventory_ops::{self, BatchLineInput, BatchRecipe, PackRow, ProduceOutcome, ProductionRunRow, StockReport, UnitDef, WasteOutcome, WasteRow};

/// Pushes the ingredients whose stock/cost just changed to the sync outbox (each with its own tenant/branch).
fn enqueue_ingredients(tx: &rusqlite::Transaction, ids: &[String], device_id: &str, license: &crate::license::cloud::CloudLicenseState) -> Result<(), String> {
    let license_status = license.cached_status();
    for id in ids {
        let (tenant_id, branch_id): (String, String) = tx
            .query_row("SELECT tenant_id, branch_id FROM ingredients WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        sync_enqueue_ingredient(tx, &tenant_id, &branch_id, id, device_id, &license_status)?;
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// The standard units (g, kg, ml, l, piece) with their kind and factor.
#[tauri::command]
pub fn list_units_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<UnitDef>, String> {
    let _actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::list_units(&conn)
}

/// Every pack (carton, sack ...) defined on ingredients.
#[tauri::command]
pub fn list_ingredient_units_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<PackRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::list_packs(&conn, &actor.scope())
}

/// Adds a pack to an ingredient, or edits one (`pack_id`). `factor_to_stock_unit` = how many stock units it holds.
#[tauri::command]
pub fn save_ingredient_unit_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, pack_id: Option<String>, name_ar: String, factor_to_stock_unit: f64) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("save_ingredient_unit_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (id, _) = inventory_ops::save_pack(&tx, &actor.scope(), &ingredient_id, pack_id.as_deref(), &name_ar, factor_to_stock_unit)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "pack": name_ar, "factor_to_stock_unit": factor_to_stock_unit }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_ingredient_unit_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, pack_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_ingredient_unit_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids = inventory_ops::delete_pack(&tx, &actor.scope(), &pack_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", ids.first().map(String::as_str).unwrap_or(""), None, Some(&serde_json::json!({ "pack_deleted": pack_id }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Every produced ingredient with its batch recipe and what one batch costs now.
#[tauri::command]
pub fn list_batch_recipes_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<BatchRecipe>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::list_batch_recipes(&conn, &actor.scope())
}

/// Defines the batch recipe of an ingredient (marks it as produced); no lines removes it.
#[tauri::command]
pub fn save_batch_recipe_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, batch_yield: f64, lines: Vec<BatchLineInput>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_batch_recipe_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids = inventory_ops::save_batch_recipe(&tx, &actor.scope(), &ingredient_id, batch_yield, &lines)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "batch_recipe_lines": lines.len(), "batch_yield": batch_yield }))).map_err(|e| e.to_string())?;
    enqueue_ingredients(&tx, &ids, &actor.device_id, &license)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Runs a production: components go down, the produced ingredient goes up by what really came out and its average cost is re-weighted.
#[tauri::command]
pub fn produce_batch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, batches: f64, actual_qty: Option<f64>, notes: Option<String>) -> Result<ProduceOutcome, String> {
    crate::lan::reject_if_local_kitchen_satellite("produce_batch_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let notes = notes.as_deref().map(str::trim).filter(|n| !n.is_empty());
    let out = inventory_ops::produce(&tx, &actor.scope(), &actor.id, &ingredient_id, batches, actual_qty, notes, &now_iso())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "production_run": out.run_id, "batches": batches, "expected_qty": out.expected_qty, "actual_qty": out.actual_qty, "cost_cents": out.cost_cents }))).map_err(|e| e.to_string())?;
    enqueue_ingredients(&tx, &out.touched, &actor.device_id, &license)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Production history, newest first, with expected vs actual yield.
#[tauri::command]
pub fn list_production_runs_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: Option<String>, limit: Option<i64>) -> Result<Vec<ProductionRunRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::list_production_runs(&conn, &actor.scope(), ingredient_id.as_deref(), limit.unwrap_or(200))
}

/// Writes off spoiled / expired / spilled stock (reason from the short list), with its value.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn record_waste_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, ingredient_id: String, quantity: f64, unit: Option<String>, reason: String, note: Option<String>) -> Result<WasteOutcome, String> {
    crate::lan::reject_if_local_kitchen_satellite("record_waste_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let out = inventory_ops::record_waste(&tx, &actor.scope(), &actor.id, &ingredient_id, quantity, unit.as_deref(), &reason, note.as_deref(), &now_iso())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "waste": out.quantity, "reason": reason, "value_cents": out.value_cents, "log_id": out.log_id }))).map_err(|e| e.to_string())?;
    enqueue_ingredients(&tx, std::slice::from_ref(&ingredient_id), &actor.device_id, &license)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn list_waste_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, range_start_iso: String, range_end_iso: String) -> Result<Vec<WasteRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::list_waste(&conn, &actor.scope(), &range_start_iso, &range_end_iso)
}

/// On hand, average cost and value per ingredient, plus the movements (received, used by sales, produced, wasted, adjusted) in a date range.
#[tauri::command]
pub fn get_stock_report_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, range_start_iso: String, range_end_iso: String) -> Result<StockReport, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    inventory_ops::stock_report(&conn, &actor.scope(), &range_start_iso, &range_end_iso)
}
