//! Order history screen and daily order numbers. Rules and queries live in
//! `order_history.rs`; these wrappers authenticate, scope to this branch and
//! audit. Who sees what: a manager or the owner sees every order of any day;
//! a cashier sees only the orders they took today (to reprint a customer's
//! receipt). The kitchen sees neither. Refunds are `refund_order_v3`.

use crate::audit;
use crate::ops_settings::{self, HistoryAccess};
use crate::order_history::{self, HistoryDetail, HistoryRow, OrderNumber};
use crate::security::{authorize, Actor, Permission, Role};
use crate::Db;
use std::collections::HashMap;
use tauri::State;
use super::shared::*;

/// History is for the people who take money: not the kitchen (same rank as
/// a cashier, so the role is checked by name).
fn may_view_history(actor: &Actor) -> Result<(), String> {
    authorize(actor, Permission::TakePayment).map_err(|e| e.to_string())?;
    if matches!(actor.role, Role::Kitchen) {
        return Err("سجل الطلبات غير متاح لحساب المطبخ".to_string());
    }
    Ok(())
}

/// The day and the person a viewer is limited to. A manager or the owner sees every order of any
/// day; a cashier sees today's own orders, or more if the owner widened it (`ops_settings`).
fn viewer_limits(conn: &rusqlite::Connection, actor: &Actor, business_date: Option<String>) -> Result<(String, Option<String>), String> {
    let today = order_history::today();
    if actor.role.rank() >= Role::Manager.rank() {
        return Ok((business_date.unwrap_or(today), None));
    }
    let access = ops_settings::load_history_access(conn, &actor.tenant_id)?;
    let date = ops_settings::clamp_cashier_date(business_date.as_deref(), &today, access.cashier_history_days);
    Ok((date, if access.cashier_sees_all { None } else { Some(actor.id.clone()) }))
}

/// Daily numbers (A-0001...) for orders, for tickets, the kitchen screen and
/// lists. Orders from before numbering are absent; the caller shows the old
/// short code for them.
#[tauri::command]
pub fn get_order_numbers_v3(state: State<Db>, session_token: String, order_ids: Vec<String>) -> Result<HashMap<String, OrderNumber>, String> {
    get_order_numbers_v3_impl(&state, session_token, order_ids)
}

pub(crate) fn get_order_numbers_v3_impl(state: &Db, session_token: String, order_ids: Vec<String>) -> Result<HashMap<String, OrderNumber>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::ViewOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    order_history::numbers_for(&conn, &actor.tenant_id, &order_ids).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
pub struct HistoryDay {
    pub business_date: String,
    pub today: String,
    /// True when the viewer only sees their own orders of today.
    pub own_only: bool,
    /// How many days before today this viewer may open (0 = today only; a manager has no limit).
    pub back_days: i64,
    pub rows: Vec<HistoryRow>,
}

#[tauri::command]
pub fn list_order_history_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, business_date: Option<String>) -> Result<HistoryDay, String> {
    list_order_history_v3_impl(&state, &license, session_token, business_date)
}

pub(crate) fn list_order_history_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, business_date: Option<String>) -> Result<HistoryDay, String> {
    let actor = authenticate_actor(state, &session_token)?;
    may_view_history(&actor)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (date, only_user) = viewer_limits(&conn, &actor, business_date)?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    let rows = order_history::list_day(&conn, &tenant_id, &branch_id, &date, only_user.as_deref())?;
    let back_days = if actor.role.rank() >= Role::Manager.rank() { 3650 } else { ops_settings::load_history_access(&conn, &actor.tenant_id)?.cashier_history_days };
    Ok(HistoryDay { business_date: date, today: order_history::today(), own_only: only_user.is_some(), back_days, rows })
}

#[tauri::command]
pub fn get_order_history_detail_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, order_id: String) -> Result<HistoryDetail, String> {
    get_order_history_detail_v3_impl(&state, &license, session_token, order_id)
}

pub(crate) fn get_order_history_detail_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, order_id: String) -> Result<HistoryDetail, String> {
    let actor = authenticate_actor(state, &session_token)?;
    may_view_history(&actor)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (_, only_user) = viewer_limits(&conn, &actor, None)?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    order_history::detail(&conn, &tenant_id, &branch_id, &order_id, only_user.as_deref())?
        .ok_or_else(|| "الطلب غير موجود".to_string())
}

/// A receipt printed again from the history screen: written to the audit
/// log, so a copy handed out can always be traced to who printed it.
#[tauri::command]
pub fn record_receipt_reprint_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, order_id: String) -> Result<(), String> {
    record_receipt_reprint_v3_impl(&state, &license, session_token, order_id)
}

pub(crate) fn record_receipt_reprint_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, order_id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    may_view_history(&actor)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (_, only_user) = viewer_limits(&conn, &actor, None)?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    if order_history::detail(&conn, &tenant_id, &branch_id, &order_id, only_user.as_deref())?.is_none() {
        return Err("الطلب غير موجود".to_string());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "receipt_reprinted" })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The owner's rule for how far back a cashier may look and reprint (managers always see all).
#[tauri::command]
pub fn get_history_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<HistoryAccess, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    ops_settings::load_history_access(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_history_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, access: HistoryAccess) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_history_access_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = ops_settings::load_history_access(&tx, &actor.tenant_id)?;
    ops_settings::save_history_access(&tx, &actor.tenant_id, &access)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "ops_settings", &actor.tenant_id, serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&access).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
