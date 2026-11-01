//! Attendance by fingerprint: the reader's status, enrolling a finger, the punch
//! itself, the raw punch log and the late rule. The device driver is not chosen
//! yet (`attendance::NoReader`), so enrolling and punching report that plainly;
//! everything else is live. See `attendance.rs`.

use crate::attendance::{self, FingerprintReader, ReaderState, ReaderStatus, Source};
use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission, Scope};
use crate::Db;
use tauri::State;
use super::shared::*;
use super::orders::sync_enqueue_staff_snapshot;

/// The branch a punch or enrolment belongs to: the actor's own, or the single branch
/// the business operates (same rule as the manual clock-in).
fn operating_branch(
    state: &Db,
    actor: &crate::security::Actor,
    license: &crate::license::cloud::CloudLicenseState,
) -> Result<(String, String), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    resolve_operating_branch(&conn, actor, license, None)
}

/// The branch to narrow a list to: a branch-scoped actor sees their branch, an owner sees all.
fn branch_filter(scope: &Scope) -> Option<String> {
    match scope {
        Scope::Branch { branch_id, .. } => Some(branch_id.clone()),
        _ => None,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FingerprintStatus {
    #[serde(flatten)]
    pub reader: ReaderStatus,
    pub enrolled_people: i64,
}

#[tauri::command]
pub fn fingerprint_status_v3(state: State<Db>, reader: State<ReaderState>, session_token: String) -> Result<FingerprintStatus, String> {
    fingerprint_status_v3_impl(&state, &**reader.0.lock().map_err(|e| e.to_string())?, session_token)
}

pub(crate) fn fingerprint_status_v3_impl(state: &Db, reader: &dyn FingerprintReader, session_token: String) -> Result<FingerprintStatus, String> {
    let actor = authenticate_actor(state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let enrolled_people: i64 = conn
        .query_row("SELECT COUNT(DISTINCT user_id) FROM fingerprint_enrolments WHERE tenant_id = ?1", rusqlite::params![actor.tenant_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(FingerprintStatus { reader: reader.status(), enrolled_people })
}

#[tauri::command]
pub fn list_fingerprint_enrolments_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<attendance::EnrolmentRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    attendance::list_enrolments(&conn, &actor.tenant_id, branch_filter(&actor.scope()).as_deref())
}

#[tauri::command]
pub fn enrol_fingerprint_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    reader: State<ReaderState>,
    session_token: String,
    user_id: String,
    finger: String,
) -> Result<String, String> {
    enrol_fingerprint_v3_impl(&state, &license, &**reader.0.lock().map_err(|e| e.to_string())?, session_token, user_id, finger)
}

pub(crate) fn enrol_fingerprint_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    reader: &dyn FingerprintReader,
    session_token: String,
    user_id: String,
    finger: String,
) -> Result<String, String> {
    crate::lan::reject_if_local_kitchen_satellite("enrol_fingerprint_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    // The person must be someone this actor manages, before the device is even asked.
    {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        Repo::new(&conn).assert_staff_in_scope(&user_id, &actor.scope()).map_err(|e| e.to_string())?;
    }
    let (tenant_id, branch_id) = staff_home(state, &user_id, &actor, license)?;
    // The finger is captured outside the database lock: the person may take a while.
    let template = reader.capture_template()?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = attendance::save_enrolment(&tx, &tenant_id, &branch_id, &user_id, &finger, reader.provider(), &template, &actor.id)?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::SettingsChanged, "fingerprint_enrolment", &id, None, Some(&serde_json::json!({ "user_id": user_id, "finger": finger }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Where a person's fingerprint lives: their own branch, else the operating one.
fn staff_home(
    state: &Db,
    user_id: &str,
    actor: &crate::security::Actor,
    license: &crate::license::cloud::CloudLicenseState,
) -> Result<(String, String), String> {
    let own: (String, Option<String>) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.query_row("SELECT tenant_id, branch_id FROM staff WHERE id = ?1", rusqlite::params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
    };
    match own {
        (tenant_id, Some(branch_id)) => Ok((tenant_id, branch_id)),
        (_, None) => operating_branch(state, actor, license),
    }
}

#[tauri::command]
pub fn delete_fingerprint_enrolment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, enrolment_id: String) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("delete_fingerprint_enrolment_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (pred, binds) = Repo::scope_predicate(&actor.scope());
    let sql = format!("DELETE FROM fingerprint_enrolments WHERE id = ?{} AND {}", binds.len() + 1, pred);
    let mut args: Vec<String> = binds;
    args.push(enrolment_id.clone());
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let n = tx.execute(&sql, refs.as_slice()).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("البصمة غير موجودة".to_string());
    }
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "fingerprint_enrolment", &enrolment_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Someone puts a finger on the reader: whoever it is gets an IN or an OUT. Any signed-in
/// user may trigger it (the till is always signed in by someone), but it only ever records
/// the person the reader identified, never one named by the caller.
#[tauri::command]
pub fn fingerprint_punch_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    reader: State<ReaderState>,
    session_token: String,
) -> Result<attendance::PunchOutcome, String> {
    fingerprint_punch_v3_impl(&state, &license, &**reader.0.lock().map_err(|e| e.to_string())?, session_token, chrono::Utc::now())
}

pub(crate) fn fingerprint_punch_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    reader: &dyn FingerprintReader,
    session_token: String,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<attendance::PunchOutcome, String> {
    crate::lan::reject_if_local_kitchen_satellite("fingerprint_punch_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    let (tenant_id, branch_id) = operating_branch(state, &actor, license)?;
    let candidates = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        attendance::templates_for_matching(&conn, &tenant_id, &branch_id, reader.provider())?
    };
    if candidates.is_empty() {
        return Err("لم تُسجَّل أي بصمة بعد. سجّل بصمات الموظفين من صفحة الموظفين أولاً".to_string());
    }
    let Some(enrolment_id) = reader.identify(&candidates)? else {
        return Err("لم أتعرف على هذه البصمة. حاول مرة أخرى أو اطلب من المدير تسجيل حضورك".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let user_id: String = tx
        .query_row("SELECT user_id FROM fingerprint_enrolments WHERE id = ?1", rusqlite::params![enrolment_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let outcome = attendance::record_punch(&tx, &tenant_id, &branch_id, &user_id, Source::Fingerprint, Some(&actor.device_id), None, now)?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::SettingsChanged, "attendance", &user_id, None, Some(&serde_json::json!({ "action": format!("fingerprint_{}", outcome.direction.to_lowercase()) }))).map_err(|e| e.to_string())?;
    sync_enqueue_staff_snapshot(&tx, &tenant_id, &user_id, &actor.device_id, &license.cached_status())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(outcome)
}

#[tauri::command]
pub fn list_punches_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    date_from: Option<String>,
    date_to: Option<String>,
    user_id: Option<String>,
) -> Result<Vec<attendance::PunchRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    attendance::list_punches(&conn, &actor.tenant_id, branch_filter(&actor.scope()).as_deref(), date_from.as_deref(), date_to.as_deref(), user_id.as_deref())
}

#[tauri::command]
pub fn get_attendance_settings_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<attendance::AttendanceSettings, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    attendance::load_settings(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn set_attendance_settings_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    shift_start: String,
    late_grace_minutes: i64,
) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    attendance::save_settings(&tx, &actor.tenant_id, &shift_start, late_grace_minutes)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "attendance_settings", &actor.tenant_id, None, Some(&serde_json::json!({ "shift_start": shift_start, "late_grace_minutes": late_grace_minutes }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
