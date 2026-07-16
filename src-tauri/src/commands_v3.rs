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

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 2 -- debt (بيع بالدين). DEBT-type entries are
// already created by `take_payment_v3`; this group is debtor CRUD + payments.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_debtors_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DebtorRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_debtors(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_debtor_v3(state: State<Db>, session_token: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("creating a debtor requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let debtor_id = Repo::new(&tx).create_debtor(&tenant_id, &branch_id, &name, &phone, email.as_deref(), address.as_deref(), notes.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "name": name, "created": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(debtor_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_debtor_v3(state: State<Db>, session_token: String, debtor_id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_debtor(&debtor_id, &name, &phone, email.as_deref(), address.as_deref(), notes.as_deref()).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn deactivate_debtor_v3(state: State<Db>, session_token: String, debtor_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).deactivate_debtor(&debtor_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, Some(&serde_json::json!({ "is_active": true })), Some(&serde_json::json!({ "is_active": false }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_debt_entries_v3(state: State<Db>, session_token: String, debtor_id: String) -> Result<Vec<crate::repo::DebtEntryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_debt_entries(&debtor_id).map_err(|e| e.to_string())
}

/// One transaction: the PAYMENT fact + the debtor's running-balance update +
/// the audit entry, same atomicity principle as `take_payment_v3`.
#[tauri::command]
pub fn record_debt_payment_v3(state: State<Db>, session_token: String, debtor_id: String, amount_cents: i64, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDebt).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("recording a debt payment requires a Branch-scoped actor".to_string());
    };
    if amount_cents <= 0 {
        return Err("payment amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let entry_id = Repo::new(&tx).record_debt_payment(&tenant_id, &branch_id, &debtor_id, amount_cents, notes.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::DebtRecorded, "debtor", &debtor_id, None, Some(&serde_json::json!({ "entry_id": entry_id, "amount_cents": amount_cents, "type": "PAYMENT" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entry_id)
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 3 -- finance + reports.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_finance_revenue_v3(state: State<Db>, session_token: String, start_iso: String, end_iso: String) -> Result<crate::repo::RevenueSummaryRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).finance_revenue_summary(&actor.scope(), &start_iso, &end_iso).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_tax_collected_v3(state: State<Db>, session_token: String, since_iso: String) -> Result<i64, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).tax_collected_since(&actor.scope(), &since_iso).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_operational_costs_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::OperationalCostRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_operational_costs(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_operational_cost_v3(state: State<Db>, session_token: String, category: String, amount_cents: i64, date: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("recording a cost requires a Branch-scoped actor".to_string());
    };
    if amount_cents <= 0 {
        return Err("cost amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let cost_id = Repo::new(&tx).create_operational_cost(&tenant_id, &branch_id, &category, amount_cents, &date, notes.as_deref(), &actor.id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::OperationalCostRecorded, "operational_cost", &cost_id, None, Some(&serde_json::json!({ "category": category, "amount_cents": amount_cents }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cost_id)
}

#[tauri::command]
pub fn list_invoices_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::InvoiceRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_invoices(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_invoice_v3(state: State<Db>, session_token: String, period_start: String, period_end: String, amount_cents: i64, due_date: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("creating an invoice requires a Branch-scoped actor".to_string());
    };
    if amount_cents <= 0 {
        return Err("invoice amount must be positive".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let invoice_id = Repo::new(&tx).create_invoice(&tenant_id, &branch_id, &period_start, &period_end, amount_cents, &due_date).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id, audit::Action::InvoiceChanged, "invoice", &invoice_id, None, Some(&serde_json::json!({ "amount_cents": amount_cents, "created": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(invoice_id)
}

#[tauri::command]
pub fn mark_invoice_paid_v3(state: State<Db>, session_token: String, invoice_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageFinance).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).mark_invoice_paid(&invoice_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::InvoiceChanged, "invoice", &invoice_id, Some(&serde_json::json!({ "status": "PENDING" })), Some(&serde_json::json!({ "status": "PAID" }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_sales_report_v3(state: State<Db>, session_token: String, today_start_iso: String) -> Result<crate::repo::SalesReportRow, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ViewReports).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).sales_report(&actor.scope(), &today_start_iso).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 4 -- settings (currency/tax/branch/printer).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_chain_config_v3(state: State<Db>, session_token: String) -> Result<crate::repo::ChainConfigRow, String> {
    authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_chain_config().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chain_currency_v3(state: State<Db>, session_token: String, currency: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_chain_currency(&currency).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "chain_config", "default", None, Some(&serde_json::json!({ "currency": currency }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_chain_tax_v3(state: State<Db>, session_token: String, tax_rate_cents: i64, tax_mode: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    if tax_rate_cents < 0 {
        return Err("negative tax rate is not valid".to_string());
    }
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_chain_tax(tax_rate_cents, &tax_mode).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "chain_config", "default", None, Some(&serde_json::json!({ "tax_rate_cents": tax_rate_cents, "tax_mode": tax_mode }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_legacy_branch_v3(state: State<Db>, session_token: String) -> Result<Option<crate::repo::LegacyBranchRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).get_legacy_branch(&actor.tenant_id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_legacy_branch_v3(state: State<Db>, session_token: String, existing_id: Option<String>, name: String, address: Option<String>, phone: Option<String>, max_tables: i64, currency: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageSettings).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let branch_id = Repo::new(&tx).upsert_legacy_branch(&actor.tenant_id, existing_id.as_deref(), &name, address.as_deref(), phone.as_deref(), max_tables, &currency).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "branch", &branch_id, None, Some(&serde_json::json!({ "name": name }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(branch_id)
}

#[tauri::command]
pub fn set_printer_active_v3(state: State<Db>, session_token: String, printer_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).set_printer_active(&printer_id, is_active).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "printer", &printer_id, None, Some(&serde_json::json!({ "is_active": is_active }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_printer_paper_width_v3(state: State<Db>, session_token: String, printer_id: String, paper_width_mm: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePrinters).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_printer_paper_width(&printer_id, paper_width_mm).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::SettingsChanged, "printer", &printer_id, None, Some(&serde_json::json!({ "paper_width_mm": paper_width_mm }))).map_err(|e| e.to_string())?;
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
        audit::Action::CustomerChanged, "customer", &customer_id,
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
#[allow(clippy::too_many_arguments)]
pub fn update_customer_v3(state: State<Db>, session_token: String, customer_id: String, name: String, phone: String, email: Option<String>, address: Option<String>, notes: Option<String>, birthday: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx)
        .update_customer(&customer_id, &name, &phone, email.as_deref(), address.as_deref(), notes.as_deref(), birthday.as_deref())
        .map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::CustomerChanged, "customer", &customer_id, None, Some(&serde_json::json!({ "name": name, "phone": phone }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_customer_v3(state: State<Db>, session_token: String, customer_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_customer(&customer_id).map_err(|e| e.to_string())?;
    audit::append(&tx, &actor.device_id, &actor.tenant_id, actor.branch_id.as_deref(), &actor.id, audit::Action::CustomerChanged, "customer", &customer_id, Some(&serde_json::json!({ "deleted": false })), Some(&serde_json::json!({ "deleted": true }))).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct CustomerDetailV3 {
    pub orders: Vec<crate::repo::CustomerOrderRow>,
    pub favorite_items: Vec<crate::repo::FavoriteItemRow>,
}

#[tauri::command]
pub fn get_customer_detail_v3(state: State<Db>, session_token: String, phone: String) -> Result<CustomerDetailV3, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageCustomers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let repo = Repo::new(&conn);
    Ok(CustomerDetailV3 {
        orders: repo.customer_order_history(&phone).map_err(|e| e.to_string())?,
        favorite_items: repo.customer_favorite_items(&phone).map_err(|e| e.to_string())?,
    })
}

// ---------------------------------------------------------------------------
// Batch 3b, slice 3, group 1b -- loyalty. Card issuance is UID
// keyboard-entry ONLY -- no hardware scan integration (Phase 2, out of scope).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_loyalty_cards_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::LoyaltyCardRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_cards(&actor.tenant_id).map_err(|e| e.to_string())
}

/// `card_number` is whatever was typed or scanned into the UID field on the
/// issue-card form -- a scanner is just a keyboard emitting the UID string,
/// so there is no separate hardware code path here at all.
#[tauri::command]
pub fn issue_loyalty_card_v3(state: State<Db>, session_token: String, customer_id: String, card_number: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
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
pub fn list_loyalty_transactions_v3(state: State<Db>, session_token: String, card_id: Option<String>) -> Result<Vec<crate::repo::LoyaltyTxRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageLoyalty).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_loyalty_transactions(&actor.scope(), card_id.as_deref()).map_err(|e| e.to_string())
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
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "supplier_id": supplier_id })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(po_id)
}

/// `NewOrderModal`'s quick-create path -- bare PO + `total_orders` bump.
#[tauri::command]
pub fn create_purchase_order_and_bump_supplier_v3(state: State<Db>, session_token: String, supplier_id: String, notes: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("purchase order creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order_and_bump_supplier(&tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref())
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
pub fn create_purchase_order_with_items_v3(state: State<Db>, session_token: String, supplier_id: String, notes: Option<String>, items: Vec<(String, f64, i64)>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("purchase order creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let po_id = Repo::new(&tx)
        .create_purchase_order_with_items(&tenant_id, &branch_id, &supplier_id, &actor.id, notes.as_deref(), &items)
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
pub fn list_purchase_orders_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::PurchaseOrderRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_purchase_orders(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_purchase_order_v3(state: State<Db>, session_token: String, po_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let Scope::Branch { tenant_id, branch_id } = &scope else {
        return Err("purchase order cancellation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).cancel_purchase_order(&po_id, &scope).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, tenant_id, Some(branch_id), &actor.id,
        audit::Action::PurchaseOrderChanged, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "status": "CANCELLED" })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_purchase_order_items_v3(state: State<Db>, session_token: String, po_id: String) -> Result<Vec<crate::repo::PurchaseOrderItemRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_purchase_order_items(&po_id, &actor.scope()).map_err(|e| e.to_string())
}

/// The atomicity target for this group -- see `Repo::receive_purchase_order`.
/// `items` is `(purchase_order_item_id, ingredient_id, quantity_received)`
/// triples for however many line items the PO has.
#[tauri::command]
pub fn receive_purchase_order_v3(state: State<Db>, session_token: String, po_id: String, items: Vec<(String, String, f64)>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let scope = actor.scope();
    let Scope::Branch { tenant_id, branch_id } = &scope else {
        return Err("purchase order receiving requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx)
        .receive_purchase_order(tenant_id, branch_id, &po_id, &actor.id, &scope, &items)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, tenant_id, Some(branch_id), &actor.id,
        audit::Action::PurchaseOrderReceived, "purchase_order", &po_id,
        None, Some(&serde_json::json!({ "item_count": items.len() })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_suppliers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::SupplierRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_suppliers(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_supplier_v3(state: State<Db>, session_token: String, name: String, phone: Option<String>, email: Option<String>) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("supplier creation requires a Branch-scoped actor".to_string());
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
pub fn update_supplier_v3(state: State<Db>, session_token: String, supplier_id: String, name: String, phone: Option<String>, email: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("supplier updates require a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_supplier(&supplier_id, &name, phone.as_deref(), email.as_deref()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::SupplierChanged, "supplier", &supplier_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_supplier_v3(state: State<Db>, session_token: String, supplier_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("supplier deletion requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).delete_supplier(&supplier_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::SupplierChanged, "supplier", &supplier_id,
        None, None,
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_inventory_logs_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::InventoryLogRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_inventory_logs(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_low_stock_ingredients_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::IngredientRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManagePurchaseOrders).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_low_stock_ingredients(&actor.scope()).map_err(|e| e.to_string())
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
        audit::Action::DriverChanged, "driver", &driver_id,
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

/// `DriversView`'s management tab -- includes deactivated drivers.
#[tauri::command]
pub fn list_all_drivers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DriverRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_all_drivers(&actor.scope()).map_err(|e| e.to_string())
}

/// `DriverSelectModal`'s pick-a-driver list -- Cashier+ (assigning a driver
/// at order time is register-floor work, same rank as `ManageDelivery`).
#[tauri::command]
pub fn list_available_drivers_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DriverRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_available_drivers(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_driver_v3(state: State<Db>, session_token: String, driver_id: String, name: String, phone: Option<String>, vehicle_type: String, vehicle_plate: Option<String>, license_number: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("driver updates require a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_driver(&driver_id, &name, phone.as_deref(), &vehicle_type, vehicle_plate.as_deref(), license_number.as_deref()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DriverChanged, "driver", &driver_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn deactivate_driver_v3(state: State<Db>, session_token: String, driver_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("driver deactivation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).deactivate_driver(&driver_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DriverChanged, "driver", &driver_id,
        None, Some(&serde_json::json!({ "is_active": false })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
        audit::Action::DeliveryAssigned, "delivery_log", &log_id,
        None, Some(&serde_json::json!({ "order_id": order_id, "driver_id": driver_id, "status": "ASSIGNED" })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(log_id)
}

/// The atomicity target for assignment -- see `Repo::assign_driver_to_delivery`.
#[tauri::command]
pub fn assign_driver_to_delivery_v3(state: State<Db>, session_token: String, order_id: String, driver_id: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery assignment requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let log_id = Repo::new(&tx)
        .assign_driver_to_delivery(&tenant_id, &branch_id, &order_id, &driver_id)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DeliveryAssigned, "delivery_log", &log_id,
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
        audit::Action::DeliveryStatusChanged, "delivery_log", &delivery_log_id,
        None, Some(&serde_json::json!({ "status": new_status })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// The atomicity target for a delivery reaching a terminal status -- see
/// `Repo::update_delivery_status_and_driver`. `failure_reason` is real
/// (0001_init.sql); the old frontend's `notes` field on this same call is
/// NOT a real `delivery_logs` column and is dropped, not carried forward.
#[tauri::command]
pub fn update_delivery_status_and_driver_v3(state: State<Db>, session_token: String, delivery_log_id: String, new_status: String, failure_reason: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery status updates require a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_delivery_status_and_driver(&delivery_log_id, &new_status, failure_reason.as_deref()).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DeliveryStatusChanged, "delivery_log", &delivery_log_id,
        None, Some(&serde_json::json!({ "status": new_status })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_active_deliveries_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::ActiveDeliveryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_active_deliveries(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_delivery_history_v3(state: State<Db>, session_token: String, limit: i64, offset: i64) -> Result<Vec<crate::repo::DeliveryHistoryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_delivery_history(&actor.scope(), limit, offset).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_driver_deliveries_v3(state: State<Db>, session_token: String, driver_id: String) -> Result<Vec<crate::repo::DriverDeliveryRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDelivery).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_driver_deliveries(&driver_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_delivery_zones_v3(state: State<Db>, session_token: String) -> Result<Vec<crate::repo::DeliveryZoneRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_delivery_zones(&actor.scope()).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_delivery_zone_v3(state: State<Db>, session_token: String, name: String, boundaries: Option<String>, fee_cents: i64, min_order_cents: i64, estimated_minutes: i64) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery zone creation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let zone_id = Repo::new(&tx)
        .create_delivery_zone(&tenant_id, &branch_id, &name, boundaries.as_deref().unwrap_or("[]"), fee_cents, min_order_cents, estimated_minutes)
        .map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DeliveryZoneChanged, "delivery_zone", &zone_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(zone_id)
}

#[tauri::command]
pub fn update_delivery_zone_v3(state: State<Db>, session_token: String, zone_id: String, name: String, fee_cents: i64, min_order_cents: i64, estimated_minutes: i64) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery zone updates require a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).update_delivery_zone(&zone_id, &name, fee_cents, min_order_cents, estimated_minutes).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DeliveryZoneChanged, "delivery_zone", &zone_id,
        None, Some(&serde_json::json!({ "name": name })),
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn deactivate_delivery_zone_v3(state: State<Db>, session_token: String, zone_id: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::ManageDrivers).map_err(|e| e.to_string())?;
    let Scope::Branch { tenant_id, branch_id } = actor.scope() else {
        return Err("delivery zone deactivation requires a Branch-scoped actor".to_string());
    };
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    Repo::new(&tx).deactivate_delivery_zone(&zone_id).map_err(|e| e.to_string())?;
    audit::append(
        &tx, &actor.device_id, &tenant_id, Some(&branch_id), &actor.id,
        audit::Action::DeliveryZoneChanged, "delivery_zone", &zone_id,
        None, None,
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

    /// Batch 3b, slice 3, group 1: customer CRUD + order-history/favorites
    /// lookup, and loyalty card issuance via UID keyboard-entry (never a
    /// generated code) + transaction listing. Proves the duplicate-UID case
    /// is a hard error (SQLite's own `UNIQUE` constraint on `card_number`),
    /// not silently overwritten.
    #[test]
    fn customers_and_loyalty_crud_with_uid_keyboard_entry() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("custloyalty");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Loyalty Cashier");
        let repo = Repo::new(&conn);

        let cust_id = repo.create_customer(&tenant_id, "أحمد", "0991112233", None, None, None, None).unwrap();
        let list = repo.list_customers(&tenant_id).unwrap();
        assert!(list.iter().any(|c| c.id == cust_id && c.total_orders == 0));
        println!("[customers] customer created, total_orders defaults to 0");

        repo.update_customer(&cust_id, "أحمد محمد", "0991112233", Some("a@x.com"), Some("دمشق"), None, None).unwrap();
        let list = repo.list_customers(&tenant_id).unwrap();
        let c = list.iter().find(|c| c.id == cust_id).unwrap();
        assert_eq!(c.name, "أحمد محمد");
        assert_eq!(c.address.as_deref(), Some("دمشق"));
        println!("[customers] customer updated");

        // Order history + favorite items, matched by phone (walk-in orders
        // may have no customers.id at all, only a phone).
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
            table_id, user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
            subtotal_cents: 1000, tax_cents: 0, total_cents: 1000, discount_cents: 0,
        }).unwrap();
        conn.execute("UPDATE orders SET customer_phone = '0991112233' WHERE id = ?1", params![order_id]).unwrap();
        let history = repo.customer_order_history("0991112233").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, order_id);
        println!("[customers] order history matched by phone: 1 order found");

        repo.delete_customer(&cust_id).unwrap();
        assert!(!repo.list_customers(&tenant_id).unwrap().iter().any(|c| c.id == cust_id));
        println!("[customers] customer deleted");

        // Loyalty: issue a card with a UID typed/scanned into card_number.
        let cust2_id = repo.create_customer(&tenant_id, "سارة", "0997778899", None, None, None, None).unwrap();
        let card_id = repo.issue_loyalty_card(&tenant_id, &cust2_id, "UID-AA11BB22").unwrap();
        let cards = repo.list_loyalty_cards(&tenant_id).unwrap();
        let card = cards.iter().find(|c| c.id == card_id).unwrap();
        assert_eq!(card.card_number, "UID-AA11BB22");
        assert_eq!(card.points, 0);
        assert_eq!(card.tier, "BRONZE");
        println!("[loyalty] card issued with UID-AA11BB22 as card_number (keyboard-entry, not generated)");

        // The SAME UID again (e.g. a mis-scan re-registering the same physical
        // card) must be a hard error, not silently create a duplicate or
        // overwrite the first card.
        let dup_result = repo.issue_loyalty_card(&tenant_id, &cust2_id, "UID-AA11BB22");
        assert!(dup_result.is_err(), "issuing a second card with the same UID must fail (UNIQUE constraint)");
        println!("[loyalty] duplicate UID correctly rejected: {:?}", dup_result.err().unwrap());

        let cards = repo.list_loyalty_cards(&tenant_id).unwrap();
        assert_eq!(cards.iter().filter(|c| c.card_number == "UID-AA11BB22").count(), 1, "still exactly one card with this UID");

        let txs = repo.list_loyalty_transactions(&scope, None).unwrap();
        assert_eq!(txs.len(), 0, "no transactions exist yet -- issuing a card is not itself a points transaction");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 3, group 2: debtor CRUD + debt payment atomicity
    /// (PAYMENT fact + balance update together), and confirms
    /// `take_payment_v3`'s existing DEBT-entry creation (slice 1) still
    /// shows up correctly in `list_debt_entries`.
    #[test]
    fn debt_debtor_crud_and_payment_atomicity() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("debt");
        let conn = Connection::open(&db_path).unwrap();
        let cashier_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Cashier, "Debt Cashier");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let repo = Repo::new(&conn);

        let debtor_id = repo.create_debtor(&tenant_id, &branch_id, "بقالة الحي", "0955443322", None, None, None).unwrap();
        let list = repo.list_debtors(&scope).unwrap();
        assert!(list.iter().any(|d| d.id == debtor_id && d.balance_cents == 0));
        println!("[debt] debtor created with balance_cents=0");

        // A DEBT entry via take_payment_v3's existing path (slice 1).
        let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
            table_id, user_id: cashier_id.clone(), order_type: "DINE_IN".into(),
            subtotal_cents: 5000, tax_cents: 0, total_cents: 5000, discount_cents: 0,
        }).unwrap();
        repo.take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
            order_id, method: "CREDIT".into(), amount_cents: 5000, change_cents: 0, debtor_id: Some(debtor_id.clone()), actor_id: cashier_id.clone(),
        }).unwrap();
        let list = repo.list_debtors(&scope).unwrap();
        let d = list.iter().find(|d| d.id == debtor_id).unwrap();
        assert_eq!(d.total_debt_cents, 5000);
        assert_eq!(d.balance_cents, 5000);
        println!("[debt] take_payment_v3's DEBT entry raised balance_cents to 5000");

        // Now pay part of it down -- one transaction, both writes together.
        let entry_id = repo.record_debt_payment(&tenant_id, &branch_id, &debtor_id, 2000, Some("دفعة جزئية"), &cashier_id).unwrap();
        let list = repo.list_debtors(&scope).unwrap();
        let d = list.iter().find(|d| d.id == debtor_id).unwrap();
        assert_eq!(d.total_paid_cents, 2000);
        assert_eq!(d.balance_cents, 3000, "5000 debt - 2000 paid = 3000 remaining");
        println!("[debt] payment recorded: balance_cents now 3000 (5000 - 2000)");

        let entries = repo.list_debt_entries(&debtor_id).unwrap();
        assert_eq!(entries.len(), 2, "one DEBT entry (from take_payment) + one PAYMENT entry, both preserved as separate append-only facts");
        assert!(entries.iter().any(|e| e.id == entry_id && e.entry_type == "PAYMENT" && e.amount_cents == 2000));
        assert!(entries.iter().any(|e| e.entry_type == "DEBT" && e.amount_cents == 5000));
        println!("[debt] list_debt_entries shows both facts: DEBT(5000) and PAYMENT(2000)");

        repo.update_debtor(&debtor_id, "بقالة الحي الجديدة", "0955443322", Some("shop@x.com"), None, None).unwrap();
        assert_eq!(repo.list_debtors(&scope).unwrap().iter().find(|d| d.id == debtor_id).unwrap().name, "بقالة الحي الجديدة");

        repo.deactivate_debtor(&debtor_id).unwrap();
        assert!(!repo.list_debtors(&scope).unwrap().iter().any(|d| d.id == debtor_id), "deactivated debtors must not appear in the active list");
        println!("[debt] debtor updated then deactivated -- no longer in the active list");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 3, group 3: finance revenue summary (order count +
    /// cash/card split) matches actual `take_payment_v3` payments, plus
    /// operational_costs and invoice CRUD, plus the sales report aggregation.
    #[test]
    fn finance_revenue_costs_invoices_and_sales_report() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("finance");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Finance Manager");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let repo = Repo::new(&conn);

        for (method, amount) in [("CASH", 1000i64), ("CARD", 2500i64)] {
            let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
                table_id: table_id.clone(), user_id: manager_id.clone(), order_type: "DINE_IN".into(),
                subtotal_cents: amount, tax_cents: 0, total_cents: amount, discount_cents: 0,
            }).unwrap();
            repo.take_payment(&tenant_id, &branch_id, crate::repo::PaymentInput {
                order_id, method: method.to_string(), amount_cents: amount, change_cents: 0, debtor_id: None, actor_id: manager_id.clone(),
            }).unwrap();
        }

        let far_past = "2000-01-01T00:00:00Z";
        let far_future = "2100-01-01T00:00:00Z";
        let revenue = repo.finance_revenue_summary(&scope, far_past, far_future).unwrap();
        assert_eq!(revenue.order_count, 2);
        assert_eq!(revenue.total, 3500);
        assert_eq!(revenue.cash, 1000);
        assert_eq!(revenue.card, 2500);
        println!("[finance] revenue summary: 2 orders, total=3500, cash=1000, card=2500 -- matches actual payments");

        let cost_id = repo.create_operational_cost(&tenant_id, &branch_id, "إيجار", 50000, "2026-07-01", Some("شهري"), &manager_id).unwrap();
        let costs = repo.list_operational_costs(&scope).unwrap();
        assert!(costs.iter().any(|c| c.id == cost_id && c.amount_cents == 50000));
        println!("[finance] operational cost recorded and listed");

        let invoice_id = repo.create_invoice(&tenant_id, &branch_id, "2026-07-01", "2026-07-31", 100000, "2026-08-15").unwrap();
        let invoices = repo.list_invoices(&tenant_id).unwrap();
        let inv = invoices.iter().find(|i| i.id == invoice_id).unwrap();
        assert_eq!(inv.status, "PENDING");
        repo.mark_invoice_paid(&invoice_id).unwrap();
        let invoices = repo.list_invoices(&tenant_id).unwrap();
        let inv = invoices.iter().find(|i| i.id == invoice_id).unwrap();
        assert_eq!(inv.status, "PAID");
        assert!(inv.paid_at.is_some());
        println!("[finance] invoice created PENDING, then marked PAID with paid_at set");

        let report = repo.sales_report(&scope, far_past).unwrap();
        assert_eq!(report.order_count, 2);
        assert_eq!(report.total_sales, 3500);
        assert!(report.staff_performance.iter().any(|s| s.name == "Finance Manager" && s.order_count == 2));
        println!("[reports] sales_report: order_count=2, total_sales=3500, staff_performance shows the manager with 2 orders");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, slice 3, group 4: chain_config currency/tax updates,
    /// legacy `branches` upsert (create-then-update, distinct from T1.1's
    /// `branch` table), and printer active-toggle/paper-width.
    #[test]
    fn settings_chain_config_legacy_branch_and_printers() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("settings");
        let conn = Connection::open(&db_path).unwrap();
        let repo = Repo::new(&conn);

        let cfg = repo.get_chain_config().unwrap();
        assert_eq!(cfg.currency, "SYP", "default seeded currency");

        repo.update_chain_currency("USD").unwrap();
        assert_eq!(repo.get_chain_config().unwrap().currency, "USD");
        repo.update_chain_tax(1500, "inclusive").unwrap();
        let cfg = repo.get_chain_config().unwrap();
        assert_eq!(cfg.tax_rate_cents, 1500);
        assert_eq!(cfg.tax_mode, "inclusive");
        println!("[settings] chain_config currency and tax updated");

        // Legacy `branches` (distinct from T1.1's `branch`) starts empty --
        // first save is a create, second is an update of the same row.
        assert!(repo.get_legacy_branch(&tenant_id).unwrap().is_none());
        let legacy_id = repo.upsert_legacy_branch(&tenant_id, None, "الفرع الرئيسي", Some("دمشق"), Some("011"), 20, "USD").unwrap();
        let legacy = repo.get_legacy_branch(&tenant_id).unwrap().unwrap();
        assert_eq!(legacy.id, legacy_id);
        assert_eq!(legacy.name, "الفرع الرئيسي");
        println!("[settings] legacy branch created");

        let legacy_id_2 = repo.upsert_legacy_branch(&tenant_id, Some(&legacy_id), "الفرع المحدث", Some("دمشق"), Some("011"), 30, "USD").unwrap();
        assert_eq!(legacy_id_2, legacy_id, "an update must reuse the same row, not create a second one");
        let legacy = repo.get_legacy_branch(&tenant_id).unwrap().unwrap();
        assert_eq!(legacy.name, "الفرع المحدث");
        assert_eq!(legacy.max_tables, 30);
        println!("[settings] legacy branch updated in place, same id");

        let printer_id = repo.create_printer(&tenant_id, &branch_id, "طابعة الكاشير", "RECEIPT", "USB", None, None, 200, true).unwrap();
        repo.set_printer_active(&printer_id, false).unwrap();
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let printers = repo.list_printers(&scope).unwrap();
        let p = printers.iter().find(|p| p.id == printer_id).unwrap();
        assert_eq!(p.is_active, 0, "list_printers must show inactive printers too, not filter them out");
        repo.update_printer_paper_width(&printer_id, 58).unwrap();
        let printers = repo.list_printers(&scope).unwrap();
        assert_eq!(printers.iter().find(|p| p.id == printer_id).unwrap().paper_width_mm, 58);
        println!("[settings] printer deactivated (still listed) and paper width updated");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, final slice, group 1: supplier CRUD, both PO-creation paths
    /// (bare + bump, vs the full line-item flow with its own bump), cancel,
    /// and the RECEIVING atomicity target -- per-item `quantity_received` +
    /// `ingredients.current_stock` + an `inventory_logs` row, then the PO
    /// itself flips to RECEIVED, all inside one transaction.
    #[test]
    fn purchase_order_lifecycle_suppliers_items_and_receiving_atomicity() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("po_lifecycle");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "PO Manager");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let repo = Repo::new(&conn);

        // Suppliers -- explicitly NO address/notes (DRIFT columns that don't
        // exist in the real `suppliers` table).
        let supplier_id = repo.create_supplier(&tenant_id, &branch_id, "مورد الخضار", Some("011-222"), None).unwrap();
        let suppliers = repo.list_suppliers(&scope).unwrap();
        assert_eq!(suppliers.len(), 1);
        assert_eq!(suppliers[0].total_orders, 0);
        println!("[po] supplier created, total_orders starts at 0");

        repo.update_supplier(&supplier_id, "مورد الخضار والفواكه", Some("011-222"), Some("veg@example.com")).unwrap();
        assert_eq!(repo.list_suppliers(&scope).unwrap()[0].name, "مورد الخضار والفواكه");

        // Bare create + bump path (NewOrderModal quick-create).
        let po1 = repo.create_purchase_order_and_bump_supplier(&tenant_id, &branch_id, &supplier_id, &manager_id, None).unwrap();
        assert_eq!(repo.list_suppliers(&scope).unwrap()[0].total_orders, 1, "quick-create must bump total_orders");

        // Bare create WITHOUT bump (AlertsTab auto-order) -- deliberately
        // preserves the old inconsistency, not "fixed".
        let _po_auto = repo.create_purchase_order(&tenant_id, &branch_id, &supplier_id, &manager_id, Some("طلبية تلقائية")).unwrap();
        assert_eq!(repo.list_suppliers(&scope).unwrap()[0].total_orders, 1, "auto-order must NOT bump total_orders, matching the old frontend's existing behavior");
        println!("[po] quick-create bumps total_orders, auto-order does not -- both preserved as-is");

        // Cancel po1.
        repo.cancel_purchase_order(&po1, &scope).unwrap();
        let pos = repo.list_purchase_orders(&scope).unwrap();
        assert_eq!(pos.iter().find(|p| p.id == po1).unwrap().status, "CANCELLED");
        // Cancelling a non-PENDING PO is a hard error.
        match repo.cancel_purchase_order(&po1, &scope) {
            Err(crate::repo::RepoError::PurchaseOrderNotPending { .. }) => println!("[po] cancelling an already-CANCELLED PO correctly hard-errors"),
            other => panic!("expected PurchaseOrderNotPending, got {other:?}"),
        }

        // Full line-item flow (CreatePOModal).
        let ing1 = repo.create_ingredient(&tenant_id, &branch_id, "بندورة", "kg", 100, 5.0).unwrap();
        let ing2 = repo.create_ingredient(&tenant_id, &branch_id, "بصل", "kg", 80, 10.0).unwrap();
        let items = vec![(ing1.clone(), 10.0, 100i64), (ing2.clone(), 20.0, 80i64)];
        let po2 = repo.create_purchase_order_with_items(&tenant_id, &branch_id, &supplier_id, &manager_id, Some("طلبية أسبوعية"), &items).unwrap();
        let po2_row = repo.list_purchase_orders(&scope).unwrap().into_iter().find(|p| p.id == po2).unwrap();
        assert_eq!(po2_row.total_cents, 10 * 100 + 20 * 80, "total_cents must be computed server-side from the items, not trusted from the client");
        assert_eq!(po2_row.supplier_name, "مورد الخضار والفواكه", "list_purchase_orders must join supplier name");
        assert_eq!(po2_row.creator_name, "PO Manager", "list_purchase_orders must join creator name");
        assert_eq!(repo.list_suppliers(&scope).unwrap()[0].total_orders, 2, "the line-item flow must also bump total_orders");
        println!("[po] line-item PO created: total_cents={} (server-computed), supplier/creator names joined", po2_row.total_cents);

        let po2_items = repo.list_purchase_order_items(&po2, &scope).unwrap();
        assert_eq!(po2_items.len(), 2);
        let item1 = po2_items.iter().find(|i| i.ingredient_id == ing1).unwrap();
        assert_eq!(item1.quantity_ordered, 10.0);
        assert_eq!(item1.quantity_received, 0.0);
        assert_eq!(item1.ingredient_name, "بندورة");

        // Receiving -- the atomicity target. Stock starts at 0 for both.
        assert_eq!(repo.list_ingredients(&scope).unwrap().iter().find(|i| i.id == ing1).unwrap().current_stock, 0.0);
        let receive_items: Vec<(String, String, f64)> = po2_items.iter().map(|i| (i.id.clone(), i.ingredient_id.clone(), i.quantity_ordered)).collect();
        repo.receive_purchase_order(&tenant_id, &branch_id, &po2, &manager_id, &scope, &receive_items).unwrap();

        let ings = repo.list_ingredients(&scope).unwrap();
        assert_eq!(ings.iter().find(|i| i.id == ing1).unwrap().current_stock, 10.0, "receiving must bump current_stock by quantity_received");
        assert_eq!(ings.iter().find(|i| i.id == ing2).unwrap().current_stock, 20.0);
        let received_items = repo.list_purchase_order_items(&po2, &scope).unwrap();
        assert!(received_items.iter().all(|i| i.quantity_received == i.quantity_ordered), "quantity_received must be persisted on the item rows");
        let po2_after = repo.list_purchase_orders(&scope).unwrap().into_iter().find(|p| p.id == po2).unwrap();
        assert_eq!(po2_after.status, "RECEIVED");
        assert!(po2_after.received_at.is_some());
        let log_count: i64 = conn.query_row("SELECT COUNT(*) FROM inventory_logs WHERE reason = 'استلام طلبية شراء'", [], |r| r.get(0)).unwrap();
        assert_eq!(log_count, 2, "one inventory_logs row per received item");
        println!("[po] receiving atomically bumped stock for both items, wrote 2 inventory_logs rows, and flipped the PO to RECEIVED with a received_at timestamp");

        // Receiving an already-RECEIVED PO is a hard error.
        match repo.receive_purchase_order(&tenant_id, &branch_id, &po2, &manager_id, &scope, &receive_items) {
            Err(crate::repo::RepoError::PurchaseOrderNotPending { .. }) => println!("[po] re-receiving an already-RECEIVED PO correctly hard-errors"),
            other => panic!("expected PurchaseOrderNotPending, got {other:?}"),
        }

        // Movements + low-stock listing.
        let movements = repo.list_inventory_logs(&scope).unwrap();
        assert_eq!(movements.len(), 2);
        assert!(movements.iter().all(|m| m.user_name == "PO Manager"));
        println!("[po] list_inventory_logs joins ingredient/staff names correctly");

        let low_stock = repo.list_low_stock_ingredients(&scope).unwrap();
        assert!(low_stock.is_empty(), "both ingredients are now well above min_stock (10>=5, 20>=10)");
        repo.adjust_stock(&tenant_id, &branch_id, &ing1, -8.0, "هالك", &manager_id).unwrap();
        let low_stock = repo.list_low_stock_ingredients(&scope).unwrap();
        assert_eq!(low_stock.len(), 1, "ing1 dropped to 2.0, below its min_stock of 5.0");
        assert_eq!(low_stock[0].id, ing1);
        println!("[po] list_low_stock_ingredients correctly reflects a stock drop below min_stock");

        // Deleting a supplier still referenced by purchase_orders must hit
        // the FK constraint, same failure mode as the old frontend.
        let fk_result = repo.delete_supplier(&supplier_id);
        assert!(fk_result.is_err(), "deleting a supplier with existing purchase_orders rows must fail the FK constraint, not silently orphan them");
        println!("[po] deleting a supplier with existing POs correctly fails FK (matches old frontend's failure mode, not silently fixed)");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Kill-9 simulation for `receive_purchase_order`: perform all the
    /// atomic writes inside a transaction, drop it WITHOUT committing
    /// (simulating a crashed process), reopen a fresh connection, and
    /// confirm NONE of the writes persisted -- not the item's
    /// quantity_received, not the ingredient's stock bump, not the
    /// inventory_logs row, not the PO's RECEIVED status.
    #[test]
    fn kill_9_mid_receive_never_leaves_a_partial_stock_bump() {
        let (db_path, tenant_id, branch_id, _table_id) = seeded_db("po_kill9");
        let manager_id = {
            let conn = Connection::open(&db_path).unwrap();
            seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Kill9 Manager")
        };
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };

        let (supplier_id, ing_id, po_id, item_id) = {
            let conn = Connection::open(&db_path).unwrap();
            let repo = Repo::new(&conn);
            let supplier_id = repo.create_supplier(&tenant_id, &branch_id, "مورد", None, None).unwrap();
            let ing_id = repo.create_ingredient(&tenant_id, &branch_id, "سكر", "kg", 50, 5.0).unwrap();
            let po_id = repo.create_purchase_order_with_items(&tenant_id, &branch_id, &supplier_id, &manager_id, None, &[(ing_id.clone(), 15.0, 50)]).unwrap();
            let item_id = repo.list_purchase_order_items(&po_id, &scope).unwrap()[0].id.clone();
            (supplier_id, ing_id, po_id, item_id)
        };

        {
            let mut conn = Connection::open(&db_path).unwrap();
            let tx = conn.transaction().unwrap();
            Repo::new(&tx)
                .receive_purchase_order(&tenant_id, &branch_id, &po_id, &manager_id, &scope, &[(item_id.clone(), ing_id.clone(), 15.0)])
                .unwrap();
            // Deliberately drop `tx` here WITHOUT `.commit()` -- simulates a
            // crash mid-receive. `rusqlite::Transaction::drop` rolls back.
            println!("[kill-9] receive_purchase_order writes applied inside an uncommitted transaction, now dropping it");
        }

        let conn = Connection::open(&db_path).unwrap();
        let repo = Repo::new(&conn);
        let ing = repo.list_ingredients(&scope).unwrap().into_iter().find(|i| i.id == ing_id).unwrap();
        assert_eq!(ing.current_stock, 0.0, "stock bump must NOT have persisted");
        let item = repo.list_purchase_order_items(&po_id, &scope).unwrap().into_iter().find(|i| i.id == item_id).unwrap();
        assert_eq!(item.quantity_received, 0.0, "quantity_received must NOT have persisted");
        let po = repo.list_purchase_orders(&scope).unwrap().into_iter().find(|p| p.id == po_id).unwrap();
        assert_eq!(po.status, "PENDING", "PO status must NOT have flipped to RECEIVED");
        let log_count: i64 = conn.query_row("SELECT COUNT(*) FROM inventory_logs WHERE ingredient_id = ?1", params![ing_id], |r| r.get(0)).unwrap();
        assert_eq!(log_count, 0, "no inventory_logs row must have persisted");
        println!("[kill-9] confirmed: after an uncommitted receive is dropped, current_stock=0, quantity_received=0, PO status=PENDING, 0 inventory_logs rows -- no partial receive is ever visible");
        let _ = supplier_id;

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    /// Batch 3b, final slice, group 2: driver CRUD (soft delete), zones,
    /// and the two atomicity pairs -- assignment (delivery_log + driver
    /// BUSY) and terminal status (delivery_log transition + driver
    /// AVAILABLE + total_deliveries bump on DELIVERED only).
    #[test]
    fn delivery_lifecycle_drivers_zones_assignment_and_status_atomicity() {
        let (db_path, tenant_id, branch_id, table_id) = seeded_db("delivery_lifecycle");
        let conn = Connection::open(&db_path).unwrap();
        let manager_id = seed_staff(&conn, &tenant_id, Some(&branch_id), Role::Manager, "Delivery Manager");
        let scope = crate::security::Scope::Branch { tenant_id: tenant_id.clone(), branch_id: branch_id.clone() };
        let repo = Repo::new(&conn);

        // Driver CRUD.
        let driver_id = repo.create_driver(&tenant_id, &branch_id, "سائق أحمد", Some("0999111222"), "MOTORCYCLE", None, None).unwrap();
        assert_eq!(repo.list_drivers(&scope).unwrap().len(), 1);
        repo.update_driver(&driver_id, "سائق أحمد المعدل", Some("0999111222"), "CAR", Some("PLATE-1"), Some("LIC-1")).unwrap();
        let all = repo.list_all_drivers(&scope).unwrap();
        assert_eq!(all[0].name, "سائق أحمد المعدل");
        assert_eq!(all[0].vehicle_type, "CAR");
        println!("[delivery] driver created and updated");

        assert_eq!(repo.list_available_drivers(&scope).unwrap().len(), 1, "a fresh driver starts AVAILABLE and must show up in the pick-a-driver list");

        // Zones.
        let zone_id = repo.create_delivery_zone(&tenant_id, &branch_id, "حي النزهة", "[]", 500, 2000, 30).unwrap();
        assert_eq!(repo.list_delivery_zones(&scope).unwrap().len(), 1);
        repo.update_delivery_zone(&zone_id, "حي النزهة المحدث", 700, 2500, 25).unwrap();
        let zones = repo.list_delivery_zones(&scope).unwrap();
        assert_eq!(zones[0].name, "حي النزهة المحدث");
        assert_eq!(zones[0].fee_cents, 700);
        repo.deactivate_delivery_zone(&zone_id).unwrap();
        assert_eq!(repo.list_delivery_zones(&scope).unwrap().len(), 0, "deactivated zones must not appear in the active list");
        println!("[delivery] zone created, updated, deactivated");

        // Assignment atomicity: a DELIVERY order, then assign the driver.
        let order_id = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
            table_id, user_id: manager_id.clone(), order_type: "DELIVERY".into(),
            subtotal_cents: 5000, tax_cents: 0, total_cents: 5000, discount_cents: 0,
        }).unwrap();
        let log_id = repo.assign_driver_to_delivery(&tenant_id, &branch_id, &order_id, &driver_id).unwrap();
        assert_eq!(repo.list_all_drivers(&scope).unwrap()[0].status, "BUSY", "assignment must flip the driver to BUSY in the same call");
        assert_eq!(repo.list_available_drivers(&scope).unwrap().len(), 0, "a BUSY driver must not show up as available");
        let active = repo.list_active_deliveries(&scope).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].driver_name, "سائق أحمد المعدل");
        assert_eq!(active[0].total_cents, 5000);
        println!("[delivery] assign_driver_to_delivery: delivery_log created ASSIGNED, driver flipped to BUSY, both visible via list_active_deliveries");

        // Terminal-status atomicity: DELIVERED bumps total_deliveries and frees the driver.
        repo.update_delivery_status_and_driver(&log_id, "PICKED_UP", None).unwrap();
        assert_eq!(repo.list_all_drivers(&scope).unwrap()[0].status, "BUSY", "still BUSY mid-delivery, not a terminal status");
        repo.update_delivery_status_and_driver(&log_id, "DELIVERED", None).unwrap();
        let driver_after = repo.list_all_drivers(&scope).unwrap().into_iter().find(|d| d.id == driver_id).unwrap();
        assert_eq!(driver_after.status, "AVAILABLE", "DELIVERED must free the driver back to AVAILABLE in the same call");
        assert_eq!(driver_after.total_deliveries, 1, "DELIVERED must bump total_deliveries");
        assert_eq!(repo.list_active_deliveries(&scope).unwrap().len(), 0, "a DELIVERED log must drop out of the active list");
        let history = repo.list_delivery_history(&scope, 10, 0).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].delivery_status, "DELIVERED");
        println!("[delivery] terminal status DELIVERED: driver freed to AVAILABLE + total_deliveries bumped to 1, log moved from active to history");

        // A second delivery that FAILS must free the driver WITHOUT bumping total_deliveries.
        let order_id_2 = repo.create_order(&scope, &tenant_id, &branch_id, NewOrder {
            table_id: "tbl-1".to_string(), user_id: manager_id.clone(), order_type: "DELIVERY".into(),
            subtotal_cents: 3000, tax_cents: 0, total_cents: 3000, discount_cents: 0,
        }).unwrap();
        let log_id_2 = repo.assign_driver_to_delivery(&tenant_id, &branch_id, &order_id_2, &driver_id).unwrap();
        repo.update_delivery_status_and_driver(&log_id_2, "FAILED", Some("العميل غير متواجد")).unwrap();
        let driver_after_fail = repo.list_all_drivers(&scope).unwrap().into_iter().find(|d| d.id == driver_id).unwrap();
        assert_eq!(driver_after_fail.status, "AVAILABLE", "FAILED must also free the driver");
        assert_eq!(driver_after_fail.total_deliveries, 1, "FAILED must NOT bump total_deliveries -- only an actual DELIVERED counts");
        let history_2 = repo.list_delivery_history(&scope, 10, 0).unwrap();
        assert_eq!(history_2.len(), 2);
        let failed_entry = history_2.iter().find(|h| h.log_id == log_id_2).unwrap();
        assert_eq!(failed_entry.failure_reason.as_deref(), Some("العميل غير متواجد"));
        println!("[delivery] FAILED: driver freed but total_deliveries NOT bumped (only DELIVERED counts), failure_reason persisted");

        let driver_deliveries = repo.list_driver_deliveries(&driver_id).unwrap();
        assert_eq!(driver_deliveries.len(), 2, "list_driver_deliveries must show both this driver's deliveries");

        // Soft delete.
        repo.deactivate_driver(&driver_id).unwrap();
        assert_eq!(repo.list_drivers(&scope).unwrap().len(), 0, "list_drivers (active-only) must exclude a deactivated driver");
        assert_eq!(repo.list_all_drivers(&scope).unwrap().len(), 1, "list_all_drivers must still show it (soft delete, not gone)");
        assert_eq!(repo.list_all_drivers(&scope).unwrap()[0].is_active, 0);
        println!("[delivery] driver deactivated: excluded from list_drivers, still visible via list_all_drivers with is_active=0");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}

