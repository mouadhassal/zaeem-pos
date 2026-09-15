use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;
use super::orders::{sync_enqueue_staff_snapshot, verify_manager_override_impl};

// ---------------------------------------------------------------------------
// Batch 3b, slice 2, group 3 -- shifts.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_active_shift_v3(state: State<Db>, session_token: String) -> Result<Option<crate::repo::ShiftRow>, String> {
    get_active_shift_v3_impl(&state, session_token)
}

pub(crate) fn get_active_shift_v3_impl(state: &Db, session_token: String) -> Result<Option<crate::repo::ShiftRow>, String> {
    crate::lan::reject_if_local_kitchen_satellite("get_active_shift_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_active_shift(&actor.id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_shift_stats_v3(state: State<Db>, session_token: String, shift_id: String) -> Result<crate::repo::ShiftStatsRow, String> {
    get_shift_stats_v3_impl(&state, session_token, shift_id)
}

/// Security audit finding (pre-launch pass): previously called only
/// `authenticate_actor` (no `authorize`, and `shift_stats` itself took no
/// scope) -- any logged-in staff member, any rank, could read any tenant's
/// shift revenue by ID. Now requires the same permission `list_shift_orders_v3`
/// implicitly relies on and scope-qualifies the query, matching that command.
pub(crate) fn get_shift_stats_v3_impl(state: &Db, session_token: String, shift_id: String) -> Result<crate::repo::ShiftStatsRow, String> {
    crate::lan::reject_if_local_kitchen_satellite("get_shift_stats_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::ManageShift).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).shift_stats(&shift_id, &actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_shift_orders_v3(state: State<Db>, session_token: String, shift_id: String) -> Result<Vec<crate::repo::ShiftOrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_shift_orders(&shift_id, &actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_shift_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, starting_cash_cents: i64, branch_id: Option<String>) -> Result<String, String> {
    open_shift_v3_impl(&state, &license, session_token, starting_cash_cents, branch_id)
}

pub(crate) fn open_shift_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, starting_cash_cents: i64, branch_id: Option<String>) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("open_shift_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::ManageShift).map_err(|e| e.to_string())?;
    if starting_cash_cents < 0 {
        return Err("negative starting cash is not valid".to_string());
    }

    let (tenant_id, resolved_branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, branch_id)?
    };

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let shift_id = Repo::new(&tx).open_shift(&tenant_id, &resolved_branch_id, &actor.id, starting_cash_cents).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&resolved_branch_id), &actor.id, audit::Action::ShiftOpened, "shift", &shift_id, None, Some(&serde_json::json!({ "starting_cash_cents": starting_cash_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(shift_id)
}

#[tauri::command]
pub fn close_shift_v3(state: State<Db>, session_token: String, shift_id: String, ending_cash_cents: i64, difference_cents: i64, manager_override_pin: Option<String>) -> Result<(), String> {
    close_shift_v3_impl(&state, session_token, shift_id, ending_cash_cents, difference_cents, manager_override_pin)
}

/// 2026-08-02: previously this threshold existed ONLY client-side
/// (`shift/page.tsx`'s `DIFF_THRESHOLD_CENTS`) with no server enforcement
/// at all -- a cashier calling this command directly (bypassing the UI)
/// could close any shift with any discrepancy, no PIN, ever. Now checked
/// here against the tenant's real `shift_diff_manager_threshold_cents`,
/// same shape as `void_order_item_v3_impl`'s check.
pub(crate) fn close_shift_v3_impl(state: &Db, session_token: String, shift_id: String, ending_cash_cents: i64, difference_cents: i64, manager_override_pin: Option<String>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("close_shift_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::ManageShift).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let threshold_cents = Repo::new(&conn).get_manager_thresholds(&actor.tenant_id).map_err(|e| e.to_string())?.shift_diff_threshold_cents;
    if difference_cents.abs() >= threshold_cents {
        let Some(pin) = manager_override_pin.as_deref() else {
            return Err("closing a shift with a discrepancy over the manager-override threshold requires a manager PIN".to_string());
        };
        if !verify_manager_override_impl(&mut conn, &actor, pin)? {
            return Err("manager PIN is not valid".to_string());
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).close_shift(&actor.scope(), &shift_id, ending_cash_cents, difference_cents).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ShiftClosed, "shift", &shift_id, None, Some(&serde_json::json!({ "ending_cash_cents": ending_cash_cents, "difference_cents": difference_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// `staff/page.tsx`'s shifts tab: list + filter, and a manager's "force
/// close" for an abandoned shift.
#[tauri::command]
pub fn list_shifts_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, date_from: Option<String>, date_to: Option<String>, user_id: Option<String>) -> Result<Vec<crate::repo::ShiftAdminRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_shifts(&actor.scope(), date_from.as_deref(), date_to.as_deref(), user_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn force_close_shift_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, shift_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).force_close_shift(&actor.scope(), &shift_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ShiftClosed, "shift", &shift_id, None, Some(&serde_json::json!({ "forced": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_attendance_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, date_from: Option<String>, date_to: Option<String>, user_id: Option<String>) -> Result<Vec<crate::repo::AttendanceRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_attendance(&actor.scope(), date_from.as_deref(), date_to.as_deref(), user_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clock_in_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String) -> Result<(), String> {
    clock_in_v3_impl(&state, &license, session_token, user_id)
}

pub(crate) fn clock_in_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("clock_in_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).clock_in(&actor.scope(), &tenant_id, &branch_id, &user_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "clock_in" }))).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_staff_snapshot(&tx, &tenant_id, &user_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clock_out_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String) -> Result<(), String> {
    clock_out_v3_impl(&state, &license, session_token, user_id)
}

pub(crate) fn clock_out_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("clock_out_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).clock_out(&actor.scope(), &user_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "clock_out" }))).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_staff_snapshot(&tx, &actor.tenant_id, &user_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

