//! Payroll commands: the owner's rules, each person's pay, the month's
//! payslips, bonuses and fines, advances, accepted-excuse days and missed
//! punches. All the logic is in `payroll.rs`; these only check who is asking
//! (the OWNER, or a branch manager the owner switched payroll on for -- see
//! `payroll::PayrollScope`), keep them to the people they may deal with,
//! audit, and call it.
//!
//! The hierarchy: the owner sets the rules, who may do what, and every
//! person's pay. A manager can, when the owner allows it, work on the staff
//! under them in their own branch (prepare the month, or also approve and pay
//! it), and never sees the owner's or another manager's pay.

use crate::audit;
use crate::payroll::{self, AdvanceRow, AttendanceReview, EmployeePay, EmployeeRow, MonthRow, Payslip, PayrollScope, PayrollSettings, WorkerStatement};
use crate::security::{authorize, Permission};
use crate::Db;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use tauri::State;
use super::shared::*;

/// Today's date on the till's wall clock.
fn local_today(tz_offset_minutes: i64) -> NaiveDate {
    (Utc::now() + Duration::minutes(tz_offset_minutes.clamp(-14 * 60, 14 * 60))).date_naive()
}

/// What this actor may do in payroll right now (the owner's `manager_access` choice decides for a manager).
pub(crate) fn scope_of(conn: &rusqlite::Connection, actor: &crate::security::Actor) -> Result<PayrollScope, String> {
    let access = payroll::load_settings(conn, &actor.tenant_id)?.manager_access;
    PayrollScope::for_actor(actor.role, actor.branch_id.as_deref(), &access)
}

fn owner_only(scope: &PayrollScope) -> Result<(), String> {
    if scope.can_edit_rules {
        Ok(())
    } else {
        Err("هذه العملية للمالك وحده".to_string())
    }
}

fn approvers_only(scope: &PayrollScope) -> Result<(), String> {
    if scope.can_approve {
        Ok(())
    } else {
        Err("اعتماد الرواتب وصرفها للمالك. المشرف يجهّز الكشف فقط".to_string())
    }
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

/// What the person asking may do in payroll: the page shows or hides its tabs and buttons by this.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PayrollAccess {
    pub is_owner: bool,
    pub can_edit_rules: bool,
    pub can_approve: bool,
    /// The owner's choice for managers: NONE | PREPARE | FULL.
    pub manager_access: String,
}

#[tauri::command]
pub fn get_payroll_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<PayrollAccess, String> {
    get_payroll_access_v3_impl(&state, &license, session_token)
}

pub(crate) fn get_payroll_access_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<PayrollAccess, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let manager_access = payroll::load_settings(&conn, &actor.tenant_id)?.manager_access;
    let scope = scope_of(&conn, &actor)?;
    Ok(PayrollAccess { is_owner: scope.is_owner, can_edit_rules: scope.can_edit_rules, can_approve: scope.can_approve, manager_access })
}

#[tauri::command]
pub fn get_payroll_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<PayrollSettings, String> {
    get_payroll_settings_v3_impl(&state, &license, session_token)
}

pub(crate) fn get_payroll_settings_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<PayrollSettings, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    owner_only(&scope_of(&conn, &actor)?)?;
    payroll::load_settings(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_payroll_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, settings: PayrollSettings) -> Result<(), String> {
    save_payroll_settings_v3_impl(&state, &license, session_token, settings)
}

pub(crate) fn save_payroll_settings_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, settings: PayrollSettings) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_payroll_settings_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
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
    list_payroll_employees_v3_impl(&state, &license, session_token)
}

pub(crate) fn list_payroll_employees_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<EmployeeRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::list_employees(&conn, &actor.tenant_id, &scope)
}

#[tauri::command]
pub fn save_payroll_employee_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, pay: EmployeePay) -> Result<(), String> {
    save_payroll_employee_v3_impl(&state, &license, session_token, pay)
}

pub(crate) fn save_payroll_employee_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, pay: EmployeePay) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_payroll_employee_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManagePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    owner_only(&scope)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &pay.user_id, &scope)?;
    let branch = home_branch(&conn, &pay.user_id, &actor, license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = payroll::load_employee_pay(&tx, &pay.user_id)?;
    payroll::save_employee_pay(&tx, &actor.tenant_id, Some(&branch), &pay)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "payroll_employee", &pay.user_id, before.and_then(|b| serde_json::to_value(b).ok()).as_ref(), serde_json::to_value(&pay).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn payroll_month_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Vec<MonthRow>, String> {
    payroll_month_v3_impl(&state, &license, session_token, month, tz_offset_minutes)
}

pub(crate) fn payroll_month_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Vec<MonthRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::month_overview(&conn, &actor.tenant_id, &scope, &month, tz, local_today(tz))
}

#[tauri::command]
pub fn get_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    get_payslip_v3_impl(&state, &license, session_token, user_id, month, tz_offset_minutes)
}

pub(crate) fn get_payslip_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    payroll::payslip(&conn, &actor.tenant_id, &user_id, &month, tz, local_today(tz))
}

#[tauri::command]
pub fn approve_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    approve_payslip_v3_impl(&state, &license, session_token, user_id, month, tz_offset_minutes)
}

pub(crate) fn approve_payslip_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<Payslip, String> {
    crate::lan::reject_if_local_kitchen_satellite("approve_payslip_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    approvers_only(&scope)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let branch = home_branch(&conn, &user_id, &actor, license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let p = payroll::approve(&tx, &actor.tenant_id, Some(&branch), &user_id, &month, tz, local_today(tz), &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::OperationalCostRecorded, "payroll_payslip", p.id.as_deref().unwrap_or(""), None, Some(&serde_json::json!({ "user_id": user_id, "month": month, "earned_cents": p.earned_cents, "net_cents": p.net_cents, "action": "approved" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(p)
}

#[tauri::command]
pub fn pay_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, payslip_id: String, tz_offset_minutes: Option<i64>) -> Result<(), String> {
    pay_payslip_v3_impl(&state, &license, session_token, payslip_id, tz_offset_minutes)
}

pub(crate) fn pay_payslip_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, payslip_id: String, tz_offset_minutes: Option<i64>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("pay_payslip_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    approvers_only(&scope)?;
    payroll::payslip_person_in_scope(&conn, &actor.tenant_id, &payslip_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::pay(&tx, &actor.tenant_id, &payslip_id, local_today(tz), &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::OperationalCostRecorded, "payroll_payslip", &payslip_id, None, Some(&serde_json::json!({ "action": "paid" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reopen_payslip_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, payslip_id: String) -> Result<(), String> {
    reopen_payslip_v3_impl(&state, &license, session_token, payslip_id)
}

pub(crate) fn reopen_payslip_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, payslip_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("reopen_payslip_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    approvers_only(&scope)?;
    payroll::payslip_person_in_scope(&conn, &actor.tenant_id, &payslip_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::reopen(&tx, &actor.tenant_id, &payslip_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_payslip", &payslip_id, None, Some(&serde_json::json!({ "action": "reopened" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_payroll_adjustment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, kind: String, amount_cents: i64, reason: String) -> Result<String, String> {
    add_payroll_adjustment_v3_impl(&state, &license, session_token, user_id, month, kind, amount_cents, reason)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add_payroll_adjustment_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, kind: String, amount_cents: i64, reason: String) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_payroll_adjustment_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_adjustment(&tx, &actor.tenant_id, &user_id, &month, &kind, amount_cents, &reason, &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_adjustment", &id, None, Some(&serde_json::json!({ "user_id": user_id, "month": month, "kind": kind, "amount_cents": amount_cents, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_payroll_adjustment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, adjustment_id: String) -> Result<(), String> {
    delete_payroll_adjustment_v3_impl(&state, &license, session_token, adjustment_id)
}

pub(crate) fn delete_payroll_adjustment_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, adjustment_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_payroll_adjustment_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::adjustment_person_in_scope(&conn, &actor.tenant_id, &adjustment_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::delete_adjustment(&tx, &actor.tenant_id, &adjustment_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_adjustment", &adjustment_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_payroll_advance_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, amount_cents: i64, instalment_cents: i64, given_on: String, reason: Option<String>) -> Result<String, String> {
    add_payroll_advance_v3_impl(&state, &license, session_token, user_id, amount_cents, instalment_cents, given_on, reason)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add_payroll_advance_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, amount_cents: i64, instalment_cents: i64, given_on: String, reason: Option<String>) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_payroll_advance_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let branch = home_branch(&conn, &user_id, &actor, license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // The advance and its expense (category «سلفة موظف») are made together, once: the same advance entered from
    // Finance already has its expense and never gets a second one.
    let (id, cost_id) = payroll::add_advance_with_cost(&tx, &actor.tenant_id, &branch, &user_id, amount_cents, instalment_cents, &given_on, reason.as_deref(), &actor.id, None)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "payroll_advance", &id, None, Some(&serde_json::json!({ "user_id": user_id, "amount_cents": amount_cents, "instalment_cents": instalment_cents, "cost_id": cost_id }))).map_err(|e| e.to_string())?;
    if let Some(cost_id) = &cost_id {
        audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::OperationalCostRecorded, "operational_cost", cost_id, None, Some(&serde_json::json!({ "category": crate::finance::ADVANCE_CATEGORY, "amount_cents": amount_cents, "advance_id": id }))).map_err(|e| e.to_string())?;
        super::orders::sync_enqueue_operational_cost(&tx, &actor.tenant_id, &branch, cost_id, &actor.device_id, &license.cached_status())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn list_payroll_advances_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: Option<String>) -> Result<Vec<AdvanceRow>, String> {
    list_payroll_advances_v3_impl(&state, &license, session_token, user_id)
}

pub(crate) fn list_payroll_advances_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: Option<String>) -> Result<Vec<AdvanceRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    if let Some(u) = user_id.as_deref() {
        payroll::person_in_scope(&conn, &actor.tenant_id, u, &scope)?;
    }
    let rows = payroll::list_advances(&conn, &actor.tenant_id, user_id.as_deref(), false)?;
    // A manager only sees the advances of the people under them.
    Ok(rows.into_iter().filter(|a| payroll::person_in_scope(&conn, &actor.tenant_id, &a.user_id, &scope).is_ok()).collect())
}

#[tauri::command]
pub fn cancel_payroll_advance_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, advance_id: String) -> Result<(), String> {
    cancel_payroll_advance_v3_impl(&state, &license, session_token, advance_id)
}

pub(crate) fn cancel_payroll_advance_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, advance_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("cancel_payroll_advance_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::advance_person_in_scope(&conn, &actor.tenant_id, &advance_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::cancel_advance(&tx, &actor.tenant_id, &advance_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_advance", &advance_id, None, Some(&serde_json::json!({ "cancelled": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Marks a day as an accepted excuse / paid leave (`on = true`) or clears the mark.
#[tauri::command]
pub fn set_paid_leave_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, day: String, note: Option<String>, on: bool) -> Result<(), String> {
    set_paid_leave_v3_impl(&state, &license, session_token, user_id, day, note, on)
}

pub(crate) fn set_paid_leave_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, day: String, note: Option<String>, on: bool) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_paid_leave_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
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
    add_manual_punch_v3_impl(&state, &license, session_token, user_id, punched_at_iso, direction, reason)
}

pub(crate) fn add_manual_punch_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, punched_at_iso: String, direction: String, reason: String) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_manual_punch_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    if reason.trim().is_empty() {
        return Err("اكتب سبب إضافة البصمة".to_string());
    }
    let at = DateTime::parse_from_rfc3339(&punched_at_iso).map_err(|_| "الوقت غير صالح".to_string())?.with_timezone(&Utc);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let branch = home_branch(&conn, &user_id, &actor, license)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_manual_punch(&tx, &actor.tenant_id, &branch, &user_id, at, &direction, &actor.id, Utc::now())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, Some(&branch), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "manual_punch", "direction": direction, "at": punched_at_iso, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Days the owner deducts by hand (separate from absence). `days` may be a fraction (0.5 = half a day).
#[tauri::command]
pub fn add_payroll_day_deduction_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, days: f64, reason: String) -> Result<String, String> {
    add_payroll_day_deduction_v3_impl(&state, &license, session_token, user_id, month, days, reason)
}

pub(crate) fn add_payroll_day_deduction_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, days: f64, reason: String) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("add_payroll_day_deduction_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    if !days.is_finite() {
        return Err("عدد الأيام غير صالح".to_string());
    }
    let days_x100 = (days * 100.0).round() as i64;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = payroll::add_day_deduction(&tx, &actor.tenant_id, &user_id, &month, days_x100, &reason, &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_day_deduction", &id, None, Some(&serde_json::json!({ "user_id": user_id, "month": month, "days_x100": days_x100, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_payroll_day_deduction_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, deduction_id: String) -> Result<(), String> {
    delete_payroll_day_deduction_v3_impl(&state, &license, session_token, deduction_id)
}

pub(crate) fn delete_payroll_day_deduction_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, deduction_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_payroll_day_deduction_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::day_deduction_person_in_scope(&conn, &actor.tenant_id, &deduction_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::delete_day_deduction(&tx, &actor.tenant_id, &deduction_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "payroll_day_deduction", &deduction_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// A person's month of attendance for the owner or manager to check, correct and approve before payroll.
#[tauri::command]
pub fn get_attendance_review_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<AttendanceReview, String> {
    get_attendance_review_v3_impl(&state, &license, session_token, user_id, month, tz_offset_minutes)
}

pub(crate) fn get_attendance_review_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, tz_offset_minutes: Option<i64>) -> Result<AttendanceReview, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    payroll::attendance_review(&conn, &actor.tenant_id, &user_id, &month, tz, local_today(tz))
}

/// Corrects one day in the review: the day's own in/out times, or the day forced absent. The punch log is not edited.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn set_attendance_day_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, day: String, absent: bool, in_time: Option<String>, out_time: Option<String>, reason: String) -> Result<(), String> {
    set_attendance_day_v3_impl(&state, &license, session_token, user_id, day, absent, in_time, out_time, reason)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn set_attendance_day_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, day: String, absent: bool, in_time: Option<String>, out_time: Option<String>, reason: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_attendance_day_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::set_day_override(&tx, &actor.tenant_id, &user_id, &day, absent, in_time.as_deref(), out_time.as_deref(), &reason, &actor.id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "day_corrected", "day": day, "absent": absent, "in": in_time, "out": out_time, "reason": reason }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Undoes a day's correction (the day goes back to what the punches say).
#[tauri::command]
pub fn clear_attendance_day_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, day: String) -> Result<(), String> {
    clear_attendance_day_v3_impl(&state, &license, session_token, user_id, day)
}

pub(crate) fn clear_attendance_day_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, day: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("clear_attendance_day_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    payroll::clear_day_override(&tx, &user_id, &day)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": "day_correction_cleared", "day": day }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// "اعتماد الحضور" for one person and month; with `approve = false` the approval is taken back.
#[tauri::command]
pub fn set_attendance_approval_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String, month: String, approve: bool, tz_offset_minutes: Option<i64>) -> Result<(), String> {
    set_attendance_approval_v3_impl(&state, &license, session_token, user_id, month, approve, tz_offset_minutes)
}

pub(crate) fn set_attendance_approval_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String, month: String, approve: bool, tz_offset_minutes: Option<i64>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("set_attendance_approval_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let tz = tz_offset_minutes.unwrap_or(0);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if approve {
        payroll::approve_attendance(&tx, &actor.tenant_id, &user_id, &month, tz, local_today(tz), &actor.id)?;
    } else {
        payroll::unapprove_attendance(&tx, &user_id, &month)?;
    }
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": if approve { "attendance_approved" } else { "attendance_unapproved" }, "month": month }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// A worker's account: the advances given, what was taken back off each payslip, and what is still owed.
#[tauri::command]
pub fn get_worker_statement_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, user_id: String) -> Result<WorkerStatement, String> {
    get_worker_statement_v3_impl(&state, &license, session_token, user_id)
}

pub(crate) fn get_worker_statement_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, user_id: String) -> Result<WorkerStatement, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UsePayroll).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = scope_of(&conn, &actor)?;
    payroll::person_in_scope(&conn, &actor.tenant_id, &user_id, &scope)?;
    payroll::worker_statement(&conn, &actor.tenant_id, &user_id)
}

// ---------------------------------------------------------------------------
// Remote back office: the arms a second till's back-office commands take on the hub
// (see `lan_rpc_office.rs`). Each arm calls the same `_impl` the local command wraps.
// ---------------------------------------------------------------------------

#[allow(unused_variables, clippy::let_unit_value)]
pub(crate) fn dispatch_remote_office(db: &Db, license: &crate::license::cloud::CloudLicenseState, command: &str, args: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    use super::lan_rpc::lan_arg;
    let value = match command {
        "add_payroll_day_deduction_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let days: f64 = lan_arg(args, "days")?;
            let reason: String = lan_arg(args, "reason")?;
            let r = add_payroll_day_deduction_v3_impl(db, license, session_token, user_id, month, days, reason)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "delete_payroll_day_deduction_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let deduction_id: String = lan_arg(args, "deductionId")?;
            let r = delete_payroll_day_deduction_v3_impl(db, license, session_token, deduction_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_attendance_review_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = get_attendance_review_v3_impl(db, license, session_token, user_id, month, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "set_attendance_day_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let day: String = lan_arg(args, "day")?;
            let absent: bool = lan_arg(args, "absent")?;
            let in_time: Option<String> = lan_arg(args, "inTime")?;
            let out_time: Option<String> = lan_arg(args, "outTime")?;
            let reason: String = lan_arg(args, "reason")?;
            let r = set_attendance_day_v3_impl(db, license, session_token, user_id, day, absent, in_time, out_time, reason)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "clear_attendance_day_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let day: String = lan_arg(args, "day")?;
            let r = clear_attendance_day_v3_impl(db, license, session_token, user_id, day)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "set_attendance_approval_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let approve: bool = lan_arg(args, "approve")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = set_attendance_approval_v3_impl(db, license, session_token, user_id, month, approve, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_worker_statement_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let r = get_worker_statement_v3_impl(db, license, session_token, user_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_payroll_access_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = get_payroll_access_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_payroll_settings_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = get_payroll_settings_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_payroll_settings_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let settings: PayrollSettings = lan_arg(args, "settings")?;
            let r = save_payroll_settings_v3_impl(db, license, session_token, settings)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "list_payroll_employees_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = list_payroll_employees_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_payroll_employee_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let pay: EmployeePay = lan_arg(args, "pay")?;
            let r = save_payroll_employee_v3_impl(db, license, session_token, pay)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "payroll_month_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let month: String = lan_arg(args, "month")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = payroll_month_v3_impl(db, license, session_token, month, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_payslip_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = get_payslip_v3_impl(db, license, session_token, user_id, month, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "approve_payslip_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = approve_payslip_v3_impl(db, license, session_token, user_id, month, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "pay_payslip_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let payslip_id: String = lan_arg(args, "payslipId")?;
            let tz_offset_minutes: Option<i64> = lan_arg(args, "tzOffsetMinutes")?;
            let r = pay_payslip_v3_impl(db, license, session_token, payslip_id, tz_offset_minutes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "reopen_payslip_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let payslip_id: String = lan_arg(args, "payslipId")?;
            let r = reopen_payslip_v3_impl(db, license, session_token, payslip_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "add_payroll_adjustment_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let month: String = lan_arg(args, "month")?;
            let kind: String = lan_arg(args, "kind")?;
            let amount_cents: i64 = lan_arg(args, "amountCents")?;
            let reason: String = lan_arg(args, "reason")?;
            let r = add_payroll_adjustment_v3_impl(db, license, session_token, user_id, month, kind, amount_cents, reason)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "delete_payroll_adjustment_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let adjustment_id: String = lan_arg(args, "adjustmentId")?;
            let r = delete_payroll_adjustment_v3_impl(db, license, session_token, adjustment_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "add_payroll_advance_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let amount_cents: i64 = lan_arg(args, "amountCents")?;
            let instalment_cents: i64 = lan_arg(args, "instalmentCents")?;
            let given_on: String = lan_arg(args, "givenOn")?;
            let reason: Option<String> = lan_arg(args, "reason")?;
            let r = add_payroll_advance_v3_impl(db, license, session_token, user_id, amount_cents, instalment_cents, given_on, reason)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "list_payroll_advances_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: Option<String> = lan_arg(args, "userId")?;
            let r = list_payroll_advances_v3_impl(db, license, session_token, user_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "cancel_payroll_advance_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let advance_id: String = lan_arg(args, "advanceId")?;
            let r = cancel_payroll_advance_v3_impl(db, license, session_token, advance_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "set_paid_leave_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let day: String = lan_arg(args, "day")?;
            let note: Option<String> = lan_arg(args, "note")?;
            let on: bool = lan_arg(args, "on")?;
            let r = set_paid_leave_v3_impl(db, license, session_token, user_id, day, note, on)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "add_manual_punch_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let user_id: String = lan_arg(args, "userId")?;
            let punched_at_iso: String = lan_arg(args, "punchedAtIso")?;
            let direction: String = lan_arg(args, "direction")?;
            let reason: String = lan_arg(args, "reason")?;
            let r = add_manual_punch_v3_impl(db, license, session_token, user_id, punched_at_iso, direction, reason)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
