//! Restaurant operations commands: item options (and, below, comps, order
//! edits and delivery). Thin wrappers: authenticate, authorize, call the
//! plain functions in `ops.rs`, audit. See Migration AE.

use crate::audit;
use crate::ops;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;

/// Option groups for the POS (active only: what the cashier can pick) or the
/// menu screen (`include_inactive`). Reading is the selling path -- open to
/// every role that can take an order, and never license-gated.
#[tauri::command]
pub fn list_option_groups_v3(state: State<Db>, session_token: String, include_inactive: Option<bool>) -> Result<Vec<ops::OptionGroup>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    ops::list_option_groups(&conn, &actor.tenant_id, !include_inactive.unwrap_or(false))
}

#[tauri::command]
pub fn save_option_group_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, group: ops::OptionGroupInput) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = ops::save_option_group(&tx, &actor.tenant_id, &group)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "option_group", &id, None, Some(&serde_json::json!({ "name": group.name, "choices": group.choices.len() }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn delete_option_group_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, group_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    ops::delete_option_group(&tx, &actor.tenant_id, &group_id)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "option_group", &group_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
