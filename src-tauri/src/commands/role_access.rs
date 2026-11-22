//! The owner's "who can open what" table, and the signed-in person's own answer for the sidebar.
//! Only the owner reads or changes the table. Everybody may ask what THEY can open.

use crate::audit;
use crate::role_access::{self, AccessCell, PersonCell};
use crate::security::Role;
use crate::Db;
use std::collections::BTreeMap;
use tauri::State;
use super::shared::*;

fn owner_only(role: Role) -> Result<(), String> {
    if matches!(role, Role::Owner | Role::Platform) {
        Ok(())
    } else {
        Err("هذه الصفحة للمالك فقط".to_string())
    }
}

#[tauri::command]
pub fn get_role_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<AccessCell>, String> {
    get_role_access_v3_impl(&state, &license, session_token)
}

pub(crate) fn get_role_access_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<AccessCell>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    owner_only(actor.role)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    role_access::load_matrix(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_role_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cells: Vec<AccessCell>) -> Result<(), String> {
    save_role_access_v3_impl(&state, &license, session_token, cells)
}

pub(crate) fn save_role_access_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, cells: Vec<AccessCell>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_role_access_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    owner_only(actor.role)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = role_access::load_matrix(&tx, &actor.tenant_id)?;
    role_access::save_matrix(&tx, &actor.tenant_id, &cells)?;
    let after = role_access::load_matrix(&tx, &actor.tenant_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "role_access", &actor.tenant_id, serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&after).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// What the signed-in person may open, by feature key (`reports`, `menu`, ...). No licence lock: the
/// sidebar needs it on every screen, and it only reads the person's own answer.
#[tauri::command]
pub fn get_my_access_v3(state: State<Db>, session_token: String) -> Result<BTreeMap<String, bool>, String> {
    get_my_access_v3_impl(&state, session_token)
}

pub(crate) fn get_my_access_v3_impl(state: &Db, session_token: String) -> Result<BTreeMap<String, bool>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(role_access::effective_map(&conn, &actor.tenant_id, actor.role, &actor.id))
}

/// The person must be one of the owner's own staff, and not an owner (owners are never restricted).
fn person_in_tenant(conn: &rusqlite::Connection, tenant_id: &str, staff_id: &str) -> Result<(), String> {
    let role: Option<String> = conn
        .query_row("SELECT role FROM staff WHERE id = ?1 AND tenant_id = ?2", rusqlite::params![staff_id, tenant_id], |r| r.get(0))
        .map_err(|_| "الموظف غير موجود".to_string())
        .map(Some)?;
    match role.as_deref() {
        Some("OWNER") | Some("PLATFORM") => Err("المالك لا تُقيَّد صلاحياته".to_string()),
        _ => Ok(()),
    }
}

/// One person's exceptions on top of their role (owner only).
#[tauri::command]
pub fn get_staff_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, staff_id: String) -> Result<Vec<PersonCell>, String> {
    get_staff_access_v3_impl(&state, &license, session_token, staff_id)
}

pub(crate) fn get_staff_access_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, staff_id: String) -> Result<Vec<PersonCell>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    owner_only(actor.role)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    person_in_tenant(&conn, &actor.tenant_id, &staff_id)?;
    role_access::load_person(&conn, &actor.tenant_id, &staff_id)
}

#[tauri::command]
pub fn save_staff_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, staff_id: String, cells: Vec<PersonCell>) -> Result<(), String> {
    save_staff_access_v3_impl(&state, &license, session_token, staff_id, cells)
}

pub(crate) fn save_staff_access_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, staff_id: String, cells: Vec<PersonCell>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_staff_access_v3")?;
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    owner_only(actor.role)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    person_in_tenant(&conn, &actor.tenant_id, &staff_id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = role_access::load_person(&tx, &actor.tenant_id, &staff_id)?;
    role_access::save_person(&tx, &actor.tenant_id, &staff_id, &cells)?;
    let after = role_access::load_person(&tx, &actor.tenant_id, &staff_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "staff_access", &staff_id, serde_json::to_value(&before).ok().as_ref(), serde_json::to_value(&after).ok().as_ref()).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
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
        "get_role_access_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = get_role_access_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_role_access_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let cells: Vec<AccessCell> = lan_arg(args, "cells")?;
            let r = save_role_access_v3_impl(db, license, session_token, cells)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_staff_access_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let staff_id: String = lan_arg(args, "staffId")?;
            let r = get_staff_access_v3_impl(db, license, session_token, staff_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "save_staff_access_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let staff_id: String = lan_arg(args, "staffId")?;
            let cells: Vec<PersonCell> = lan_arg(args, "cells")?;
            let r = save_staff_access_v3_impl(db, license, session_token, staff_id, cells)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
