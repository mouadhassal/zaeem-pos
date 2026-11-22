use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use serde::Serialize;
use tauri::State;
use super::shared::*;

// ---------------------------------------------------------------------------
// Batch 3a, Decision B -- customers, purchase_orders, drivers, printers,
// delivery. Each of these fixes its DRIFT_REPORT.md finding for free: the
// repo methods behind these commands write/read the columns Migration D just
// added, so the frontend pages this replaces stop hard-erroring on a fresh
// install. `customers` is tenant-only (no Branch destructure); the other 4
// are branch-scoped writes, same shape as `create_order_v3`.
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_customer_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, phone: Option<String>, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<String, String> {
    create_customer_v3_impl(&state, &license, session_token, name, phone, email, address, notes, birthday)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn create_customer_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, name: String, phone: Option<String>, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    // Loyalty card issuance needs to create a customer with just an email --
    // phone used to be mandatory here, blocking that. At least one of the
    // two is still required so a customer row always has a way to reach them.
    let phone = phone.filter(|p| !p.trim().is_empty());
    let email = email.filter(|e| !e.trim().is_empty());
    if phone.is_none() && email.is_none() {
        return Err("either a phone number or an email is required".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let customer_id = Repo::new(&tx)
        .create_customer(&actor.tenant_id, &name, phone.as_deref(), email.as_deref(), address.as_deref(), notes.as_deref(), birthday.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::CustomerChanged, "customer", &customer_id,
        None, Some(&serde_json::json!({ "name": name, "phone": phone })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(customer_id)
}

#[tauri::command]
pub fn list_customers_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::CustomerRow>, String> {
    list_customers_v3_impl(&state, &license, session_token)
}

pub(crate) fn list_customers_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<crate::repo::CustomerRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_customers(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_customer_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, customer_id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<(), String> {
    update_customer_v3_impl(&state, &license, session_token, customer_id, name, phone, email, address, notes, birthday)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_customer_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, customer_id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx)
        .update_customer(&actor.tenant_id, &customer_id, &name, &phone, email.as_deref(), address.as_deref(), notes.as_deref(), birthday.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::CustomerChanged, "customer", &customer_id, None, Some(&serde_json::json!({ "name": name, "phone": phone }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_customer_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, customer_id: String) -> Result<(), String> {
    delete_customer_v3_impl(&state, &license, session_token, customer_id)
}

pub(crate) fn delete_customer_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, customer_id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_customer(&actor.tenant_id, &customer_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::CustomerChanged, "customer", &customer_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CustomerDetailV3 {
    pub orders: Vec<crate::repo::CustomerOrderRow>,
    pub favorite_items: Vec<crate::repo::FavoriteItemRow>,
    // Live-computed (see Repo::customer_order_stats) -- NOT the dead
    // customers.total_orders/total_spent_cents columns, which never get
    // updated after row creation. The frontend previously read those
    // stale columns and always showed 0/0 regardless of real history.
    pub total_orders: i64,
    pub total_spent_cents: i64,
    // Live-computed (see Repo::customer_loyalty_points) -- NOT the dead
    // customers.loyalty_points column (same class of bug as the two
    // fields above, flagged but deferred in commit 4e9cf0e). The real
    // balance lives on loyalty_cards.points; this sums every card the
    // customer holds.
    pub loyalty_points: i64,
}

#[tauri::command]
pub fn get_customer_detail_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, phone: String) -> Result<CustomerDetailV3, String> {
    get_customer_detail_v3_impl(&state, &license, session_token, phone)
}

pub(crate) fn get_customer_detail_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, phone: String) -> Result<CustomerDetailV3, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let repo = Repo::new(&conn);
    let (total_orders, total_spent_cents) = repo.customer_order_stats(&actor.tenant_id, &phone).map_err(|e| e.to_string())?;
    let loyalty_points = repo.customer_loyalty_points(&actor.tenant_id, &phone).map_err(|e| e.to_string())?;
    Ok(CustomerDetailV3 {
        orders: repo.customer_order_history(&actor.tenant_id, &phone).map_err(|e| e.to_string())?,
        favorite_items: repo.customer_favorite_items(&actor.tenant_id, &phone).map_err(|e| e.to_string())?,
        total_orders,
        total_spent_cents,
        loyalty_points,
    })
}

// ---------------------------------------------------------------------------

/// What a customer owes on credit, with the statement (credit invoices and payments): for the customer page.
/// Needs the debt permission too, so the page simply hides the section for someone without it.
#[tauri::command]
pub fn get_customer_debt_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, customer_id: String) -> Result<crate::credit::CustomerDebt, String> {
    get_customer_debt_v3_impl(&state, &license, session_token, customer_id)
}

pub(crate) fn get_customer_debt_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String, customer_id: String) -> Result<crate::credit::CustomerDebt, String> {
    let actor = authenticate_actor(state, &session_token)?;
    require_license_not_locked(license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut debt = crate::credit::customer_debt(&conn, &actor.tenant_id, &customer_id)?;
    // A branch cashier only sees the credit accounts of their own branch.
    let repo = Repo::new(&conn);
    let scope = actor.scope();
    debt.statements.retain(|s| repo.assert_debtor_in_scope(&scope, &s.debtor_id).is_ok());
    debt.balance_cents = debt.statements.iter().map(|s| s.balance_cents).sum();
    Ok(debt)
}

// ---------------------------------------------------------------------------
// Remote back office: the arms a second till's back-office commands take on the hub
// (see `lan_rpc_office.rs`). Each arm calls the same `_impl` the local command wraps.
// ---------------------------------------------------------------------------

#[allow(unused_variables, clippy::let_unit_value)]
pub(crate) fn dispatch_remote_office(db: &Db, license: &crate::license::cloud::CloudLicenseState, command: &str, args: &serde_json::Value) -> Result<Option<serde_json::Value>, String> {
    use super::lan_rpc::lan_arg;
    let value = match command {
        "get_customer_debt_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let customer_id: String = lan_arg(args, "customerId")?;
            let r = get_customer_debt_v3_impl(db, license, session_token, customer_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "create_customer_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let name: String = lan_arg(args, "name")?;
            let phone: Option<String> = lan_arg(args, "phone")?;
            let email: Option<String> = lan_arg(args, "email")?;
            let address: Option<String> = lan_arg(args, "address")?;
            let notes: Option<String> = lan_arg(args, "notes")?;
            let birthday: Option<String> = lan_arg(args, "birthday")?;
            let r = create_customer_v3_impl(db, license, session_token, name, phone, email, address, notes, birthday)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "list_customers_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let r = list_customers_v3_impl(db, license, session_token)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "update_customer_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let customer_id: String = lan_arg(args, "customerId")?;
            let name: String = lan_arg(args, "name")?;
            let phone: String = lan_arg(args, "phone")?;
            let email: Option<String> = lan_arg(args, "email")?;
            let address: Option<String> = lan_arg(args, "address")?;
            let notes: Option<String> = lan_arg(args, "notes")?;
            let birthday: Option<String> = lan_arg(args, "birthday")?;
            let r = update_customer_v3_impl(db, license, session_token, customer_id, name, phone, email, address, notes, birthday)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "delete_customer_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let customer_id: String = lan_arg(args, "customerId")?;
            let r = delete_customer_v3_impl(db, license, session_token, customer_id)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        "get_customer_detail_v3" => {
            let session_token: String = lan_arg(args, "sessionToken")?;
            let phone: String = lan_arg(args, "phone")?;
            let r = get_customer_detail_v3_impl(db, license, session_token, phone)?;
            serde_json::to_value(r).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
