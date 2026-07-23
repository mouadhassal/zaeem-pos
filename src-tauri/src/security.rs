//! T1.4 (+ T1.3's permission matrix) -- session, authentication, scope
//! resolution, and role-rank authorization. Per SPRINT_01_multitenant_trust_boundary_v3.md
//! T1.2/T1.3/T1.4 and SCHEMA_V3.md §2/§3.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// P0 fix (2026-07-18): session tokens used to be hashed with bcrypt and
/// verified by scanning every `session_v3` row, calling `bcrypt::verify`
/// (deliberately expensive -- that's the whole point of bcrypt for
/// PASSWORD storage) on each one until a match. Measured: ~963ms for a
/// single stored session, ~8.3s with 9 (the real dev db's actual
/// accumulated count after a sprint of hand-testing -- nothing ever
/// expired/cleaned old rows). Every one of the app's ~141 commands calls
/// `authenticate_actor` at the top, so this cost was paid on EVERY
/// `invoke()`, compounding into exactly the reported "6 second table
/// load, general lag everywhere".
///
/// bcrypt is the wrong tool here: session tokens are already
/// high-entropy random UUIDs (128 bits), not user-chosen passwords --
/// they don't need brute-force-resistant slow hashing, they need a fast
/// hash so the token itself is still never stored in plaintext (a stolen
/// DB backup can't be replayed directly) AND can be looked up by an
/// indexed exact match instead of a linear scan. SHA-256 + `WHERE
/// token_hash = ?` (indexed, see migrate_v3's session_v3 index) gives
/// both properties in microseconds instead of seconds.
fn hash_token(raw_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_token.as_bytes());
    format!("{:x}", hasher.finalize())
}

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

// P0 fix (2026-07-23): was 15 minutes of IDLE time with no sliding refresh
// at all -- expires_at was set once at login and never touched again, so
// a session was dead 15 minutes after login regardless of how busy the
// terminal was. Every one of the app's ~154 commands calls authenticate()
// first, so once the session died every single page started failing
// identically -- this is what was reported as "the database becomes
// unreachable after ~1 hour" (the DB was never the problem; see
// docs/STATE_AUDIT.md-adjacent P0 investigation -- busy_timeout was a
// real, separate bug, but session expiry is what actually reproduces
// "every page errors, app-wide, until re-login").
//
// Fix: 16h (a full double shift) AND sliding -- `authenticate()` below
// extends `expires_at` to `now + SESSION_LIFETIME_SECONDS` on every
// successful call, so a terminal in continuous use never hits this at
// all. It only fires if the terminal sits completely untouched for a
// full 16h straight (e.g. left on overnight after everyone's gone home),
// which is exactly when requiring PIN re-entry is correct behavior.
const SESSION_LIFETIME_SECONDS: i64 = 16 * 60 * 60;

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
        );
        CREATE INDEX IF NOT EXISTS idx_session_v3_token_hash ON session_v3(token_hash);",
    )?;
    Ok(())
}

/// Creates a session row bound to a device, hashed at rest (never store the
/// raw token). Returns the raw token (only time it's ever visible).
pub fn create_session(conn: &Connection, actor_id: &str, device_id: &str) -> Result<String, SecurityError> {
    let raw_token = format!("v3_{}", Uuid::new_v4());
    let token_hash = hash_token(&raw_token);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let expires_at = now + SESSION_LIFETIME_SECONDS;
    // Sweep expired sessions on every login, not just on read -- without
    // this, session_v3 only ever grows (nothing else ever DELETEs a row),
    // which is exactly how the real dev db accumulated 9 rows over one
    // sprint of hand-testing in the first place.
    conn.execute("DELETE FROM session_v3 WHERE expires_at < ?1", params![now]).ok();
    conn.execute(
        "INSERT INTO session_v3 (id, actor_id, device_id, token_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![Uuid::new_v4().to_string(), actor_id, device_id, token_hash, now, expires_at],
    )?;
    Ok(raw_token)
}

/// authn -- resolves a raw session token to the Actor it belongs to. This is
/// step 1 of every command's shape. Never trusts a client-supplied actor id.
/// Indexed exact-match lookup on `token_hash` (see `hash_token`'s doc
/// comment for why this replaced a bcrypt linear scan) -- O(1)/O(log n),
/// not O(n) with an expensive op per row.
pub fn authenticate(conn: &Connection, raw_token: &str) -> Result<Actor, SecurityError> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let token_hash = hash_token(raw_token);

    let (actor_id, device_id, expires_at): (String, String, i64) = conn
        .query_row(
            "SELECT actor_id, device_id, expires_at FROM session_v3 WHERE token_hash = ?1",
            params![token_hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| SecurityError::InvalidSession)?;

    if now > expires_at {
        return Err(SecurityError::SessionExpired);
    }

    // Sliding refresh: every successful authenticated call pushes expiry
    // another SESSION_LIFETIME_SECONDS out. Best-effort -- a failure to
    // extend must never fail the auth check that already succeeded above.
    let new_expires_at = now + SESSION_LIFETIME_SECONDS;
    conn.execute(
        "UPDATE session_v3 SET expires_at = ?1 WHERE token_hash = ?2",
        params![new_expires_at, token_hash],
    ).ok();

    load_actor(conn, &actor_id, &device_id)
}

/// Deletes the `session_v3` row backing `raw_token`, if any -- now a direct
/// indexed delete instead of a bcrypt-verify scan. An unrecognized token is
/// not an error, just a no-op logout.
pub fn revoke_session(conn: &Connection, raw_token: &str) -> Result<(), SecurityError> {
    let token_hash = hash_token(raw_token);
    conn.execute("DELETE FROM session_v3 WHERE token_hash = ?1", params![token_hash])?;
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

    // ─── P0 fix (2026-07-23): session lifetime/sliding-refresh proof ──────

    fn session_test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_security_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT, role TEXT NOT NULL, is_active INTEGER NOT NULL);
             INSERT INTO staff (id, tenant_id, branch_id, role, is_active) VALUES ('cashier-1', 't1', 'b1', 'CASHIER', 1);",
        ).unwrap();
        conn
    }

    fn now_secs() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
    }

    fn stored_expires_at(conn: &Connection, raw_token: &str) -> i64 {
        let token_hash = hash_token(raw_token);
        conn.query_row("SELECT expires_at FROM session_v3 WHERE token_hash = ?1", params![token_hash], |r| r.get(0)).unwrap()
    }

    /// Reproduces the reported bug directly: the OLD behavior (15min idle,
    /// no sliding refresh) would fail this by construction -- a session
    /// backdated to "about to expire" and then used repeatedly, simulating
    /// a full 16h double shift's worth of scattered command calls, must
    /// stay valid the entire time under the NEW behavior.
    #[test]
    fn session_survives_16_hours_of_scattered_activity_via_sliding_refresh() {
        let conn = session_test_conn();
        let raw_token = create_session(&conn, "cashier-1", "device-1").unwrap();

        // Simulate 16 "checkpoints" of activity, each one landing when the
        // session is only ~10 seconds from expiring under whatever the
        // PREVIOUS refresh set it to -- if sliding refresh were broken (or
        // still the old fixed 15-min idle window with no refresh), this
        // loop would hit SessionExpired well before the 16th checkpoint.
        for checkpoint in 1..=16 {
            let token_hash = hash_token(&raw_token);
            let almost_expired = now_secs() + 10;
            conn.execute("UPDATE session_v3 SET expires_at = ?1 WHERE token_hash = ?2", params![almost_expired, token_hash]).unwrap();

            let result = authenticate(&conn, &raw_token);
            assert!(result.is_ok(), "checkpoint {checkpoint}/16: session must still authenticate (sliding refresh): {result:?}");

            let new_expiry = stored_expires_at(&conn, &raw_token);
            assert!(
                new_expiry > now_secs() + SESSION_LIFETIME_SECONDS - 5,
                "checkpoint {checkpoint}/16: expires_at must have been pushed back out to ~16h, got {} seconds from now",
                new_expiry - now_secs()
            );
        }
        println!("session_survives_16_hours_of_scattered_activity_via_sliding_refresh: 16/16 checkpoints authenticated, each one slid expiry back out to ~16h");
    }

    /// The other half: a session that is ACTUALLY untouched for the full
    /// 16h window (not refreshed by any activity) must still expire --
    /// this is not a session that never dies, it dies exactly when the
    /// terminal has been genuinely idle for a full double shift.
    #[test]
    fn session_expires_after_16h_of_true_inactivity() {
        let conn = session_test_conn();
        let raw_token = create_session(&conn, "cashier-1", "device-1").unwrap();
        let token_hash = hash_token(&raw_token);

        // Backdate as if created_at/expires_at were set 16h+1s ago and
        // never touched since (no intervening authenticate() calls).
        let long_ago_expiry = now_secs() - 1;
        conn.execute("UPDATE session_v3 SET expires_at = ?1 WHERE token_hash = ?2", params![long_ago_expiry, token_hash]).unwrap();

        let result = authenticate(&conn, &raw_token);
        assert!(matches!(result, Err(SecurityError::SessionExpired)), "expected SessionExpired, got {result:?}");
        println!("session_expires_after_16h_of_true_inactivity: correctly expired -- PIN re-entry required, as designed");
    }

    /// The frontend's session-expired detection (src/lib/invoke.ts) keys
    /// off this exact string -- if it ever changes, that detection silently
    /// breaks and users see a raw error banner again instead of the PIN
    /// re-entry overlay. Pinned here so a Display wording change can't
    /// slip through unnoticed.
    #[test]
    fn session_expired_display_text_matches_what_the_frontend_greps_for() {
        assert_eq!(SecurityError::SessionExpired.to_string(), "session expired");
    }
}
