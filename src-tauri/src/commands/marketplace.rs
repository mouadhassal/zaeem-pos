//! Marketplace bridge commands: reorder deep-link context and goods received
//! (ECOSYSTEM_CONTRACTS.md §6). Back-office, license-gated.

use crate::audit;
use crate::goods_receipt::{self, ApplyOutcome, PendingReceipts, ReceiptLine};
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;
use super::orders::sync_enqueue_ingredient;

#[derive(serde::Serialize)]
pub struct MarketplaceContext {
    /// The licensed branch, for `/ar/buyer/reorder?branch=`.
    pub branch_id: Option<String>,
    /// Goods-received pull needs a cloud device token (not offline-CLI licenses).
    pub receipts_enabled: bool,
}

#[tauri::command]
pub fn get_marketplace_context_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<MarketplaceContext, String> {
    authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    Ok(MarketplaceContext {
        branch_id: license.licensed_branch().map(|(_, branch_id)| branch_id),
        receipts_enabled: license.device_token().is_some(),
    })
}

pub(crate) const NO_CLOUD_TOKEN_ERR: &str = "استلام طلبيات السوق يتطلب ترخيصاً سحابياً مفعّلاً على هذا الجهاز";

#[tauri::command]
pub async fn list_marketplace_receipts_v3(state: State<'_, Db>, license: State<'_, crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<PendingReceipts, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let token = license.device_token().ok_or_else(|| NO_CLOUD_TOKEN_ERR.to_string())?;
    let resp = goods_receipt::fetch_pending(&token, 50).await?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    goods_receipt::prepare_pending(&conn, resp).map_err(|e| e.to_string())
}

/// Adds received stock locally and queues the cloud ack. Returns false when
/// the order had already been received on this terminal (no double stock).
#[tauri::command]
pub fn receive_marketplace_order_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, order_id: String, lines: Vec<ReceiptLine>, note: Option<String>) -> Result<bool, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let outcome = goods_receipt::apply_receipt(&tx, &actor.scope(), &tenant_id, &branch_id, &actor.id, &order_id, &lines, note.as_deref())?;
    let ApplyOutcome::Applied(touched) = outcome else {
        return Ok(false);
    };
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "marketplace_order", &order_id, None, Some(&serde_json::json!({ "lines": lines }))).map_err(|e| e.to_string())?;
    let license_status = license.cached_status();
    for ingredient_id in &touched {
        sync_enqueue_ingredient(&tx, &tenant_id, &branch_id, ingredient_id, &actor.device_id, &license_status)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}
