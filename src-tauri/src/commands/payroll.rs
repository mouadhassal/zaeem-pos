//! Payroll commands (owner only): the owner's rules, each person's pay, the
//! month's payslips, bonuses and fines, advances, accepted-excuse days and
//! missed punches. All the logic is in `payroll.rs`; these only check who is
//! asking, scope the staff member to this business, audit, and call it.

use crate::audit;
use crate::payroll::{self, AdvanceRow, EmployeePay, EmployeeRow, MonthRow, Payslip, PayrollSettings};
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use tauri::State;
use super::shared::*;

/// Today's date on the till's wall clock.
fn local_today(tz_offset_minutes: i64) -> NaiveDate {
    (Utc::now() + Duration::minutes(tz_offset_minutes.clamp(-14 * 60, 14 * 60))).date_naive()
}

/// The person must be on this business's staff.
fn assert_person(conn: &rusqlite::Connection, user_id: &str, actor: &crate::security::Actor) -> Result<(), String> {
    Repo::new(conn).assert_staff_in_scope(user_id, &actor.scope()).map_err(|e| e.to_string())
}

/// Where a person's payroll rows live: their own branch, else the one the business operates.
fn home_branch(conn: &rusqlite::Connection, user_id: &str, actor: &crate::security::Actor, license: &crate::license::cloud::CloudLicenseState) -> Result<String, String> {
    let own: Option<String> = conn
        .query_row("SELECT branch_id FROM staff WHERE id = ?1", rusqlite::params![user_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    match own {
        Some(b) => Ok(b),
        None => resolve_operating_branch(conn, actor, license, None).map(|(_, b)| b),
    }
}

#[tauri::command]
pub fn get_payroll_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<PayrollSettings, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    payroll::load_settings(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_payroll_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, settings: PayrollSettings) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_payroll_settings_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = payroll::load_settings(&tx, &actor.tenant_id)?;
    payroll::save_settings(&tx, &actor.tenant_id, &settings)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_settings", &actor.tenant_id, serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&settings).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_payroll_employees_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<EmployeeRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    payroll::list_employees(&conn, &actor.tenant_id, None)
}

#[tauri::command]
pub fn save_payroll_employee_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, pay: EmployeePay) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_payroll_employee_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &pay.user_id, &actor)?;
    let branch = home_branch(&conn, &pay.user_id, &actor, &license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = payroll::load_employee_pay(&tx, &pay.user_id)?;
    payroll::save_employee_pay(&tx, &actor.tenant_id, Some(&branch), &pay)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "payroll_employee", &pay.user_id, before.and_then(|b| serde_json::to_value(b).ok()).as_ref(), serde_json::to_value(&pay).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn payroll_month_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Vec<MonthRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    payroll::month_overview(&conn, &actor.tenant_id, None, &month, tz, local_today(tz))
}

#[tauri::command]
pub fn get_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    payroll::payslip(&conn, &actor.tenant_id, &user_id, &month, tz, local_today(tz))
}

#[tauri::command]
pub fn approve_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    crate::lan::reject_if_local_kitchen_satellite("approve_payslip_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    let branch = home_branch(&conn, &user_id, &actor, &license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = payroll::approve(&tx, &actor.tenant_id, Some(&branch), &user_id, &month, tz, local_today(tz), &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::OperationalCostRecorded, "payroll_payslip", p.id.as_deref().unwrap_or(""), None, Some(&serde_json::json!({ "user_id": user_id, "month": month, "earned_cents": p.earned_cents, "net_cents": p.net_cents, "action": "approved" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(p)
}

#[tauri::command]
pub fn pay_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, payslip_id: String, tz_offset_minutes: Option<i64>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("pay_payslip_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::pay(&tx, &actor.tenant_id, &payslip_id, local_today(tz), &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::OperationalCostRecorded, "payroll_payslip", &payslip_id, None, Some(&serde_json::json!({ "action": "paid" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reopen_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, payslip_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("reopen_payslip_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::reopen(&tx, &actor.tenant_id, &payslip_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_payslip", &payslip_id, None, Some(&serde_json::json!({ "action": "reopened" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_payroll_adjustment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, kind: String, amount_cents: i64, reason: String) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_payroll_adjustment_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_adjustment(&tx, &actor.tenant_id, &user_id, &month, &kind, amount_cents, &reason, &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_adjustment", &id, None, Some(&serde_json::json!({ "user_id": user_id, "month": month, "kind": kind, "amount_cents": amount_cents, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_payroll_adjustment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, adjustment_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_payroll_adjustment_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::delete_adjustment(&tx, &actor.tenant_id, &adjustment_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_adjustment", &adjustment_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_payroll_advance_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, amount_cents: i64, instalment_cents: i64, given_on: String, reason: Option<String>) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_payroll_advance_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    let branch = home_branch(&conn, &user_id, &actor, &license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_advance(&tx, &actor.tenant_id, Some(&branch), &user_id, amount_cents, instalment_cents, &given_on, reason.as_deref(), &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "payroll_advance", &id, None, Some(&serde_json::json!({ "user_id": user_id, "amount_cents": amount_cents, "instalment_cents": instalment_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_payroll_advances_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: Option<String>) -> Result<Vec<AdvanceRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    payroll::list_advances(&conn, &actor.tenant_id, user_id.as_deref(), false)
}

#[tauri::command]
pub fn cancel_payroll_advance_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, advance_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("cancel_payroll_advance_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::cancel_advance(&tx, &actor.tenant_id, &advance_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_advance", &advance_id, None, Some(&serde_json::json!({ "cancelled": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Marks a day as an accepted excuse / paid leave (`on = true`) or clears the mark.
#[tauri::command]
pub fn set_paid_leave_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, day: String, note: Option<String>, on: bool) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_paid_leave_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if on {
        payroll::mark_paid_leave(&tx, &actor.tenant_id, &user_id, &day, note.as_deref(), &actor.id)?;
    } else {
        payroll::unmark_paid_leave(&tx, &user_id, &day)?;
    }
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_day_mark", &user_id, None, Some(&serde_json::json!({ "day": day, "paid_leave": on, "note": note }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// A missed arrival or departure added by hand, for a time that has passed.
#[tauri::command]
pub fn add_manual_punch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, punched_at_iso: String, direction: String, reason: String) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_manual_punch_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    if reason.trim().is_empty() {
        return Err("اكتب سبب إضافة البصمة".to_string());
    }
    let at = DateTime::parse_from_rfc3339(&punched_at_iso).map_err(|_| "الوقت غير صالح".to_string())?.with_timezone(&Utc);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_person(&conn, &user_id, &actor)?;
    let branch = home_branch(&conn, &user_id, &actor, &license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_manual_punch(&tx, &actor.tenant_id, &branch, &user_id, at, &direction, &actor.id, Utc::now())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "manual_punch", "direction": direction, "at": punched_at_iso, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
