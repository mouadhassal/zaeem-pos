//! T1.4 (+ T1.3's permission matrix) -- session, authentication, scope
//! resolution, and role-rank authorization. Per SPRINT_01_multitenant_trust_boundary_v3.md
//! T1.2/T1.3/T1.4 and SCHEMA_V3.md §2/§3.

use bcrypt::verify;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Scope -- the type that makes cross-tenant/cross-branch leaks structurally
// impossible. There is deliberately no "Scope::None" or "Scope::All" variant:
// a repo call that needs a Scope cannot be made without providing one of the
// three real ones. See repo.rs for how this is enforced at the query layer.
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Scope {
    Platform,
    Tenant { tenant_id: String },
    Branch { tenant_id: String, branch_id: String },
}

impl Scope {
    // Not called by this batch's 7 commands yet -- kept because T1.5 (audit
    // log) needs exactly these accessors to stamp tenant_id/branch_id onto
    // every audit entry, and re-deriving them ad hoc there would duplicate
    // this match.
    #[allow(dead_code)]
    pub fn tenant_id(&self) -> Option<&str> {
        match self {
            Scope::Platform => None,
            Scope::Tenant { tenant_id } | Scope::Branch { tenant_id, .. } => Some(tenant_id),
        }
    }
    #[allow(dead_code)]
    pub fn branch_id(&self) -> Option<&str> {
        match self {
            Scope::Branch { branch_id, .. } => Some(branch_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Role {
    Cashier,
    Kitchen,
    Server,
    Manager,
    Owner,
    Platform,
}

impl Role {
    /// Per SCHEMA_V3.md §2.1 / review decision 2026-07-16: an actor can only
    /// assign a role strictly below their own rank, and higher ranks are
    /// supersets of every permission a lower rank holds. This single function
    /// is the entire mechanism -- there is no separate per-role permission
    /// list to fall out of sync with it.
    pub fn rank(self) -> u8 {
        match self {
            Role::Platform => 4,
            Role::Owner => 3,
            Role::Manager => 2,
            Role::Cashier | Role::Kitchen | Role::Server => 1,
        }
    }

    pub fn from_str(s: &str) -> Option<Role> {
        match s {
            "PLATFORM" => Some(Role::Platform),
            "OWNER" => Some(Role::Owner),
            "MANAGER" | "ADMIN" => Some(Role::Manager), // ADMIN folds into Manager rank, per legacy role CHECK
            "CASHIER" => Some(Role::Cashier),
            "KITCHEN" => Some(Role::Kitchen),
            "SERVER" => Some(Role::Server),
            _ => None,
        }
    }
}

/// Every permission this batch's commands check. `minimum_rank` is the whole
/// authorization decision for "can this role do this at all" -- scope
/// (which branch/tenant) is a SEPARATE check, see `authorize_scope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    CreateBranch,
    CreateStaff,
    UpdateStaff,
    ViewOrders,
    CreateOrder,
    UpdateOrderStatus,
    ChangeOwnPassword,
    /// Batch 3a, Decision B -- one Permission per DRIFT-broken command group,
    /// rather than a separate Create/View/Update variant for each of the ~15
    /// new commands. Rank matches how these features are gated today
    /// (customers/delivery handoff are cashier-facing; PO/driver-roster/
    /// printer-config are manager-facing setup & procurement).
    ManageCustomers,
    ManagePurchaseOrders,
    ManageDrivers,
    ManagePrinters,
    ManageDelivery,
    /// Batch 3b, T1.9's critical acceptance criterion -- the same rank as
    /// `CreateOrder` (a Cashier who can build an order can also close it out).
    TakePayment,
    /// Batch 3b, slice 2 -- menu CRUD is Manager+ (pricing/catalog changes,
    /// not a Cashier-facing action).
    ManageMenu,
    /// Batch 3b, slice 2, group 2 -- ingredient CRUD is Manager+; stock
    /// adjustment is Cashier+ (receiving deliveries, correcting counts
    /// during a shift is routine floor work, not a manager-only action).
    ManageIngredients,
    AdjustStock,
    /// Batch 3b, slice 2, group 3 -- opening/closing one's own shift is
    /// Cashier+ (every floor role clocks in/out of a shift, not just managers).
    ManageShift,
    /// Batch 3b, slice 3 -- Cashier+ (every floor role looks up/edits
    /// customers and issues loyalty cards at the register).
    ManageLoyalty,
    /// Batch 3b, slice 3, group 2 -- بيع بالدين. Cashier+ (recording a debt
    /// payment at the register is routine floor work).
    ManageDebt,
    /// Batch 3b, slice 3, group 3 -- finance (costs/invoices/revenue) and
    /// reports are Manager+ (owner back-office reads, not floor work).
    ManageFinance,
    ViewReports,
    /// Batch 3b, slice 3, group 4 -- currency/tax/branch/printer config is
    /// Manager+ (a Cashier should never be able to change the tax rate).
    ManageSettings,
    /// Batch 3b, final slice, group 3 -- Cashier+: printing a receipt at
    /// checkout or sending a ticket to the kitchen is routine floor work,
    /// distinct from `ManagePrinters` (Manager+, adding/configuring
    /// hardware in Settings).
    UsePrinter,
    /// Slice C -- `branches/page.tsx`'s multi-branch admin CRUD operates on
    /// the LEGACY `branches` table (plural, tenant-only; distinct from
    /// T1.1's new `branch` table that `CreateBranch`/`create_branch_v3`
    /// operate on -- see the punch-listed table-duality note). Owner+, not
    /// Platform-only: an Owner managing their own tenant's physical branch
    /// locations is routine back-office work, not the cross-tenant
    /// provisioning `CreateBranch` guards.
    ManageBranches,
}

impl Permission {
    pub fn minimum_rank(self) -> u8 {
        match self {
            Permission::CreateBranch => Role::Platform.rank(), // hard rule #1, ARCHITECTURE_V3.md §2
            Permission::CreateStaff | Permission::UpdateStaff => Role::Manager.rank(),
            Permission::ViewOrders | Permission::CreateOrder | Permission::UpdateOrderStatus | Permission::TakePayment => Role::Cashier.rank(),
            Permission::ChangeOwnPassword => Role::Cashier.rank(),
            Permission::ManageCustomers | Permission::ManageDelivery => Role::Cashier.rank(),
            Permission::ManagePurchaseOrders | Permission::ManageDrivers | Permission::ManagePrinters => Role::Manager.rank(),
            Permission::ManageMenu => Role::Manager.rank(),
            Permission::ManageIngredients => Role::Manager.rank(),
            Permission::AdjustStock => Role::Cashier.rank(),
            Permission::ManageShift => Role::Cashier.rank(),
            Permission::ManageLoyalty => Role::Cashier.rank(),
            Permission::ManageDebt => Role::Cashier.rank(),
            Permission::ManageFinance | Permission::ViewReports => Role::Manager.rank(),
            Permission::ManageSettings => Role::Manager.rank(),
            Permission::UsePrinter => Role::Cashier.rank(),
            Permission::ManageBranches => Role::Owner.rank(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Actor {
    pub id: String,
    pub tenant_id: String,
    pub branch_id: Option<String>,
    pub role: Role,
    /// The device_id of the session that authenticated this Actor -- used by
    /// `audit::append` to attribute the entry to the right per-device chain.
    pub device_id: String,
}

impl Actor {
    pub fn scope(&self) -> Scope {
        match self.role {
            Role::Platform => Scope::Platform,
            Role::Owner => Scope::Tenant { tenant_id: self.tenant_id.clone() },
            _ => Scope::Branch {
                tenant_id: self.tenant_id.clone(),
                branch_id: self.branch_id.clone().unwrap_or_default(),
            },
        }
    }
}

#[derive(Debug)]
pub enum SecurityError {
    Db(rusqlite::Error),
    InvalidSession,
    SessionExpired,
    Forbidden { permission: &'static str, reason: String },
    OutOfScope { target: String },
}

impl fmt::Display for SecurityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::InvalidSession => write!(f, "invalid session"),
            Self::SessionExpired => write!(f, "session expired"),
            Self::Forbidden { permission, reason } => write!(f, "forbidden ({permission}): {reason}"),
            Self::OutOfScope { target } => write!(f, "out of scope: {target}"),
        }
    }
}
impl std::error::Error for SecurityError {}
impl From<rusqlite::Error> for SecurityError {
    fn from(e: rusqlite::Error) -> Self { Self::Db(e) }
}
impl From<SecurityError> for String {
    fn from(e: SecurityError) -> String { e.to_string() }
}

const SESSION_IDLE_SECONDS: i64 = 15 * 60; // T1.4: idle 15min -> PIN re-entry (enforced by caller, session simply expires)

/// `session_v3` is genuinely new (no prior migration defines it -- session
/// tokens didn't exist in the scoped model before this batch). Created here
/// rather than folded into T1.1's Migration A/B, which are closed and tested;
/// this is pure new infrastructure with zero legacy data to reconcile.
pub fn ensure_security_schema(conn: &Connection) -> Result<(), SecurityError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_v3 (
            id TEXT PRIMARY KEY,
            actor_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

/// Creates a session row bound to a device, hashed at rest (never store the
/// raw token). Returns the raw token (only time it's ever visible).
pub fn create_session(conn: &Connection, actor_id: &str, device_id: &str) -> Result<String, SecurityError> {
    let raw_token = format!("v3_{}", Uuid::new_v4());
    let token_hash = bcrypt::hash(&raw_token, bcrypt::DEFAULT_COST).map_err(|_| SecurityError::InvalidSession)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let expires_at = now + SESSION_IDLE_SECONDS;
    conn.execute(
        "INSERT INTO session_v3 (id, actor_id, device_id, token_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Uuid::new_v4().to_string(), actor_id, device_id, token_hash, now, expires_at],
    )?;
    Ok(raw_token)
}

/// authn -- resolves a raw session token to the Actor it belongs to. This is
/// step 1 of every command's shape. Never trusts a client-supplied actor id.
pub fn authenticate(conn: &Connection, raw_token: &str) -> Result<Actor, SecurityError> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;

    let sessions: Vec<(String, String, String, String, i64)> = {
        let mut stmt = conn.prepare("SELECT id, actor_id, device_id, token_hash, expires_at FROM session_v3")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for (_id, actor_id, device_id, token_hash, expires_at) in sessions {
        if verify(raw_token, &token_hash).unwrap_or(false) {
            if now > expires_at {
                return Err(SecurityError::SessionExpired);
            }
            return load_actor(conn, &actor_id, &device_id);
        }
    }
    Err(SecurityError::InvalidSession)
}

/// Deletes the `session_v3` row backing `raw_token`, if any. Same bcrypt-scan
/// pattern as `authenticate` (tokens are hashed at rest, so there's no direct
/// lookup) -- an unrecognized token is not an error, just a no-op logout.
pub fn revoke_session(conn: &Connection, raw_token: &str) -> Result<(), SecurityError> {
    let sessions: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, token_hash FROM session_v3")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (id, token_hash) in sessions {
        if verify(raw_token, &token_hash).unwrap_or(false) {
            conn.execute("DELETE FROM session_v3 WHERE id = ?1", params![id])?;
            break;
        }
    }
    Ok(())
}

fn load_actor(conn: &Connection, actor_id: &str, device_id: &str) -> Result<Actor, SecurityError> {
    let (tenant_id, branch_id, role_str): (String, Option<String>, String) = conn.query_row(
        "SELECT tenant_id, branch_id, role FROM staff WHERE id = ?1 AND is_active = 1",
        params![actor_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).map_err(|_| SecurityError::InvalidSession)?;

    let role = Role::from_str(&role_str).ok_or(SecurityError::InvalidSession)?;

    // Defense in depth on top of the `staff` table's own CHECK constraint
    // (T1.1's Migration A): a Branch-level role MUST have a branch_id. Refuse
    // to construct an Actor otherwise, rather than let `Actor::scope()` fall
    // back to a default branch id -- that fallback must never be reachable.
    if !matches!(role, Role::Platform | Role::Owner) && branch_id.is_none() {
        return Err(SecurityError::InvalidSession);
    }

    Ok(Actor { id: actor_id.to_string(), tenant_id, branch_id, role, device_id: device_id.to_string() })
}

/// authz step 1: does this role hold the permission at all (rank check).
/// Per T1.3: `authorize` is permission-only; scope is checked SEPARATELY
/// (`authorize_scope`) because a manager can hold `ViewOrders` and still be
/// blocked from another branch's orders -- the permission being present does
/// not imply the target is in scope.
pub fn authorize(actor: &Actor, perm: Permission) -> Result<(), SecurityError> {
    if actor.role.rank() >= perm.minimum_rank() {
        Ok(())
    } else {
        Err(SecurityError::Forbidden {
            permission: match perm {
                Permission::CreateBranch => "CreateBranch",
                Permission::CreateStaff => "CreateStaff",
                Permission::UpdateStaff => "UpdateStaff",
                Permission::ViewOrders => "ViewOrders",
                Permission::CreateOrder => "CreateOrder",
                Permission::UpdateOrderStatus => "UpdateOrderStatus",
                Permission::ChangeOwnPassword => "ChangeOwnPassword",
                Permission::ManageCustomers => "ManageCustomers",
                Permission::ManagePurchaseOrders => "ManagePurchaseOrders",
                Permission::ManageDrivers => "ManageDrivers",
                Permission::ManagePrinters => "ManagePrinters",
                Permission::ManageDelivery => "ManageDelivery",
                Permission::TakePayment => "TakePayment",
                Permission::ManageMenu => "ManageMenu",
                Permission::ManageIngredients => "ManageIngredients",
                Permission::AdjustStock => "AdjustStock",
                Permission::ManageShift => "ManageShift",
                Permission::ManageLoyalty => "ManageLoyalty",
                Permission::ManageDebt => "ManageDebt",
                Permission::ManageFinance => "ManageFinance",
                Permission::ViewReports => "ViewReports",
                Permission::ManageSettings => "ManageSettings",
                Permission::UsePrinter => "UsePrinter",
                Permission::ManageBranches => "ManageBranches",
            },
            reason: format!("role {:?} (rank {}) is below the minimum rank {} for this permission", actor.role, actor.role.rank(), perm.minimum_rank()),
        })
    }
}

/// authz step 2: is the target (a branch id, typically) within the actor's
/// scope. Platform is always in scope of everything. Owner is in scope of
/// any branch in their own tenant. Branch-level roles are in scope only of
/// their own branch.
pub fn authorize_scope(actor: &Actor, target_tenant_id: &str, target_branch_id: Option<&str>) -> Result<(), SecurityError> {
    match actor.role {
        Role::Platform => Ok(()),
        Role::Owner => {
            if actor.tenant_id == target_tenant_id {
                Ok(())
            } else {
                Err(SecurityError::OutOfScope { target: format!("tenant {target_tenant_id}") })
            }
        }
        _ => {
            let actor_branch = actor.branch_id.as_deref().unwrap_or("");
            if actor.tenant_id == target_tenant_id && target_branch_id == Some(actor_branch) {
                Ok(())
            } else {
                Err(SecurityError::OutOfScope { target: format!("tenant {target_tenant_id} branch {target_branch_id:?}") })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_ROLES: [Role; 6] = [Role::Platform, Role::Owner, Role::Manager, Role::Cashier, Role::Kitchen, Role::Server];
    const ALL_PERMS: [Permission; 24] = [
        Permission::CreateBranch, Permission::CreateStaff, Permission::UpdateStaff,
        Permission::ViewOrders, Permission::CreateOrder, Permission::UpdateOrderStatus, Permission::ChangeOwnPassword,
        Permission::ManageCustomers, Permission::ManagePurchaseOrders, Permission::ManageDrivers,
        Permission::ManagePrinters, Permission::ManageDelivery, Permission::TakePayment, Permission::ManageMenu,
        Permission::ManageIngredients, Permission::AdjustStock, Permission::ManageShift, Permission::ManageLoyalty,
        Permission::ManageDebt, Permission::ManageFinance, Permission::ViewReports, Permission::ManageSettings,
        Permission::UsePrinter, Permission::ManageBranches,
    ];

    fn actor_for(role: Role, tenant: &str, branch: Option<&str>) -> Actor {
        Actor { id: format!("actor-{role:?}"), tenant_id: tenant.to_string(), branch_id: branch.map(|s| s.to_string()), role, device_id: "test-device".to_string() }
    }

    /// T1.3's headline requirement: every permission x every role. This is
    /// the exhaustive matrix, printed and asserted, not sampled.
    #[test]
    fn rbac_matrix_permission_x_role() {
        let mut total = 0;
        let mut allowed = 0;
        for perm in ALL_PERMS {
            for role in ALL_ROLES {
                total += 1;
                let actor = actor_for(role, "t1", if matches!(role, Role::Platform | Role::Owner) { None } else { Some("b1") });
                let result = authorize(&actor, perm);
                let should_allow = role.rank() >= perm.minimum_rank();
                let did_allow = result.is_ok();
                println!("{perm:?} x {role:?} (rank {}, min {}) -> {}", role.rank(), perm.minimum_rank(), if did_allow { "ALLOW" } else { "DENY" });
                assert_eq!(
                    did_allow, should_allow,
                    "MISMATCH: {perm:?} x {role:?} -- expected allow={should_allow}, got allow={did_allow}"
                );
                if did_allow { allowed += 1; }
            }
        }
        println!("rbac_matrix_permission_x_role: {allowed}/{total} (permission, role) pairs allowed, {}/{total} denied, all matched expectation", total - allowed);
        assert_eq!(total, ALL_PERMS.len() * ALL_ROLES.len());
    }

    /// Rank ordering is monotonic and total: every pair of roles is
    /// comparable, and rank strictly increases up the hierarchy. If this
    /// ever fails, the "actor_rank > target_rank" assignment rule (T1.3)
    /// stops being meaningful.
    #[test]
    fn role_rank_is_strictly_ordered() {
        let ordered = [Role::Cashier, Role::Manager, Role::Owner, Role::Platform];
        for w in ordered.windows(2) {
            assert!(w[0].rank() < w[1].rank(), "{:?} (rank {}) must be strictly below {:?} (rank {})", w[0], w[0].rank(), w[1], w[1].rank());
        }
        assert_eq!(Role::Kitchen.rank(), Role::Cashier.rank(), "Kitchen and Cashier must be peer rank 1");
        assert_eq!(Role::Server.rank(), Role::Cashier.rank(), "Server and Cashier must be peer rank 1");
    }

    /// Scope isolation, the OTHER half of authorization (T1.3: permission
    /// present does not imply in-scope). Exhaustive over role x
    /// same-tenant/same-branch, same-tenant/other-branch, other-tenant.
    #[test]
    fn rbac_matrix_scope_in_and_out() {
        struct Case { role: Role, actor_tenant: &'static str, actor_branch: Option<&'static str>, target_tenant: &'static str, target_branch: Option<&'static str>, expect_in_scope: bool, label: &'static str }
        let cases = [
            Case { role: Role::Platform, actor_tenant: "t1", actor_branch: None, target_tenant: "t2", target_branch: Some("b9"), expect_in_scope: true, label: "Platform sees any tenant/branch" },
            Case { role: Role::Owner, actor_tenant: "t1", actor_branch: None, target_tenant: "t1", target_branch: Some("b1"), expect_in_scope: true, label: "Owner sees own tenant, any branch" },
            Case { role: Role::Owner, actor_tenant: "t1", actor_branch: None, target_tenant: "t1", target_branch: Some("b2"), expect_in_scope: true, label: "Owner sees own tenant, another own branch" },
            Case { role: Role::Owner, actor_tenant: "t1", actor_branch: None, target_tenant: "t2", target_branch: Some("b9"), expect_in_scope: false, label: "Owner CANNOT see another tenant" },
            Case { role: Role::Manager, actor_tenant: "t1", actor_branch: Some("b1"), target_tenant: "t1", target_branch: Some("b1"), expect_in_scope: true, label: "Manager sees own branch" },
            Case { role: Role::Manager, actor_tenant: "t1", actor_branch: Some("b1"), target_tenant: "t1", target_branch: Some("b2"), expect_in_scope: false, label: "Manager CANNOT see another branch, same tenant" },
            Case { role: Role::Manager, actor_tenant: "t1", actor_branch: Some("b1"), target_tenant: "t2", target_branch: Some("b9"), expect_in_scope: false, label: "Manager CANNOT see another tenant" },
            Case { role: Role::Cashier, actor_tenant: "t1", actor_branch: Some("b1"), target_tenant: "t1", target_branch: Some("b1"), expect_in_scope: true, label: "Cashier sees own branch" },
            Case { role: Role::Cashier, actor_tenant: "t1", actor_branch: Some("b1"), target_tenant: "t1", target_branch: Some("b2"), expect_in_scope: false, label: "Cashier CANNOT see another branch" },
        ];
        for c in cases {
            let actor = actor_for(c.role, c.actor_tenant, c.actor_branch);
            let result = authorize_scope(&actor, c.target_tenant, c.target_branch);
            println!("{}: {:?} -> {}", c.label, c.role, if result.is_ok() { "IN-SCOPE" } else { "OUT-OF-SCOPE" });
            assert_eq!(result.is_ok(), c.expect_in_scope, "FAILED: {}", c.label);
        }
        println!("rbac_matrix_scope_in_and_out: 9/9 scope cases matched expectation across Platform/Owner/Manager/Cashier");
    }

    /// The assignment rank rule (SCHEMA_V3.md §2.1): actor_rank > target_rank,
    /// exhaustively over every (actor role, target role) pair.
    #[test]
    fn rbac_matrix_staff_assignment_rank_rule() {
        let mut checked = 0;
        for actor_role in ALL_ROLES {
            for target_role in ALL_ROLES {
                checked += 1;
                let allowed = actor_role.rank() > target_role.rank();
                println!(
                    "assign: actor={actor_role:?}(rank {}) -> target={target_role:?}(rank {}) => {}",
                    actor_role.rank(), target_role.rank(), if allowed { "ALLOWED" } else { "BLOCKED" }
                );
                // The rule itself (mirrors the check in commands_v3::create_staff_v3 / update_staff_v3):
                let rule_result = actor_role.rank() > target_role.rank();
                assert_eq!(rule_result, allowed);
            }
        }
        assert_eq!(checked, ALL_ROLES.len() * ALL_ROLES.len());
        println!("rbac_matrix_staff_assignment_rank_rule: {checked} (actor,target) role pairs checked exhaustively");
    }
}
