//! Who may open which part of the system, chosen by the owner.
//!
//! Every shop runs differently: one lets the cashier see the reports, another keeps them to the
//! manager. The owner ticks, per role, which areas that role may use. The rank rules in
//! `security::Permission` stay the default; this table only stores what the owner changed, so an
//! untouched shop behaves exactly as before. The owner (and the platform) are never restricted.
//!
//! The decision is made on the server (`security::authorize` asks the actor's loaded access), so a
//! hidden button is not the only thing standing between a cashier and the numbers.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS role_access (
    tenant_id TEXT NOT NULL,
    role_key  TEXT NOT NULL,
    feature   TEXT NOT NULL,
    allowed   INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, role_key, feature)
);
";

/// The roles the owner can configure. The owner is never in this list.
pub const ROLE_KEYS: [&str; 3] = ["MANAGER", "CASHIER", "KITCHEN"];

/// An area of the system the owner can open or close for a role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    /// The reports page (sales, gifts, no-shows, insights, the assistant).
    Reports,
    /// Printing the sales report as a strip on the receipt printer.
    ReportPrint,
    /// The finance page: costs, invoices, profit.
    Finance,
    /// Ingredients, suppliers, purchase orders and the product stockroom.
    Inventory,
    /// Editing the menu: items, categories, options, offers.
    Menu,
    /// Staff, shifts review, attendance and the weekly schedule.
    Staff,
    /// Refunding an order after it was paid.
    Refund,
    /// The settings page: printers, tax, branch data, preferences.
    Settings,
}

pub const ALL_FEATURES: [Feature; 8] = [
    Feature::Reports,
    Feature::ReportPrint,
    Feature::Finance,
    Feature::Inventory,
    Feature::Menu,
    Feature::Staff,
    Feature::Refund,
    Feature::Settings,
];

impl Feature {
    pub fn key(self) -> &'static str {
        match self {
            Feature::Reports => "reports",
            Feature::ReportPrint => "report_print",
            Feature::Finance => "finance",
            Feature::Inventory => "inventory",
            Feature::Menu => "menu",
            Feature::Staff => "staff",
            Feature::Refund => "refund",
            Feature::Settings => "settings",
        }
    }

    pub fn from_key(k: &str) -> Option<Feature> {
        ALL_FEATURES.iter().copied().find(|f| f.key() == k)
    }

    /// The feature a permission belongs to, if the owner may switch it. Floor work (selling, paying,
    /// shifts, stock counts at the shelf, customers at the till) is deliberately not here.
    pub fn of(perm: crate::security::Permission) -> Option<Feature> {
        use crate::security::Permission as P;
        match perm {
            P::ViewReports => Some(Feature::Reports),
            P::ManageFinance => Some(Feature::Finance),
            P::ManageIngredients | P::ManagePurchaseOrders => Some(Feature::Inventory),
            P::ManageMenu => Some(Feature::Menu),
            P::CreateStaff | P::UpdateStaff | P::ManageRoster => Some(Feature::Staff),
            P::RefundOrder => Some(Feature::Refund),
            P::ManageSettings => Some(Feature::Settings),
            _ => None,
        }
    }
}

/// The role key of a staff role, or `None` for roles that are never restricted.
pub fn role_key(role: crate::security::Role) -> Option<&'static str> {
    use crate::security::Role;
    match role {
        Role::Manager => Some("MANAGER"),
        Role::Cashier | Role::Server => Some("CASHIER"),
        Role::Kitchen => Some("KITCHEN"),
        Role::Owner | Role::Platform => None,
    }
}

/// What a role may do when the owner has changed nothing: today's behaviour.
pub fn default_allowed(role_key: &str, feature: Feature) -> bool {
    match role_key {
        "MANAGER" => !matches!(feature, Feature::Finance),
        _ => false,
    }
}

/// The owner's changes for one role: only the boxes that differ from the default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Access {
    role_key: Option<&'static str>,
    changed: BTreeMap<Feature, bool>,
}

impl Access {
    /// An actor nobody restricts (the owner, the platform), or one whose access was not loaded.
    pub fn unrestricted() -> Access {
        Access::default()
    }

    /// `Some(true/false)` when the owner's table decides, `None` when the rank rule applies.
    pub fn decision(&self, feature: Feature) -> Option<bool> {
        let key = self.role_key?;
        Some(self.changed.get(&feature).copied().unwrap_or_else(|| default_allowed(key, feature)))
    }

    /// May this actor use the feature, counting the owner's table (rank rule as the fallback).
    pub fn allows(&self, feature: Feature, rank_allows: bool) -> bool {
        match self.decision(feature) {
            Some(v) => v,
            None => rank_allows,
        }
    }
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn load_changes(conn: &Connection, tenant_id: &str, role_key: &str) -> Result<BTreeMap<Feature, bool>, String> {
    let mut stmt = conn
        .prepare("SELECT feature, allowed FROM role_access WHERE tenant_id = ?1 AND role_key = ?2")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![tenant_id, role_key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)))
        .map_err(db_err)?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (k, v) = row.map_err(db_err)?;
        if let Some(f) = Feature::from_key(&k) {
            out.insert(f, v);
        }
    }
    Ok(out)
}

/// The access of a signed-in actor. A shop whose table is missing or unreadable keeps the rank rules.
pub fn load_access(conn: &Connection, tenant_id: &str, role: crate::security::Role) -> Access {
    let Some(key) = role_key(role) else { return Access::unrestricted() };
    let changed = load_changes(conn, tenant_id, key).unwrap_or_default();
    Access { role_key: Some(key), changed }
}

/// One cell of the owner's table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessCell {
    pub role: String,
    pub feature: String,
    pub allowed: bool,
}

/// The whole table as the settings screen shows it: every role and feature, with what is in force.
pub fn load_matrix(conn: &Connection, tenant_id: &str) -> Result<Vec<AccessCell>, String> {
    let mut out = Vec::new();
    for key in ROLE_KEYS {
        let changed = load_changes(conn, tenant_id, key)?;
        for f in ALL_FEATURES {
            let allowed = changed.get(&f).copied().unwrap_or_else(|| default_allowed(key, f));
            out.push(AccessCell { role: key.to_string(), feature: f.key().to_string(), allowed });
        }
    }
    Ok(out)
}

/// Saves the table. Only the cells that differ from the default are stored, so the defaults can
/// still be improved later for every shop that never touched them.
pub fn save_matrix(conn: &Connection, tenant_id: &str, cells: &[AccessCell]) -> Result<(), String> {
    for c in cells {
        if !ROLE_KEYS.contains(&c.role.as_str()) {
            return Err(format!("دور غير معروف: {}", c.role));
        }
        if Feature::from_key(&c.feature).is_none() {
            return Err(format!("صلاحية غير معروفة: {}", c.feature));
        }
    }
    conn.execute("DELETE FROM role_access WHERE tenant_id = ?1", params![tenant_id]).map_err(db_err)?;
    for c in cells {
        let f = Feature::from_key(&c.feature).expect("checked above");
        if c.allowed != default_allowed(&c.role, f) {
            conn.execute(
                "INSERT INTO role_access (tenant_id, role_key, feature, allowed) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(tenant_id, role_key, feature) DO UPDATE SET allowed = excluded.allowed",
                params![tenant_id, c.role, c.feature, c.allowed as i64],
            )
            .map_err(db_err)?;
        }
    }
    Ok(())
}

/// What the signed-in person may open, by feature key: sent to the screen to build the sidebar.
pub fn effective_map(conn: &Connection, tenant_id: &str, role: crate::security::Role) -> BTreeMap<String, bool> {
    let access = load_access(conn, tenant_id, role);
    ALL_FEATURES
        .iter()
        .map(|f| (f.key().to_string(), access.decision(*f).unwrap_or(true)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::Role;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    fn cell(role: &str, feature: &str, allowed: bool) -> AccessCell {
        AccessCell { role: role.into(), feature: feature.into(), allowed }
    }

    #[test]
    fn an_untouched_shop_keeps_todays_rules() {
        let conn = db();
        let m = load_access(&conn, "t1", Role::Manager);
        assert_eq!(m.decision(Feature::Reports), Some(true));
        assert_eq!(m.decision(Feature::Finance), Some(false), "finance was never the manager's page");
        let c = load_access(&conn, "t1", Role::Cashier);
        assert_eq!(c.decision(Feature::Reports), Some(false));
        assert_eq!(c.decision(Feature::Menu), Some(false));
        assert!(load_access(&conn, "t1", Role::Owner).decision(Feature::Settings).is_none(), "the owner is never restricted");
        assert!(load_access(&conn, "t1", Role::Platform).decision(Feature::Settings).is_none());
    }

    #[test]
    fn the_owner_can_open_reports_to_cashiers_and_close_them_to_managers() {
        let conn = db();
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true), cell("MANAGER", "reports", false)]).unwrap();
        assert_eq!(load_access(&conn, "t1", Role::Cashier).decision(Feature::Reports), Some(true));
        assert_eq!(load_access(&conn, "t1", Role::Server).decision(Feature::Reports), Some(true), "a server counts as a cashier");
        assert_eq!(load_access(&conn, "t1", Role::Manager).decision(Feature::Reports), Some(false));
        assert_eq!(load_access(&conn, "t1", Role::Cashier).decision(Feature::ReportPrint), Some(false), "printing is its own box");
        assert_eq!(load_access(&conn, "t1", Role::Kitchen).decision(Feature::Reports), Some(false));
    }

    #[test]
    fn one_shop_never_changes_another() {
        let conn = db();
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true)]).unwrap();
        assert_eq!(load_access(&conn, "t2", Role::Cashier).decision(Feature::Reports), Some(false));
    }

    #[test]
    fn only_changes_are_stored_and_saving_replaces_the_old_table() {
        let conn = db();
        let all_default: Vec<AccessCell> = load_matrix(&conn, "t1").unwrap();
        save_matrix(&conn, "t1", &all_default).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM role_access", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the defaults are not stored");
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true)]).unwrap();
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", false)]).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM role_access", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "putting a box back to the default removes the row");
    }

    #[test]
    fn nonsense_is_refused() {
        let conn = db();
        assert!(save_matrix(&conn, "t1", &[cell("OWNER", "reports", false)]).is_err(), "the owner cannot be locked out");
        assert!(save_matrix(&conn, "t1", &[cell("CASHIER", "nuclear_codes", true)]).is_err());
    }

    #[test]
    fn a_missing_table_keeps_the_rank_rules() {
        let conn = Connection::open_in_memory().unwrap();
        let a = load_access(&conn, "t1", Role::Cashier);
        assert_eq!(a.decision(Feature::Reports), Some(false));
        assert!(!a.allows(Feature::Reports, false));
    }

    #[test]
    fn every_switchable_permission_maps_to_a_feature() {
        use crate::security::Permission as P;
        assert_eq!(Feature::of(P::ViewReports), Some(Feature::Reports));
        assert_eq!(Feature::of(P::UpdateStaff), Some(Feature::Staff));
        assert_eq!(Feature::of(P::TakePayment), None, "paying is floor work, never switched off");
        assert_eq!(Feature::of(P::CreateOrder), None);
        assert_eq!(Feature::of(P::ManagePayroll), None, "payroll has its own owner switch");
    }

    fn actor(conn: &Connection, role: Role) -> crate::security::Actor {
        crate::security::Actor { id: "a".into(), tenant_id: "t1".into(), branch_id: Some("b".into()), role, device_id: "d".into(), access: load_access(conn, "t1", role) }
    }

    #[test]
    fn authorize_follows_the_owners_table_not_just_the_rank() {
        use crate::security::{authorize, Permission as P};
        let conn = db();
        assert!(authorize(&actor(&conn, Role::Cashier), P::ViewReports).is_err(), "default: a cashier cannot open reports");
        assert!(authorize(&actor(&conn, Role::Manager), P::ViewReports).is_ok());
        assert!(authorize(&actor(&conn, Role::Manager), P::ManageFinance).is_err(), "finance is not a manager page by default");

        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true), cell("MANAGER", "reports", false), cell("MANAGER", "finance", true)]).unwrap();
        assert!(authorize(&actor(&conn, Role::Cashier), P::ViewReports).is_ok(), "the owner gave the cashier the reports");
        assert!(authorize(&actor(&conn, Role::Cashier), P::ManageMenu).is_err(), "and nothing else");
        assert!(authorize(&actor(&conn, Role::Manager), P::ViewReports).is_err(), "the owner took the reports from the manager");
        assert!(authorize(&actor(&conn, Role::Manager), P::ManageFinance).is_ok());
        assert!(authorize(&actor(&conn, Role::Owner), P::ViewReports).is_ok(), "the owner is never locked out");
        assert!(authorize(&actor(&conn, Role::Cashier), P::TakePayment).is_ok(), "selling is never switched off");
        assert!(authorize(&actor(&conn, Role::Manager), P::TakePayment).is_ok());
        let denied = authorize(&actor(&conn, Role::Manager), P::ViewReports).unwrap_err().to_string();
        assert!(denied.contains("owner"), "the refusal says the owner decided: {denied}");
    }

    #[test]
    fn printing_the_report_is_its_own_box() {
        let conn = db();
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true)]).unwrap();
        let a = actor(&conn, Role::Cashier);
        assert!(!a.access.allows(Feature::ReportPrint, true), "may read, may not print");
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true), cell("CASHIER", "report_print", true)]).unwrap();
        assert!(actor(&conn, Role::Cashier).access.allows(Feature::ReportPrint, true));
        assert!(actor(&conn, Role::Manager).access.allows(Feature::ReportPrint, true), "managers print by default");
        assert!(actor(&conn, Role::Owner).access.allows(Feature::ReportPrint, true));
    }

    #[test]
    fn the_effective_map_is_what_the_sidebar_needs() {
        let conn = db();
        save_matrix(&conn, "t1", &[cell("CASHIER", "reports", true)]).unwrap();
        let m = effective_map(&conn, "t1", Role::Cashier);
        assert_eq!(m.get("reports"), Some(&true));
        assert_eq!(m.get("menu"), Some(&false));
        let owner = effective_map(&conn, "t1", Role::Owner);
        assert!(owner.values().all(|v| *v), "the owner may open everything");
    }
}
