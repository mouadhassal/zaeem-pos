use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission, Scope};
use crate::Db;
use rusqlite::{params, OptionalExtension};
use tauri::State;
use super::shared::*;
use super::orders::{sync_enqueue_ingredient, sync_enqueue_operational_cost, sync_enqueue_supplier_payment};

#[tauri::command]
pub fn create_purchase_order_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order(&actor.scope(), &tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "supplier_id": supplier_id })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(po_id)
}

/// `NewOrderModal`'s quick-create path -- bare PO + `total_orders` bump.
#[tauri::command]
pub fn create_purchase_order_and_bump_supplier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order_and_bump_supplier(&actor.scope(), &tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "supplier_id": supplier_id })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(po_id)
}

/// `CreatePOModal`'s full line-item flow. `items` is `(ingredient_id,
/// quantity_ordered, unit_cost_cents)` triples -- the same shape
/// `create_purchase_order_with_items` expects, so no reshaping needed
/// between the Tauri boundary and the repo call.
#[tauri::command]
pub fn create_purchase_order_with_items_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String, notes: Option<String>, items: Vec<(String, f64, i64)>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order_with_items(&actor.scope(), &tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref(), &items)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "supplier_id": supplier_id, "item_count": items.len() })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(po_id)
}

#[tauri::command]
pub fn list_purchase_orders_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::PurchaseOrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_purchase_orders(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_purchase_order_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, po_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).cancel_purchase_order(&po_id, &scope).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "status": "CANCELLED" })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_purchase_order_items_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, po_id: String) -> Result<Vec<crate::repo::PurchaseOrderItemRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_purchase_order_items(&po_id, &actor.scope()).map_err(|e| e.to_string())
}

/// The atomicity target for this group -- see `Repo::receive_purchase_order`.
/// `items` is `(purchase_order_item_id, ingredient_id, quantity_received)`
/// triples for however many line items the PO has.
///
/// T2.0 supplier ledger: `amount_paid_cents` (default 0 if the frontend
/// sends nothing, preserving today's fully-unpaid-by-default behavior) and
/// `method` are new, optional trailing arguments -- what the cashier/manager
/// actually paid the driver/supplier at receive time. Zero validation
/// ceiling on "paid more than total_cents" -- that's a legitimate advance,
/// handled by `Repo::receive_purchase_order`'s payment_status logic.
#[tauri::command]
pub fn receive_purchase_order_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, po_id: String, items: Vec<(String, String, f64)>, amount_paid_cents: Option<i64>, method: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let amount_paid_cents = amount_paid_cents.unwrap_or(0);
    if amount_paid_cents < 0 {
        return Err("amount paid cannot be negative".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (payment_ids, cost_id) = Repo::new(&tx)
        .receive_purchase_order(&tenant_id, &branch_id, &po_id, &actor.id, &scope, &items, amount_paid_cents, method.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PurchaseOrderReceived, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "item_count": items.len(), "amount_paid_cents": amount_paid_cents })),
    ).map_err(|e| e.to_string())?;
    if amount_paid_cents > 0 {
        audit::append(
            &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
            audit::Action::SupplierPaymentRecorded, "purchase_order", &po_id,
            None, Some(&serde_json::json!({ "payment_ids": payment_ids, "amount_paid_cents": amount_paid_cents, "method": method })),
        ).map_err(|e| e.to_string())?;
    }

    let license_status = license.cached_status();
    for payment_id in &payment_ids {
        sync_enqueue_supplier_payment(&tx, &tenant_id, &branch_id, payment_id, &actor.device_id, &license_status)?;
    }
    if let Some(cost_id) = &cost_id {
        sync_enqueue_operational_cost(&tx, &tenant_id, &branch_id, cost_id, &actor.device_id, &license_status)?;
    }

    // Every ingredient whose current_stock just got bumped by receiving --
    // real ingredient_id re-derived from `purchase_order_items` itself
    // (same server-side-authoritative lookup `Repo::receive_purchase_order`
    // already does internally), not trusted from the client's own `items`
    // tuples.
    let mut received_ingredient_ids: Vec<String> = Vec::new();
    for (item_id, _client_ingredient_id, _qty) in &items {
        let real_ingredient_id: Option<String> = tx.query_row(
            "SELECT ingredient_id FROM purchase_order_items WHERE id = ?1 AND purchase_order_id = ?2",
            params![item_id, po_id],
            |r| r.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(id) = real_ingredient_id {
            if !received_ingredient_ids.contains(&id) {
                received_ingredient_ids.push(id);
            }
        }
    }
    for ingredient_id in &received_ingredient_ids {
        sync_enqueue_ingredient(&tx, &tenant_id, &branch_id, ingredient_id, &actor.device_id, &license_status)?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Standalone supplier payment -- settling an old invoice or recording an
/// advance, not tied to a fresh receive. Mirrors `record_debt_payment_v3`
/// exactly, including the "no Branch-scope requirement" reasoning: the
/// supplier's own tenant_id/branch_id is looked up by `Repo::record_supplier_payment`,
/// so a Tenant-scoped Owner (no home branch) can still pay off any supplier
/// in their own tenant.
#[tauri::command]
pub fn record_supplier_payment_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String, amount_cents: i64, method: Option<String>, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    if amount_cents <= 0 {
        return Err("payment amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (payment_id, cost_id) = Repo::new(&tx).record_supplier_payment(&actor.scope(), &supplier_id, amount_cents, method.as_deref(), notes.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SupplierPaymentRecorded, "supplier", &supplier_id,
        None, Some(&serde_json::json!({ "payment_id": payment_id, "amount_cents": amount_cents, "type": "PAYMENT" })),
    ).map_err(|e| e.to_string())?;

    // The supplier's own tenant_id/branch_id (looked up by
    // Repo::record_supplier_payment, not necessarily the actor's own scope
    // -- see that function's doc comment) is what the fact must be enqueued
    // under, same reasoning as `record_debt_payment_v3` if it synced.
    let (tenant_id, branch_id): (String, String) = tx.query_row(
        "SELECT tenant_id, branch_id FROM suppliers WHERE id = ?1", params![supplier_id], |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    sync_enqueue_supplier_payment(&tx, &tenant_id, &branch_id, &payment_id, &actor.device_id, &license_status)?;
    sync_enqueue_operational_cost(&tx, &tenant_id, &branch_id, &cost_id, &actor.device_id, &license_status)?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(payment_id)
}

#[tauri::command]
pub fn list_supplier_payments_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String) -> Result<Vec<crate::repo::SupplierPaymentRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_supplier_payments(&actor.scope(), &supplier_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_suppliers_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::SupplierRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_suppliers(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_supplier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, phone: Option<String>, email: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let supplier_id = Repo::new(&tx)
        .create_supplier(&tenant_id, &branch_id, &name, phone.as_deref(), email.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::SupplierChanged, "supplier", &supplier_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(supplier_id)
}

#[tauri::command]
pub fn update_supplier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String, name: String, phone: Option<String>, email: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_supplier(&scope, &supplier_id, &name, phone.as_deref(), email.as_deref()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::SupplierChanged, "supplier", &supplier_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_supplier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let scope = Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_supplier(&scope, &supplier_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::SupplierChanged, "supplier", &supplier_id,
        None, None,
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_inventory_logs_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::InventoryLogRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_inventory_logs(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_low_stock_ingredients_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::IngredientRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_low_stock_ingredients(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_printer_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, printer_type: String, interface: String, vendor_id: Option<String>, product_id: Option<String>, drawer_pulse_ms: i64, is_primary: bool, system_printer_name: Option<String>, ip_address: Option<String>, port: Option<i64>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let printer_id = Repo::new(&tx)
        .create_printer(&tenant_id, &branch_id, &name, &printer_type, &interface, vendor_id.as_deref(), product_id.as_deref(), drawer_pulse_ms, is_primary, system_printer_name.as_deref(), ip_address.as_deref(), port)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::StaffCreated, "printer", &printer_id,
        None, Some(&serde_json::json!({ "name": name, "printer_type": printer_type })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(printer_id)
}

#[tauri::command]
pub fn list_printers_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::PrinterRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_printers(&actor.scope()).map_err(|e| e.to_string())
}

/// `printer.ts`'s read path (print receipt/kitchen ticket/open drawer) --
/// Cashier+, distinct from `list_printers_v3` (Manager+, Settings' printer
/// config tab, which also needs to see deactivated printers). Filters to
/// `is_active = 1` server-side, matching the old frontend's own filter.
#[tauri::command]
pub fn list_active_printers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::PrinterRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UsePrinter).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(Repo::new(&conn).list_printers(&actor.scope()).map_err(|e| e.to_string())?
        .into_iter().filter(|p| p.is_active == 1).collect())
}
