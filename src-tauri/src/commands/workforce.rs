//! Workers who never use the app (cleaners, guards, dishwashers...), job titles, and the business
//! type + modules (business.rs).
//!
//! A worker without the app is a `staff` row with `app_access = 0`, no PIN and the lowest role
//! (`SERVER`, which has no back-office permission): payroll, advances, attendance and the schedule
//! see them like everyone else, and they can never sign in (security.rs `load_actor` and the login
//! queries refuse `app_access = 0`). Only the owner adds them, unless the owner opens it to managers
//! in the access table (feature `workers`); a manager only ever works in their own branch.

use crate::audit;
use crate::business::{self, Profile};
use crate::role_access::Feature;
use crate::security::{authorize, authorize_scope, Actor, Permission, Role};
use crate::Db;
use rusqlite::{params, OptionalExtension};
use tauri::State;
use super::orders::sync_enqueue_staff_snapshot;
use super::shared::*;

const MAX_TITLE: usize = 40;

fn clean_title(t: Option<String>) -> Option<String> {
    t.map(|s| s.trim().chars().take(MAX_TITLE).collect::<String>()).filter(|s| !s.is_empty())
}

/// The owner always; a manager only when the owner switched "workers" on for managers.
fn may_manage_workers(actor: &Actor) -> Result<(), String> {
    match actor.role {
        Role::Owner | Role::Platform => Ok(()),
        Role::Manager => {
            authorize(actor, Permission::CreateStaff).map_err(|e| e.to_string())?;
            if actor.access.allows(Feature::Workers, false) {
                Ok(())
            } else {
                Err("إضافة العمال بدون تطبيق للمالك فقط -- يمكنه السماح للمدير من الإعدادات ← الصلاحيات".to_string())
            }
        }
        _ => Err("ليست لديك صلاحية إدارة العمال".to_string()),
    }
}

/// The business type and which modules are on. Every signed-in person may read it (the sidebar and
/// the till are built from it).
#[tauri::command]
pub fn get_business_profile_v3(state: State<Db>, session_token: String) -> Result<Profile, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    business::load(&conn, &actor.tenant_id)
}

/// Owner only: the type of business and the modules switched on or off.
#[tauri::command]
pub fn save_business_profile_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, profile: Profile) -> Result<(), String> {
    save_business_profile_v3_impl(&state, &license, session_token, profile)
}

pub(crate) fn save_business_profile_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, profile: Profile) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_business_profile_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    require_license_not_locked_or_initial_setup(license, &conn)?;
    if !matches!(actor.role, Role::Owner | Role::Platform) {
        return Err("نوع النشاط والوحدات يختارها المالك فقط".to_string());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = business::load(&tx, &actor.tenant_id)?;
    business::save(&tx, &actor.tenant_id, &profile)?;
    let after = business::load(&tx, &actor.tenant_id)?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SettingsChanged, "business_profile", &actor.tenant_id,
        serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&after).ok().as_ref(),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    business::set_cache(&after);
    Ok(())
}

/// Adds a worker who will never use the app. Returns the new staff id.
#[tauri::command]
pub fn create_worker_v3(
    state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String, name: String, job_title: Option<String>, target_branch_id: Option<String>,
) -> Result<String, String> {
    create_worker_v3_impl(&state, &license, session_token, name, job_title, target_branch_id)
}

pub(crate) fn create_worker_v3_impl(
    state: &Db, license: &crate::license::cloud::CloudLicenseState,
    session_token: String, name: String, job_title: Option<String>, target_branch_id: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    may_manage_workers(&actor)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("اكتب اسم العامل".to_string());
    }
    let job_title = clean_title(job_title);
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    // A manager's worker is always in the manager's branch; the owner picks one (or the only one).
    let (tenant_id, branch_id) = match actor.role {
        Role::Manager => (actor.tenant_id.clone(), actor.branch_id.clone().ok_or("لا يوجد فرع للمدير")?),
        _ => resolve_operating_branch(&conn, &actor, license, target_branch_id)?,
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let staff_id = uuid::Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO staff (id, tenant_id, branch_id, role, role_rank, name, pin_hash, password_hash, is_active, created_at, updated_at_hlc, device_id, rev, job_title, app_access) \
         VALUES (?1, ?2, ?3, 'SERVER', ?4, ?5, NULL, NULL, 1, ?6, ?6, 'platform-command', 1, ?7, 0)",
        params![staff_id, tenant_id, branch_id, Role::Server.rank(), name, now, job_title],
    ).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::StaffCreated, "staff", &staff_id,
        None, Some(&serde_json::json!({ "role": "SERVER", "name": name, "job_title": job_title, "app_access": false })),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_staff_snapshot(&tx, &tenant_id, &staff_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(staff_id)
}

/// Changes a worker's name, job title, or stops them (left the job).
#[tauri::command]
pub fn update_worker_v3(
    state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String, staff_id: String, name: String, job_title: Option<String>, is_active: bool,
) -> Result<(), String> {
    update_worker_v3_impl(&state, &license, session_token, staff_id, name, job_title, is_active)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_worker_v3_impl(
    state: &Db, license: &crate::license::cloud::CloudLicenseState,
    session_token: String, staff_id: String, name: String, job_title: Option<String>, is_active: bool,
) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    may_manage_workers(&actor)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("اكتب اسم العامل".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row("SELECT tenant_id, branch_id, COALESCE(app_access, 1) FROM staff WHERE id = ?1", params![staff_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional().map_err(|e| e.to_string())?;
    let Some((tenant_id, branch_id, app_access)) = row else { return Err("العامل غير موجود".to_string()) };
    authorize_scope(&actor, &tenant_id, branch_id.as_deref()).map_err(|e| e.to_string())?;
    if app_access != 0 {
        return Err("هذا موظف يستخدم التطبيق: عدّله من قائمة الموظفين".to_string());
    }
    let job_title = clean_title(job_title);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE staff SET name = ?1, job_title = ?2, is_active = ?3, rev = rev + 1, updated_at_hlc = ?4 WHERE id = ?5",
        params![name, job_title, is_active as i64, chrono::Utc::now().to_rfc3339(), staff_id],
    ).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, branch_id.as_deref(), &actor.id,
        audit::Action::StaffRoleUpdated, "staff", &staff_id,
        None, Some(&serde_json::json!({ "name": name, "job_title": job_title, "is_active": is_active, "app_access": false })),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_staff_snapshot(&tx, &tenant_id, &staff_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The job title of anyone (app user or not), by whoever may edit that person.
#[tauri::command]
pub fn set_staff_job_title_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, staff_id: String, job_title: Option<String>) -> Result<(), String> {
    set_staff_job_title_v3_impl(&state, &license, session_token, staff_id, job_title)
}

pub(crate) fn set_staff_job_title_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, staff_id: String, job_title: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row("SELECT tenant_id, branch_id, role_rank FROM staff WHERE id = ?1", params![staff_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional().map_err(|e| e.to_string())?;
    let Some((tenant_id, branch_id, rank)) = row else { return Err("الموظف غير موجود".to_string()) };
    authorize_scope(&actor, &tenant_id, branch_id.as_deref()).map_err(|e| e.to_string())?;
    if actor.id != staff_id && i64::from(actor.role.rank()) <= rank {
        return Err("لا يمكنك تعديل موظف بنفس رتبتك أو أعلى منها".to_string());
    }
    let job_title = clean_title(job_title);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE staff SET job_title = ?1, rev = rev + 1 WHERE id = ?2", params![job_title, staff_id]).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, branch_id.as_deref(), &actor.id,
        audit::Action::StaffRoleUpdated, "staff", &staff_id, None, Some(&serde_json::json!({ "job_title": job_title })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// A no-app worker is never given a PIN or a role: they would become an app user by the back door.
pub(crate) fn refuse_if_worker(conn: &rusqlite::Connection, staff_id: &str) -> Result<(), String> {
    let app_access: i64 = conn
        .query_row("SELECT COALESCE(app_access, 1) FROM staff WHERE id = ?1", params![staff_id], |r| r.get(0))
        .unwrap_or(1);
    if app_access == 0 {
        return Err("هذا عامل بدون تطبيق: لا رمز دخول ولا دور له".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Remote back office: the arms a second till's back-office commands take on the hub
// (see `lan_rpc_office.rs`). Each arm calls the same `_impl` the local command wraps.
// ---------------------------------------------------------------------------

#[allow(unused_variables, clippy::let_unit_value)]
pub(crate) fn dispatch_remote_office(db: &Db, license: &crate::license::cloud::CloudLicenseState, command: &str, args: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    use super::lan_rpc::lan_arg;
    let value = match command {
        "create_worker_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let name: String = lan_arg(args, "name")?;
            let job_title: Option<String> = lan_arg(args, "jobTitle")?;
            let target_branch_id: Option<String> = lan_arg(args, "targetBranchId")?;
            let r = create_worker_v3_impl(db, license, session_token, name, job_title, target_branch_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "update_worker_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let staff_id: String = lan_arg(args, "staffId")?;
            let name: String = lan_arg(args, "name")?;
            let job_title: Option<String> = lan_arg(args, "jobTitle")?;
            let is_active: bool = lan_arg(args, "isActive")?;
            let r = update_worker_v3_impl(db, license, session_token, staff_id, name, job_title, is_active)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "set_staff_job_title_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let staff_id: String = lan_arg(args, "staffId")?;
            let job_title: Option<String> = lan_arg(args, "jobTitle")?;
            let r = set_staff_job_title_v3_impl(db, license, session_token, staff_id, job_title)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
