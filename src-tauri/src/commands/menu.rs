use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;

// ---------------------------------------------------------------------------
// Batch 3b, slice 2 -- menu CRUD (`categories` + `menu_items`, tenant-only).
// Deliberately NOT `combo_meals`/`combo_items`/`happy_hour_rules` -- stated
// scope reduction, `menu/page.tsx` still reads/writes those 3 via `getDb()`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_categories_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::CategoryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_categories(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_category_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, color: Option<String>, sort_order: i64, image_path: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let category_id = Repo::new(&tx).create_category(&actor.tenant_id, &name, color.as_deref(), sort_order, image_path.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(category_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_category_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category_id: String, name: String, color: Option<String>, sort_order: i64, image_path: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_category(&actor.tenant_id, &category_id, &name, color.as_deref(), sort_order, image_path.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_category_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_category(&actor.tenant_id, &category_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 2026-08-02: real category photo upload, same shape as
/// `upload_menu_item_photo_v3`/`delete_menu_item_photo_v3`/
/// `get_menu_item_photo_v3` below -- categories previously only had a raw
/// URL text field ("رابط الصورة"), inconsistent with menu items' real
/// upload flow, and most owners don't have an image URL handy.
#[tauri::command]
pub fn upload_category_photo_v3(app: tauri::AppHandle, state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category_id: String, photo_bytes: Vec<u8>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;

    let app_data_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file_path = crate::photos::store_photo(&app_data_dir, &actor.tenant_id, &category_id, &photo_bytes).map_err(|e| e.to_string())?;
    let path_str = file_path.to_string_lossy().to_string();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_category_photo(&actor.tenant_id, &category_id, Some(&path_str)).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "photo_uploaded": true, "bytes": photo_bytes.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_category_photo_v3(app: tauri::AppHandle, state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, category_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_category_photo(&actor.tenant_id, &category_id, None).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, Some(&serde_json::json!({ "photo_uploaded": true })), Some(&serde_json::json!({ "photo_uploaded": false }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let app_data_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::photos::delete_photo(&app_data_dir, &actor.tenant_id, &category_id);
    Ok(())
}

#[tauri::command]
pub fn get_category_photo_v3(state: State<Db>, session_token: String, category_id: String) -> Result<Option<String>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let path = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        Repo::new(&conn).get_category_photo_path(&actor.tenant_id, &category_id).map_err(|e| e.to_string())?
    };
    Ok(path.as_deref().and_then(crate::photos::read_as_data_uri))
}

#[tauri::command]
pub fn list_menu_items_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::MenuItemRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut items = Repo::new(&conn).list_menu_items(&actor.tenant_id).map_err(|e| e.to_string())?;
    // P0 fix (2026-07-18): this used to resolve EVERY item's photo to a
    // full base64 data: URI right here, inside the SAME state.0.lock()
    // guard every one of the app's ~141 other commands also needs for any
    // DB access at all. Measured: 5 items with 2MB photos each added
    // 415ms of file-read + base64-encode work INSIDE that lock, and blew
    // the JSON payload up to 13.3MB for a 5-row list -- on a real menu
    // with dozens of photographed items this is multiple seconds of the
    // entire app (any payment, any order, any other screen) stalled
    // behind one menu-grid load. That's the reported "app frequently
    // hangs" bug, reproduced and measured, not guessed.
    //
    // Fixed: this now returns instantly regardless of photo count/size.
    // `image_path` carries only a boolean-shaped signal ("HAS_PHOTO" or
    // null) -- never the real filesystem path (nothing for the frontend
    // to do with a server-local absolute path anyway) and never image
    // bytes. The actual photo is fetched lazily, one item at a time, via
    // `get_menu_item_photo_v3`, only for items visible on screen -- see
    // that command's doc comment for the scope-check + single-file-read
    // cost (milliseconds, not hundreds of them, and never blocks anyone
    // else since it touches one row, not the whole list).
    for item in &mut items {
        item.image_path = item.image_path.as_deref().map(|_| "HAS_PHOTO".to_string());
    }
    Ok(items)
}

/// P0 fix (2026-07-18): the lazy per-item counterpart to `list_menu_
/// items_v3` no longer embedding photos. Reads exactly one file, scope-
/// checked (a Manager can only fetch a photo for their own tenant's
/// product, same `assert_tenant_owns_row` guard as every other menu_items
/// access), and returns a data: URI ready for <img src> -- or None if the
/// item has no photo / the stored path is stale, which the frontend
/// treats as "show the category glyph", identical to today's fallback.
#[tauri::command]
pub fn get_menu_item_photo_v3(state: State<Db>, session_token: String, item_id: String) -> Result<Option<String>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let path = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        Repo::new(&conn).get_menu_item_photo_path(&actor.tenant_id, &item_id).map_err(|e| e.to_string())?
        // lock dropped here, before the file read -- the DB mutex is never
        // held during disk I/O, not even for one file.
    };
    Ok(path.as_deref().and_then(crate::photos::read_as_data_uri))
}

/// Phase 2 Part 2: attach a photo to a product. Stored on disk, keyed by
/// product id, tenant-namespaced (`photos::store_photo`); `menu_items.
/// image_path` is updated to the real file path in the same transaction.
/// `ManageMenu`-gated (Manager+) and tenant-scoped via `set_menu_item_
/// photo`'s `assert_tenant_owns_row` -- a manager can only set a photo for
/// their own tenant's product, never another tenant's by id.
#[tauri::command]
pub fn upload_menu_item_photo_v3(app: tauri::AppHandle, state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, photo_bytes: Vec<u8>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;

    let app_data_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let file_path = crate::photos::store_photo(&app_data_dir, &actor.tenant_id, &item_id, &photo_bytes).map_err(|e| e.to_string())?;
    let path_str = file_path.to_string_lossy().to_string();

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_menu_item_photo(&actor.tenant_id, &item_id, Some(&path_str)).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "photo_uploaded": true, "bytes": photo_bytes.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes a product's photo (falls back to the category glyph).
#[tauri::command]
pub fn delete_menu_item_photo_v3(app: tauri::AppHandle, state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_menu_item_photo(&actor.tenant_id, &item_id, None).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, Some(&serde_json::json!({ "photo_uploaded": true })), Some(&serde_json::json!({ "photo_uploaded": false }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let app_data_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::photos::delete_photo(&app_data_dir, &actor.tenant_id, &item_id);
    Ok(())
}

/// Every "تصدير PDF" button (customers, debt, finance, suppliers, reports)
/// renders a PDF client-side (html2canvas + jsPDF) then hands the raw bytes
/// here to actually reach disk. jsPDF's own `doc.save()` -- a blob URL plus
/// a synthetic `<a download>` click -- relies on a browser's download
/// manager to catch that click; Tauri's webview has none, and the app's CSP
/// has no `blob:` allowance either, so every export button silently
/// generated a PDF in memory and then did nothing with it. Writes straight
/// to the OS Downloads folder (no save dialog/new plugin: a well-known,
/// predictable destination is enough for a desktop POS's periodic reports)
/// and returns the full path so the UI can tell the user where it landed.
/// NOT_GATED: exports must keep working even with a locked license, same
/// posture as printing.
#[tauri::command]
pub fn export_pdf_v3(app: tauri::AppHandle, state: State<Db>, session_token: String, filename: String, bytes: Vec<u8>) -> Result<String, String> {
    authenticate_actor(&state, &session_token)?;
    // No path traversal from a caller-controlled filename -- keep only the
    // leaf name, strip any ".." segments.
    let leaf = filename.rsplit(['/', '\\']).next().unwrap_or(&filename);
    let safe_name = leaf.replace("..", "");
    if safe_name.is_empty() {
        return Err("invalid export filename".to_string());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_combo_components_v3(state: State<Db>, session_token: String, menu_item_id: String) -> Result<Vec<crate::repo::ComboComponentRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_combo_components(&actor.tenant_id, &menu_item_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_menu_item_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, category_id: String, price_cents: i64, cost_cents: i64, description: Option<String>, barcode: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if price_cents < 0 || cost_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let item_id = Repo::new(&tx)
        .create_menu_item(&actor.tenant_id, &name, &category_id, price_cents, cost_cents, description.as_deref(), barcode.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "name": name, "price_cents": price_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(item_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_menu_item_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, name: String, category_id: String, price_cents: i64, cost_cents: i64, description: Option<String>, barcode: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if price_cents < 0 || cost_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx)
        .update_menu_item(&actor.tenant_id, &item_id, &name, &category_id, price_cents, cost_cents, description.as_deref(), barcode.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "name": name, "price_cents": price_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_menu_item_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_menu_item(&actor.tenant_id, &item_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_menu_item_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, item_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_menu_item_active(&actor.tenant_id, &item_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 2026-08-04: "mark an item out of stock mid-rush" -- deliberately a
/// separate, lower-friction command from `set_menu_item_active_v3` above,
/// not a relaxed permission on that one. Same underlying repo write
/// (`Repo::set_menu_item_active`), but `set_menu_item_active_v3` is the
/// full menu-management action (Manager+, license-gated) and this is
/// floor work: Cashier/Kitchen rank, and deliberately NOT license-gated
/// -- a locked back-office license must never stop the kitchen from
/// pulling a sold-out item off the grid before someone orders it.
#[tauri::command]
pub fn toggle_menu_item_availability_v3(state: State<Db>, session_token: String, item_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ToggleItemAvailability).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_menu_item_active(&actor.tenant_id, &item_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "is_active": is_active, "via": "kds_availability_toggle" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
// License-gate removed (found live, 2026-08-30): this is read by the POS
// floor's own MenuGridContainer/menuStore.fetchMenu() -- bundled into the
// SAME Promise.all() as list_menu_items_v3/list_categories_v3, all needed
// just to price and sell what's already on the menu. `require_license_
// not_locked`'s own doc comment is explicit that "order/payment/print
// commands never call this at all" and the POS-never-stops-selling
// guarantee is meant to be structural -- this READ was gating exactly the
// commands that guarantee promises stay open, and because Promise.all
// rejects on the FIRST failure, one locked combo-meal read was enough to
// blank the entire sales floor grid to "0 items" (reproduced live: a real
// expired-license install showed the console error "license expired --
// back-office access is locked... Point of sale keeps working normally"
// immediately followed by a totally empty item grid -- the opposite of
// what that message promises). The WRITE side (create/update/delete_
// combo_meal_v3, below) correctly keeps the gate -- editing what's on the
// menu is a real back-office task; reading it to sell it is not.
pub fn list_combo_meals_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::ComboMealRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_combo_meals(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
// Same fix, same reasoning as list_combo_meals_v3 immediately above.
pub fn list_combo_meal_items_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::ComboItemJoinRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_combo_meal_items(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_combo_meal_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, bundle_price_cents: i64, items: Vec<(String, i64)>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let combo_id = Repo::new(&tx).create_combo_meal(&actor.tenant_id, &name, bundle_price_cents, &items).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ComboMealChanged, "combo_meal", &combo_id, None, Some(&serde_json::json!({ "name": name, "item_count": items.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(combo_id)
}

#[tauri::command]
pub fn update_combo_meal_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, combo_id: String, name: String, bundle_price_cents: i64, items: Vec<(String, i64)>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_combo_meal(&actor.tenant_id, &combo_id, &name, bundle_price_cents, &items).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ComboMealChanged, "combo_meal", &combo_id, None, Some(&serde_json::json!({ "name": name, "item_count": items.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_combo_meal_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, combo_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_combo_meal(&actor.tenant_id, &combo_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ComboMealChanged, "combo_meal", &combo_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
// Same fix, same reasoning as list_combo_meals_v3's doc comment above --
// happy-hour discount rules are read live by the sales floor to price an
// order correctly, not a back-office-only concern. Write side (create/
// update/delete_happy_hour_rule_v3, below) correctly keeps the gate.
pub fn list_happy_hour_rules_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::HappyHourRuleRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_happy_hour_rules(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_happy_hour_rule_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, menu_item_id: String, discount_percent: i64, day_of_week: i64, start_time: String, end_time: String, is_active: bool) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let rule_id = Repo::new(&tx).create_happy_hour_rule(&actor.tenant_id, &menu_item_id, discount_percent, day_of_week, &start_time, &end_time, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::HappyHourRuleChanged, "happy_hour_rule", &rule_id, None, Some(&serde_json::json!({ "menu_item_id": menu_item_id, "discount_percent": discount_percent }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rule_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_happy_hour_rule_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, rule_id: String, menu_item_id: String, discount_percent: i64, day_of_week: i64, start_time: String, end_time: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_happy_hour_rule(&actor.tenant_id, &rule_id, &menu_item_id, discount_percent, day_of_week, &start_time, &end_time, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::HappyHourRuleChanged, "happy_hour_rule", &rule_id, None, Some(&serde_json::json!({ "menu_item_id": menu_item_id, "discount_percent": discount_percent }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_happy_hour_rule_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, rule_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_happy_hour_rule(&actor.tenant_id, &rule_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::HappyHourRuleChanged, "happy_hour_rule", &rule_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_happy_hour_rule_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, rule_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_happy_hour_rule_active(&actor.tenant_id, &rule_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::HappyHourRuleChanged, "happy_hour_rule", &rule_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

