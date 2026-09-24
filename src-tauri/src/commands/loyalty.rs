use crate::audit;
use crate::repo::Repo;
use crate::security::{authorize, Permission};
use crate::Db;
use tauri::State;
use super::shared::*;

// Batch 3b, slice 3, group 1b -- loyalty. Card issuance is UID
// keyboard-entry ONLY -- no hardware scan integration (Phase 2, out of scope).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_loyalty_cards_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::LoyaltyCardRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_cards(&actor.tenant_id).map_err(|e| e.to_string())
}

/// `card_number` is whatever was typed or scanned into the UID field on the
/// issue-card form -- a scanner is just a keyboard emitting the UID string,
/// so there is no separate hardware code path here at all.
#[tauri::command]
pub fn issue_loyalty_card_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, customer_id: String, card_number: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    if card_number.trim().is_empty() {
        return Err("رقم البطاقة مطلوب".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let card_id = Repo::new(&tx)
        .issue_loyalty_card(&actor.tenant_id, &customer_id, card_number.trim())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyCardIssued, "loyalty_card", &card_id, None, Some(&serde_json::json!({ "customer_id": customer_id, "card_number": card_number }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(card_id)
}

#[tauri::command]
pub fn list_loyalty_transactions_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, card_id: Option<String>) -> Result<Vec<crate::repo::LoyaltyTxRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_transactions(&actor.scope(), card_id.as_deref()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// T2.0 loyalty rethink -- tier config, rewards catalog, redemption. Tier/
// reward config is tenant-only (chain-wide), same Owner-configurable
// pattern as menu defaults; back-office gated same as the rest of loyalty.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_loyalty_tiers_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::LoyaltyTierRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_tiers(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_loyalty_tier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, min_points: i64, points_multiplier: f64, sort_order: i64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    if min_points < 0 || points_multiplier <= 0.0 {
        return Err("الحد الأدنى للنقاط ومضاعف النقاط يجب أن يكونا موجبين".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let tier_id = Repo::new(&tx).create_loyalty_tier(&actor.tenant_id, &name, min_points, points_multiplier, sort_order).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyTierChanged, "loyalty_tier", &tier_id, None, Some(&serde_json::json!({ "name": name, "min_points": min_points, "points_multiplier": points_multiplier }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(tier_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_loyalty_tier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, tier_id: String, name: String, min_points: i64, points_multiplier: f64, sort_order: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    if min_points < 0 || points_multiplier <= 0.0 {
        return Err("الحد الأدنى للنقاط ومضاعف النقاط يجب أن يكونا موجبين".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_loyalty_tier(&actor.tenant_id, &tier_id, &name, min_points, points_multiplier, sort_order).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyTierChanged, "loyalty_tier", &tier_id, None, Some(&serde_json::json!({ "name": name, "min_points": min_points, "points_multiplier": points_multiplier }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_loyalty_tier_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, tier_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_loyalty_tier(&actor.tenant_id, &tier_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyTierChanged, "loyalty_tier", &tier_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_loyalty_rewards_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::LoyaltyRewardRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_rewards(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_loyalty_reward_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, name: String, points_cost: i64, reward_type: String, value_cents: Option<i64>, value_percent_bps: Option<i64>, linked_menu_item_id: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    if points_cost <= 0 {
        return Err("تكلفة المكافأة بالنقاط يجب أن تكون موجبة".to_string());
    }
    if !["FREE_ITEM", "DISCOUNT_FIXED", "DISCOUNT_PERCENT"].contains(&reward_type.as_str()) {
        return Err("نوع مكافأة غير صالح".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let reward_id = Repo::new(&tx).create_loyalty_reward(&actor.tenant_id, &name, points_cost, &reward_type, value_cents, value_percent_bps, linked_menu_item_id.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyRewardChanged, "loyalty_reward", &reward_id, None, Some(&serde_json::json!({ "name": name, "points_cost": points_cost, "reward_type": reward_type }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(reward_id)
}

#[tauri::command]
pub fn set_loyalty_reward_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, reward_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_loyalty_reward_active(&actor.tenant_id, &reward_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyRewardChanged, "loyalty_reward", &reward_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_loyalty_reward_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, reward_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    require_plan_includes_management(&license)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_loyalty_reward(&actor.tenant_id, &reward_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyRewardChanged, "loyalty_reward", &reward_id, None, Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Redeem points for a catalog reward at checkout. Cashier-facing (selling
/// path), NOT gated by `require_license_not_locked` -- a dinner service
/// redemption is exactly the kind of thing that must keep working even
/// with a lapsed back-office license, same reasoning as `earn_loyalty_points_v3`.
/// Per AGENTS.md prime directive #4 (the threat model is the employee): a
/// redemption is money leaving through a side door exactly like a manual
/// discount, so it gets the same audit rigor, non-negotiably.
#[tauri::command]
pub fn redeem_loyalty_reward_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, card_number: String, reward_id: String) -> Result<crate::repo::LoyaltyRewardRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let (_, branch_id) = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        resolve_operating_branch(&conn, &actor, &license, None)?
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let reward = Repo::new(&tx).redeem_loyalty_reward(&actor.tenant_id, &branch_id, &card_number, &reward_id, &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::LoyaltyPointsRedeemed, "loyalty_card", &card_number, None, Some(&serde_json::json!({ "reward_id": reward_id, "reward_name": reward.name, "points_cost": reward.points_cost }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(reward)
}

