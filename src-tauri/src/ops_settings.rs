//! Owner choices that the server has to enforce (not just a screen preference of one till).
//!
//! Today: how far back a cashier may look in the order history to reprint a receipt. Managers and
//! the owner always see every day; a cashier sees only today and only their own orders unless the
//! owner widens it here. One row per tenant, `ops_settings` (Migration AN).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS ops_settings (
    tenant_id            TEXT PRIMARY KEY,
    cashier_history_days INTEGER NOT NULL DEFAULT 0,
    cashier_sees_all     INTEGER NOT NULL DEFAULT 0
);
";

/// The most days back an owner can allow.
pub const MAX_HISTORY_DAYS: i64 = 90;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryAccess {
    /// 0 = today only; N = today and the N days before it.
    pub cashier_history_days: i64,
    /// A cashier also sees the orders other staff took (to reprint a colleague's receipt).
    pub cashier_sees_all: bool,
}

impl HistoryAccess {
    pub fn validate(&self) -> Result<(), String> {
        if !(0..=MAX_HISTORY_DAYS).contains(&self.cashier_history_days) {
            return Err(format!("عدد الأيام بين 0 و{MAX_HISTORY_DAYS}"));
        }
        Ok(())
    }
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn load_history_access(conn: &Connection, tenant_id: &str) -> Result<HistoryAccess, String> {
    let row = conn
        .query_row(
            "SELECT cashier_history_days, cashier_sees_all FROM ops_settings WHERE tenant_id = ?1",
            params![tenant_id],
            |r| Ok(HistoryAccess { cashier_history_days: r.get(0)?, cashier_sees_all: r.get::<_, i64>(1)? != 0 }),
        )
        .optional()
        .map_err(db_err)?;
    Ok(row.unwrap_or_default())
}

pub fn save_history_access(conn: &Connection, tenant_id: &str, a: &HistoryAccess) -> Result<(), String> {
    a.validate()?;
    conn.execute(
        "INSERT INTO ops_settings (tenant_id, cashier_history_days, cashier_sees_all) VALUES (?1, ?2, ?3) \
         ON CONFLICT(tenant_id) DO UPDATE SET cashier_history_days = ?2, cashier_sees_all = ?3",
        params![tenant_id, a.cashier_history_days, a.cashier_sees_all as i64],
    )
    .map_err(db_err)?;
    Ok(())
}

/// The day a cashier may open: the one asked for, kept inside `[today - days, today]`.
/// Dates are `YYYY-MM-DD` business dates, which sort like text.
pub fn clamp_cashier_date(requested: Option<&str>, today: &str, days: i64) -> String {
    let Some(req) = requested else { return today.to_string() };
    let (Ok(r), Ok(t)) = (
        chrono::NaiveDate::parse_from_str(req, "%Y-%m-%d"),
        chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d"),
    ) else {
        return today.to_string();
    };
    let oldest = t - chrono::Duration::days(days.max(0));
    if r > t {
        today.to_string()
    } else if r < oldest {
        oldest.format("%Y-%m-%d").to_string()
    } else {
        req.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    #[test]
    fn defaults_are_today_and_own_orders_only() {
        let conn = db();
        assert_eq!(load_history_access(&conn, "t1").unwrap(), HistoryAccess { cashier_history_days: 0, cashier_sees_all: false });
    }

    #[test]
    fn saves_per_tenant_and_rejects_nonsense() {
        let conn = db();
        save_history_access(&conn, "t1", &HistoryAccess { cashier_history_days: 7, cashier_sees_all: true }).unwrap();
        assert_eq!(load_history_access(&conn, "t1").unwrap().cashier_history_days, 7);
        assert_eq!(load_history_access(&conn, "t2").unwrap().cashier_history_days, 0, "another shop is unaffected");
        assert!(save_history_access(&conn, "t1", &HistoryAccess { cashier_history_days: -1, cashier_sees_all: false }).is_err());
        assert!(save_history_access(&conn, "t1", &HistoryAccess { cashier_history_days: 400, cashier_sees_all: false }).is_err());
    }

    #[test]
    fn a_cashier_stays_inside_the_allowed_days() {
        assert_eq!(clamp_cashier_date(None, "2026-11-05", 7), "2026-11-05");
        assert_eq!(clamp_cashier_date(Some("2026-11-03"), "2026-11-05", 7), "2026-11-03");
        assert_eq!(clamp_cashier_date(Some("2026-10-01"), "2026-11-05", 7), "2026-10-29", "too old: the oldest allowed day");
        assert_eq!(clamp_cashier_date(Some("2026-11-09"), "2026-11-05", 7), "2026-11-05", "the future is today");
        assert_eq!(clamp_cashier_date(Some("2026-11-04"), "2026-11-05", 0), "2026-11-05", "0 days = today only");
        assert_eq!(clamp_cashier_date(Some("garbage"), "2026-11-05", 7), "2026-11-05");
    }
}
