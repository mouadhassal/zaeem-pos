//! Shop stock commands: each product's stock per branch, receiving goods,
//! counts and adjustments, the movement log, importing products from a
//! spreadsheet, extra barcodes and the shop settings (scale barcodes, refuse
//! sales the stock cannot cover). The logic and its tests are in `stockroom.rs`;
//! these check who is asking, keep it to this business and branch, audit, and call it.

use crate::audit;
use crate::stockroom::{self, ExtraBarcode, ImportRow, ImportSummary, LogRow, ReceiveLine, ReceiveOutcome, RetailSettings, StockRow};
use crate::security::{authorize, Permission};
use crate::Db;
use chrono::Utc;
use tauri::State;
use super::shared::*;

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_product_stock_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, search: Option<String>, only_low: Option<bool>, include_untracked: Option<bool>) -> Result<Vec<StockRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    stockroom::list_stock(&conn, &tenant_id, &branch_id, search.as_deref(), only_low.unwrap_or(false), include_untracked.unwrap_or(false), 5000)
}

#[tauri::command]
pub fn set_product_tracking_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, track: bool, min_quantity: f64, opening_quantity: Option<f64>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_product_tracking_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    stockroom::set_tracking(&tx, &tenant_id, &branch_id, &item_id, track, min_quantity, opening_quantity, &actor.id, &now_iso())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "product_stock", &item_id, None, Some(&serde_json::json!({ "track": track, "min_quantity": min_quantity, "opening_quantity": opening_quantity }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Adds or removes pieces (damage, theft, a found box) with a reason that is kept in the log.
#[tauri::command]
pub fn adjust_product_stock_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, change: f64, note: String) -> Result<f64, String> {
    crate::lan::reject_if_local_kitchen_satellite("adjust_product_stock_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    if note.trim().is_empty() {
        return Err("اكتب سبب التعديل".to_string());
    }
    if change == 0.0 {
        return Err("الكمية صفر".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let item_ok: bool = tx.query_row("SELECT COUNT(*) > 0 FROM menu_items WHERE id = ?1 AND tenant_id = ?2", rusqlite::params![item_id, tenant_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !item_ok {
        return Err("الصنف غير موجود".to_string());
    }
    tx.execute("UPDATE menu_items SET track_stock = 1 WHERE id = ?1", rusqlite::params![item_id]).map_err(|e| e.to_string())?;
    let after = stockroom::apply_change(&tx, &tenant_id, &branch_id, &item_id, change, "ADJUST", Some(note.trim()), None, Some(&actor.id), &now_iso())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "product_stock", &item_id, None, Some(&serde_json::json!({ "change": change, "note": note, "balance_after": after }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(after)
}

/// A shelf count: the quantity becomes what was counted; the difference is logged.
#[tauri::command]
pub fn count_product_stock_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, counted: f64, note: Option<String>) -> Result<f64, String> {
    crate::lan::reject_if_local_kitchen_satellite("count_product_stock_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let after = stockroom::count(&tx, &tenant_id, &branch_id, &item_id, counted, note.as_deref(), &actor.id, &now_iso())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "product_stock", &item_id, None, Some(&serde_json::json!({ "counted": counted, "note": note }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(after)
}

/// Goods arrive: scanned or picked products with the quantity received (and a new cost price if it changed).
#[tauri::command]
pub fn receive_products_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, lines: Vec<ReceiveLine>, note: Option<String>) -> Result<ReceiveOutcome, String> {
    crate::lan::reject_if_local_kitchen_satellite("receive_products_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let out = stockroom::receive(&tx, &tenant_id, &branch_id, &lines, note.as_deref().map(str::trim).filter(|n| !n.is_empty()), &actor.id, &now_iso())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "product_stock", &branch_id, None, Some(&serde_json::json!({ "received_lines": out.lines, "pieces": out.pieces, "note": note }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
pub fn list_product_stock_log_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: Option<String>, limit: Option<i64>) -> Result<Vec<LogRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    stockroom::list_log(&conn, &tenant_id, &branch_id, item_id.as_deref(), limit.unwrap_or(200).clamp(1, 1000) as usize)
}

/// Brings products in from a spreadsheet (already read into rows by the page).
#[tauri::command]
pub fn import_products_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, rows: Vec<ImportRow>) -> Result<ImportSummary, String> {
    crate::lan::reject_if_local_kitchen_satellite("import_products_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let summary = stockroom::import_products(&tx, &tenant_id, &branch_id, &rows, &actor.id, &now_iso())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::MenuItemChanged, "menu_import", &branch_id, None, Some(&serde_json::json!({ "created": summary.created, "updated": summary.updated, "skipped": summary.skipped }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub fn list_product_barcodes_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String) -> Result<Vec<ExtraBarcode>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    stockroom::list_extra_barcodes(&conn, &actor.tenant_id, &item_id)
}

#[tauri::command]
pub fn add_product_barcode_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, barcode: String, units: f64) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_product_barcode_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    stockroom::add_extra_barcode(&conn, &actor.tenant_id, &item_id, &barcode, units)
}

#[tauri::command]
pub fn delete_product_barcode_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, barcode_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_product_barcode_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    stockroom::delete_extra_barcode(&conn, &actor.tenant_id, &barcode_id)
}

/// A new barcode of ours (EAN-13, starts with 29) for a product that has none.
#[tauri::command]
pub fn generate_product_barcode_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    stockroom::generate_barcode(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn get_retail_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<RetailSettings, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    stockroom::load_settings(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_retail_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, settings: RetailSettings) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_retail_settings_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = stockroom::load_settings(&tx, &actor.tenant_id)?;
    stockroom::save_settings(&tx, &actor.tenant_id, &settings)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "retail_settings", &actor.tenant_id, serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&settings).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
