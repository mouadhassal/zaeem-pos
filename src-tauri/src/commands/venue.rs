//! Dining areas, delivery apps and receipt templates (Migration AT). Thin wrappers: authenticate,
//! authorize, call the plain functions in `venue.rs`, audit. Reading what the till needs (areas,
//! active apps, templates) and stating an order's source are selling-path work and never
//! licence-gated; setting things up is.

use crate::audit;
use crate::security::{authorize, Permission};
use crate::venue::{self, DiningArea, Platform, PlatformAccount, PlatformInput, PlatformSettlement, ReceiptTemplate, TemplateInput};
use crate::Db;
use tauri::State;
use super::shared::*;

fn audit_settings(tx: &rusqlite::Transaction, actor: &crate::security::Actor, entity: &str, id: &str, detail: serde_json::Value) -> Result<(), String> {
    audit::append(tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, entity, id, None, Some(&detail)).map_err(|e| e.to_string())
}

// ---- dining areas ----

#[tauri::command]
pub fn list_dining_areas_v3(state: State<Db>, session_token: String) -> Result<Vec<DiningArea>, String> {
    list_dining_areas_v3_impl(&state, session_token)
}

pub(crate) fn list_dining_areas_v3_impl(state: &Db, session_token: String) -> Result<Vec<DiningArea>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::list_areas(&conn, &actor.scope())
}

/// Creates (`area_id` None) or renames an area.
#[tauri::command]
pub fn save_dining_area_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, area_id: Option<String>, name: String, sort_order: Option<i64>) -> Result<String, String> {
    save_dining_area_v3_impl(&state, &license, session_token, area_id, name, sort_order)
}

pub(crate) fn save_dining_area_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, area_id: Option<String>, name: String, sort_order: Option<i64>) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = venue::save_area(&tx, &actor.scope(), &tenant_id, &branch_id, area_id.as_deref(), &name, sort_order)?;
    audit_settings(&tx, &actor, "dining_area", &id, serde_json::json!({ "name": name.trim(), "created": area_id.is_none() }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_dining_area_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, area_id: String) -> Result<(), String> {
    delete_dining_area_v3_impl(&state, &license, session_token, area_id)
}

pub(crate) fn delete_dining_area_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, area_id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    venue::delete_area(&tx, &actor.scope(), &area_id)?;
    audit_settings(&tx, &actor, "dining_area", &area_id, serde_json::json!({ "deleted": true }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts a table in an area, or (area_id None) takes it out of its area.
#[tauri::command]
pub fn set_table_area_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, table_id: String, area_id: Option<String>) -> Result<(), String> {
    set_table_area_v3_impl(&state, &license, session_token, table_id, area_id)
}

pub(crate) fn set_table_area_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, table_id: String, area_id: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    venue::set_table_area(&tx, &actor.scope(), &table_id, area_id.as_deref())?;
    audit_settings(&tx, &actor, "table", &table_id, serde_json::json!({ "area_id": area_id }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---- delivery apps ----

/// The apps an order can come from (the till shows the active ones).
#[tauri::command]
pub fn list_delivery_platforms_v3(state: State<Db>, session_token: String, include_inactive: Option<bool>) -> Result<Vec<Platform>, String> {
    list_delivery_platforms_v3_impl(&state, session_token, include_inactive)
}

pub(crate) fn list_delivery_platforms_v3_impl(state: &Db, session_token: String, include_inactive: Option<bool>) -> Result<Vec<Platform>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::list_platforms(&conn, &actor.scope(), include_inactive.unwrap_or(false))
}

/// States which app an open order came from (None = direct). Saved on the order the same way
/// "no bill" is.
#[tauri::command]
pub fn set_order_platform_v3(state: State<Db>, session_token: String, order_id: String, platform_id: Option<String>) -> Result<(), String> {
    set_order_platform_v3_impl(&state, session_token, order_id, platform_id)
}

pub(crate) fn set_order_platform_v3_impl(state: &Db, session_token: String, order_id: String, platform_id: Option<String>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_order_platform_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::set_order_platform(&conn, &actor.scope(), &order_id, platform_id.as_deref())
}

#[tauri::command]
pub fn save_delivery_platform_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, platform: PlatformInput) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = venue::save_platform(&tx, &actor.scope(), &tenant_id, &branch_id, &platform)?;
    audit_settings(&tx, &actor, "delivery_platform", &id, serde_json::json!({ "name": platform.name.trim(), "commission_bp": platform.commission_bp, "active": platform.active }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Every app's account for a period (local dates, YYYY-MM-DD, either end may be empty).
#[tauri::command]
pub fn platform_accounts_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, from: Option<String>, to: Option<String>) -> Result<Vec<PlatformAccount>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::platform_accounts(&conn, &actor.scope(), from.as_deref(), to.as_deref())
}

/// Records what an app paid out for a period.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn record_platform_settlement_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    platform_id: String,
    amount_cents: i64,
    period_from: Option<String>,
    period_to: Option<String>,
    note: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = venue::record_settlement(&tx, &actor.scope(), &platform_id, amount_cents, period_from.as_deref(), period_to.as_deref(), note.as_deref(), &actor.id)?;
    audit_settings(&tx, &actor, "platform_settlement", &id, serde_json::json!({ "platform_id": platform_id, "amount_cents": amount_cents, "period_from": period_from, "period_to": period_to }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_platform_settlements_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, platform_id: String, limit: Option<i64>) -> Result<Vec<PlatformSettlement>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::list_settlements(&conn, &actor.scope(), &platform_id, limit.unwrap_or(50))
}

// ---- receipt templates ----

/// The templates the printing code applies (read on every terminal that prints).
#[tauri::command]
pub fn list_receipt_templates_v3(state: State<Db>, session_token: String) -> Result<Vec<ReceiptTemplate>, String> {
    list_receipt_templates_v3_impl(&state, session_token)
}

pub(crate) fn list_receipt_templates_v3_impl(state: &Db, session_token: String) -> Result<Vec<ReceiptTemplate>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    venue::list_templates(&conn, &actor.scope())
}

#[tauri::command]
pub fn save_receipt_template_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, template: TemplateInput) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = venue::save_template(&tx, &actor.scope(), &tenant_id, &branch_id, &template)?;
    audit_settings(&tx, &actor, "receipt_template", &id, serde_json::json!({ "name": template.name.trim(), "kind": template.kind }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_receipt_template_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, template_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    venue::delete_template(&tx, &actor.scope(), &template_id)?;
    audit_settings(&tx, &actor, "receipt_template", &template_id, serde_json::json!({ "deleted": true }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Chooses the template a printer prints with (None = the standard layout).
#[tauri::command]
pub fn set_printer_template_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, printer_id: String, template_id: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    venue::set_printer_template(&tx, &actor.scope(), &printer_id, template_id.as_deref())?;
    audit_settings(&tx, &actor, "printer", &printer_id, serde_json::json!({ "template_id": template_id }))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
