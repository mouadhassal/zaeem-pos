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
    list_option_groups_v3_impl(&state, session_token, include_inactive)
}

pub(crate) fn list_option_groups_v3_impl(state: &Db, session_token: String, include_inactive: Option<bool>) -> Result<Vec<ops::OptionGroup>, String> {
    let actor = authenticate_actor(state, &session_token)?;
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

// ---------------------------------------------------------------------------
// Editing and gifting lines of an order that is already open (sent to the
// kitchen, not yet paid). The kitchen slips are printed by the till afterwards.
// ---------------------------------------------------------------------------

use crate::repo::{OrderItemInput, OrderModifierInput, Repo};
use crate::security::Scope;
use super::orders::{price_order_authoritatively, sync_enqueue_order, sync_enqueue_single_order_item, verify_manager_override_impl};

#[derive(Debug, Clone, serde::Serialize)]
pub struct EditedItem {
    pub new_item_id: String,
    pub order_total_cents: i64,
}

/// Re-prices an open order from its remaining lines and stores the totals.
fn reprice_open_order(tx: &rusqlite::Transaction, scope: &Scope, order_id: &str) -> Result<i64, String> {
    let (tenant_id, _branch, _status, discount_cents, delivery_fee_cents) =
        Repo::new(tx).get_order_pricing_context(scope, order_id).map_err(|e| e.to_string())?;
    let remaining = Repo::new(tx).list_order_items_as_input(order_id).map_err(|e| e.to_string())?;
    let (_, subtotal_cents, tax_cents, total_cents) =
        price_order_authoritatively(tx, &tenant_id, &remaining, discount_cents, delivery_fee_cents)?;
    Repo::new(tx).update_order_totals(order_id, subtotal_cents, tax_cents, total_cents).map_err(|e| e.to_string())?;
    Ok(total_cents)
}

/// Changes one line of an open order: quantity, options, kitchen note. The old
/// line is voided (with the reason, and linked to its replacement) and a new
/// one takes its place, so nothing is silently rewritten. Taking value off the
/// order (fewer items, a removed paid option) at or above the manager
/// threshold needs a manager PIN, exactly like voiding.
#[allow(clippy::too_many_arguments)]
pub(crate) fn edit_order_item_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    item_id: String,
    quantity: i64,
    modifiers: Vec<OrderModifierInput>,
    notes: Option<String>,
    reason: String,
    manager_override_pin: Option<String>,
) -> Result<EditedItem, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let reason = reason.trim().to_string();
    if reason.is_empty() {
        return Err("سبب التعديل مطلوب".to_string());
    }
    if quantity <= 0 {
        return Err("الكمية يجب أن تكون أكبر من صفر (لحذف الصنف استخدم الإلغاء)".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let old = Repo::new(&conn).open_order_item_info(&scope, &item_id).map_err(|e| e.to_string())?;
    if old.voided {
        return Err("هذا الصنف ملغى مسبقاً".to_string());
    }
    let old_total = Repo::new(&conn).order_item_line_total_cents(&scope, &item_id).map_err(|e| e.to_string())?;
    let (tenant_id, branch_id, ..) = Repo::new(&conn).get_order_pricing_context(&scope, &old.order_id).map_err(|e| e.to_string())?;

    // An option the line already carried keeps the price it was sold at, even
    // if the menu has changed since; only newly added options are priced from
    // the menu.
    let modifiers: Vec<OrderModifierInput> = modifiers
        .into_iter()
        .map(|m| match old.modifiers.iter().find(|o| o.name == m.name.trim()) {
            Some(kept) => OrderModifierInput { name: kept.name.clone(), price_cents: kept.price_cents, locked: true },
            None => m,
        })
        .collect();
    let candidate = OrderItemInput {
        menu_item_id: old.menu_item_id.clone(), name: None, quantity, unit_price_cents: old.unit_price_cents,
        notes: notes.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()), combo_id: old.combo_id.clone(),
        modifiers, comped: old.comped, comp_reason: old.comp_reason.clone(), comp_by: old.comp_by.clone(),
    };
    let priced = Repo::new(&conn).price_authoritative_items(&tenant_id, std::slice::from_ref(&candidate)).map_err(|e| e.to_string())?;
    let new_item = priced.into_iter().next().ok_or("empty pricing result")?;
    let new_total = Repo::line_total_cents(&new_item);

    // Value taken off the bill by this edit. Adding value never needs approval.
    let removed = if old.comped { 0 } else { (old_total - new_total).max(0) };
    let thresholds = Repo::new(&conn).get_manager_thresholds(&actor.tenant_id).map_err(|e| e.to_string())?;
    let override_used = if removed > 0 && thresholds.void_requires_manager(removed) {
        let Some(pin) = manager_override_pin.as_deref() else {
            return Err("هذا التعديل يتجاوز حد موافقة المدير ويتطلب رمز المدير".to_string());
        };
        if !verify_manager_override_impl(&mut conn, &actor, pin)? {
            return Err("رمز المدير غير صحيح".to_string());
        }
        true
    } else {
        false
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let new_id = Repo::new(&tx)
        .replace_order_item(&scope, &item_id, &new_item, &format!("تعديل: {reason}"), &actor.id)
        .map_err(|e| e.to_string())?;
    let total = reprice_open_order(&tx, &scope, &old.order_id)?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order_item", &new_id,
        None, Some(&serde_json::json!({
            "action": "edit", "replaces": item_id, "reason": reason,
            "before": { "quantity": old.quantity, "options": old.modifiers.iter().map(|m| m.name.clone()).collect::<Vec<_>>(), "notes": old.notes },
            "after": { "quantity": new_item.quantity, "options": new_item.modifiers.iter().map(|m| m.name.clone()).collect::<Vec<_>>(), "notes": new_item.notes },
            "value_removed_cents": removed, "manager_override_used": override_used,
        })),
    ).map_err(|e| e.to_string())?;

    let license_status = license.cached_status();
    sync_enqueue_single_order_item(&tx, &tenant_id, &branch_id, &item_id, &actor.device_id, &license_status)?;
    sync_enqueue_single_order_item(&tx, &tenant_id, &branch_id, &new_id, &actor.device_id, &license_status)?;
    sync_enqueue_order(&tx, &tenant_id, &branch_id, &old.order_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EditedItem { new_item_id: new_id, order_total_cents: total })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn edit_order_item_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    item_id: String,
    quantity: i64,
    modifiers: Vec<OrderModifierInput>,
    notes: Option<String>,
    reason: String,
    manager_override_pin: Option<String>,
) -> Result<EditedItem, String> {
    edit_order_item_v3_impl(&state, &license, session_token, item_id, quantity, modifiers, notes, reason, manager_override_pin)
}

/// Gives a line of an open order away ("on the house") or takes the gift back.
/// A reason is required; the logged-in user is recorded as the giver.
pub(crate) fn set_order_item_comp_v3_impl(
    state: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    session_token: String,
    item_id: String,
    comped: bool,
    reason: Option<String>,
) -> Result<i64, String> {
    let actor = authenticate_actor(state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let reason = reason.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    if comped && reason.is_none() {
        return Err("سبب الضيافة مطلوب".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let info = Repo::new(&tx).set_order_item_comp(&scope, &item_id, comped, reason.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    let total = reprice_open_order(&tx, &scope, &info.order_id)?;
    let (tenant_id, branch_id, ..) = Repo::new(&tx).get_order_pricing_context(&scope, &info.order_id).map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::OrderStatusChanged, "order_item", &item_id,
        None, Some(&serde_json::json!({ "action": if comped { "gift" } else { "gift_removed" }, "reason": reason })),
    ).map_err(|e| e.to_string())?;

    let license_status = license.cached_status();
    sync_enqueue_single_order_item(&tx, &tenant_id, &branch_id, &item_id, &actor.device_id, &license_status)?;
    sync_enqueue_order(&tx, &tenant_id, &branch_id, &info.order_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(total)
}

#[tauri::command]
pub fn set_order_item_comp_v3(
    state: State<Db>,
    license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    item_id: String,
    comped: bool,
    reason: Option<String>,
) -> Result<i64, String> {
    set_order_item_comp_v3_impl(&state, &license, session_token, item_id, comped, reason)
}
