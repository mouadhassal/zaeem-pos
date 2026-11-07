//! A supplier's marketplace orders and products, tied to its POS stock (see `supplier_link.rs`).
//! Back-office, license-gated, hub only. The network calls hold no database lock.

use crate::audit;
use crate::security::{authorize, Permission};
use crate::supplier_link::{self, ApplyOutcome, SupplierOrder, SupplierProduct};
use crate::Db;
use tauri::State;
use super::shared::*;

#[derive(serde::Serialize)]
pub struct SupplierMarketState {
    /// False when this shop has no supplier account on the marketplace.
    pub is_supplier: bool,
    pub products: Vec<SupplierProduct>,
    /// Accepted orders not yet taken out of the POS stock, each line showing the POS product it will leave.
    pub orders: Vec<SupplierOrder>,
}

#[derive(serde::Serialize, Default)]
pub struct SupplierSyncOutcome {
    pub is_supplier: bool,
    /// Orders taken out of the POS stock in this round.
    pub applied_orders: usize,
    /// Orders waiting because a line has no linked POS product.
    pub needs_link_orders: usize,
    /// Products whose stock was published to the marketplace.
    pub published: usize,
    pub error: Option<String>,
}

const NOT_ENABLED: &str = "ربط السوق يتطلب ترخيصاً سحابياً مفعّلاً على هذا الجهاز";

fn token_of(license: &crate::license::cloud::CloudLicenseState) -> Result<String, String> {
    license.device_token().ok_or_else(|| NOT_ENABLED.to_string())
}

#[tauri::command]
pub async fn supplier_market_state_v3(state: State<'_, Db>, license: State<'_, crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<SupplierMarketState, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let token = token_of(&license)?;
    let products = supplier_link::fetch_products(&token).await?;
    if !products.supplier {
        return Ok(SupplierMarketState { is_supplier: false, products: vec![], orders: vec![] });
    }
    let orders = supplier_link::fetch_orders(&token, 50).await?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Ok(SupplierMarketState {
        is_supplier: true,
        products: supplier_link::decorate_products(&conn, &actor.tenant_id, products.products)?,
        orders: supplier_link::decorate_orders(&conn, &actor.tenant_id, orders.orders)?,
    })
}

/// Links a marketplace product to a POS product (`None` removes the link).
#[tauri::command]
pub fn link_supplier_product_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, supplier_product_id: String, menu_item_id: Option<String>) -> Result<(), String> {
    crate::lan::reject_if_local_kitchen_satellite("link_supplier_product_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    supplier_link::set_link(&tx, &actor.tenant_id, &supplier_product_id, menu_item_id.as_deref())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::SettingsChanged, "supplier_product_link", &supplier_product_id,
        None, Some(&serde_json::json!({ "menu_item_id": menu_item_id })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Takes one accepted order out of the POS stock now (the owner pressed the button). The order is read
/// from the marketplace again, never from the screen, so what is taken out is what the buyer ordered.
#[tauri::command]
pub async fn apply_supplier_order_v3(state: State<'_, Db>, license: State<'_, crate::license::cloud::CloudLicenseState>, session_token: String, order_id: String) -> Result<bool, String> {
    crate::lan::reject_if_local_kitchen_satellite("apply_supplier_order_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let token = token_of(&license)?;
    let fetched = supplier_link::fetch_orders(&token, 200).await?;
    let order = fetched.orders.into_iter().find(|o| o.order_id == order_id).ok_or_else(|| "الطلبية لم تعد بانتظار الخصم من المخزون".to_string())?;
    let applied = {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let outcome = supplier_link::apply_order(&tx, &tenant_id, &branch_id, &actor.id, &order, None, &now)?;
        let applied = matches!(outcome, ApplyOutcome::Applied { .. });
        if let ApplyOutcome::Applied { lines, unlinked } = &outcome {
            audit::append(
                &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
                audit::Action::InventoryAdjusted, "supplier_market_order", &order_id,
                None, Some(&serde_json::json!({ "lines": lines, "unlinked": unlinked })),
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        applied
    };
    let _ = supplier_link::run_ack_tick(&state.0, &token).await;
    Ok(applied)
}

/// One round of the two-way link, run by the till every couple of minutes on a supplier's hub:
/// accepted orders whose every line is linked leave the POS stock (when `auto_apply`), the
/// acknowledgements go out, and the stock of the linked products is published. Failures are returned,
/// never thrown: a shop with no internet just tries again next round.
#[tauri::command]
pub async fn supplier_market_sync_v3(state: State<'_, Db>, license: State<'_, crate::license::cloud::CloudLicenseState>, session_token: String, auto_apply: bool) -> Result<SupplierSyncOutcome, String> {
    crate::lan::reject_if_local_kitchen_satellite("supplier_market_sync_v3")?;
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Some(token) = license.device_token() else {
        return Ok(SupplierSyncOutcome::default());
    };
    let mut out = SupplierSyncOutcome::default();
    let fetched = match supplier_link::fetch_orders(&token, 100).await {
        Ok(f) => f,
        Err(e) => {
            out.error = Some(e);
            return Ok(out);
        }
    };
    out.is_supplier = fetched.supplier;
    if !fetched.supplier {
        return Ok(out);
    }
    {
        let mut conn = state.0.lock().map_err(|e| e.to_string())?;
        let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
        let orders = supplier_link::decorate_orders(&conn, &tenant_id, fetched.orders)?;
        for order in orders {
            if !supplier_link::fully_linked(&order) {
                out.needs_link_orders += 1;
                continue;
            }
            if !auto_apply {
                continue;
            }
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            if let ApplyOutcome::Applied { lines, unlinked } = supplier_link::apply_order(&tx, &tenant_id, &branch_id, &actor.id, &order, Some("تلقائي"), &now)? {
                audit::append(
                    &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
                    audit::Action::InventoryAdjusted, "supplier_market_order", &order.order_id,
                    None, Some(&serde_json::json!({ "lines": lines, "unlinked": unlinked, "auto": true })),
                ).map_err(|e| e.to_string())?;
                out.applied_orders += 1;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
    }
    let _ = supplier_link::run_ack_tick(&state.0, &token).await;
    let to_publish = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        let (tenant_id, branch_id) = resolve_operating_branch(&conn, &actor, &license, None)?;
        supplier_link::stock_to_publish(&conn, &tenant_id, &branch_id)?
    };
    match supplier_link::push_stock(&token, &to_publish).await {
        Ok(()) => out.published = to_publish.len(),
        Err(e) => out.error = Some(e),
    }
    Ok(out)
}
