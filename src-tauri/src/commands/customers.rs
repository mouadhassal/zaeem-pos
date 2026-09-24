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
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_customers(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_customer_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, customer_id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
