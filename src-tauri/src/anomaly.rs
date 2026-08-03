//! 2026-08-02: statistical, fully-offline anomaly detection -- no AI
//! vendor involved at all, deliberately. This flags things that could
//! cost an owner real money (theft, cash shortfalls), so every finding
//! has to be something a manager can independently verify against real
//! numbers, not a black-box judgment call from a model. Three signals,
//! chosen for reliability over cleverness -- "small and convincing," per
//! the explicit direction this was built under, not the most
//! sophisticated algorithm available.
use crate::security::Scope;
use chrono::NaiveDateTime;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AnomalyKind {
    HighVoidRate,
    CashVariance,
    VoidResellPattern,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnomalyFinding {
    pub staff_id: String,
    pub staff_name: String,
    pub kind: AnomalyKind,
    pub severity: Severity,
    /// Arabic, human-readable, always includes the real numbers behind
    /// the claim -- never just an accusation with nothing to check.
    pub description: String,
    pub evidence: serde_json::Value,
}

/// A staff member needs to have actually sold enough for a void RATE to
/// mean anything -- 2 voids out of 3 items looks identical to 40 voids
/// out of 60 as a raw percentage, but only one of those is real signal.
const MIN_ITEMS_FOR_VOID_SIGNAL: i64 = 20;
/// Same reasoning for cash variance -- one bad shift happens to everyone.
const MIN_SHIFTS_FOR_CASH_SIGNAL: i64 = 3;
const VOID_RESELL_WINDOW_MINUTES: i64 = 30;

fn scope_predicate(scope: &Scope, alias: &str) -> (String, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1".to_string(), vec![]),
        Scope::Tenant { tenant_id } => (format!("{alias}.tenant_id = ?"), vec![tenant_id.clone()]),
        Scope::Branch { tenant_id, branch_id } => {
            (format!("{alias}.tenant_id = ? AND {alias}.branch_id = ?"), vec![tenant_id.clone(), branch_id.clone()])
        }
    }
}

pub fn detect_anomalies(conn: &Connection, scope: &Scope, days: i64) -> Result<Vec<AnomalyFinding>, rusqlite::Error> {
    let mut findings = Vec::new();
    findings.extend(detect_high_void_rate(conn, scope, days)?);
    findings.extend(detect_cash_variance(conn, scope, days)?);
    findings.extend(detect_void_resell_pattern(conn, scope, days)?);
    Ok(findings)
}

// ---------------------------------------------------------------------------
// Signal 1: void rate meaningfully above the branch average.
// ---------------------------------------------------------------------------

struct VoidStats {
    staff_id: String,
    staff_name: String,
    total_items: i64,
    voided_items: i64,
}

fn detect_high_void_rate(conn: &Connection, scope: &Scope, days: i64) -> Result<Vec<AnomalyFinding>, rusqlite::Error> {
    let (pred, mut binds) = scope_predicate(scope, "s");
    binds.push(format!("-{days} days"));
    let sql = format!(
        "SELECT s.id, s.name, COUNT(*) as total_items, \
                SUM(CASE WHEN oi.voided = 1 THEN 1 ELSE 0 END) as voided_items \
         FROM order_items oi \
         JOIN orders o ON o.id = oi.order_id \
         JOIN staff s ON s.id = o.user_id \
         WHERE {pred} AND o.created_at >= datetime('now', ?) \
         GROUP BY s.id, s.name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<VoidStats> = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(VoidStats { staff_id: r.get(0)?, staff_name: r.get(1)?, total_items: r.get(2)?, voided_items: r.get(3)? })
        })?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(vec![]);
    }

    let branch_total: i64 = rows.iter().map(|r| r.total_items).sum();
    let branch_voided: i64 = rows.iter().map(|r| r.voided_items).sum();
    if branch_total == 0 {
        return Ok(vec![]);
    }
    let branch_avg_rate = branch_voided as f64 / branch_total as f64;

    let mut findings = Vec::new();
    for row in &rows {
        if row.total_items < MIN_ITEMS_FOR_VOID_SIGNAL {
            continue;
        }
        let rate = row.voided_items as f64 / row.total_items as f64;
        // Needs to be BOTH a real multiple of the branch average AND a
        // real absolute gap -- a branch where everyone voids a lot (bad
        // menu design, whatever) shouldn't flag its most average cashier
        // just because 2x-of-high is still high.
        let ratio = if branch_avg_rate > 0.0 { rate / branch_avg_rate } else { f64::INFINITY };
        let gap_pct = (rate - branch_avg_rate) * 100.0;
        if ratio < 2.0 || gap_pct < 10.0 {
            continue;
        }
        let severity = if ratio >= 3.0 { Severity::High } else { Severity::Medium };
        findings.push(AnomalyFinding {
            staff_id: row.staff_id.clone(),
            staff_name: row.staff_name.clone(),
            kind: AnomalyKind::HighVoidRate,
            severity,
            description: format!(
                "معدل إلغاء {:.0}% مقابل متوسط الفرع {:.0}% (بناءً على {} صنف خلال {} يوم)",
                rate * 100.0,
                branch_avg_rate * 100.0,
                row.total_items,
                days
            ),
            evidence: serde_json::json!({
                "void_rate_percent": (rate * 100.0 * 10.0).round() / 10.0,
                "branch_average_percent": (branch_avg_rate * 100.0 * 10.0).round() / 10.0,
                "total_items": row.total_items,
                "voided_items": row.voided_items,
                "window_days": days,
            }),
        });
    }
    Ok(findings)
}

// ---------------------------------------------------------------------------
// Signal 2: shifts that consistently close short on cash, not one bad night.
// ---------------------------------------------------------------------------

struct CashStats {
    staff_id: String,
    staff_name: String,
    shift_count: i64,
    avg_diff_cents: f64,
    short_count: i64,
}

fn detect_cash_variance(conn: &Connection, scope: &Scope, days: i64) -> Result<Vec<AnomalyFinding>, rusqlite::Error> {
    let (pred, mut binds) = scope_predicate(scope, "s");
    binds.push(format!("-{days} days"));
    let sql = format!(
        "SELECT s.id, s.name, COUNT(*) as shift_count, \
                AVG(sh.difference_cents) as avg_diff, \
                SUM(CASE WHEN sh.difference_cents < 0 THEN 1 ELSE 0 END) as short_count \
         FROM shifts sh \
         JOIN staff s ON s.id = sh.user_id \
         WHERE {pred} AND sh.closed_at IS NOT NULL AND sh.closed_at >= datetime('now', ?) \
         GROUP BY s.id, s.name"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<CashStats> = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(CashStats {
                staff_id: r.get(0)?,
                staff_name: r.get(1)?,
                shift_count: r.get(2)?,
                avg_diff_cents: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                short_count: r.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let mut findings = Vec::new();
    for row in &rows {
        if row.shift_count < MIN_SHIFTS_FOR_CASH_SIGNAL {
            continue;
        }
        // Consistently short (most shifts negative) AND the average
        // shortfall is real money, not rounding noise.
        let short_ratio = row.short_count as f64 / row.shift_count as f64;
        if short_ratio < 0.6 || row.avg_diff_cents > -500.0 {
            continue;
        }
        let severity = if row.avg_diff_cents <= -2000.0 && short_ratio >= 0.8 { Severity::High } else { Severity::Medium };
        findings.push(AnomalyFinding {
            staff_id: row.staff_id.clone(),
            staff_name: row.staff_name.clone(),
            kind: AnomalyKind::CashVariance,
            severity,
            description: format!(
                "عجز نقدي بمتوسط {:.2} في {} من أصل {} وردية خلال {} يوم",
                -row.avg_diff_cents / 100.0,
                row.short_count,
                row.shift_count,
                days
            ),
            evidence: serde_json::json!({
                "average_difference_cents": row.avg_diff_cents.round() as i64,
                "shifts_short": row.short_count,
                "total_shifts": row.shift_count,
                "window_days": days,
            }),
        });
    }
    Ok(findings)
}

// ---------------------------------------------------------------------------
// Signal 3: the "smoking gun" -- an item voided, then the same cashier
// rings up the same item again for cash shortly after. Correlated
// in-memory (two flat queries + a Rust join) rather than a single
// correlated SQL subquery -- easier to get right and to test.
// ---------------------------------------------------------------------------

struct VoidEvent {
    staff_id: String,
    staff_name: String,
    menu_item_id: String,
    quantity: i64,
    at: NaiveDateTime,
}

struct CashSale {
    staff_id: String,
    menu_item_id: String,
    quantity: i64,
    at: NaiveDateTime,
}

fn parse_dt(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok())
}

fn detect_void_resell_pattern(conn: &Connection, scope: &Scope, days: i64) -> Result<Vec<AnomalyFinding>, rusqlite::Error> {
    let (pred, mut binds) = scope_predicate(scope, "s");
    binds.push(format!("-{days} days"));

    let void_sql = format!(
        "SELECT s.id, s.name, oi.menu_item_id, oi.quantity, o.created_at \
         FROM order_items oi \
         JOIN orders o ON o.id = oi.order_id \
         JOIN staff s ON s.id = o.user_id \
         WHERE oi.voided = 1 AND {pred} AND o.created_at >= datetime('now', ?)"
    );
    let mut void_stmt = conn.prepare(&void_sql)?;
    let voids: Vec<VoidEvent> = void_stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            let at_str: String = r.get(4)?;
            Ok((
                VoidEvent {
                    staff_id: r.get(0)?,
                    staff_name: r.get(1)?,
                    menu_item_id: r.get(2)?,
                    quantity: r.get(3)?,
                    at: parse_dt(&at_str).unwrap_or_default(),
                },
                at_str,
            ))
        })?
        .filter_map(|r| r.ok())
        .map(|(v, _)| v)
        .collect();

    if voids.is_empty() {
        return Ok(vec![]);
    }

    let (pred2, mut binds2) = scope_predicate(scope, "s");
    binds2.push(format!("-{days} days"));
    let cash_sql = format!(
        "SELECT o.user_id, oi.menu_item_id, oi.quantity, o.created_at \
         FROM order_items oi \
         JOIN orders o ON o.id = oi.order_id \
         JOIN staff s ON s.id = o.user_id \
         JOIN payments p ON p.order_id = o.id AND p.method = 'CASH' \
         WHERE oi.voided = 0 AND {pred2} AND o.created_at >= datetime('now', ?)"
    );
    let mut cash_stmt = conn.prepare(&cash_sql)?;
    let cash_sales: Vec<CashSale> = cash_stmt
        .query_map(params_from_iter(binds2.iter()), |r| {
            let at_str: String = r.get(3)?;
            Ok(CashSale { staff_id: r.get(0)?, menu_item_id: r.get(1)?, quantity: r.get(2)?, at: parse_dt(&at_str).unwrap_or_default() })
        })?
        .filter_map(|r| r.ok())
        .collect();

    let window = chrono::Duration::minutes(VOID_RESELL_WINDOW_MINUTES);
    let mut matches_per_staff: HashMap<String, (String, Vec<serde_json::Value>)> = HashMap::new();

    for v in &voids {
        let matched = cash_sales.iter().find(|c| {
            c.staff_id == v.staff_id
                && c.menu_item_id == v.menu_item_id
                && c.quantity >= v.quantity
                && c.at >= v.at
                && c.at <= v.at + window
        });
        if let Some(c) = matched {
            let entry = matches_per_staff.entry(v.staff_id.clone()).or_insert_with(|| (v.staff_name.clone(), vec![]));
            entry.1.push(serde_json::json!({
                "menu_item_id": v.menu_item_id,
                "voided_at": v.at.to_string(),
                "resold_at": c.at.to_string(),
            }));
        }
    }

    let mut findings = Vec::new();
    for (staff_id, (staff_name, evidence)) in matches_per_staff {
        let count = evidence.len();
        if count == 0 {
            continue;
        }
        let severity = if count >= 4 { Severity::High } else if count >= 2 { Severity::Medium } else { Severity::Low };
        findings.push(AnomalyFinding {
            staff_id,
            staff_name,
            kind: AnomalyKind::VoidResellPattern,
            severity,
            description: format!(
                "{count} حالة: إلغاء صنف ثم بيع نفس الصنف نقداً خلال {VOID_RESELL_WINDOW_MINUTES} دقيقة، لنفس الموظف، خلال {days} يوم"
            ),
            evidence: serde_json::json!({ "occurrences": evidence, "window_minutes": VOID_RESELL_WINDOW_MINUTES }),
        });
    }
    Ok(findings)
}
