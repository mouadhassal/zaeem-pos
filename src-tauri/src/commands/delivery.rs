//! Delivery commands: drivers, assigning a driver, moving a delivery along,
//! the driver's statement and settling with him. The rules live in
//! `delivery.rs`; these wrappers authenticate, authorize, audit and (for
//! settling) take the cash through the normal payment path.

use crate::audit;
use crate::delivery::{self, DeliveryFilter, DeliveryRow, DeliverySettings, Driver, DriverInput, SettlementRecord, Statement};
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::orders::take_payment_v3_impl;
use super::shared::*;

// ---- settings and drivers (manager / owner) ----

#[tauri::command]
pub fn get_delivery_settings_v3(state: State<Db>, session_token: String) -> Result<DeliverySettings, String> {
    get_delivery_settings_v3_impl(&state, session_token)
}

pub(crate) fn get_delivery_settings_v3_impl(state: &Db, session_token: String) -> Result<DeliverySettings, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(delivery::get_settings(&conn))
}

#[tauri::command]
pub fn update_delivery_settings_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    pay_mode: String,
    pay_value: i64,
) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    delivery::set_settings(&tx, &pay_mode, pay_value)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "delivery_settings", "driver_pay", None, Some(&serde_json::json!({ "pay_mode": pay_mode, "pay_value": pay_value }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_delivery_drivers_v3(state: State<Db>, session_token: String, include_inactive: Option<bool>) -> Result<Vec<Driver>, String> {
    list_delivery_drivers_v3_impl(&state, session_token, include_inactive)
}

pub(crate) fn list_delivery_drivers_v3_impl(state: &Db, session_token: String, include_inactive: Option<bool>) -> Result<Vec<Driver>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delivery::list_drivers(&conn, &actor.tenant_id, include_inactive.unwrap_or(false))
}

#[tauri::command]
pub fn save_delivery_driver_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    driver: DriverInput,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = delivery::save_driver(&tx, &actor.tenant_id, &driver)?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "delivery_driver", &id, None, Some(&serde_json::json!({ "name": driver.name, "pay_value": driver.pay_value, "is_active": driver.is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

// ---- the work of a delivery (cashier and up) ----

#[tauri::command]
pub fn list_deliveries_v3(state: State<Db>, session_token: String, filter: Option<DeliveryFilter>) -> Result<Vec<DeliveryRow>, String> {
    list_deliveries_v3_impl(&state, session_token, filter)
}

pub(crate) fn list_deliveries_v3_impl(state: &Db, session_token: String, filter: Option<DeliveryFilter>) -> Result<Vec<DeliveryRow>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delivery::list_deliveries(&conn, &actor.tenant_id, &filter.unwrap_or_default())
}

#[tauri::command]
pub fn assign_delivery_driver_v3(state: State<Db>, session_token: String, order_id: String, driver_id: Option<String>) -> Result<DeliveryRow, String> {
    assign_delivery_driver_v3_impl(&state, session_token, order_id, driver_id)
}

pub(crate) fn assign_delivery_driver_v3_impl(
    state: &Db,
    session_token: String,
    order_id: String,
    driver_id: Option<String>,
) -> Result<DeliveryRow, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let row = delivery::assign_driver(&tx, &actor.tenant_id, &order_id, driver_id.as_deref())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::OrderStatusChanged, "order", &order_id, None, Some(&serde_json::json!({ "action": "delivery_driver_assigned", "driver_id": driver_id }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

/// ASSIGNED -> OUT -> DELIVERED, or FAILED with a reason. A failed delivery
/// whose order was never paid cancels the order so it does not sit in the
/// kitchen queue forever; a failed delivery that was already paid keeps its
/// payment and has to be refunded through the normal refund.
pub(crate) fn set_delivery_status_v3_impl(state: &Db, session_token: String, order_id: String, new_status: String, note: Option<String>) -> Result<DeliveryRow, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before = delivery::get_delivery(&tx, &actor.tenant_id, &order_id)?;
    let row = delivery::set_status(&tx, &actor.tenant_id, &order_id, &new_status, note.as_deref())?;
    // A delivery that never reached the customer and was never paid must not
    // sit in the kitchen queue: cancel the order (nothing to refund).
    if new_status == "FAILED" && !matches!(before.order_status.as_str(), "PAID" | "CANCELLED") {
        crate::repo::Repo::new(&tx)
            .cancel_open_order(&actor.scope(), &order_id, note.as_deref().unwrap_or("فشل التوصيل"), &actor.id, &actor.device_id)
            .map_err(|e| e.to_string())?;
    }
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::OrderStatusChanged, "order", &order_id, None, Some(&serde_json::json!({ "action": "delivery_status", "status": new_status, "note": note, "pay_cents": row.pay_cents, "cash_due_cents": row.cash_due_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

#[tauri::command]
pub fn set_delivery_status_v3(state: State<Db>, session_token: String, order_id: String, new_status: String, note: Option<String>) -> Result<DeliveryRow, String> {
    set_delivery_status_v3_impl(&state, session_token, order_id, new_status, note)
}

#[tauri::command]
pub fn get_driver_statement_v3(state: State<Db>, session_token: String, driver_id: String, from: Option<String>, to: Option<String>) -> Result<Statement, String> {
    get_driver_statement_v3_impl(&state, session_token, driver_id, from, to)
}

pub(crate) fn get_driver_statement_v3_impl(
    state: &Db,
    session_token: String,
    driver_id: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<Statement, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delivery::driver_statement(&conn, &actor.tenant_id, &driver_id, from.as_deref(), to.as_deref())
}

#[tauri::command]
pub fn list_driver_settlements_v3(state: State<Db>, session_token: String, driver_id: String) -> Result<Vec<SettlementRecord>, String> {
    list_driver_settlements_v3_impl(&state, session_token, driver_id)
}

pub(crate) fn list_driver_settlements_v3_impl(state: &Db, session_token: String, driver_id: String) -> Result<Vec<SettlementRecord>, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    delivery::list_settlements(&conn, &actor.tenant_id, &driver_id, 50)
}

/// Settles with a driver: takes in the cash for every delivered order that was
/// not paid at the till (each one through the normal payment path, so the
/// sale, stock and reports see it), then records his pay and the handover.
/// Safe to retry: an order already paid or settled is not charged twice.
pub(crate) fn settle_driver_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    driver_id: String,
    order_ids: Vec<String>,
    note: Option<String>,
) -> Result<SettlementRecord, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::TakePayment).map_err(|e| e.to_string())?;
    if order_ids.is_empty() {
        return Err("اختر طلباً واحداً على الأقل للتسوية".to_string());
    }

    // Work out what is open, then take the cash one order at a time.
    let todo: Vec<DeliveryRow> = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let open = delivery::unsettled(&conn, &actor.tenant_id, &driver_id)?;
        let mut picked = Vec::new();
        for id in &order_ids {
            picked.push(
                open.iter().find(|r| &r.order_id == id).cloned().ok_or_else(|| "طلب غير مفتوح للتسوية لهذا السائق".to_string())?,
            );
        }
        picked
    };
    for d in &todo {
        if d.cash_settled || d.cash_due_cents <= 0 {
            continue;
        }
        // The order may have been paid in the meantime (retry after a partial run).
        let unpaid = {
            let conn = state.0.lock().map_err(|e| e.to_string())?;
            let status: String = conn.query_row("SELECT status FROM orders WHERE id = ?1", rusqlite::params![d.order_id], |r| r.get(0)).map_err(|e| e.to_string())?;
            status != "PAID"
        };
        if unpaid {
            take_payment_v3_impl(state, license, session_token.clone(), d.order_id.clone(), "CASH".to_string(), d.cash_due_cents, 0, None)?;
        }
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let rec = delivery::record_settlement(&tx, &actor.tenant_id, actor.branch_id.as_deref(), &driver_id, &order_ids, &actor.id, note.as_deref())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::PaymentTaken, "delivery_settlement", &rec.id, None, Some(&serde_json::json!({ "driver_id": driver_id, "deliveries": rec.deliveries_count, "pay_cents": rec.pay_cents, "cash_cents": rec.cash_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rec)
}

#[tauri::command]
pub fn settle_driver_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    driver_id: String,
    order_ids: Vec<String>,
    note: Option<String>,
) -> Result<SettlementRecord, String> {
    settle_driver_v3_impl(&state, &license, session_token, driver_id, order_ids, note)
}
