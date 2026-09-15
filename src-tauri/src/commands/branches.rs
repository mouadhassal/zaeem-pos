use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;

// ---------------------------------------------------------------------------
// Slice C -- `branches/page.tsx`'s multi-branch admin CRUD, on the LEGACY
// `branches` table (see `Repo`'s doc comment on this group -- punch-listed
// table duality vs T1.1's `branch`, not reconciled here).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_branches_full_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::LegacyBranchFullRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_branches_full(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_branch_full_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, address: Option<String>, city: Option<String>, phone: Option<String>, timezone: String, currency: String, tax_rate_cents: i64, max_tables: i64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let branch_id = Repo::new(&tx).create_branch_full(&actor.tenant_id, &name, address.as_deref(), city.as_deref(), phone.as_deref(), &timezone, &currency, tax_rate_cents, max_tables).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::BranchChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(branch_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_branch_full_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, branch_id: String, name: String, address: Option<String>, city: Option<String>, phone: Option<String>, timezone: String, currency: String, tax_rate_cents: i64, max_tables: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_branch_full(&actor.tenant_id, &branch_id, &name, address.as_deref(), city.as_deref(), phone.as_deref(), &timezone, &currency, tax_rate_cents, max_tables).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::BranchChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_branch_full_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, branch_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_branch_full_active(&actor.tenant_id, &branch_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::BranchChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_branch_detail_field_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, branch_id: String, field: String, value: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_branch_detail_field(&actor.tenant_id, &branch_id, &field, value.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::BranchChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "field": field }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_terminals_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, branch_id: String) -> Result<Vec<crate::repo::TerminalRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_terminals(&actor.tenant_id, &branch_id).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct TenantTodayStats {
    pub order_count: i64,
    pub revenue_cents: i64,
    pub staff_count: i64,
}

#[tauri::command]
pub fn get_tenant_today_stats_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<TenantTodayStats, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (order_count, revenue_cents, staff_count) = Repo::new(&conn).tenant_today_stats(&actor.tenant_id).map_err(|e| e.to_string())?;
    Ok(TenantTodayStats { order_count, revenue_cents, staff_count })
}

/// Correctness audit finding (pre-launch pass): the branches page used to
/// show tenant-wide totals identically on every branch card via
/// `get_tenant_today_stats_v3` -- real per-branch numbers now.
#[tauri::command]
pub fn get_branch_today_stats_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<(String, i64, i64)>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).branch_today_stats(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_staff_counts_by_branch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<(String, i64)>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).staff_counts_by_branch(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_terminal_counts_by_branch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<(String, i64)>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageBranches).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).terminal_counts_by_branch(&actor.tenant_id).map_err(|e| e.to_string())
}

