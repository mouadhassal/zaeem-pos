//! The owner's "who can open what" table, and the signed-in person's own answer for the sidebar.
//! Only the owner reads or changes the table. Everybody may ask what THEY can open.

use crate::audit;
use crate::role_access::{self, AccessCell};
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
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    owner_only(actor.role)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    role_access::load_matrix(&conn, &actor.tenant_id)
}

#[tauri::command]
pub fn save_role_access_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, cells: Vec<AccessCell>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("save_role_access_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(role_access::effective_map(&conn, &actor.tenant_id, actor.role))
}
