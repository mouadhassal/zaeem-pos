//! Pickup queue commands: phone orders the customer collects and pays for
//! later. The rules live in `pickup.rs`; these wrappers authenticate,
//! authorize, check the manager for a no-show, and audit. Creating a pickup
//! is `create_full_order_v3` with `pickup_at_ms`; paying it is the normal
//! `finalize_order_with_payment_v3`, which marks it collected.

use crate::audit;
use crate::pickup::{self, NoShowRow, PickupRow};
use crate::repo::Repo;
use crate::security::{authorize, Permission, Role};
use crate::Db;
use tauri::State;
use super::orders::verify_manager_override_impl;
use super::shared::*;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The pickup queue: orders still waiting for their customer.
#[tauri::command]
pub fn list_pickup_orders_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<PickupRow>, String> {
    list_pickup_orders_v3_impl(&state, &license, session_token)
}

pub(crate) fn list_pickup_orders_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<PickupRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    pickup::list_waiting(&conn, &tenant_id, &branch_id)
}

/// Pickups whose kitchen time has come and that no till has sent yet. The
/// caller prints their kitchen slips; each order is returned once, ever.
#[tauri::command]
pub fn claim_due_pickup_kitchen_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<PickupRow>, String> {
    claim_due_pickup_kitchen_v3_impl(&state, &license, session_token)
}

pub(crate) fn claim_due_pickup_kitchen_v3_impl(state: &Db, license: &crate::license::cloud::CloudLicenseState, session_token: String) -> Result<Vec<PickupRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, license, None)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let claimed = pickup::claim_due(&tx, &tenant_id, &branch_id, now_ms())?;
    for row in &claimed {
        audit::append(
            &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
            audit::Action::OrderStatusChanged, "order", &row.order_id,
            None, Some(&serde_json::json!({ "action": "pickup_sent_to_kitchen", "pickup_at_ms": row.pickup_at_ms })),
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(claimed)
}

/// The customer came early: a held-back order goes to the kitchen now.
#[tauri::command]
pub fn send_pickup_to_kitchen_now_v3(state: State<Db>, session_token: String, order_id: String) -> Result<(), String> {
    send_pickup_to_kitchen_now_v3_impl(&state, session_token, order_id)
}

pub(crate) fn send_pickup_to_kitchen_now_v3_impl(state: &Db, session_token: String, order_id: String) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    pickup::send_now(&conn, &actor.tenant_id, &order_id, now_ms())
}

/// The customer never came: cancels the unpaid order. A manager does it, or
/// approves it with a PIN, and a reason is required -- otherwise a cashier
/// could keep the cash of a collected order and call it a no-show.
#[tauri::command]
pub fn mark_pickup_no_show_v3(state: State<Db>, session_token: String, order_id: String, reason: String, manager_override_pin: Option<String>) -> Result<(), String> {
    mark_pickup_no_show_v3_impl(&state, session_token, order_id, reason, manager_override_pin)
}

pub(crate) fn mark_pickup_no_show_v3_impl(state: &Db, session_token: String, order_id: String, reason: String, manager_override_pin: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let reason = reason.trim().to_string();
    if reason.is_empty() {
        return Err("اكتب سبب الإلغاء".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    if pickup::get(&conn, &actor.tenant_id, &order_id)?.is_none() {
        return Err("هذا الطلب ليس طلب استلام بانتظار الزبون".to_string());
    }
    let manager_override_used = if actor.role.rank() >= Role::Manager.rank() {
        false
    } else {
        let Some(pin) = manager_override_pin.as_deref() else {
            return Err("إلغاء طلب لم يُستلم يحتاج رمز المدير".to_string());
        };
        if !verify_manager_override_impl(&mut conn, &actor, pin)? {
            return Err("رمز المدير غير صحيح".to_string());
        }
        true
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    pickup::mark_no_show(&tx, &actor.tenant_id, &order_id, &reason, &actor.id, now_ms())?;
    Repo::new(&tx)
        .cancel_open_order(&actor.scope(), &order_id, &format!("لم يحضر الزبون: {reason}"), &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        None, Some(&serde_json::json!({ "action": "pickup_no_show", "reason": reason, "manager_override_used": manager_override_used })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// For the owner: orders whose customer never came, within [from, to] (epoch
/// ms). A report like the gifts report, so gated the same way.
#[tauri::command]
pub fn list_pickup_no_shows_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, from_ms: i64, to_ms: i64) -> Result<Vec<NoShowRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    pickup::list_no_shows(&conn, &actor.tenant_id, actor.branch_id.as_deref(), from_ms, to_ms)
}
