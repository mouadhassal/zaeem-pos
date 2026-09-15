use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;
use super::orders::sync_enqueue_staff_snapshot;

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
    login_pin_v3_impl(&state, pin, device_id)
}

/// Split out (T3.0 LAN hub/satellite) so `dispatch_lan_rpc` can call this
/// with a plain `&Db` -- `tauri::State<T>` has no public constructor
/// outside a live `Manager`, and this crate's tests can't build a real
/// `tauri::App` on this dev box at all (see `command_wrapper_tests`'s own
/// doc comment for the confirmed `STATUS_ENTRYPOINT_NOT_FOUND` crash), so
/// anything the LAN dispatcher needs to call has to be reachable without
/// one.
const LOGIN_PIN_MAX_ATTEMPTS: i64 = 5;
const LOGIN_PIN_LOCKOUT_SECONDS: i64 = 5 * 60;
const LOGIN_PIN_FAILURES_KEY: &str = "login_pin_failures";
const LOGIN_PIN_LOCKED_UNTIL_KEY: &str = "login_pin_locked_until";

/// Security audit finding (pre-launch pass): this used to scan every active
/// staff row in the ENTIRE local `staff` table with no tenant filter and no
/// lockout -- two staff picking the same PIN could cross-authenticate as
/// each other, and the 10,000-combination 6-digit PIN space had no
/// brute-force protection on an idle/physically-accessible terminal (unlike
/// `verify_manager_override_impl`, which already had both). Fixed the same
/// way: scope candidates to this device's one tenant (a terminal is licensed
/// to exactly one tenant -- see `setup_owner_v3`), and apply the same
/// device-wide lockout pattern (there's no authenticated actor yet to scope
/// a per-actor lockout to; a device-wide one is exactly right here since
/// this IS the login screen for that one physical terminal).
pub(crate) fn login_pin_v3_impl(state: &Db, pin: String, device_id: String) -> Result<LoginV3Response, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    let locked_until_ms: i64 = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![LOGIN_PIN_LOCKED_UNTIL_KEY], |r| r.get::<_, String>(0))
        .optional().map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if locked_until_ms > 0 && now_ms < locked_until_ms {
        return Err("محاولات كثيرة فاشلة -- حاول مرة أخرى لاحقاً".to_string());
    }
    if locked_until_ms > 0 && now_ms >= locked_until_ms {
        conn.execute("DELETE FROM app_settings WHERE key IN (?1, ?2)", params![LOGIN_PIN_FAILURES_KEY, LOGIN_PIN_LOCKED_UNTIL_KEY])
            .map_err(|e| e.to_string())?;
    }

    // A device is licensed/set up for exactly one tenant (setup_owner_v3
    // attaches the bootstrap owner to `SELECT id FROM tenant LIMIT 1`) --
    // scoping candidates to that tenant is defense-in-depth even though a
    // second tenant row should never exist in this local DB at all.
    let tenant_id: Option<String> = conn
        .query_row("SELECT id FROM tenant LIMIT 1", [], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, tenant_id, branch_id, role, pin_hash FROM staff WHERE pin_hash IS NOT NULL AND is_active = 1 AND (?1 IS NULL OR tenant_id = ?1)")
        .map_err(|e| e.to_string())?;
    let candidates: Vec<(String, String, String, Option<String>, String, String)> = stmt
        .query_map(params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (actor_id, name, staff_tenant_id, branch_id, role_str, pin_hash) in candidates {
        if verify(&pin, &pin_hash).unwrap_or(false) {
            conn.execute("DELETE FROM app_settings WHERE key IN (?1, ?2)", params![LOGIN_PIN_FAILURES_KEY, LOGIN_PIN_LOCKED_UNTIL_KEY])
                .map_err(|e| e.to_string())?;
            return login_response(&conn, &actor_id, &name, &role_str, staff_tenant_id, branch_id, &device_id);
        }
    }

    let failures: i64 = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![LOGIN_PIN_FAILURES_KEY], |r| r.get::<_, String>(0))
        .optional().map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0) + 1;
    if failures >= LOGIN_PIN_MAX_ATTEMPTS {
        let until = now_ms + LOGIN_PIN_LOCKOUT_SECONDS * 1000;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![LOGIN_PIN_LOCKED_UNTIL_KEY, until.to_string()],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
            params![LOGIN_PIN_FAILURES_KEY],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![LOGIN_PIN_FAILURES_KEY, failures.to_string()],
        ).map_err(|e| e.to_string())?;
    }
    // 2026-08-28 sweep fix: this was the literal English string "invalid
    // PIN" -- authStore.ts's loginWithPin() trusts a string error from the
    // backend verbatim (only falls back to its own Arabic default for a
    // non-string error), so this leaked untranslated straight to the login
    // screen while every other error in this codebase is already Arabic.
    Err("الرمز غير صحيح".to_string())
}

/// Server-side PIN format enforcement -- `create_staff_v3`/
/// `update_staff_profile_v3` previously trusted the frontend's zod
/// `/^\d{6}$/` check entirely; a direct Tauri IPC call (or a future
/// frontend bug) could store a PIN of any shape.
fn validate_pin_format(pin: &str) -> Result<(), String> {
    if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err("الرقم السري يجب أن يكون 6 أرقام".to_string());
    }
    Ok(())
}

/// Rejects a new/changed PIN that collides with another active staff
/// member's PIN in the same tenant -- bcrypt hashes can't be compared
/// directly, so this re-verifies the candidate plaintext against every
/// existing hash the same way login itself does. Two staff sharing a PIN
/// means whichever one SQLite returns first silently authenticates BOTH of
/// them at login; this closes that off at the point the PIN is set, not by
/// changing login's find-first behavior (which is what the underlying
/// staff-identification model actually depends on).
fn assert_pin_not_taken(conn: &rusqlite::Connection, tenant_id: &str, pin: &str, exclude_staff_id: Option<&str>) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id, pin_hash FROM staff WHERE tenant_id = ?1 AND pin_hash IS NOT NULL AND is_active = 1")
        .map_err(|e| e.to_string())?;
    let candidates: Vec<(String, String)> = stmt
        .query_map(params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for (staff_id, pin_hash) in candidates {
        if Some(staff_id.as_str()) == exclude_staff_id {
            continue;
        }
        if verify(pin, &pin_hash).unwrap_or(false) {
            return Err("هذا الرقم السري مستخدم بالفعل من قبل موظف آخر -- اختر رقماً مختلفاً".to_string());
        }
    }
    Ok(())
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
    // Opens the license-gate exemption SetupWizard's own remaining steps
    // (currency/branch/business-mode) need -- see
    // `require_license_not_locked_or_initial_setup`'s doc comment.
    // `update_business_mode_v3` (the wizard's final step) closes it early
    // on success; this timestamp bounds it regardless.
    let setup_expires_at_ms = (chrono::Utc::now().timestamp_millis() + INITIAL_SETUP_WINDOW_MS).to_string();
    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![INITIAL_SETUP_IN_PROGRESS_KEY, setup_expires_at_ms],
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
    logout_v3_impl(&state, session_token)
}

pub(crate) fn logout_v3_impl(state: &Db, session_token: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    security::revoke_session(&conn, &session_token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_branch_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, tenant_id: String, name: String, currency: String) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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
    state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>,
    session_token: String,
    target_branch_id: Option<String>,
    role: String,
    name: String,
    pin: String,
) -> Result<String, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::CreateStaff).map_err(|e| e.to_string())?;

    let target_role = Role::from_str(&role).ok_or_else(|| "دور غير معروف".to_string())?;

    // Hard rule (SCHEMA_V3.md §2.1, decision 2026-07-16): actor_rank > target_rank, always.
    // 2026-08-22 QA re-audit: this raw English message reached the Arabic
    // Staff page verbatim ("role Owner (rank 3) cannot assign role Owner
    // (rank 3) -- must be strictly below the actor's own rank") -- found
    // live by trying to create a second Owner from Settings > الموظفين
    // (the role dropdown offers "مالك" with nothing stopping the actor from
    // picking it; the backend correctly refuses, just never in Arabic).
    if actor.role.rank() <= target_role.rank() {
        return Err("لا يمكنك تعيين دور بنفس رتبة حسابك أو أعلى منها".to_string());
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

    validate_pin_format(&pin)?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    assert_pin_not_taken(&conn, &actor.tenant_id, &pin, None)?;
    let pin_hash = hash(&pin, DEFAULT_COST).map_err(|e| e.to_string())?;
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
    let license_status = license.cached_status();
    sync_enqueue_staff_snapshot(&tx, &actor.tenant_id, &staff_id, &actor.device_id, &license_status)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(staff_id)
}

/// Same rank rule as `create_staff_v3`, checked against the TARGET's current
/// rank (read back from the DB, never trusted from the caller) as well as
/// the new role being assigned -- an actor cannot demote-then-promote around
/// the rule, and cannot touch a target who already outranks them.
#[tauri::command]
pub fn update_staff_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, target_staff_id: String, new_role: String) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;

    let new_role_parsed = Role::from_str(&new_role).ok_or_else(|| "دور غير معروف".to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (target_tenant_id, target_branch_id, target_current_rank) =
        Repo::new(&conn).get_staff_scope(&target_staff_id).map_err(|e| e.to_string())?;

    authorize_scope(&actor, &target_tenant_id, target_branch_id.as_deref()).map_err(|e| e.to_string())?;

    // 2026-08-22 QA re-audit: both of these raw English messages reached
    // the Arabic Staff page verbatim -- same class of bug as
    // create_staff_v3's rank check right above, fixed the same way.
    if actor.role.rank() <= target_current_rank {
        return Err("لا يمكنك تعديل موظف بنفس رتبتك أو أعلى منها".to_string());
    }
    if actor.role.rank() <= new_role_parsed.rank() {
        return Err("لا يمكنك تعيين دور بنفس رتبة حسابك أو أعلى منها".to_string());
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
pub fn list_branches_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<(String, String)>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_branches(&actor.tenant_id).map_err(|e| e.to_string())
}

/// Back-office command -- license-gated (see `require_license_not_locked`).
/// This is a representative example of the gate, not exhaustive coverage:
/// staff/reports/settings management are the intended surface, order/
/// payment/print commands must never be gated this way.
#[tauri::command]
pub fn list_staff_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String) -> Result<Vec<crate::repo::StaffRow>, String> {
    let actor = authenticate_actor(&state, &session_token)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;
    require_license_not_locked(&license)?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    Repo::new(&conn).list_staff(&actor.scope()).map_err(|e| e.to_string())
}

/// Batch 3b -- `staff/page.tsx`'s "edit employee" path. Only `name` and,
/// optionally, a new PIN -- `staff` has no `email`/`phone`/`photo_path`/
/// `cv_path` for this to update (see `Repo::update_staff_profile`'s doc
/// comment). Role changes still go through `update_staff_v3` (the
/// rank-checked path); this command never touches `role`/`role_rank`.
#[tauri::command]
pub fn update_staff_profile_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, target_staff_id: String, name: String, new_pin: Option<String>) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
    authorize(&actor, Permission::UpdateStaff).map_err(|e| e.to_string())?;

    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let (target_tenant_id, target_branch_id, target_current_rank) =
        Repo::new(&conn).get_staff_scope(&target_staff_id).map_err(|e| e.to_string())?;
    authorize_scope(&actor, &target_tenant_id, target_branch_id.as_deref()).map_err(|e| e.to_string())?;
    // A Manager may edit their own profile (rank equal to self is fine here --
    // this isn't a rank-elevation action) but never someone who outranks them.
    // 2026-08-22 QA re-audit: same raw-English-reaches-Arabic-UI bug as
    // create_staff_v3/update_staff_v3's rank checks.
    if actor.id != target_staff_id && actor.role.rank() <= target_current_rank {
        return Err("لا يمكنك تعديل موظف بنفس رتبتك أو أعلى منها".to_string());
    }

    if let Some(ref p) = new_pin {
        validate_pin_format(p)?;
        assert_pin_not_taken(&conn, &target_tenant_id, p, Some(&target_staff_id))?;
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
pub fn set_staff_active_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, target_staff_id: String, is_active: bool) -> Result<(), String> {
    let actor = authenticate_actor(&state, &session_token)?;
    require_license_not_locked(&license)?;
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

