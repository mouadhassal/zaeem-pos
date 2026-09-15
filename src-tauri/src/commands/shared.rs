use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
/// Takes `&Db` rather than `&State<Db>` so it (and everything built on it)
/// can be called both from the real `#[tauri::command]` wrapper (where
/// `&state` deref-coerces from `State<Db>`) and directly from command-wrapper
/// tests holding a plain `Db` -- no `tauri::App`/`State` construction needed.
pub(crate) fn authenticate_actor(state: &Db, session_token: &str) -> Result<Actor, String> {
    let local_result = {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        security::ensure_security_schema(&conn).map_err(|e| e.to_string())?;
        security::authenticate(&conn, session_token).map_err(|e| e.to_string())
    };
    match local_result {
        Ok(actor) => Ok(actor),
        // A Satellite's own local `session_v3` never has this row -- every
        // login is LAN-redirected to the Hub (staff accounts/PINs are
        // Hub-authoritative, see `lan.rs`'s module doc), so the ~140
        // commands NOT on the Phase 1 order/table allowlist would
        // otherwise see a cashier's own just-created session as "session
        // expired" everywhere except the 11 redirected commands. Only
        // reached on the local-lookup failure path -- zero extra cost for
        // every standalone/Hub terminal, where this always returns
        // `Ok(None)` immediately (mode != "satellite").
        Err(local_err) => match crate::lan::resolve_actor_via_hub(session_token) {
            Ok(Some(actor)) => Ok(actor),
            Ok(None) => Err(local_err),
            Err(hub_err) => Err(hub_err),
        },
    }
}

/// Wire shape for `__resolve_actor_v3` -- `security::Actor` itself doesn't
/// derive `Serialize` (it's never persisted or sent anywhere else), so
/// this is a deliberate, minimal copy just for the one LAN round-trip.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct ActorWire {
    pub id: String,
    pub tenant_id: String,
    pub branch_id: Option<String>,
    pub role: Role,
    pub device_id: String,
}

/// The POS-never-stops-selling guarantee is structural, not a flag check:
/// order/payment/print commands never call this at all. Only back-office /
/// reports commands do. See license/signed.rs's `LicenseStatus::back_office_locked`.
pub(crate) fn require_license_not_locked(license: &crate::license::cloud::CloudLicenseState) -> Result<(), String> {
    if license.cached_status().back_office_locked() {
        return Err("license expired -- back-office access is locked until renewed. Point of sale keeps working normally.".to_string());
    }
    Ok(())
}

pub(crate) const INITIAL_SETUP_IN_PROGRESS_KEY: &str = "initial_setup_in_progress";
// Bounds the exemption below even if the wizard's own "تخطي -- الإعداد
// لاحقاً" (skip) button is used -- that path reloads straight into the
// authenticated app without ever calling `update_business_mode_v3`,
// which is the exemption's normal (immediate) close. 30 minutes is far
// more than any real owner takes to click through three short forms;
// this is just a backstop so an abandoned/skipped setup can't leave the
// exemption open indefinitely.
pub(crate) const INITIAL_SETUP_WINDOW_MS: i64 = 30 * 60 * 1000;

/// 2026-08-21 QA re-audit: same lock as `require_license_not_locked`,
/// except within `INITIAL_SETUP_WINDOW_MS` of `setup_owner_v3` creating
/// the very first owner (`INITIAL_SETUP_IN_PROGRESS_KEY` stores that
/// expiry timestamp). `update_business_mode_v3` -- the wizard's own
/// final step -- clears it early, on success. In between, SetupWizard's
/// "branch" and "business" steps call `update_chain_currency_v3`/
/// `save_legacy_branch_v3`/`update_business_mode_v3`, none of which the
/// owner could have possibly gotten a license activated for yet:
/// Settings' activation UI is itself unreachable until setup finishes.
/// Without this exemption that was a real deadlock --
/// `require_license_not_locked` failed every one of those three calls
/// with "لا يوجد ترخيص صالح" on a brand-new device, confirmed live
/// against a release build (debug builds never hit this, since
/// `needs_setup_v3` always returns false under `cfg!(debug_assertions)`,
/// so the wizard was never actually exercised before this pass).
///
/// A local `branches`/staff-count check was considered instead and
/// rejected: `update_business_mode_v3` runs AFTER `save_legacy_branch_v3`
/// already created the tenant's one branch in the same wizard pass, so
/// "zero branches" doesn't hold for all three calls, and "exactly one
/// branch" is indistinguishable from a genuinely already-set-up,
/// single-branch tenant editing business mode later with an expired
/// license -- that would reopen the exact licensing bypass this gate
/// exists to prevent. The flag can't be replayed: `setup_owner_v3`
/// itself refuses a second run once an owner exists ("المالك موجود
/// بالفعل"), so there is no path for an already-set-up tenant to ever
/// see this flag set again.
pub(crate) fn require_license_not_locked_or_initial_setup(
    license: &crate::license::cloud::CloudLicenseState,
    conn: &Connection,
) -> Result<(), String> {
    let expires_at_ms: Option<i64> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", params![INITIAL_SETUP_IN_PROGRESS_KEY], |r| r.get::<_, String>(0))
        .optional()
        .unwrap_or(None)
        .and_then(|v| v.parse().ok());
    if let Some(expires_at_ms) = expires_at_ms {
        if chrono::Utc::now().timestamp_millis() < expires_at_ms {
            return Ok(());
        }
    }
    require_license_not_locked(license)
}

/// 2026-08-14 pricing tiers: 'pos_lite' is the sell-and-print terminal
/// without the CRM/ERP layer (reports, loyalty, debt, roster/HR, anomaly/
/// forecast/reconciliation) -- that's the actual product difference from
/// 'full', priced accordingly. Reads `plan` off the SAME already-verified
/// license payload `require_license_not_locked` reads `back_office_locked`
/// from -- no new trust boundary, just a second check on data that's
/// already there. An `Invalid`/no-license status has no plan to read; that
/// case is left to `require_license_not_locked` (called first at every
/// existing call site) to reject, so this only ever runs against a
/// verified payload. Any plan string other than the literal "pos_lite"
/// passes -- this fails OPEN for unrecognized/legacy plan values
/// (including every already-issued license, whose payload predates this
/// field's meaning) rather than silently locking out a paying customer on
/// an unrecognized string, same reasoning as this repo's licensing
/// incidents already documented in README.md #6.
pub(crate) fn require_plan_includes_management(license: &crate::license::cloud::CloudLicenseState) -> Result<(), String> {
    let plan = match license.cached_status() {
        license_core::signed::LicenseStatus::Active { plan, .. }
        | license_core::signed::LicenseStatus::Grace { plan, .. }
        | license_core::signed::LicenseStatus::LockedBackOffice { plan, .. } => plan,
        license_core::signed::LicenseStatus::Invalid { .. } => return Ok(()),
    };
    if plan == "pos_lite" {
        return Err("هذه الباقة (POS خفيف) لا تشمل هذه الميزة -- تواصل معنا للترقية إلى الباقة الكاملة".to_string());
    }
    Ok(())
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

pub(crate) fn login_response(conn: &rusqlite::Connection, actor_id: &str, name: &str, role_str: &str, tenant_id: String, branch_id: Option<String>, device_id: &str) -> Result<LoginV3Response, String> {
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

/// Pure scope-resolution shared by every branch-scoped write that a
/// Tenant-scoped Owner might issue (`open_shift_v3`, `create_table_v3`) --
/// pulled out so it's unit testable without a `Db`/`State` at all.
/// `tenant_branches` is the caller's already-looked-up `(id, name)` list for
/// the actor's own tenant (empty slice is fine when `scope` isn't `Tenant`,
/// since it's never read then).
///
/// `branch_id` is only consulted for a Tenant-scoped caller (Owner) -- an
/// Owner has no home branch (`Actor::scope()` always maps Owner to
/// `Scope::Tenant`, never `Scope::Branch`, regardless of any assigned
/// `branch_id`), so without this they could never open a shift (or create a
/// table) at all, which is exactly the bug this fixes for shifts: the
/// frontend's "start shift" button silently failed for the seeded Owner
/// account with "opening a shift requires a Branch-scoped actor" swallowed
/// by a bare `catch {}`. A Branch-scoped caller (Manager/Cashier/Kitchen/
/// Server) is forced to their own branch regardless of what `branch_id`
/// says, same convention as `create_staff`'s `actor_branch_id`/
/// `target_branch_id` forcing.
pub(crate) fn resolve_branch_for_actor(
    scope: Scope,
    requested_branch_id: Option<String>,
    tenant_branches: &[(String, String)],
) -> Result<(String, String), String> {
    match scope {
        Scope::Branch { tenant_id, branch_id } => Ok((tenant_id, branch_id)),
        Scope::Tenant { tenant_id } => {
            let requested = requested_branch_id.filter(|b| !b.is_empty())
                .ok_or_else(|| "select a branch first".to_string())?;
            if !tenant_branches.iter().any(|(id, _)| id == &requested) {
                return Err("that branch does not belong to your tenant".to_string());
            }
            Ok((tenant_id, requested))
        }
        Scope::Platform => Err("a platform account has no branch to act on".to_string()),
    }
}

/// The single source of truth for "which branch does THIS write act on."
/// Branch-scoped actors (Manager/Cashier/Kitchen/Server) are unambiguous --
/// their own branch, always (`resolve_branch_for_actor`'s original
/// behavior, unchanged). Owner accounts are Tenant-scoped by role design
/// (`Actor::scope()` gives them every branch, since they oversee the whole
/// tenant) -- but the PHYSICAL TERMINAL they're sitting at was licensed for
/// exactly one branch when it was activated, and that doesn't change based
/// on who's currently logged into it. Prefers the device's own license
/// binding (`CloudLicenseState::licensed_branch`) over asking the Owner to
/// pick one from a dropdown every time -- this is what removes the
/// "select a branch" step that was pure friction for the overwhelmingly
/// common one-branch-per-device case, and is also what makes
/// create_debtor_v3/create_supplier_v3/create_ingredient_v3/etc. work for
/// an Owner testing or running the POS directly instead of hard-failing
/// with "requires a Branch-scoped actor." Only falls back to
/// `resolve_branch_for_actor`'s explicit-picker behavior if this terminal
/// has no branch-bound license yet (pre-activation) -- Platform accounts
/// still have no branch to act on, ever.
pub(crate) fn resolve_operating_branch(
    conn: &Connection,
    actor: &Actor,
    license: &crate::license::cloud::CloudLicenseState,
    requested_branch_id: Option<String>,
) -> Result<(String, String), String> {
    let scope = actor.scope();
    if let Scope::Branch { tenant_id, branch_id } = &scope {
        return Ok((tenant_id.clone(), branch_id.clone()));
    }
    if let Scope::Tenant { tenant_id } = &scope {
        if let Some((lic_tenant, lic_branch)) = license.licensed_branch() {
            if &lic_tenant == tenant_id {
                return Ok((lic_tenant, lic_branch));
            }
        }
    }
    let tenant_branches = if let Scope::Tenant { tenant_id } = &scope {
        Repo::new(conn).list_branches(tenant_id).map_err(|e| e.to_string())?
    } else {
        vec![]
    };
    // An unlicensed (or differently-licensed) Owner testing locally with
    // exactly one branch on file has nothing ambiguous to pick between --
    // don't force them through a branch selector that printer setup (and
    // other Owner-testing call sites passing `None`) never actually offers.
    if requested_branch_id.is_none() && tenant_branches.len() == 1 {
        if let Scope::Tenant { tenant_id } = &scope {
            return Ok((tenant_id.clone(), tenant_branches[0].0.clone()));
        }
    }
    resolve_branch_for_actor(scope, requested_branch_id, &tenant_branches)
}

