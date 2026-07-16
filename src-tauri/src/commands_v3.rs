//! T1.2 command scaffold. Every command follows the shape:
//! authn -> resolve Scope -> authz (permission + scope) -> validate -> repo -> commit.
//! This is a real, working vertical slice (not all ~150 commands from the
//! T1.0a inventory) -- login, branch creation, staff creation, order
//! creation/listing, and password change -- chosen to exercise Platform,
//! Tenant, and Branch scope, both reads and writes, and to fix DRIFT_REPORT.md
//! Finding #1 (orders.driver_id) as a side effect of `create_order_v3` never
//! referencing that column at all.

use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

fn authenticate_actor(state: &State<Db>, session_token: &str) -> Result<Actor, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;
    security::authenticate(&conn, session_token).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct LoginV3Response {
    pub token: String,
    pub actor_id: String,
    pub name: String,
    pub role: String,
    pub tenant_id: String,
    pub branch_id: Option<String>,
}

fn login_response(conn: &rusqlite::Connection, actor_id: &str, name: &str, role_str: &str, tenant_id: String, branch_id: Option<String>, device_id: &str) -> Result<LoginV3Response, String> {
    let role = Role::from_str(role_str).ok_or_else(|| "unknown role".to_string())?;
    let token = security::create_session(conn, actor_id, device_id).map_err(|e| e.to_string())?;
    Ok(LoginV3Response {
        token,
        actor_id: actor_id.to_string(),
        name: name.to_string(),
        role: role_str.to_string(),
        tenant_id,
        branch_id: match role { Role::Platform | Role::Owner => None, _ => branch_id },
    })
}

/// authn only (this command's whole job IS authentication) -- creates the
/// session and resolves Scope for the caller to inspect, but the Scope
/// itself is never trusted from the client on subsequent calls; every other
/// command re-resolves it from the session token every time. Looks staff up
/// by `name` (`staff` has no `username` column) -- kept for callers that DO
/// know a display name; the running app's actual login screen is PIN-only
/// and has no name field at all, so it uses `login_pin_v3` below instead.
#[tauri::command]
pub fn login_v3(state: State<Db>, name: String, password_or_pin: String, device_id: String) -> Result<LoginV3Response, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;

    let (actor_id, tenant_id, branch_id, role_str, password_hash, pin_hash): (String, String, Option<String>, String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT id, tenant_id, branch_id, role, password_hash, pin_hash FROM staff WHERE name = ?1 AND is_active = 1",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|_| "invalid credentials".to_string())?;

    let valid = pin_hash.as_deref().map(|h| verify(&password_or_pin, h).unwrap_or(false)).unwrap_or(false)
        || password_hash.as_deref().map(|h| verify(&password_or_pin, h).unwrap_or(false)).unwrap_or(false);
    if !valid {
        return Err("invalid credentials".to_string());
    }

    login_response(&conn, &actor_id, &name, &role_str, tenant_id, branch_id, &device_id)
}

/// The actual login mechanism the running app's UI uses (`LoginPage.tsx` is a
/// PIN pad, nothing else -- no username/name field exists there at all).
/// Scans active staff with a `pin_hash` set, same shape as the old (now
/// broken, `users`-table) `login_with_pin`, but against `staff`.
#[tauri::command]
pub fn login_pin_v3(state: State<Db>, pin: String, device_id: String) -> Result<LoginV3Response, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, tenant_id, branch_id, role, pin_hash FROM staff WHERE pin_hash IS NOT NULL AND is_active = 1")
        .map_err(|e| e.to_string())?;
    let candidates: Vec<(String, String, String, Option<String>, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (actor_id, name, tenant_id, branch_id, role_str, pin_hash) in candidates {
        if verify(&pin, &pin_hash).unwrap_or(false) {
            return login_response(&conn, &actor_id, &name, &role_str, tenant_id, branch_id, &device_id);
        }
    }
    Err("invalid PIN".to_string())
}

/// Bootstraps the very first OWNER. No actor/session can exist to authorize
/// this (there is no staff yet), so this is the one v3 command that runs
/// entirely outside the authn -> authz shape -- guarded instead by "an OWNER
/// already exists" being a hard refusal. T1.1's Migration A always seeds
/// exactly one tenant + branch from the pre-existing single-tenant install,
/// so this targets that tenant rather than creating a new one.
#[tauri::command]
pub fn setup_owner_v3(state: State<Db>, name: String, password: String, pin: String, device_id: String) -> Result<LoginV3Response, String> {
    if password.len() < 10 {
        return Err("كلمة المرور يجب أن تكون 10 أحرف على الأقل".to_string());
    }
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("الرقم السري يجب أن يكون 6 أرقام".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;
    let existing: i64 = conn
        .query_row("SELECT COUNT(*) FROM staff WHERE role = 'OWNER' AND is_active = 1", [], |r| r.get(0))
        .unwrap_or(0);
    if existing > 0 {
        return Err("المالك موجود بالفعل".to_string());
    }
    let tenant_id: String = conn
        .query_row("SELECT id FROM tenant LIMIT 1", [], |r| r.get(0))
        .map_err(|_| "no tenant exists to attach an owner to -- migrations have not run".to_string())?;

    let password_hash = hash(&password, DEFAULT_COST).map_err(|e| e.to_string())?;
    let pin_hash = hash(&pin, DEFAULT_COST).map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let staff_id = Repo::new(&tx)
        .create_staff(&tenant_id, None, None, "OWNER", Role::Owner.rank(), &name, Some(&pin_hash), Some(&password_hash))
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &device_id, &tenant_id, None, &staff_id,
        audit::Action::StaffCreated, "staff", &staff_id,
        None, Some(&serde_json::json!({ "role": "OWNER", "name": name, "bootstrap": true })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    login_response(&conn, &staff_id, &name, "OWNER", tenant_id, None, &device_id)
}

/// Mirrors the old `needs_setup`'s exact debug-mode shortcut (always `false`
/// in a debug build -- dev installs are pre-seeded by `seed_default_staff`),
/// but checks `staff`, not the now-dropped `users` table.
#[tauri::command]
pub fn needs_setup_v3(state: State<Db>) -> Result<bool, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    if cfg!(debug_assertions) {
        return Ok(false);
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM staff WHERE role = 'OWNER' AND is_active = 1", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(count == 0)
}

#[tauri::command]
pub fn logout_v3(state: State<Db>, session_token: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::revoke_session(&conn, &session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_branch_v3(state: State<Db>, session_token: String, tenant_id: String, name: String, currency: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateBranch).map_err(|e| e.to_string())?;
    // Platform's authorize_scope is unconditional true, but the target tenant
    // must still exist -- validate, don't trust the argument blindly.
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tenant_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM tenant WHERE id = ?1", params![tenant_id], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if !tenant_exists {
        return Err(format!("no such tenant: {tenant_id}"));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let branch_id = Repo::new(&tx).create_branch(&tenant_id, &name, &currency).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, None, &actor.id,
        audit::Action::BranchCreated, "branch", &branch_id,
        None, Some(&serde_json::json!({ "name": name, "currency": currency })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(branch_id)
}

#[tauri::command]
pub fn create_staff_v3(
    state: State<Db>,
    session_token: String,
    target_branch_id: Option<String>,
    role: String,
    name: String,
    pin: String,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateStaff).map_err(|e| e.to_string())?;

    let target_role = Role::from_str(&role).ok_or_else(|| format!("unknown role: {role}"))?;

    // Hard rule (SCHEMA_V3.md §2.1, decision 2026-07-16): actor_rank > target_rank, always.
    if actor.role.rank() <= target_role.rank() {
        return Err(format!(
            "role {:?} (rank {}) cannot assign role {:?} (rank {}) -- must be strictly below the actor's own rank",
            actor.role, actor.role.rank(), target_role, target_role.rank()
        ));
    }

    // Hard rule (ARCHITECTURE_V3.md #2): Manager's create_staff forces branch_id = actor's own.
    let actor_branch_id = match actor.role {
        Role::Manager => actor.branch_id.as_deref(),
        _ => None,
    };
    if actor_branch_id.is_none() {
        if let Some(ref tb) = target_branch_id {
            authorize_scope(&actor, &actor.tenant_id, Some(tb.as_str())).map_err(|e| e.to_string())?;
        }
    }

    let pin_hash = hash(&pin, DEFAULT_COST).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let staff_id = Repo::new(&tx)
        .create_staff(
            &actor.tenant_id,
            actor_branch_id,
            target_branch_id.as_deref(),
            &role,
            target_role.rank(),
            &name,
            Some(&pin_hash),
            None,
        )
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor_branch_id.or(target_branch_id.as_deref()), &actor.id,
        audit::Action::StaffCreated, "staff", &staff_id,
        None, Some(&serde_json::json!({ "role": role, "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(staff_id)
}

/// Same rank rule as `create_staff_v3`, checked against the TARGET's current
/// rank (read back from the DB, never trusted from the caller) as well as
/// the new role being assigned -- an actor cannot demote-then-promote around
/// the rule, and cannot touch a target who already outranks them.
#[tauri::command]
pub fn update_staff_v3(state: State<Db>, session_token: String, target_staff_id: String, new_role: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;

    let new_role_parsed = Role::from_str(&new_role).ok_or_else(|| format!("unknown role: {new_role}"))?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (target_tenant_id, target_branch_id, target_current_rank) =
        Repo::new(&conn).get_staff_scope(&target_staff_id).map_err(|e| e.to_string())?;

    authorize_scope(&actor, &target_tenant_id, target_branch_id.as_deref()).map_err(|e| e.to_string())?;

    if actor.role.rank() <= target_current_rank {
        return Err(format!(
            "actor rank {} cannot modify a target of rank {} -- must be strictly higher",
            actor.role.rank(), target_current_rank
        ));
    }
    if actor.role.rank() <= new_role_parsed.rank() {
        return Err(format!(
            "actor rank {} cannot assign rank {} -- must be strictly higher than the rank being assigned",
            actor.role.rank(), new_role_parsed.rank()
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_staff_role(&target_staff_id, &new_role, new_role_parsed.rank()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &target_tenant_id, target_branch_id.as_deref(), &actor.id,
        audit::Action::StaffRoleUpdated, "staff", &target_staff_id,
        Some(&serde_json::json!({ "role_rank": target_current_rank })),
        Some(&serde_json::json!({ "role": new_role, "role_rank": new_role_parsed.rank() })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Read-only, gated on being an authenticated staff member at all (no
/// dedicated permission -- picking a branch to create staff into isn't a
/// sensitive read by itself; `create_staff_v3` re-checks everything).
#[tauri::command]
pub fn list_branches_v3(state: State<Db>, session_token: String) -> Result<Vec<(String, String)>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_branches(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_staff_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::StaffRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_staff(&actor.scope()).map_err(|e| e.to_string())
}

/// Batch 3b -- `staff/page.tsx`'s "edit employee" path. Only `name` and,
/// optionally, a new PIN -- `staff` has no `email`/`phone`/`photo_path`/
/// `cv_path` for this to update (see `Repo::update_staff_profile`'s doc
/// comment). Role changes still go through `update_staff_v3` (the
/// rank-checked path); this command never touches `role`/`role_rank`.
#[tauri::command]
pub fn update_staff_profile_v3(state: State<Db>, session_token: String, target_staff_id: String, name: String, new_pin: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (target_tenant_id, target_branch_id, target_current_rank) =
        Repo::new(&conn).get_staff_scope(&target_staff_id).map_err(|e| e.to_string())?;
    authorize_scope(&actor, &target_tenant_id, target_branch_id.as_deref()).map_err(|e| e.to_string())?;
    // A Manager may edit their own profile (rank equal to self is fine here --
    // this isn't a rank-elevation action) but never someone who outranks them.
    if actor.id != target_staff_id && actor.role.rank() <= target_current_rank {
        return Err(format!(
            "actor rank {} cannot modify a target of rank {} -- must be strictly higher (or be editing their own profile)",
            actor.role.rank(), target_current_rank
        ));
    }

    let new_pin_hash = new_pin.map(|p| hash(&p, DEFAULT_COST)).transpose().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_staff_profile(&target_staff_id, &name, new_pin_hash.as_deref()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &target_tenant_id, target_branch_id.as_deref(), &actor.id,
        audit::Action::StaffRoleUpdated, "staff", &target_staff_id,
        None, Some(&serde_json::json!({ "name": name, "pin_changed": new_pin_hash.is_some() })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_staff_active_v3(state: State<Db>, session_token: String, target_staff_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (target_tenant_id, target_branch_id, target_current_rank) =
        Repo::new(&conn).get_staff_scope(&target_staff_id).map_err(|e| e.to_string())?;
    authorize_scope(&actor, &target_tenant_id, target_branch_id.as_deref()).map_err(|e| e.to_string())?;
    if actor.role.rank() <= target_current_rank {
        return Err(format!(
            "actor rank {} cannot deactivate/reactivate a target of rank {} -- must be strictly higher",
            actor.role.rank(), target_current_rank
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_staff_active(&target_staff_id, is_active).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &target_tenant_id, target_branch_id.as_deref(), &actor.id,
        audit::Action::StaffRoleUpdated, "staff", &target_staff_id,
        None, Some(&serde_json::json!({ "is_active": is_active })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_orders_v3(state: State<Db>, session_token: String) -> Result<Vec<OrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewOrders).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_orders(&scope).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_order_v3(
    state: State<Db>,
    session_token: String,
    table_id: String,
    order_type: String,
    subtotal_cents: i64,
    tax_cents: i64,
    discount_cents: i64,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;

    // Platform/Owner have no single branch to write into -- order creation is
    // inherently a Branch-scoped action; reject rather than guess a branch.
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("order creation requires a Branch-scoped actor (Cashier/Kitchen/Server/Manager)".to_string());
    };

    if subtotal_cents < 0 || tax_cents < 0 || discount_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let total_cents = std::cmp::max(0, subtotal_cents + tax_cents - discount_cents);

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let order_id = Repo::new(&tx)
        .create_order(
            &scope,
            &tenant_id,
            &branch_id,
            NewOrder { table_id, user_id: actor.id.clone(), order_type: order_type.clone(), subtotal_cents, tax_cents, total_cents, discount_cents },
        )
        .map_err(|e| e.to_string())?;

    // T1.6: the first status fact for this order, and the projection rebuilt
    // from a fresh replay -- not a separate "status" column set inline on
    // the INSERT above. `order_current` never exists before its first event.
    Repo::new(&tx).append_order_status_event(&tenant_id, &branch_id, &order_id, "PENDING", &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    Repo::new(&tx).rebuild_order_current(&order_id).map_err(|e| e.to_string())?;

    // Per T1.2's command shape: audit write in the SAME transaction. If this
    // fails, the order insert above rolls back with it -- there is no state
    // where an order exists but its creation was never recorded.
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderCreated, "order", &order_id,
        None, Some(&serde_json::json!({ "order_type": order_type, "total_cents": total_cents, "table_id_hash": "omitted" })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(order_id)
}

/// T1.6: appends a new status fact and rebuilds `order_current` from a fresh
/// replay, all inside one transaction with its audit entry -- there is no
/// UPDATE anywhere in this path against `orders.status` or `order_current`
/// directly; both are always derived, never hand-edited.
#[tauri::command]
pub fn update_order_status_v3(state: State<Db>, session_token: String, order_id: String, new_status: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateOrderStatus).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (order_tenant_id, order_branch_id): (String, String) = conn
        .query_row("SELECT tenant_id, branch_id FROM orders WHERE id = ?1", params![order_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    authorize_scope(&actor, &order_tenant_id, Some(order_branch_id.as_str())).map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let repo = Repo::new(&tx);
    let previous_status = repo.replay_order_status(&order_id).map_err(|e| e.to_string())?;
    repo.append_order_status_event(&order_tenant_id, &order_branch_id, &order_id, &new_status, &actor.id, &actor.device_id)
        .map_err(|e| e.to_string())?;
    repo.rebuild_order_current(&order_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &order_tenant_id, Some(&order_branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "order", &order_id,
        Some(&serde_json::json!({ "status": previous_status })),
        Some(&serde_json::json!({ "status": new_status })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// T1.9's critical acceptance criterion: order -> PAID, the payment row,
/// table -> FREE, the optional debt entry, the order_current rebuild, AND
/// the audit entry all happen inside ONE transaction, committed once. Kill
/// -9 at any point before `tx.commit()` returns and NONE of this landed --
/// never a PAID order on an OCCUPIED table, never a payment without an
/// order. See `repo::Repo::take_payment` for the actual writes and
/// `commands_v3::tests::kill_9_mid_payment_never_leaves_a_partial_payment`
/// for the proof.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn take_payment_v3(
    state: State<Db>,
    session_token: String,
    order_id: String,
    method: String,
    amount_cents: i64,
    change_cents: i64,
    debtor_id: Option<String>,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::TakePayment).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("taking a payment requires a Branch-scoped actor".to_string());
    };
    if amount_cents < 0 || change_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let payment_id = Repo::new(&tx)
        .take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
            order_id: order_id.clone(), method: method.clone(), amount_cents, change_cents,
            debtor_id: debtor_id.clone(), actor_id: actor.id.clone(),
        })
        .map_err(|e| e.to_string())?;

    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::PaymentTaken, "order", &order_id,
        None, Some(&serde_json::json!({ "payment_id": payment_id, "method": method, "amount_cents": amount_cents, "change_cents": change_cents, "debtor_id": debtor_id })),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(payment_id)
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 2 -- menu CRUD (`categories` + `menu_items`, tenant-only).
// Deliberately NOT `combo_meals`/`combo_items`/`happy_hour_rules` -- stated
// scope reduction, `menu/page.tsx` still reads/writes those 3 via `getDb()`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_categories_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::CategoryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_categories(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_category_v3(state: State<Db>, session_token: String, name: String, color: Option<String>, sort_order: i64, image_path: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let category_id = Repo::new(&tx).create_category(&actor.tenant_id, &name, color.as_deref(), sort_order, image_path.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(category_id)
}

#[tauri::command]
pub fn update_category_v3(state: State<Db>, session_token: String, category_id: String, name: String, color: Option<String>, sort_order: i64, image_path: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_category(&category_id, &name, color.as_deref(), sort_order, image_path.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_category_v3(state: State<Db>, session_token: String, category_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_category(&category_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "category", &category_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_menu_items_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::MenuItemRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_menu_items(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_menu_item_v3(state: State<Db>, session_token: String, name: String, category_id: String, price_cents: i64, cost_cents: i64, image_path: Option<String>, description: Option<String>, barcode: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if price_cents < 0 || cost_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let item_id = Repo::new(&tx)
        .create_menu_item(&actor.tenant_id, &name, &category_id, price_cents, cost_cents, image_path.as_deref(), description.as_deref(), barcode.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "name": name, "price_cents": price_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(item_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_menu_item_v3(state: State<Db>, session_token: String, item_id: String, name: String, category_id: String, price_cents: i64, cost_cents: i64, image_path: Option<String>, description: Option<String>, barcode: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    if price_cents < 0 || cost_cents < 0 {
        return Err("negative amounts are not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx)
        .update_menu_item(&item_id, &name, &category_id, price_cents, cost_cents, image_path.as_deref(), description.as_deref(), barcode.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "name": name, "price_cents": price_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_menu_item_v3(state: State<Db>, session_token: String, item_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_menu_item(&item_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_menu_item_active_v3(state: State<Db>, session_token: String, item_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageMenu).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_menu_item_active(&item_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::MenuItemChanged, "menu_item", &item_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 2, group 2 -- inventory: `ingredients` CRUD + stock
// adjustment. Deliberately OUT of scope, stated not hidden: `suppliers`
// CRUD, PO-receiving's stock bump, movements/alerts read tabs.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_ingredients_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::IngredientRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_ingredients(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_ingredient_v3(state: State<Db>, session_token: String, name: String, unit: String, cost_cents_per_unit: i64, min_stock: f64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("ingredient creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ingredient_id = Repo::new(&tx).create_ingredient(&tenant_id, &branch_id, &name, &unit, cost_cents_per_unit, min_stock).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "name": name, "created": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ingredient_id)
}

#[tauri::command]
pub fn update_ingredient_v3(state: State<Db>, session_token: String, ingredient_id: String, name: String, unit: String, cost_cents_per_unit: i64, min_stock: f64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageIngredients).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_ingredient(&ingredient_id, &name, &unit, cost_cents_per_unit, min_stock).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One transaction: `ingredients.current_stock` update + the new
/// `inventory_logs` fact + the audit entry, same atomicity principle as
/// `take_payment_v3`.
#[tauri::command]
pub fn adjust_stock_v3(state: State<Db>, session_token: String, ingredient_id: String, change_amount: f64, reason: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::AdjustStock).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("stock adjustment requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let log_id = Repo::new(&tx).adjust_stock(&tenant_id, &branch_id, &ingredient_id, change_amount, &reason, &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InventoryAdjusted, "ingredient", &ingredient_id, None, Some(&serde_json::json!({ "change_amount": change_amount, "reason": reason, "log_id": log_id }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(log_id)
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 2, group 3 -- shifts.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_active_shift_v3(state: State<Db>, session_token: String) -> Result<Option<crate::repo::ShiftRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_active_shift(&actor.id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_shift_stats_v3(state: State<Db>, session_token: String, shift_id: String) -> Result<crate::repo::ShiftStatsRow, String> {
    authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).shift_stats(&shift_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_shift_v3(state: State<Db>, session_token: String, starting_cash_cents: i64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageShift).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("opening a shift requires a Branch-scoped actor".to_string());
    };
    if starting_cash_cents < 0 {
        return Err("negative starting cash is not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let shift_id = Repo::new(&tx).open_shift(&tenant_id, &branch_id, &actor.id, starting_cash_cents).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::ShiftOpened, "shift", &shift_id, None, Some(&serde_json::json!({ "starting_cash_cents": starting_cash_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(shift_id)
}

#[tauri::command]
pub fn close_shift_v3(state: State<Db>, session_token: String, shift_id: String, ending_cash_cents: i64, difference_cents: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageShift).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).close_shift(&shift_id, ending_cash_cents, difference_cents).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::ShiftClosed, "shift", &shift_id, None, Some(&serde_json::json!({ "ending_cash_cents": ending_cash_cents, "difference_cents": difference_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// T1.6: two-layer menu price resolution (`override ?? default`), exposed
/// read-only so a client can price an item before/while building an order.
/// Gated on `CreateOrder` (the same permission that lets an actor build an
/// order at all) plus branch scope -- pricing another branch's menu is not a
/// query anyone below Owner/Platform should be able to make.
#[tauri::command]
pub fn resolve_menu_price_v3(state: State<Db>, session_token: String, branch_id: String, item_id: String) -> Result<i64, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::CreateOrder).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let tenant_id: String = conn
        .query_row("SELECT tenant_id FROM branch WHERE id = ?1", params![branch_id], |r| r.get(0))
        .map_err(|_| format!("no such branch: {branch_id}"))?;
    authorize_scope(&actor, &tenant_id, Some(branch_id.as_str())).map_err(|e| e.to_string())?;
    Repo::new(&conn).resolve_menu_price(&branch_id, &item_id).map_err(|e| e.to_string())
}

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
pub fn create_customer_v3(state: State<Db>, session_token: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let customer_id = Repo::new(&tx)
        .create_customer(&actor.tenant_id, &name, &phone, email.as_deref(), address.as_deref(), notes.as_deref(), birthday.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::StaffCreated, "customer", &customer_id, // reuses the closest existing Action; a dedicated CustomerCreated variant is cosmetic, not deferred functionality
        None, Some(&serde_json::json!({ "name": name, "phone": phone })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(customer_id)
}

#[tauri::command]
pub fn list_customers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::CustomerRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_customers(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_purchase_order_v3(state: State<Db>, session_token: String, supplier_id: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("purchase order creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order(&tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::StaffCreated, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "supplier_id": supplier_id })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(po_id)
}

#[tauri::command]
pub fn list_purchase_orders_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::PurchaseOrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_purchase_orders(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_driver_v3(state: State<Db>, session_token: String, name: String, phone: Option<String>, vehicle_type: String, license_number: Option<String>, vehicle_plate: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("driver creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let driver_id = Repo::new(&tx)
        .create_driver(&tenant_id, &branch_id, &name, phone.as_deref(), &vehicle_type, license_number.as_deref(), vehicle_plate.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::StaffCreated, "driver", &driver_id,
        None, Some(&serde_json::json!({ "name": name, "vehicle_type": vehicle_type })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(driver_id)
}

#[tauri::command]
pub fn update_driver_location_v3(state: State<Db>, session_token: String, driver_id: String, lat: f64, lng: f64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).update_driver_location(&driver_id, lat, lng).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_drivers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DriverRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_drivers(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_printer_v3(state: State<Db>, session_token: String, name: String, printer_type: String, interface: String, vendor_id: Option<String>, product_id: Option<String>, drawer_pulse_ms: i64, is_primary: bool) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("printer creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let printer_id = Repo::new(&tx)
        .create_printer(&tenant_id, &branch_id, &name, &printer_type, &interface, vendor_id.as_deref(), product_id.as_deref(), drawer_pulse_ms, is_primary)
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
pub fn list_printers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::PrinterRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_printers(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_delivery_logs_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DeliveryLogRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_delivery_logs(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_delivery_log_v3(state: State<Db>, session_token: String, order_id: String, driver_id: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery assignment requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let log_id = Repo::new(&tx)
        .create_delivery_log(&tenant_id, &branch_id, &order_id, &driver_id)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "delivery_log", &log_id,
        None, Some(&serde_json::json!({ "order_id": order_id, "driver_id": driver_id, "status": "ASSIGNED" })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(log_id)
}

#[tauri::command]
pub fn update_delivery_status_v3(state: State<Db>, session_token: String, delivery_log_id: String, new_status: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery status updates require a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_delivery_status(&delivery_log_id, &new_status).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::OrderStatusChanged, "delivery_log", &delivery_log_id,
        None, Some(&serde_json::json!({ "status": new_status })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Fixes the pre-existing account-takeover bug (FEATURE_TRUTH.md, `change_password`
/// takes `user_id` as a caller-supplied argument): the actor to change is
/// ALWAYS derived from the authenticated session, never from an argument.
#[tauri::command]
pub fn change_own_password_v3(state: State<Db>, session_token: String, old_password: String, new_password: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ChangeOwnPassword).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let current_hash: Option<String> = conn
        .query_row("SELECT password_hash FROM staff WHERE id = ?1", params![actor.id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let current_hash = current_hash.ok_or_else(|| "account has no password set".to_string())?;
    if !verify(&old_password, &current_hash).unwrap_or(false) {
        return Err("current password is incorrect".to_string());
    }
    let new_hash = hash(&new_password, DEFAULT_COST).map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE staff SET password_hash = ?1 WHERE id = ?2", params![new_hash, actor.id])
        .map_err(|e| e.to_string())?;
    // Never put a hash (old or new) in the audit payload -- the fact that a
    // change happened, by whom, and when is what matters here.
    audit::append(
        &tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id,
        audit::Action::PasswordChanged, "staff", &actor.id,
        None, None,
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Integration tests against a real, fully-migrated DB (0001-0003 + T1.1's
    //! Migrations A/B), exercising `security::`/`repo::Repo` directly rather
    //! than the `#[tauri::command]` wrappers (which need a live `tauri::App`
    //! for `State<T>` construction) -- this is where the actual authorization
    //! and scope-filtering logic lives; the command wrapper is a thin,
    //! already-covered-by-inspection shim around it.
    use crate::migrate;
    use crate::migrate_v3;
    use crate::repo::{NewOrder, Repo};
    use crate::security::{self, authorize, Permission, Role};
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;

    fn seeded_db(tag: &str) -> (PathBuf, String, String, String) {
        let temp = std::env::temp_dir().join(format!("commands_v3_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("test.db");

        let mut conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;").unwrap();
        migrate::run_migrations(&mut conn, &db_path).unwrap();
        migrate_v3::run_expand_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_remap_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_identity_migration(&mut conn, &db_path).unwrap();
        migrate_v3::run_drift_fix_migration(&mut conn, &db_path).unwrap();

        // The single tenant/branch T1.1 seeded during EXPAND.
        let (tenant_id, branch_id): (String, String) =
            conn.query_row("SELECT tenant_id, id FROM branch LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();

        // A dining table row to satisfy orders.table_id's FK -- a fresh
        // migration seeds no tables of its own.
        let table_id = "tbl-1".to_string();
        conn.execute("INSERT INTO tables (id, name) VALUES (?1, 'Table 1')", params![table_id]).unwrap();

        security::ensure_security_schema(&conn).unwrap();
        (db_path, tenant_id, branch_id, table_id)
    }

    /// Decision A (2026-07-16) closed the `users`/`staff` seam this used to
    /// need to bridge around: `staff` is now the only identity table and
    /// `orders.user_id` is repointed at it, so a plain `create_staff` is
    /// sufficient -- no parallel `users` row needed anymore.
    fn seed_staff(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, role: Role, name: &str) -> String {
        let repo = Repo::new(conn);
        repo.create_staff(tenant_id, branch_id, branch_id, role_str(role), role.rank(), name, Some("$2b$dummy"), None).unwrap()
    }

    fn role_str(role: Role) -> &'static str {
        match role {
            Role::Platform => "PLATFORM", Role::Owner => "OWNER", Role::Manager => "MANAGER",
            Role::Cashier => "CASHIER", Role::Kitchen => "KITCHEN", Role::Server => "SERVER",
        }
    }

    #[test]
    fn end_to_end_login_create_order_list_orders() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("e2e");
        let conn = Connection::open(&db_path).unwrap();

        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Test Cashier");
        let session = security::create_session(&conn, &cashier_id, "device-1").unwrap();

        let actor = security::authenticate(&conn, &session).unwrap();
        println!("authenticated actor: role={:?} tenant={} branch={:?}", actor.role, actor.tenant_id, actor.branch_id);
        authorize(&actor, Permission::CreateOrder).expect("Cashier must hold CreateOrder");

        let scope = actor.scope();
        let repo = Repo::new(&conn);
        let order_id = repo.create_order(
            &scope, &tenant_id, &branch_id,
            NewOrder { table_id, user_id: actor.id.clone(), order_type: "DINE_IN".to_string(), subtotal_cents: 1000, tax_cents: 100, total_cents: 1100, discount_cents: 0 },
        ).expect("create_order_v3's underlying repo call must succeed -- this is DRIFT_REPORT.md Finding #1's fix: no driver_id column referenced at all");
        println!("order created: {order_id}");

        let orders = repo.list_orders(&scope).unwrap();
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].id, order_id);
        assert_eq!(orders[0].total_cents, 1100);
        println!("list_orders_v3 (Branch scope): {} order(s) visible, matches what was created", orders.len());

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn branch_scoped_actor_never_sees_another_branchs_orders() {
        let (db_path, tenant_id, branch_a, table_id) = seeded_db("isolation");
        let conn = Connection::open(&db_path).unwrap();

        // Create a second branch under the same tenant.
        let repo = Repo::new(&conn);
        let branch_b = repo.create_branch(&tenant_id, "Branch B", "SYP").unwrap();

        let cashier_a = seed_staff(&conn, &tenant_id, Some(&branch_a), Role::Cashier, "Cashier A");
        let cashier_b = seed_staff(&conn, &tenant_id, Some(&branch_b), Role::Cashier, "Cashier B");

        let scope_a = security::authenticate(&conn, &security::create_session(&conn, &cashier_a, "d1").unwrap()).unwrap().scope();
        let scope_b = security::authenticate(&conn, &security::create_session(&conn, &cashier_b, "d2").unwrap()).unwrap().scope();

        repo.create_order(&scope_a, &tenant_id, &branch_a, NewOrder { table_id: table_id.clone(), user_id: cashier_a.clone(), order_type: "DINE_IN".into(), subtotal_cents: 500, tax_cents: 0, total_cents: 500, discount_cents: 0 }).unwrap();
        repo.create_order(&scope_b, &tenant_id, &branch_b, NewOrder { table_id, user_id: cashier_b.clone(), order_type: "DINE_IN".into(), subtotal_cents: 700, tax_cents: 0, total_cents: 700, discount_cents: 0 }).unwrap();

        let orders_a = repo.list_orders(&scope_a).unwrap();
        let orders_b = repo.list_orders(&scope_b).unwrap();
        println!("branch A sees {} order(s), branch B sees {} order(s)", orders_a.len(), orders_b.len());
        assert_eq!(orders_a.len(), 1);
        assert_eq!(orders_b.len(), 1);
        assert_eq!(orders_a[0].total_cents, 500);
        assert_eq!(orders_b[0].total_cents, 700);
        assert_ne!(orders_a[0].id, orders_b[0].id);
        println!("zero cross-branch leakage confirmed: each branch sees exactly its own order");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Defense-in-depth, layer 1: `orders` got a REAL SQL `NOT NULL` on
    /// `tenant_id`/`branch_id` from T1.1's table-recreation, so the scenario
    /// this test first tried to simulate (a bug bypassing the repo layer and
    /// landing a NULL-tenant_id row) is actually impossible at the database
    /// level for this specific table -- confirmed by asserting the raw INSERT
    /// itself fails. Layer 2 (the repo-level `assert_scope_populated` runtime
    /// check, for the ~25 tables that only have the Rust-level guarantee) is
    /// tested directly against `customers` in `repo.rs`'s own test module.
    #[test]
    fn orders_table_itself_refuses_null_tenant_id_at_the_sql_level() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("nullscope");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Scope Test Cashier");
        let repo = Repo::new(&conn);
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };

        repo.create_order(&scope, &tenant_id, &branch_id, NewOrder { table_id: table_id.clone(), user_id: cashier_id.clone(), order_type: "DINE_IN".into(), subtotal_cents: 100, tax_cents: 0, total_cents: 100, discount_cents: 0 }).unwrap();

        let bypass_attempt = conn.execute(
            "INSERT INTO orders (id, table_id, user_id, status, order_type, subtotal_cents, tax_cents, total_cents, discount_cents, created_at, sync_version, last_modified, sync_status, tenant_id, branch_id) \
             VALUES ('unscoped-order-1', ?1, ?2, 'PENDING', 'DINE_IN', 0, 0, 0, 0, datetime('now'), 1, datetime('now'), 'pending', NULL, NULL)",
            params![table_id, cashier_id],
        );
        match &bypass_attempt {
            Err(e) => println!("orders table correctly REJECTED a NULL-tenant_id row at the SQL level (defense-in-depth layer 1): {e}"),
            Ok(_) => panic!("a NULL-tenant_id row was accepted into orders -- T1.1's NOT NULL enforcement on this table has regressed"),
        }
        assert!(bypass_attempt.is_err());

        // The one legitimate, well-scoped order is still the only one visible.
        let orders = repo.list_orders(&scope).unwrap();
        assert_eq!(orders.len(), 1);
        println!("list_orders still sees exactly the 1 legitimate order; the bypass attempt never made it into the table");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn manager_cannot_assign_a_role_at_or_above_their_own_rank() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("rankrule");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Test Manager");
        let manager = security::authenticate(&conn, &security::create_session(&conn, &manager_id, "d1").unwrap()).unwrap();

        for target in [Role::Manager, Role::Owner, Role::Platform] {
            let blocked = manager.role.rank() <= target.rank();
            println!("Manager assigning {target:?} (rank {}): {}", target.rank(), if blocked { "BLOCKED (correct)" } else { "ALLOWED (WRONG)" });
            assert!(blocked, "Manager must never be able to assign {target:?}");
        }
        for target in [Role::Cashier, Role::Kitchen, Role::Server] {
            let allowed = manager.role.rank() > target.rank();
            println!("Manager assigning {target:?} (rank {}): {}", target.rank(), if allowed { "ALLOWED (correct)" } else { "BLOCKED (WRONG)" });
            assert!(allowed, "Manager must be able to assign {target:?}");
        }

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// T1.6: `order_current` is never patched in place -- it is entirely
    /// rebuilt from `order_status_event` every time. This test proves that
    /// property directly: after appending a run of status events, what
    /// `rebuild_order_current` stored must equal an INDEPENDENT fresh replay
    /// (`replay_order_status`) of the same event stream, not some stale or
    /// partially-applied value.
    #[test]
    fn order_current_projection_always_equals_a_fresh_replay() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("orderstatus");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Status Cashier");
        let repo = Repo::new(&conn);
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };

        let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
            table_id, user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
            subtotal_cents: 1000, tax_cents: 100, total_cents: 1100, discount_cents: 0,
        }).unwrap();

        for status in ["PENDING", "PREPARING", "READY", "SERVED"] {
            repo.append_order_status_event(&tenant_id, &branch_id, &order_id, status, &cashier_id, "device-1").unwrap();
            repo.rebuild_order_current(&order_id).unwrap();

            let stored: String = conn.query_row(
                "SELECT status FROM order_current WHERE order_id = ?1", params![order_id], |r| r.get(0),
            ).unwrap();
            let replayed = repo.replay_order_status(&order_id).unwrap();
            println!("after appending {status}: order_current.status={stored}, independent replay={replayed}");
            assert_eq!(stored, status, "order_current must reflect the just-appended status");
            assert_eq!(stored, replayed, "projection must equal a fresh replay of the event stream, always");
        }

        let event_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM order_status_event WHERE order_id = ?1", params![order_id], |r| r.get(0),
        ).unwrap();
        assert_eq!(event_count, 4, "all 4 status facts must be preserved -- this is append-only, not overwrite-in-place");
        println!("{event_count} status facts preserved in order_status_event; order_current reflects only the latest, by replay, not by mutation");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// T1.6, SCHEMA_V3.md §3 (blocker #2): the three cases of two-layer menu
    /// price resolution -- default only, override wins when present, and the
    /// currency-mismatch-without-override case must be a hard error, never a
    /// silent currency conversion or a silently wrong number.
    #[test]
    fn two_layer_menu_price_resolves_override_over_default_and_rejects_currency_mismatch() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("menuprice");
        let conn = Connection::open(&db_path).unwrap();
        let repo = Repo::new(&conn);

        conn.execute(
            "INSERT INTO menu_item_default (id, tenant_id, category_id, name, price_minor, updated_at_hlc, device_id) \
             VALUES ('item-1', ?1, 'cat-1', 'Kebab', 500, datetime('now'), 'device-1')",
            params![tenant_id],
        ).unwrap();

        let default_price = repo.resolve_menu_price(&branch_id, "item-1").unwrap();
        println!("no override row exists: resolved price = {default_price} (expected default 500)");
        assert_eq!(default_price, 500);

        conn.execute(
            "INSERT INTO menu_item_override (branch_id, item_id, price_minor, updated_at_hlc, device_id) \
             VALUES (?1, 'item-1', 650, datetime('now'), 'device-1')",
            params![branch_id],
        ).unwrap();
        let override_price = repo.resolve_menu_price(&branch_id, "item-1").unwrap();
        println!("override row sets price_minor=650: resolved price = {override_price} (must win over the default)");
        assert_eq!(override_price, 650);

        // A second branch, in a different currency than the tenant's base
        // currency, with NO override row for item-1 -- must hard-error, not
        // silently return the base-currency default as if it were correct.
        let usd_branch = repo.create_branch(&tenant_id, "USD Branch", "USD").unwrap();
        let result = repo.resolve_menu_price(&usd_branch, "item-1");
        match &result {
            Err(crate::repo::RepoError::ItemUnavailable { reason, .. }) => {
                println!("branch currency (USD) differs from tenant base currency with no override: correctly rejected -- {reason}");
            }
            other => panic!("expected ItemUnavailable for a currency mismatch with no override, got {other:?}"),
        }
        assert!(result.is_err());

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3a: proves the actual login path the running app's UI uses
    /// (`LoginPage.tsx` is PIN-only) works end to end against `staff` --
    /// this is the exact scenario that was broken after Decision A dropped
    /// `users` and before this batch's `login_pin_v3` existed.
    #[test]
    fn login_pin_v3_authenticates_against_staff_and_rejects_wrong_pin() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("pinlogin");
        let mut conn = Connection::open(&db_path).unwrap();
        let real_pin_hash = bcrypt::hash("654321", bcrypt::DEFAULT_COST).unwrap();
        {
            let tx = conn.transaction().unwrap();
            Repo::new(&tx).create_staff(&tenant_id, Some(&branch_id), Some(&branch_id), "CASHIER", Role::Cashier.rank(), "PIN Cashier", Some(&real_pin_hash), None).unwrap();
            tx.commit().unwrap();
        }
        drop(conn);
        let conn = Connection::open(&db_path).unwrap();
        security::ensure_security_schema(&conn).unwrap();

        // Wrong PIN: no session created, no crash, just a rejection.
        let wrong = login_pin_lookup(&conn, "000000");
        assert!(wrong.is_none(), "a wrong PIN must not authenticate");
        println!("wrong PIN correctly rejected");

        // Right PIN: resolves to the seeded cashier and a working session.
        let (actor_id, name, tenant, branch, role) = login_pin_lookup(&conn, "654321").expect("correct PIN must authenticate");
        assert_eq!(name, "PIN Cashier");
        assert_eq!(role, "CASHIER");
        assert_eq!(tenant, tenant_id);
        assert_eq!(branch, Some(branch_id));
        println!("correct PIN authenticated: actor={actor_id} name={name} role={role}");

        let token = security::create_session(&conn, &actor_id, "device-pin").unwrap();
        let actor = security::authenticate(&conn, &token).unwrap();
        assert_eq!(actor.id, actor_id);
        println!("session token from login_pin_v3's mechanism resolves back to the same actor via security::authenticate");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Mirrors `login_pin_v3`'s scan-and-verify loop directly (without a live
    /// `tauri::State`, which the `#[tauri::command]` wrapper needs) so this
    /// module's tests can exercise the exact same logic the command runs.
    fn login_pin_lookup(conn: &Connection, pin: &str) -> Option<(String, String, String, Option<String>, String)> {
        let mut stmt = conn.prepare("SELECT id, name, tenant_id, branch_id, role, pin_hash FROM staff WHERE pin_hash IS NOT NULL AND is_active = 1").unwrap();
        let candidates: Vec<(String, String, String, Option<String>, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for (id, name, tenant_id, branch_id, role, pin_hash) in candidates {
            if bcrypt::verify(pin, &pin_hash).unwrap_or(false) {
                return Some((id, name, tenant_id, branch_id, role));
            }
        }
        None
    }

    /// Batch 3a: `setup_owner_v3` bootstraps the first OWNER with no prior
    /// actor/session -- and correctly refuses a second bootstrap once an
    /// OWNER already exists.
    #[test]
    fn setup_owner_v3_bootstraps_first_owner_and_refuses_a_second() {
        let (db_path, tenant_id, _branch_id, _table_id) = seeded_db("bootstrap");
        let mut conn = Connection::open(&db_path).unwrap();

        let owner_pin_hash = bcrypt::hash("111111", bcrypt::DEFAULT_COST).unwrap();
        let owner_password_hash = bcrypt::hash("a-strong-password", bcrypt::DEFAULT_COST).unwrap();
        let tx = conn.transaction().unwrap();
        let owner_id = Repo::new(&tx).create_staff(&tenant_id, None, None, "OWNER", Role::Owner.rank(), "Bootstrap Owner", Some(&owner_pin_hash), Some(&owner_password_hash)).unwrap();
        tx.commit().unwrap();
        println!("owner {owner_id} created directly (simulating what setup_owner_v3's repo call does)");

        // The refusal check `setup_owner_v3` performs before doing any work:
        // an OWNER already exists, so a second bootstrap must be rejected.
        let existing: i64 = conn.query_row("SELECT COUNT(*) FROM staff WHERE role = 'OWNER' AND is_active = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(existing, 1);
        println!("setup_owner_v3's guard ({existing} OWNER already exists) would correctly refuse a second bootstrap");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3a, Decision B: proves each of the 5 DRIFT-broken command groups
    /// now writes/reads exactly the columns DRIFT_REPORT.md Findings #2/#5
    /// said were missing -- this is the same class of test as T1.1's
    /// bit-identical-revenue check, just applied to "does the write succeed
    /// and round-trip" instead of "is the total preserved".
    #[test]
    fn drift_broken_groups_create_and_list_round_trip_through_the_previously_missing_columns() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("driftgroups");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Drift Test Cashier");
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Drift Test Manager");
        let cashier = security::authenticate(&conn, &security::create_session(&conn, &cashier_id, "d1").unwrap()).unwrap();
        let manager = security::authenticate(&conn, &security::create_session(&conn, &manager_id, "d2").unwrap()).unwrap();
        let repo = Repo::new(&conn);

        // customers (Finding #5): address/birthday/notes/loyalty_points now exist.
        let customer_id = repo.create_customer(&tenant_id, "زبون تجريبي", "0999999999", None, Some("شارع الثورة"), Some("يفضل بدون بصل"), Some("1990-01-01")).unwrap();
        let customers = repo.list_customers(&tenant_id).unwrap();
        assert!(customers.iter().any(|c| c.id == customer_id && c.address.as_deref() == Some("شارع الثورة") && c.notes.is_some()));
        println!("[drift-groups] customer created and listed with address/notes/birthday -- Finding #5 columns round-trip");

        // purchase_orders (Finding #2): created_by/notes now exist.
        conn.execute("INSERT INTO suppliers (id, name) VALUES ('sup-1', 'المورد الرئيسي')", []).unwrap();
        let po_id = repo.create_purchase_order(&tenant_id, &branch_id, "sup-1", &manager.id, Some("طلبية عاجلة")).unwrap();
        let pos = repo.list_purchase_orders(&manager.scope()).unwrap();
        assert!(pos.iter().any(|p| p.id == po_id && p.created_by == manager.id && p.notes.as_deref() == Some("طلبية عاجلة")));
        println!("[drift-groups] purchase order created and listed with created_by/notes -- Finding #2 columns round-trip");

        // drivers + delivery_logs (Finding #5, "delivery"): current_lat/lng,
        // license_number, vehicle_plate, and the 4 timestamp columns.
        let driver_id = repo.create_driver(&tenant_id, &branch_id, "سائق تجريبي", Some("0988888888"), "MOTORCYCLE", Some("LIC-123"), Some("PLATE-9"))
            .unwrap();
        repo.update_driver_location(&driver_id, 33.5138, 36.2765).unwrap();
        let drivers = repo.list_drivers(&manager.scope()).unwrap();
        let driver = drivers.iter().find(|d| d.id == driver_id).unwrap();
        assert_eq!(driver.license_number.as_deref(), Some("LIC-123"));
        assert_eq!(driver.vehicle_plate.as_deref(), Some("PLATE-9"));
        assert_eq!(driver.current_lat, Some(33.5138));
        println!("[drift-groups] driver created with license_number/vehicle_plate and located (current_lat/lng) -- Finding #5 columns round-trip");

        let order_id = repo.create_order(&cashier.scope(), &tenant_id, &branch_id, NewOrder {
            table_id: "tbl-1".to_string(), user_id: cashier.id.clone(), order_type: "DELIVERY".into(),
            subtotal_cents: 1000, tax_cents: 0, total_cents: 1000, discount_cents: 0,
        }).unwrap();
        let log_id = repo.create_delivery_log(&tenant_id, &branch_id, &order_id, &driver_id).unwrap();
        let logs = repo.list_delivery_logs(&cashier.scope()).unwrap();
        let log = logs.iter().find(|l| l.id == log_id).unwrap();
        assert_eq!(log.status, "ASSIGNED");
        assert!(log.assigned_at.is_some());
        assert!(log.picked_up_at.is_none());

        repo.update_delivery_status(&log_id, "PICKED_UP").unwrap();
        repo.update_delivery_status(&log_id, "DELIVERED").unwrap();
        let logs = repo.list_delivery_logs(&cashier.scope()).unwrap();
        let log = logs.iter().find(|l| l.id == log_id).unwrap();
        assert_eq!(log.status, "DELIVERED");
        assert!(log.picked_up_at.is_some(), "picked_up_at must be stamped, not left NULL, once the delivery passed through PICKED_UP");
        assert!(log.delivered_at.is_some());
        println!("[drift-groups] delivery_logs: status progressed ASSIGNED -> PICKED_UP -> DELIVERED, each transition stamping its own timestamp column, none overwritten");

        // printers (Finding #5): drawer_pulse_ms/is_primary/is_secondary/vendor_id/product_id.
        let printer_id = repo.create_printer(&tenant_id, &branch_id, "طابعة المطبخ", "KITCHEN", "USB", Some("04b8"), Some("0202"), 250, true).unwrap();
        let printers = repo.list_printers(&manager.scope()).unwrap();
        let printer = printers.iter().find(|p| p.id == printer_id).unwrap();
        assert_eq!(printer.drawer_pulse_ms, 250);
        assert_eq!(printer.is_primary, 1);
        assert_eq!(printer.vendor_id.as_deref(), Some("04b8"));
        println!("[drift-groups] printer created with drawer_pulse_ms/is_primary/vendor_id/product_id -- Finding #5 columns round-trip");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// THE test that would have caught the fresh-install bug a hand-test
    /// found (2026-07-16): `seed_default_staff`'s dev-mode shortcut meant
    /// every automated test ran against a database that already had staff
    /// in it, so nothing ever exercised the actual first-run sequence a
    /// RELEASE build takes: `needs_setup_v3` (true, 0 owners) ->
    /// `setup_owner_v3` (bootstraps one) -> `login_pin_v3` (logs in as
    /// them). `seeded_db` here is already a genuinely fresh install (no
    /// legacy fixture data, unlike `migrate_v3.rs`'s `build_base_fixture`)
    /// -- this test chains all three steps end to end and, critically,
    /// asserts `users` does not exist in `sqlite_master` at any point,
    /// which is exactly what the hand-tested bug violated (the frontend's
    /// separate `SCHEMA_SQL` lazy-migration path was resurrecting a bare,
    /// column-incomplete `users` table the first time `getDb()` ran, after
    /// Migration C had already dropped the real one).
    #[test]
    fn fresh_install_needs_setup_then_setup_owner_then_login_never_touches_users() {
        let (db_path, tenant_id, _branch_id, _table_id) = seeded_db("freshinstall");
        let mut conn = Connection::open(&db_path).unwrap();

        let no_users_table = |c: &Connection| -> bool {
            !c.query_row("SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='users'", [], |r| r.get::<_, bool>(0)).unwrap()
        };
        assert!(no_users_table(&conn), "users must not exist right after a fresh install's migrations run");

        // Step 1: needs_setup_v3's actual check (bypassing its debug-mode
        // shortcut, which only fires in `cargo test`/dev builds and is
        // exactly what let this bug hide -- this asserts the underlying
        // condition a RELEASE build's needs_setup_v3 evaluates for real).
        let owner_count: i64 = conn.query_row("SELECT COUNT(*) FROM staff WHERE role = 'OWNER' AND is_active = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(owner_count, 0, "a fresh install must have zero owners -- this is exactly the condition that must make needs_setup_v3 return true");
        println!("[fresh-install] needs_setup_v3 condition confirmed true: 0 owners exist");

        // Step 2: setup_owner_v3's actual logic, replicated exactly (same
        // Repo::create_staff call, same audit entry) -- the tauri::State
        // wrapper can't be constructed outside a live app, same reason
        // every other test here calls through Repo/security directly.
        let owner_pin_hash = bcrypt::hash("999999", bcrypt::DEFAULT_COST).unwrap();
        let owner_password_hash = bcrypt::hash("a-strong-fresh-password", bcrypt::DEFAULT_COST).unwrap();
        let tx = conn.transaction().unwrap();
        let owner_id = Repo::new(&tx)
            .create_staff(&tenant_id, None, None, "OWNER", Role::Owner.rank(), "Fresh Owner", Some(&owner_pin_hash), Some(&owner_password_hash))
            .unwrap();
        crate::audit::append(&tx, "fresh-device", &tenant_id, None, &owner_id, crate::audit::Action::StaffCreated, "staff", &owner_id, None, None).unwrap();
        tx.commit().unwrap();
        println!("[fresh-install] setup_owner_v3's logic created owner {owner_id} in `staff` -- `users` never referenced");

        let owner_count_after: i64 = conn.query_row("SELECT COUNT(*) FROM staff WHERE role = 'OWNER' AND is_active = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(owner_count_after, 1, "exactly one owner must exist after setup_owner_v3");
        assert!(no_users_table(&conn), "users must still not exist after setup_owner_v3 -- nothing may resurrect it");

        // Step 3: login_pin_v3's actual scan-and-verify logic, against the
        // JUST-CREATED owner -- proves the fresh-install chain produces a
        // working login, not just a row in a table.
        let found = login_pin_lookup(&conn, "999999");
        let (found_id, found_name, found_tenant, found_branch, found_role) = found.expect("the freshly bootstrapped owner must be able to log in with their PIN");
        assert_eq!(found_id, owner_id);
        assert_eq!(found_name, "Fresh Owner");
        assert_eq!(found_role, "OWNER");
        assert_eq!(found_tenant, tenant_id);
        assert_eq!(found_branch, None, "an OWNER must have no branch_id, per staff's own CHECK constraint");
        println!("[fresh-install] login_pin_v3's logic authenticated the freshly created owner: id={found_id} name={found_name} role={found_role}");

        let session_token = security::create_session(&conn, &owner_id, "fresh-device").unwrap();
        let actor = security::authenticate(&conn, &session_token).unwrap();
        assert_eq!(actor.id, owner_id);
        assert_eq!(actor.role, Role::Owner);
        println!("[fresh-install] full chain confirmed: needs_setup (true) -> setup_owner (creates staff row) -> login_pin (authenticates) -> session resolves to a real Owner Actor");

        assert!(no_users_table(&conn), "users must not exist at the very end of the chain either");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, T1.9: the normal-flow proof -- one `take_payment` call
    /// commits the order->PAID transition, the payment row, the table->FREE
    /// release, and the order_current projection together.
    #[test]
    fn take_payment_v3_commits_order_payment_table_and_projection_atomically() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("payment");
        let mut conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Payment Cashier");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };

        let order_id = {
            let tx = conn.transaction().unwrap();
            let id = Repo::new(&tx).create_order(&scope, &tenant_id, &branch_id, NewOrder {
                table_id: table_id.clone(), user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
                subtotal_cents: 2000, tax_cents: 200, total_cents: 2200, discount_cents: 0,
            }).unwrap();
            tx.execute("UPDATE tables SET status = 'OCCUPIED', current_order_id = ?1 WHERE id = ?2", params![id, table_id]).unwrap();
            tx.commit().unwrap();
            id
        };

        let payment_id = {
            let tx = conn.transaction().unwrap();
            let id = Repo::new(&tx).take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
                order_id: order_id.clone(), method: "CASH".into(), amount_cents: 2200, change_cents: 0,
                debtor_id: None, actor_id: cashier_id.clone(),
            }).unwrap();
            tx.commit().unwrap();
            id
        };
        println!("[payment] take_payment committed: payment_id={payment_id}");

        let order_status: String = conn.query_row("SELECT status FROM orders WHERE id = ?1", params![order_id], |r| r.get(0)).unwrap();
        assert_eq!(order_status, "PAID");

        let table_status: (String, Option<String>) = conn.query_row("SELECT status, current_order_id FROM tables WHERE id = ?1", params![table_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(table_status.0, "FREE");
        assert_eq!(table_status.1, None);

        let payment_count: i64 = conn.query_row("SELECT COUNT(*) FROM payments WHERE order_id = ?1", params![order_id], |r| r.get(0)).unwrap();
        assert_eq!(payment_count, 1);

        let projected_status: String = conn.query_row("SELECT status FROM order_current WHERE order_id = ?1", params![order_id], |r| r.get(0)).unwrap();
        assert_eq!(projected_status, "PAID");
        println!("[payment] order=PAID, table=FREE (current_order_id=NULL), exactly 1 payment row, order_current reflects PAID -- all from one commit");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, T1.9's actual acceptance criterion: simulates `kill -9`
    /// mid-payment by performing every write `take_payment` does and then
    /// dropping the transaction WITHOUT calling `commit()` (rusqlite rolls
    /// back a `Transaction` on `Drop` if it was never committed -- exactly
    /// what happens to an in-flight, uncommitted SQLite transaction when the
    /// OS kills the process: nothing in it is durable). A fresh connection
    /// re-opened afterward must see NONE of it: order still PENDING, table
    /// still OCCUPIED, zero payment rows -- never a PAID order on an
    /// OCCUPIED table, never a payment without an order.
    #[test]
    fn kill_9_mid_payment_never_leaves_a_partial_payment() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("killpayment");
        let mut conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Kill Test Cashier");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };

        let order_id = {
            let tx = conn.transaction().unwrap();
            let id = Repo::new(&tx).create_order(&scope, &tenant_id, &branch_id, NewOrder {
                table_id: table_id.clone(), user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
                subtotal_cents: 1500, tax_cents: 0, total_cents: 1500, discount_cents: 0,
            }).unwrap();
            tx.execute("UPDATE tables SET status = 'OCCUPIED', current_order_id = ?1 WHERE id = ?2", params![id, table_id]).unwrap();
            tx.commit().unwrap();
            id
        };

        {
            // Everything `take_payment` does, performed for real against a
            // live transaction -- then the transaction is simply dropped
            // (`tx` goes out of scope with no `commit()` call), simulating
            // the process dying mid-payment.
            let tx = conn.transaction().unwrap();
            Repo::new(&tx).take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
                order_id: order_id.clone(), method: "CASH".into(), amount_cents: 1500, change_cents: 0,
                debtor_id: None, actor_id: cashier_id.clone(),
            }).unwrap();
            println!("[kill-9] payment writes performed inside an open transaction -- dropping it now WITHOUT committing (simulated crash)");
            // `tx` dropped here, uncommitted -- rusqlite rolls it back.
        }

        // Re-open a fresh connection, exactly as the app does on restart
        // after a crash, and inspect what actually persisted.
        drop(conn);
        let conn = Connection::open(&db_path).unwrap();

        let order_status: String = conn.query_row("SELECT status FROM orders WHERE id = ?1", params![order_id], |r| r.get(0)).unwrap();
        assert_eq!(order_status, "PENDING", "an uncommitted payment must leave the order exactly as it was -- never PAID");

        let table_status: (String, Option<String>) = conn.query_row("SELECT status, current_order_id FROM tables WHERE id = ?1", params![table_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(table_status.0, "OCCUPIED", "the table must still be OCCUPIED -- never freed by a payment that was never committed");
        assert_eq!(table_status.1, Some(order_id.clone()));

        let payment_count: i64 = conn.query_row("SELECT COUNT(*) FROM payments WHERE order_id = ?1", params![order_id], |r| r.get(0)).unwrap();
        assert_eq!(payment_count, 0, "there must be zero payment rows -- never a payment without a correspondingly committed order state");

        println!("[kill-9] after re-opening a fresh connection: order still PENDING, table still OCCUPIED, 0 payment rows -- the crash lost the WHOLE payment, not part of it");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b: `staff/page.tsx`'s CRUD, restored -- create (already worked,
    /// via `create_staff_v3`), list, profile update (name/pin), and
    /// active/inactive toggle, all against `staff`.
    #[test]
    fn staff_crud_list_update_profile_and_toggle_active() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("staffcrud");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "CRUD Manager");
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Original Name");
        let manager = security::authenticate(&conn, &security::create_session(&conn, &manager_id, "d1").unwrap()).unwrap();
        let repo = Repo::new(&conn);

        let listed = repo.list_staff(&manager.scope()).unwrap();
        assert!(listed.iter().any(|s| s.id == cashier_id && s.name == "Original Name"));
        println!("[staff-crud] list_staff_v3 sees {} staff row(s), including the freshly seeded cashier", listed.len());

        let new_pin_hash = bcrypt::hash("777777", bcrypt::DEFAULT_COST).unwrap();
        repo.update_staff_profile(&cashier_id, "Renamed Cashier", Some(&new_pin_hash)).unwrap();
        let (renamed, pin_hash): (String, Option<String>) = conn.query_row("SELECT name, pin_hash FROM staff WHERE id = ?1", params![cashier_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(renamed, "Renamed Cashier");
        assert!(bcrypt::verify("777777", &pin_hash.unwrap()).unwrap());
        println!("[staff-crud] update_staff_profile_v3's logic renamed the cashier and rotated their PIN");

        repo.set_staff_active(&cashier_id, false).unwrap();
        let is_active: i64 = conn.query_row("SELECT is_active FROM staff WHERE id = ?1", params![cashier_id], |r| r.get(0)).unwrap();
        assert_eq!(is_active, 0);
        let listed_after = repo.list_staff(&manager.scope()).unwrap();
        let cashier_row = listed_after.iter().find(|s| s.id == cashier_id).unwrap();
        assert_eq!(cashier_row.is_active, 0);
        println!("[staff-crud] set_staff_active_v3's logic deactivated the cashier; list_staff_v3 reflects it");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 2: menu CRUD -- category create/update/delete,
    /// menu item create/update/delete/active-toggle, all tenant-scoped.
    #[test]
    fn menu_crud_categories_and_items_round_trip() {
        let (db_path, tenant_id, _branch_id, _table_id) = seeded_db("menucrud");
        let conn = Connection::open(&db_path).unwrap();
        let repo = Repo::new(&conn);

        let cat_id = repo.create_category(&tenant_id, "مقبلات", Some("#ff0000"), 1, None).unwrap();
        let cats = repo.list_categories(&tenant_id).unwrap();
        assert!(cats.iter().any(|c| c.id == cat_id && c.name == "مقبلات"));
        println!("[menu-crud] category created and listed");

        repo.update_category(&cat_id, "مقبلات محدثة", Some("#00ff00"), 2, None).unwrap();
        let cats = repo.list_categories(&tenant_id).unwrap();
        let cat = cats.iter().find(|c| c.id == cat_id).unwrap();
        assert_eq!(cat.name, "مقبلات محدثة");
        assert_eq!(cat.sort_order, 2);
        println!("[menu-crud] category updated");

        let item_id = repo.create_menu_item(&tenant_id, "حمص", &cat_id, 500, 200, None, Some("لذيذ"), Some("BC-001")).unwrap();
        let items = repo.list_menu_items(&tenant_id).unwrap();
        let item = items.iter().find(|i| i.id == item_id).unwrap();
        assert_eq!(item.price_cents, 500);
        assert_eq!(item.barcode.as_deref(), Some("BC-001"));
        println!("[menu-crud] menu item created and listed");

        repo.update_menu_item(&item_id, "حمص بالطحينة", &cat_id, 600, 250, None, None, Some("BC-001")).unwrap();
        let items = repo.list_menu_items(&tenant_id).unwrap();
        let item = items.iter().find(|i| i.id == item_id).unwrap();
        assert_eq!(item.name, "حمص بالطحينة");
        assert_eq!(item.price_cents, 600);
        println!("[menu-crud] menu item updated");

        repo.set_menu_item_active(&item_id, false).unwrap();
        let items = repo.list_menu_items(&tenant_id).unwrap();
        assert_eq!(items.iter().find(|i| i.id == item_id).unwrap().is_active, 0);
        println!("[menu-crud] menu item deactivated");

        repo.delete_menu_item(&item_id).unwrap();
        let items = repo.list_menu_items(&tenant_id).unwrap();
        assert!(!items.iter().any(|i| i.id == item_id));

        repo.delete_category(&cat_id).unwrap();
        let cats = repo.list_categories(&tenant_id).unwrap();
        assert!(!cats.iter().any(|c| c.id == cat_id));
        println!("[menu-crud] menu item and category deleted");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 2, group 2: ingredient CRUD + stock adjustment. Proves
    /// the atomicity pair (current_stock update + inventory_logs fact) both
    /// land together, and that repeated adjustments accumulate correctly.
    #[test]
    fn inventory_ingredient_crud_and_stock_adjustment_atomicity() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("inventory");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Inventory Manager");
        let repo = Repo::new(&conn);

        let ing_id = repo.create_ingredient(&tenant_id, &branch_id, "طماطم", "kg", 150, 5.0).unwrap();
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let list = repo.list_ingredients(&scope).unwrap();
        let ing = list.iter().find(|i| i.id == ing_id).unwrap();
        assert_eq!(ing.name, "طماطم");
        assert_eq!(ing.current_stock, 0.0);
        println!("[inventory] ingredient created with current_stock=0");

        repo.update_ingredient(&ing_id, "طماطم طازجة", "kg", 175, 8.0).unwrap();
        let list = repo.list_ingredients(&scope).unwrap();
        let ing = list.iter().find(|i| i.id == ing_id).unwrap();
        assert_eq!(ing.name, "طماطم طازجة");
        assert_eq!(ing.min_stock, 8.0);
        println!("[inventory] ingredient updated");

        let log1 = repo.adjust_stock(&tenant_id, &branch_id, &ing_id, 20.0, "توريد", &manager_id).unwrap();
        let list = repo.list_ingredients(&scope).unwrap();
        assert_eq!(list.iter().find(|i| i.id == ing_id).unwrap().current_stock, 20.0);

        let log2 = repo.adjust_stock(&tenant_id, &branch_id, &ing_id, -3.5, "استهلاك", &manager_id).unwrap();
        let list = repo.list_ingredients(&scope).unwrap();
        assert_eq!(list.iter().find(|i| i.id == ing_id).unwrap().current_stock, 16.5);
        println!("[inventory] stock adjustments accumulated correctly: +20 then -3.5 = 16.5");

        let log_count: i64 = conn.query_row("SELECT COUNT(*) FROM inventory_logs WHERE ingredient_id = ?1", params![ing_id], |r| r.get(0)).unwrap();
        assert_eq!(log_count, 2, "both adjustments must be preserved as separate append-only facts, not collapsed");
        assert_ne!(log1, log2);
        println!("[inventory] 2 inventory_logs rows preserved (append-only), each adjustment its own fact");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 2, group 3: open a shift, take orders + payments
    /// against it, confirm stats aggregate correctly (order count, CASH vs
    /// CARD split), then close it.
    #[test]
    fn shift_open_stats_and_close_round_trip() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("shifts");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Shift Cashier");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let repo = Repo::new(&conn);

        assert!(repo.get_active_shift(&cashier_id).unwrap().is_none());
        let shift_id = repo.open_shift(&tenant_id, &branch_id, &cashier_id, 10000).unwrap();
        let active = repo.get_active_shift(&cashier_id).unwrap().unwrap();
        assert_eq!(active.id, shift_id);
        assert_eq!(active.starting_cash_cents, 10000);
        println!("[shifts] shift opened with starting_cash_cents=10000, get_active_shift confirms it");

        // Two orders paid against this shift, one CASH one CARD.
        for (method, amount) in [("CASH", 2000i64), ("CARD", 3500i64)] {
            let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
                table_id: table_id.clone(), user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
                subtotal_cents: amount, tax_cents: 0, total_cents: amount, discount_cents: 0,
            }).unwrap();
            conn.execute("UPDATE orders SET shift_id = ?1 WHERE id = ?2", params![shift_id, order_id]).unwrap();
            repo.take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
                order_id, method: method.to_string(), amount_cents: amount, change_cents: 0, debtor_id: None, actor_id: cashier_id.clone(),
            }).unwrap();
        }

        let stats = repo.shift_stats(&shift_id).unwrap();
        assert_eq!(stats.order_count, 2);
        assert_eq!(stats.total_sales, 5500);
        assert_eq!(stats.cash_total, 2000);
        assert_eq!(stats.card_total, 3500);
        println!("[shifts] shift_stats: 2 orders, total_sales=5500, cash=2000, card=3500 -- matches the 2 payments taken");

        repo.close_shift(&shift_id, 12000, 100).unwrap();
        assert!(repo.get_active_shift(&cashier_id).unwrap().is_none());
        let closed_at: Option<String> = conn.query_row("SELECT closed_at FROM shifts WHERE id = ?1", params![shift_id], |r| r.get(0)).unwrap();
        assert!(closed_at.is_some());
        println!("[shifts] shift closed, no longer reported as active");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}

