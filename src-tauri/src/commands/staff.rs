use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;

// ---------------------------------------------------------------------------
// HR_AND_GENERALIZATION_PLAN.md Part A -- roster (planned work
// assignments). Distinct from attendance (above): a roster entry can be
// any date, past or future, and represents a plan, not a fact.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_roster_entries_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, date_from: String, date_to: String) -> Result<Vec<crate::repo::RosterEntryRow>, String> {
    list_roster_entries_v3_impl(&state, &license, session_token, date_from, date_to)
}

pub(crate) fn list_roster_entries_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, date_from: String, date_to: String) -> Result<Vec<crate::repo::RosterEntryRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    require_plan_includes_management(license)?;
    authorize(&actor, Permission::ManageRoster).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_roster_entries(&actor.scope(), &date_from, &date_to).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_roster_entry_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String,
    staff_id: String, work_date: String, start_time: String, end_time: String, notes: Option<String>,) -> Result<String, String> {
    create_roster_entry_v3_impl(&state, &license, session_token, staff_id, work_date, start_time, end_time, notes)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_roster_entry_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, staff_id: String, work_date: String, start_time: String, end_time: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    require_plan_includes_management(license)?;
    authorize(&actor, Permission::ManageRoster).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = Repo::new(&tx)
        .create_roster_entry(&actor.scope(), &tenant_id, &branch_id, &staff_id, &actor.id, &work_date, &start_time, &end_time, notes.as_deref(), &actor.device_id)
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::SettingsChanged, "roster_entry", &id, None, Some(&serde_json::json!({ "action": "create", "staff_id": staff_id, "work_date": work_date }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn update_roster_entry_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, id: String, work_date: String, start_time: String, end_time: String, notes: Option<String>) -> Result<(), String> {
    update_roster_entry_v3_impl(&state, &license, session_token, id, work_date, start_time, end_time, notes)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_roster_entry_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, id: String, work_date: String, start_time: String, end_time: String, notes: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    require_plan_includes_management(license)?;
    authorize(&actor, Permission::ManageRoster).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_roster_entry(&actor.scope(), &id, &work_date, &start_time, &end_time, notes.as_deref(), &actor.device_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "roster_entry", &id, None, Some(&serde_json::json!({ "action": "update" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_roster_entry_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, id: String) -> Result<(), String> {
    delete_roster_entry_v3_impl(&state, &license, session_token, id)
}

pub(crate) fn delete_roster_entry_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    require_plan_includes_management(license)?;
    authorize(&actor, Permission::ManageRoster).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_roster_entry(&actor.scope(), &id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "roster_entry", &id, None, Some(&serde_json::json!({ "action": "delete" }))).map_err(|e| e.to_string())?;
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
        "list_roster_entries_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let date_from: String = lan_arg(args, "dateFrom")?;
            let date_to: String = lan_arg(args, "dateTo")?;
            let r = list_roster_entries_v3_impl(db, license, session_token, date_from, date_to)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "create_roster_entry_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let staff_id: String = lan_arg(args, "staffId")?;
            let work_date: String = lan_arg(args, "workDate")?;
            let start_time: String = lan_arg(args, "startTime")?;
            let end_time: String = lan_arg(args, "endTime")?;
            let notes: Option<String> = lan_arg(args, "notes")?;
            let r = create_roster_entry_v3_impl(db, license, session_token, staff_id, work_date, start_time, end_time, notes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "update_roster_entry_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let id: String = lan_arg(args, "id")?;
            let work_date: String = lan_arg(args, "workDate")?;
            let start_time: String = lan_arg(args, "startTime")?;
            let end_time: String = lan_arg(args, "endTime")?;
            let notes: Option<String> = lan_arg(args, "notes")?;
            let r = update_roster_entry_v3_impl(db, license, session_token, id, work_date, start_time, end_time, notes)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "delete_roster_entry_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let id: String = lan_arg(args, "id")?;
            let r = delete_roster_entry_v3_impl(db, license, session_token, id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
