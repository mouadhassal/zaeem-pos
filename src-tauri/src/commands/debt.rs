use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 2 -- debt (بيع بالدين). DEBT-type entries are
// already created by `take_payment_v3`; this group is debtor CRUD + payments.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_debtors_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DebtorRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_debtors(&actor.scope()).map_err(|e| e.to_string())
}

/// `phone` is optional (DebtSelectModal's inline "new debtor" form -- the
/// POS debt flow -- allows email-only, matching create_customer_v3's same
/// "at least one of phone/email" pattern). Was `String` (required) until
/// this fix: the frontend sending `phone: null` for an email-only debtor
/// failed to deserialize at the Tauri IPC boundary before this command
/// body ever ran, so the debtor was silently never created -- the debtor
/// list looked permanently empty because nothing had ever successfully
/// been added to it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_debtor_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, phone: Option<String>, email: Option<String>, address: Option<String>, notes: Option<String>, initial_debt_cents: Option<i64>, credit_limit_cents: Option<i64>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let phone = phone.filter(|p| !p.trim().is_empty());
    let email = email.filter(|e| !e.trim().is_empty());
    if phone.is_none() && email.is_none() {
        return Err("either a phone number or an email is required".to_string());
    }
    let initial_debt_cents = initial_debt_cents.unwrap_or(0);
    if initial_debt_cents < 0 {
        return Err("initial debt amount cannot be negative".to_string());
    }
    if let Some(limit) = credit_limit_cents {
        if limit < 0 {
            return Err("credit limit cannot be negative".to_string());
        }
    }
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let debtor_id = Repo::new(&tx).create_debtor(&tenant_id, &branch_id, &name, phone.as_deref(), email.as_deref(), address.as_deref(), notes.as_deref(), credit_limit_cents).map_err(|e| e.to_string())?;
    if initial_debt_cents > 0 {
        // Local-only fact (see `record_initial_debt`'s doc comment) --
        // customer debt does not sync to the cloud, deliberately: the web
        // owner dashboard shows business (supplier) debt only, never
        // per-customer balances, so there is nothing on the other end to
        // feed.
        Repo::new(&tx).record_initial_debt(&tenant_id, &branch_id, &debtor_id, initial_debt_cents, &actor.id).map_err(|e| e.to_string())?;
    }
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "name": name, "created": true, "initial_debt_cents": initial_debt_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(debtor_id)
}

// `phone` was `String` (required) until this fix -- see `update_debtor`'s
// (repo.rs) own doc comment: a debtor created phone-less via
// `create_debtor_v3` (email-only) could never be edited afterward, since
// the frontend's `phone: null` failed to deserialize at the IPC boundary
// before this command body ever ran. Now `Option<String>`, matching
// `create_debtor_v3` exactly.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_debtor_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, debtor_id: String, name: String, phone: Option<String>, email: Option<String>, address: Option<String>, notes: Option<String>, credit_limit_cents: Option<i64>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let phone = phone.filter(|p| !p.trim().is_empty());
    let email = email.filter(|e| !e.trim().is_empty());
    if let Some(limit) = credit_limit_cents {
        if limit < 0 {
            return Err("credit limit cannot be negative".to_string());
        }
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_debtor(&actor.scope(), &debtor_id, &name, phone.as_deref(), email.as_deref(), address.as_deref(), notes.as_deref(), credit_limit_cents).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn deactivate_debtor_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, debtor_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).deactivate_debtor(&actor.scope(), &debtor_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, Some(&serde_json::json!({ "is_active": true })), Some(&serde_json::json!({ "is_active": false }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_debt_entries_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, debtor_id: String) -> Result<Vec<crate::repo::DebtEntryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_debt_entries(&actor.scope(), &debtor_id).map_err(|e| e.to_string())
}

/// One transaction: the PAYMENT fact + the debtor's running-balance update +
/// the audit entry, same atomicity principle as `take_payment_v3`.
///
/// Unlike `create_debtor_v3`, this does NOT require a Branch-scoped actor:
/// paying off an existing debtor's balance doesn't need to invent a branch
/// for a Tenant-scoped Owner (who has none) -- `Repo::record_debt_payment`
/// looks up and stamps the DEBTOR's own tenant_id/branch_id instead. Was
/// previously hard-required to be Branch-scoped, which meant an Owner
/// account could never record a debt payment at all -- every attempt
/// failed with "recording a debt payment requires a Branch-scoped actor",
/// which the frontend's catch block showed as a generic "حدث خطأ في
/// تسجيل الدفعة" with no indication of why, indistinguishable from the
/// amount input simply not working.
#[tauri::command]
pub fn record_debt_payment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, debtor_id: String, amount_cents: i64, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    if amount_cents <= 0 {
        return Err("payment amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let entry_id = Repo::new(&tx).record_debt_payment(&actor.scope(), &debtor_id, amount_cents, notes.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "entry_id": entry_id, "amount_cents": amount_cents, "type": "PAYMENT" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entry_id)
}

