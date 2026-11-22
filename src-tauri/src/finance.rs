//! The finance ledger: expense categories, the extra fields of an expense, rent contracts,
//! cost reports and the cost-of-sales classes.
//!
//! Money is whole pounds in `*_cents` columns, like everywhere else. Dates are plain
//! `YYYY-MM-DD` text, months `YYYY-MM`.
//!
//! * **Categories**: a fixed list plus the owner's own. Old stored names (إنترنت، صيانة، تسويق،
//!   أخرى) are never rewritten; `canonical_category` maps them to the new name for display,
//!   grouping and filtering.
//! * **Rent**: a contract says how much per day / month / year from a start date. A payment is an
//!   ordinary expense (category إيجار, `reference_type = 'rent'`, `reference_id` = contract) that
//!   names the month it pays for in `accrual_period`.
//! * **Cost basis**: by default a cost that names its month counts in that month (spread over its
//!   days); the owner can choose to count every cost on the day it was paid instead.

use crate::assistant::{qualify, scope_predicate};
use crate::repo::RepoError;
use crate::security::Scope;
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeMap;

pub const RENT_SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS rent_contracts (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    branch_id    TEXT NOT NULL,
    label        TEXT NOT NULL,
    period       TEXT NOT NULL CHECK (period IN ('DAILY', 'MONTHLY', 'YEARLY')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    start_date   TEXT NOT NULL,
    end_date     TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rent_contracts_scope ON rent_contracts (tenant_id, branch_id);
";

pub const RENT_CATEGORY: &str = "إيجار";
pub const RENT_REFERENCE: &str = "rent";

/// The categories the owner picks from, in the order shown.
pub const EXPENSE_CATEGORIES: [&str; 20] = [
    "مشتريات مواد", "إيجار", "رواتب", "كهرباء", "مياه", "محروقات", "غاز", "ضرائب ورسوم", "تأمينات اجتماعية", "ضيافة",
    "هاتف واتصالات", "تغليف", "خدمات عامة", "مستلزمات", "صيانة وإصلاح", "دعاية وتسويق", "مستلزمات مكتبية", "أجور توصيل",
    "وجبات موظفين", "نثريات",
];

/// Names stored before the list changed, and the new name each one counts as.
const LEGACY_CATEGORIES: [(&str, &str); 5] = [
    ("إنترنت", "هاتف واتصالات"),
    ("صيانة", "صيانة وإصلاح"),
    ("تسويق", "دعاية وتسويق"),
    ("أخرى", "نثريات"),
    ("مشتريات من الموردين", "مشتريات مواد"),
];

/// The name a stored category is shown and grouped under.
pub fn canonical_category(stored: &str) -> &str {
    let t = stored.trim();
    LEGACY_CATEGORIES.iter().find(|(old, _)| *old == t).map(|(_, new)| *new).unwrap_or(t)
}

/// Every stored spelling that counts as `canonical` (itself plus the old names).
pub fn names_for(canonical: &str) -> Vec<String> {
    let mut v = vec![canonical.to_string()];
    for (old, new) in LEGACY_CATEGORIES {
        if new == canonical {
            v.push(old.to_string());
        }
    }
    v
}

// ---------------------------------------------------------------------------
// Settings (app_settings key/value, like the delivery settings)
// ---------------------------------------------------------------------------

const KEY_BASIS: &str = "finance.cost_basis";
const KEY_CUSTOM: &str = "finance.custom_categories";
pub const MAX_CUSTOM_CATEGORIES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CostBasis {
    /// A cost that names its month counts in that month (the default).
    #[default]
    Accrual,
    /// Every cost counts on the day it was paid.
    Payment,
}

impl CostBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            CostBasis::Accrual => "accrual",
            CostBasis::Payment => "payment",
        }
    }
    pub fn parse(s: &str) -> Option<CostBasis> {
        match s {
            "accrual" => Some(CostBasis::Accrual),
            "payment" => Some(CostBasis::Payment),
            _ => None,
        }
    }
    /// SQL: true for a cost that is counted by its accrual month.
    pub fn accrued_sql(self) -> &'static str {
        match self {
            CostBasis::Accrual => "length(COALESCE(accrual_period, '')) = 7",
            CostBasis::Payment => "0",
        }
    }
    /// SQL: the day a cost that is not counted by its month falls on.
    pub fn day_sql(self) -> &'static str {
        match self {
            CostBasis::Accrual => "substr(date, 1, 10)",
            CostBasis::Payment => "substr(COALESCE(NULLIF(payment_date, ''), date), 1, 10)",
        }
    }
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0)).optional().ok().flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn cost_basis(conn: &Connection) -> CostBasis {
    read_setting(conn, KEY_BASIS).and_then(|v| CostBasis::parse(&v)).unwrap_or_default()
}

pub fn custom_categories(conn: &Connection) -> Vec<String> {
    read_setting(conn, KEY_CUSTOM).and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok()).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FinanceSettings {
    /// "accrual" or "payment".
    pub cost_basis: String,
    pub custom_categories: Vec<String>,
    /// The built-in list, so the screen needs no copy of it.
    pub builtin_categories: Vec<String>,
}

pub fn load_settings(conn: &Connection) -> FinanceSettings {
    FinanceSettings {
        cost_basis: cost_basis(conn).as_str().to_string(),
        custom_categories: custom_categories(conn),
        builtin_categories: EXPENSE_CATEGORIES.iter().map(|c| c.to_string()).collect(),
    }
}

/// Cleans the owner's list: trimmed, no empties, no repeats, nothing that is already built in.
pub fn clean_custom_categories(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        if name.chars().count() > 40 {
            return Err("اسم البند أطول من 40 حرفاً".to_string());
        }
        let canon = canonical_category(name);
        if EXPENSE_CATEGORIES.contains(&canon) || LEGACY_CATEGORIES.iter().any(|(old, _)| *old == name) {
            continue;
        }
        if !out.iter().any(|c| c == name) {
            out.push(name.to_string());
        }
    }
    if out.len() > MAX_CUSTOM_CATEGORIES {
        return Err(format!("الحد الأقصى {MAX_CUSTOM_CATEGORIES} بنداً خاصاً"));
    }
    Ok(out)
}

pub fn save_settings(conn: &Connection, basis: &str, custom: &[String]) -> Result<(), String> {
    let basis = CostBasis::parse(basis).ok_or_else(|| "طريقة احتساب غير معروفة".to_string())?;
    let custom = clean_custom_categories(custom)?;
    write_setting(conn, KEY_BASIS, basis.as_str())?;
    write_setting(conn, KEY_CUSTOM, &serde_json::to_string(&custom).map_err(|e| e.to_string())?)
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

fn month_key(d: NaiveDate) -> String {
    format!("{:04}-{:02}", d.year(), d.month())
}

fn parse_month(s: &str) -> Option<NaiveDate> {
    if s.len() != 7 {
        return None;
    }
    NaiveDate::parse_from_str(&format!("{s}-01"), "%Y-%m-%d").ok()
}

/// Every day of `month` (`YYYY-MM`) with its share of `amount`. The shares add up to exactly
/// `amount` (the rounding is spread, not dropped). An invalid month gives nothing.
pub fn spread_month(amount: i64, month: &str) -> Vec<(String, i64)> {
    let Some(first) = parse_month(month) else { return Vec::new() };
    let mut days = Vec::new();
    let mut d = first;
    while d.month() == first.month() {
        days.push(d);
        d += Duration::days(1);
    }
    let n = days.len() as i64;
    let mut out = Vec::with_capacity(days.len());
    let mut given = 0;
    for (i, day) in days.iter().enumerate() {
        let upto = amount * (i as i64 + 1) / n;
        out.push((day.format("%Y-%m-%d").to_string(), upto - given));
        given = upto;
    }
    out
}

// ---------------------------------------------------------------------------
// An expense
// ---------------------------------------------------------------------------

pub const PAYMENT_METHODS: [&str; 4] = ["CASH", "CARD", "TRANSFER", "OTHER"];

/// What the owner types for one expense. `normalise` checks it and cleans the text.
#[derive(Debug, Clone, Default)]
pub struct CostFields {
    pub category: String,
    pub amount_cents: i64,
    pub date: String,
    pub notes: Option<String>,
    pub payment_date: Option<String>,
    pub payee: Option<String>,
    pub payment_method: Option<String>,
    pub reference_no: Option<String>,
    pub cost_centre: Option<String>,
    pub accrual_period: Option<String>,
    pub reference_type: Option<String>,
    pub reference_id: Option<String>,
}

fn tidy(v: &mut Option<String>, max: usize, what: &str) -> Result<(), String> {
    if let Some(s) = v {
        let t = s.trim().to_string();
        if t.chars().count() > max {
            return Err(format!("{what} طويل جداً (الحد {max} حرفاً)"));
        }
        *v = if t.is_empty() { None } else { Some(t) };
    }
    Ok(())
}

impl CostFields {
    pub fn normalise(&mut self) -> Result<(), String> {
        self.category = self.category.trim().to_string();
        if self.category.is_empty() {
            return Err("اختر بند المصروف".to_string());
        }
        if self.category.chars().count() > 60 {
            return Err("اسم البند طويل جداً".to_string());
        }
        if self.amount_cents <= 0 {
            return Err("المبلغ يجب أن يكون أكبر من صفر".to_string());
        }
        let date = parse_day(self.date.trim()).ok_or_else(|| "التاريخ غير صحيح".to_string())?;
        self.date = date.format("%Y-%m-%d").to_string();
        tidy(&mut self.notes, 500, "الملاحظات")?;
        tidy(&mut self.payee, 100, "اسم المستفيد")?;
        tidy(&mut self.reference_no, 100, "رقم المرجع")?;
        tidy(&mut self.cost_centre, 100, "مركز التكلفة")?;
        tidy(&mut self.payment_date, 10, "تاريخ الدفع")?;
        tidy(&mut self.accrual_period, 7, "فترة الاستحقاق")?;
        tidy(&mut self.payment_method, 20, "طريقة الدفع")?;
        if let Some(p) = &self.payment_date {
            let d = parse_day(p).ok_or_else(|| "تاريخ الدفع غير صحيح".to_string())?;
            self.payment_date = Some(d.format("%Y-%m-%d").to_string());
        }
        if let Some(m) = &self.accrual_period {
            if parse_month(m).is_none() {
                return Err("فترة الاستحقاق يجب أن تكون بصيغة 2026-11".to_string());
            }
        }
        if let Some(m) = &self.payment_method {
            let up = m.to_uppercase();
            if !PAYMENT_METHODS.contains(&up.as_str()) {
                return Err("طريقة الدفع غير معروفة".to_string());
            }
            self.payment_method = Some(up);
        }
        Ok(())
    }
}

/// Inserts one expense. Returns its id.
pub fn insert_cost(conn: &Connection, tenant_id: &str, branch_id: &str, actor_id: &str, c: &CostFields) -> Result<String, RepoError> {
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO operational_costs (id, tenant_id, branch_id, category, amount_cents, date, notes, user_id, reference_type, reference_id, \
            payment_date, payee, payment_method, reference_no, cost_centre, accrual_period, last_modified, sync_status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, datetime('now'), 'pending')",
        params![
            id, tenant_id, branch_id, c.category, c.amount_cents, c.date, c.notes, actor_id, c.reference_type, c.reference_id,
            c.payment_date, c.payee, c.payment_method, c.reference_no, c.cost_centre, c.accrual_period
        ],
    )?;
    Ok(id)
}

/// Where an expense lives: its shop and branch, and what made it (payroll and supplier
/// payments are edited where they were made, not here).
pub fn cost_owner(conn: &Connection, scope: &Scope, cost_id: &str) -> Result<(String, String, Option<String>), String> {
    let (pred, args) = scope_predicate(scope);
    let mut a = args.clone();
    a.push(cost_id.to_string());
    let sql = format!("SELECT tenant_id, branch_id, reference_type FROM operational_costs WHERE {pred} AND id = ?{}", args.len() + 1);
    conn.query_row(&sql, params_from_iter(a.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "المصروف غير موجود".to_string())
}

/// Edits an expense. Rows made by payroll or a supplier payment are refused.
pub fn update_cost(conn: &Connection, scope: &Scope, cost_id: &str, c: &CostFields) -> Result<(String, String), String> {
    let (tenant_id, branch_id, reference_type) = cost_owner(conn, scope, cost_id)?;
    if let Some(rt) = reference_type.as_deref() {
        if rt != RENT_REFERENCE {
            return Err("هذا المصروف أنشأه النظام (راتب أو دفعة مورّد)، يُعدَّل من مكانه".to_string());
        }
    }
    conn.execute(
        "UPDATE operational_costs SET category = ?1, amount_cents = ?2, date = ?3, notes = ?4, payment_date = ?5, payee = ?6, \
            payment_method = ?7, reference_no = ?8, cost_centre = ?9, accrual_period = ?10, last_modified = datetime('now'), sync_status = 'pending' \
         WHERE id = ?11",
        params![c.category, c.amount_cents, c.date, c.notes, c.payment_date, c.payee, c.payment_method, c.reference_no, c.cost_centre, c.accrual_period, cost_id],
    )
    .map_err(|e| e.to_string())?;
    Ok((tenant_id, branch_id))
}

pub fn set_attachment(conn: &Connection, scope: &Scope, cost_id: &str, path: Option<&str>) -> Result<(String, String), String> {
    let (tenant_id, branch_id, _) = cost_owner(conn, scope, cost_id)?;
    conn.execute("UPDATE operational_costs SET attachment_path = ?1, last_modified = datetime('now') WHERE id = ?2", params![path, cost_id])
        .map_err(|e| e.to_string())?;
    Ok((tenant_id, branch_id))
}

pub fn attachment_path(conn: &Connection, scope: &Scope, cost_id: &str) -> Result<Option<String>, String> {
    cost_owner(conn, scope, cost_id)?;
    conn.query_row("SELECT attachment_path FROM operational_costs WHERE id = ?1", params![cost_id], |r| r.get(0)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Listing and reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct CostFilter {
    /// `YYYY-MM-DD`, inclusive.
    pub from: Option<String>,
    pub to: Option<String>,
    /// A category name (old spellings count too).
    pub category: Option<String>,
    pub cost_centre: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostRow {
    pub id: String,
    pub category: String,
    /// The name it is shown under (old names mapped to the new list).
    pub category_label: String,
    pub amount_cents: i64,
    pub notes: Option<String>,
    pub date: String,
    pub payment_date: Option<String>,
    pub payee: Option<String>,
    pub payment_method: Option<String>,
    pub reference_no: Option<String>,
    pub cost_centre: Option<String>,
    pub has_attachment: bool,
    pub accrual_period: Option<String>,
    pub reference_type: Option<String>,
    pub reference_id: Option<String>,
}

fn filter_sql(scope: &Scope, basis: CostBasis, f: &CostFilter) -> (String, Vec<String>) {
    let (pred, mut args) = scope_predicate(scope);
    let mut sql = pred.to_string();
    let (accrued, day) = (basis.accrued_sql(), basis.day_sql());
    // A cost counted by its month is in range when that month touches the range.
    if let Some(from) = f.from.as_deref().filter(|s| s.len() >= 10) {
        args.push(from[..10].to_string());
        let i = args.len();
        sql += &format!(" AND (({accrued}) AND accrual_period >= substr(?{i}, 1, 7) OR NOT ({accrued}) AND {day} >= ?{i})");
    }
    if let Some(to) = f.to.as_deref().filter(|s| s.len() >= 10) {
        args.push(to[..10].to_string());
        let i = args.len();
        sql += &format!(" AND (({accrued}) AND accrual_period <= substr(?{i}, 1, 7) OR NOT ({accrued}) AND {day} <= ?{i})");
    }
    if let Some(cat) = f.category.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let names = names_for(canonical_category(cat));
        let marks: Vec<String> = names
            .iter()
            .map(|n| {
                args.push(n.clone());
                format!("?{}", args.len())
            })
            .collect();
        sql += &format!(" AND category IN ({})", marks.join(", "));
    }
    if let Some(cc) = f.cost_centre.as_deref() {
        if cc == "-" {
            sql += " AND COALESCE(cost_centre, '') = ''";
        } else if !cc.trim().is_empty() {
            args.push(cc.trim().to_string());
            sql += &format!(" AND cost_centre = ?{}", args.len());
        }
    }
    (sql, args)
}

pub fn list_costs(conn: &Connection, scope: &Scope, f: &CostFilter, limit: i64) -> Result<Vec<CostRow>, RepoError> {
    let basis = cost_basis(conn);
    let (w, args) = filter_sql(scope, basis, f);
    let sql = format!(
        "SELECT id, category, amount_cents, notes, date, payment_date, payee, payment_method, reference_no, cost_centre, \
                COALESCE(attachment_path, '') <> '', accrual_period, reference_type, reference_id \
         FROM operational_costs WHERE {w} ORDER BY substr(date, 1, 10) DESC, id DESC LIMIT {}",
        limit.clamp(1, 2000)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        let category: String = r.get(1)?;
        Ok(CostRow {
            id: r.get(0)?,
            category_label: canonical_category(&category).to_string(),
            category,
            amount_cents: r.get(2)?,
            notes: r.get(3)?,
            date: r.get(4)?,
            payment_date: r.get(5)?,
            payee: r.get(6)?,
            payment_method: r.get(7)?,
            reference_no: r.get(8)?,
            cost_centre: r.get(9)?,
            has_attachment: r.get(10)?,
            accrual_period: r.get(11)?,
            reference_type: r.get(12)?,
            reference_id: r.get(13)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(RepoError::from)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CostGroup {
    pub key: String,
    pub label: String,
    pub total_cents: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CostReport {
    pub group_by: String,
    pub total_cents: i64,
    pub count: i64,
    pub groups: Vec<CostGroup>,
}

pub const NO_COST_CENTRE: &str = "بدون مركز تكلفة";

/// Totals of the filtered costs grouped by `category`, `period` (month) or `cost_centre`.
pub fn cost_report(conn: &Connection, scope: &Scope, f: &CostFilter, group_by: &str) -> Result<CostReport, String> {
    if !["category", "period", "cost_centre"].contains(&group_by) {
        return Err("تجميع غير معروف".to_string());
    }
    let basis = cost_basis(conn);
    let (w, args) = filter_sql(scope, basis, f);
    let (accrued, day) = (basis.accrued_sql(), basis.day_sql());
    let sql = format!(
        "SELECT category, amount_cents, CASE WHEN {accrued} THEN accrual_period ELSE substr({day}, 1, 7) END, COALESCE(cost_centre, '') \
         FROM operational_costs WHERE {w}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut groups: BTreeMap<String, CostGroup> = BTreeMap::new();
    let (mut total, mut count) = (0, 0);
    for (category, amount, month, centre) in rows {
        let (key, label) = match group_by {
            "category" => {
                let c = canonical_category(&category).to_string();
                (c.clone(), c)
            }
            "period" => (month.clone(), month),
            _ => {
                if centre.is_empty() {
                    ("-".to_string(), NO_COST_CENTRE.to_string())
                } else {
                    (centre.clone(), centre)
                }
            }
        };
        let g = groups.entry(key.clone()).or_insert(CostGroup { key, label, total_cents: 0, count: 0 });
        g.total_cents += amount;
        g.count += 1;
        total += amount;
        count += 1;
    }
    let mut groups: Vec<CostGroup> = groups.into_values().collect();
    if group_by != "period" {
        groups.sort_by(|a, b| b.total_cents.cmp(&a.total_cents).then_with(|| a.key.cmp(&b.key)));
    }
    Ok(CostReport { group_by: group_by.to_string(), total_cents: total, count, groups })
}

// ---------------------------------------------------------------------------
// Rent
// ---------------------------------------------------------------------------

pub const RENT_PERIODS: [&str; 3] = ["DAILY", "MONTHLY", "YEARLY"];

/// What a contract has fallen due, month by month (`YYYY-MM` -> amount), from its start to
/// `min(today, end)`. A MONTHLY period starts on the start date's day each month, a YEARLY one on
/// its anniversary, a DAILY one every day; each is due the moment it starts and is filed under the
/// month it starts in.
pub fn due_by_month(period: &str, amount_cents: i64, start: NaiveDate, end: Option<NaiveDate>, today: NaiveDate) -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    let last = end.map_or(today, |e| e.min(today));
    if start > last {
        return out;
    }
    let step_months = match period {
        "MONTHLY" => 1u32,
        "YEARLY" => 12,
        _ => 0,
    };
    if step_months == 0 {
        let mut d = start;
        while d <= last {
            *out.entry(month_key(d)).or_insert(0) += amount_cents;
            d += Duration::days(1);
        }
    } else {
        let mut i = 0u32;
        while let Some(d) = start.checked_add_months(chrono::Months::new(i * step_months)) {
            if d > last {
                break;
            }
            *out.entry(month_key(d)).or_insert(0) += amount_cents;
            i += 1;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RentMonthRow {
    pub period: String,
    pub due_cents: i64,
    pub paid_cents: i64,
    /// `due - paid`; negative means paid ahead.
    pub remaining_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RentContract {
    pub id: String,
    pub label: String,
    pub period: String,
    pub amount_cents: i64,
    pub start_date: String,
    pub end_date: Option<String>,
    pub active: bool,
    pub due_cents: i64,
    pub paid_cents: i64,
    /// What is still owed (never negative).
    pub outstanding_cents: i64,
    /// Paid beyond what has fallen due.
    pub advance_cents: i64,
    pub months: Vec<RentMonthRow>,
}

/// Builds the month table: every month with something due or paid, oldest first.
pub fn month_rows(due: &BTreeMap<String, i64>, paid: &BTreeMap<String, i64>) -> Vec<RentMonthRow> {
    let mut keys: Vec<&String> = due.keys().chain(paid.keys()).collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .map(|k| {
            let (d, p) = (due.get(k).copied().unwrap_or(0), paid.get(k).copied().unwrap_or(0));
            RentMonthRow { period: k.clone(), due_cents: d, paid_cents: p, remaining_cents: d - p }
        })
        .collect()
}

pub fn rent_contracts(conn: &Connection, scope: &Scope, today: &str) -> Result<Vec<RentContract>, String> {
    let today = parse_day(today).ok_or_else(|| "التاريخ غير صحيح".to_string())?;
    let (pred, args) = scope_predicate(scope);
    let mut stmt = conn
        .prepare(&format!("SELECT id, label, period, amount_cents, start_date, end_date, active FROM rent_contracts WHERE {pred} ORDER BY active DESC, start_date DESC, id"))
        .map_err(|e| e.to_string())?;
    let list = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, i64>(6)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // What was paid, by contract and month. A payment with no month counts in the month it was made.
    let mut paid: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT reference_id, COALESCE(NULLIF(accrual_period, ''), substr(date, 1, 7)), COALESCE(SUM(amount_cents), 0) \
                 FROM operational_costs WHERE {pred} AND reference_type = '{RENT_REFERENCE}' GROUP BY 1, 2"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (cid, month, sum) in rows {
            if let Some(cid) = cid {
                *paid.entry(cid).or_default().entry(month).or_insert(0) += sum;
            }
        }
    }

    let mut out = Vec::new();
    for (id, label, period, amount, start, end, active) in list {
        let start_d = parse_day(&start).ok_or_else(|| "تاريخ بداية العقد غير صحيح".to_string())?;
        let end_d = end.as_deref().and_then(parse_day);
        let due = due_by_month(&period, amount, start_d, end_d, today);
        let p = paid.remove(&id).unwrap_or_default();
        let (due_total, paid_total): (i64, i64) = (due.values().sum(), p.values().sum());
        out.push(RentContract {
            months: month_rows(&due, &p),
            id,
            label,
            period,
            amount_cents: amount,
            start_date: start,
            end_date: end,
            active: active != 0,
            due_cents: due_total,
            paid_cents: paid_total,
            outstanding_cents: (due_total - paid_total).max(0),
            advance_cents: (paid_total - due_total).max(0),
        });
    }
    Ok(out)
}

/// What the owner types for a contract.
#[derive(Debug, Clone)]
pub struct RentInput {
    pub label: String,
    pub period: String,
    pub amount_cents: i64,
    pub start_date: String,
    pub end_date: Option<String>,
    pub active: bool,
}

impl RentInput {
    pub fn validate(&mut self, today: &str) -> Result<(), String> {
        self.label = self.label.trim().to_string();
        if self.label.is_empty() || self.label.chars().count() > 100 {
            return Err("اكتب اسم العقد (مثلاً: إيجار المحل)".to_string());
        }
        if !RENT_PERIODS.contains(&self.period.as_str()) {
            return Err("نوع الدفعة غير معروف".to_string());
        }
        if self.amount_cents <= 0 {
            return Err("المبلغ يجب أن يكون أكبر من صفر".to_string());
        }
        let start = parse_day(self.start_date.trim()).ok_or_else(|| "تاريخ البداية غير صحيح".to_string())?;
        self.start_date = start.format("%Y-%m-%d").to_string();
        self.end_date = match self.end_date.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(e) => {
                let end = parse_day(e).ok_or_else(|| "تاريخ النهاية غير صحيح".to_string())?;
                if end < start {
                    return Err("تاريخ النهاية قبل البداية".to_string());
                }
                Some(end.format("%Y-%m-%d").to_string())
            }
            None => None,
        };
        // A stopped contract stops accruing today unless the owner gave an end date.
        if !self.active && self.end_date.is_none() {
            let t = parse_day(today).ok_or_else(|| "التاريخ غير صحيح".to_string())?;
            self.end_date = Some(t.max(start).format("%Y-%m-%d").to_string());
        }
        Ok(())
    }
}

pub fn save_rent_contract(conn: &Connection, tenant_id: &str, branch_id: &str, scope: &Scope, id: Option<&str>, r: &RentInput) -> Result<String, String> {
    match id {
        Some(id) => {
            let (pred, args) = scope_predicate(scope);
            let mut a = args.clone();
            a.extend([r.label.clone(), r.period.clone(), r.start_date.clone()]);
            let n = args.len();
            let mut sql = format!("UPDATE rent_contracts SET label = ?{}, period = ?{}, start_date = ?{}, amount_cents = {}, active = {}, ", n + 1, n + 2, n + 3, r.amount_cents, r.active as i64);
            match &r.end_date {
                Some(e) => {
                    a.push(e.clone());
                    sql += &format!("end_date = ?{} ", n + 4);
                }
                None => sql += "end_date = NULL ",
            }
            a.push(id.to_string());
            sql += &format!("WHERE {pred} AND id = ?{}", a.len());
            let changed = conn.execute(&sql, params_from_iter(a.iter())).map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("العقد غير موجود".to_string());
            }
            Ok(id.to_string())
        }
        None => {
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO rent_contracts (id, tenant_id, branch_id, label, period, amount_cents, start_date, end_date, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, tenant_id, branch_id, r.label, r.period, r.amount_cents, r.start_date, r.end_date, r.active as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// Records a rent payment as an ordinary expense linked to the contract. The month it pays for
/// defaults to the month of the payment date.
pub fn record_rent_payment(conn: &Connection, scope: &Scope, actor_id: &str, contract_id: &str, mut c: CostFields) -> Result<(String, String, String), String> {
    let (pred, args) = scope_predicate(scope);
    let mut a = args.clone();
    a.push(contract_id.to_string());
    let (tenant_id, branch_id, label): (String, String, String) = conn
        .query_row(&format!("SELECT tenant_id, branch_id, label FROM rent_contracts WHERE {pred} AND id = ?{}", args.len() + 1), params_from_iter(a.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "العقد غير موجود".to_string())?;
    c.category = RENT_CATEGORY.to_string();
    c.reference_type = Some(RENT_REFERENCE.to_string());
    c.reference_id = Some(contract_id.to_string());
    if c.notes.as_deref().map(str::trim).unwrap_or("").is_empty() {
        c.notes = Some(label);
    }
    c.normalise()?;
    if c.accrual_period.is_none() {
        c.accrual_period = Some(c.date[..7].to_string());
    }
    let id = insert_cost(conn, &tenant_id, &branch_id, actor_id, &c).map_err(|e| e.to_string())?;
    Ok((id, tenant_id, branch_id))
}

// ---------------------------------------------------------------------------
// Cost classes
// ---------------------------------------------------------------------------

pub const COST_CLASSES: [&str; 4] = ["FOOD", "BEVERAGE", "SHISHA", "OTHER"];

pub fn normalise_cost_class(c: &str) -> Option<&'static str> {
    COST_CLASSES.iter().copied().find(|k| k.eq_ignore_ascii_case(c.trim()))
}

pub fn set_category_cost_class(conn: &Connection, tenant_id: &str, category_id: &str, class: Option<&str>) -> Result<(), String> {
    let class = match class.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => Some(normalise_cost_class(c).ok_or_else(|| "نوع التكلفة غير معروف".to_string())?),
        None => None,
    };
    let changed = conn
        .execute("UPDATE categories SET cost_class = ?1, last_modified = datetime('now') WHERE id = ?2 AND tenant_id = ?3", params![class, category_id, tenant_id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("التصنيف غير موجود".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClassCost {
    pub class: String,
    pub cost_cents: i64,
    /// Share of net sales, in basis points (3000 = 30.00%).
    pub bp: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostOfSales {
    pub net_sales_cents: i64,
    pub classes: Vec<ClassCost>,
    pub total_cost_cents: i64,
    pub total_bp: i64,
    /// Salaries expensed in the period.
    pub labour_cents: i64,
    pub labour_bp: i64,
}

fn share_bp(part: i64, whole: i64) -> i64 {
    if whole > 0 {
        part * 10_000 / whole
    } else {
        0
    }
}

/// What the items sold in the range cost, per cost class (the same line costs the profit uses), each
/// as a share of net sales, plus the salaries expensed in the range as a share of net sales.
pub fn cost_of_sales(conn: &Connection, scope: &Scope, start_iso: &str, end_iso: &str, tz_offset_minutes: i64) -> Result<CostOfSales, RepoError> {
    let (pred, args) = scope_predicate(scope);
    let (ia, ib) = (args.len() + 1, args.len() + 2);
    let mut a = args.clone();
    a.push(start_iso.to_string());
    a.push(end_iso.to_string());
    let p_orders = qualify(pred, "orders");
    let line_cost = crate::profit::LINE_COST_SQL;
    let mut stmt = conn.prepare(&format!(
        "SELECT COALESCE(NULLIF(categories.cost_class, ''), 'FOOD'), COALESCE(SUM({line_cost}), 0) \
         FROM order_items \
         INNER JOIN orders ON orders.id = order_items.order_id \
         INNER JOIN menu_items ON menu_items.id = order_items.menu_item_id \
         LEFT JOIN categories ON categories.id = menu_items.category_id \
         WHERE {p_orders} AND orders.status = 'PAID' AND order_items.voided = 0 \
           AND COALESCE(orders.closed_at, orders.created_at) >= ?{ia} AND COALESCE(orders.closed_at, orders.created_at) <= ?{ib} \
         GROUP BY 1"
    ))?;
    let found = stmt.query_map(params_from_iter(a.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    let totals = crate::profit::summary(conn, scope, start_iso, end_iso, tz_offset_minutes)?.totals;
    let net = totals.net_sales_cents;
    let mut by_class: BTreeMap<&str, i64> = COST_CLASSES.iter().map(|c| (*c, 0)).collect();
    for (class, cost) in found {
        // A stray value in the column counts as FOOD, the same as NULL.
        let key = normalise_cost_class(&class).unwrap_or("FOOD");
        *by_class.entry(key).or_insert(0) += cost;
    }
    let classes: Vec<ClassCost> =
        COST_CLASSES.iter().map(|c| ClassCost { class: c.to_string(), cost_cents: by_class[c], bp: share_bp(by_class[c], net) }).collect();
    let total_cost_cents: i64 = classes.iter().map(|c| c.cost_cents).sum();
    Ok(CostOfSales {
        net_sales_cents: net,
        total_bp: share_bp(total_cost_cents, net),
        total_cost_cents,
        classes,
        labour_cents: totals.salaries_cents,
        labour_bp: share_bp(totals.salaries_cents, net),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn old_category_names_map_to_the_new_list() {
        assert_eq!(canonical_category("إنترنت"), "هاتف واتصالات");
        assert_eq!(canonical_category("صيانة"), "صيانة وإصلاح");
        assert_eq!(canonical_category("تسويق"), "دعاية وتسويق");
        assert_eq!(canonical_category("أخرى"), "نثريات");
        assert_eq!(canonical_category("مشتريات من الموردين"), "مشتريات مواد");
        assert_eq!(canonical_category("إيجار"), "إيجار");
        assert_eq!(canonical_category("بند خاص"), "بند خاص");
        assert_eq!(names_for("هاتف واتصالات"), vec!["هاتف واتصالات".to_string(), "إنترنت".to_string()]);
        assert_eq!(EXPENSE_CATEGORIES.len(), 20);
    }

    #[test]
    fn custom_categories_are_cleaned() {
        let list = vec!["  حلويات ".to_string(), "حلويات".to_string(), "".to_string(), "إيجار".to_string(), "أخرى".to_string(), "مصاريف سفر".to_string()];
        assert_eq!(clean_custom_categories(&list).unwrap(), vec!["حلويات".to_string(), "مصاريف سفر".to_string()]);
        assert!(clean_custom_categories(&["س".repeat(41)]).is_err());
    }

    #[test]
    fn a_month_is_spread_to_the_exact_amount() {
        let s = spread_month(1_000, "2026-11");
        assert_eq!(s.len(), 30);
        assert_eq!(s.iter().map(|(_, c)| c).sum::<i64>(), 1_000);
        assert_eq!(s[0].0, "2026-11-01");
        assert_eq!(s[29].0, "2026-11-30");
        assert!(spread_month(10, "2026-13").is_empty());
        assert_eq!(spread_month(31, "2026-12").iter().map(|(_, c)| *c).collect::<Vec<_>>(), vec![1; 31]);
    }

    #[test]
    fn monthly_rent_falls_due_each_month_from_the_start() {
        // Started 15 Aug: periods start 15 Aug, 15 Sep, 15 Oct, 15 Nov. 22 Nov = 4 periods due.
        let due = due_by_month("MONTHLY", 5_000, day("2026-08-15"), None, day("2026-11-22"));
        assert_eq!(due.values().sum::<i64>(), 20_000);
        assert_eq!(due.keys().cloned().collect::<Vec<_>>(), vec!["2026-08", "2026-09", "2026-10", "2026-11"]);
        // Today is before this month's start day: that period has not started.
        let due = due_by_month("MONTHLY", 5_000, day("2026-08-25"), None, day("2026-11-22"));
        assert_eq!(due.values().sum::<i64>(), 15_000);
        // An end date stops it.
        let due = due_by_month("MONTHLY", 5_000, day("2026-08-01"), Some(day("2026-09-30")), day("2026-11-22"));
        assert_eq!(due.values().sum::<i64>(), 10_000);
        // Not started yet.
        assert!(due_by_month("MONTHLY", 5_000, day("2027-01-01"), None, day("2026-11-22")).is_empty());
        // Start on the 31st: no drift to the 28th.
        let due = due_by_month("MONTHLY", 100, day("2026-01-31"), None, day("2026-03-31"));
        assert_eq!(due.values().sum::<i64>(), 300);
    }

    #[test]
    fn daily_and_yearly_rent() {
        let due = due_by_month("DAILY", 100, day("2026-10-30"), None, day("2026-11-02"));
        assert_eq!(due.get("2026-10"), Some(&200));
        assert_eq!(due.get("2026-11"), Some(&200));
        let due = due_by_month("YEARLY", 12_000, day("2025-03-10"), None, day("2026-11-22"));
        assert_eq!(due.values().sum::<i64>(), 24_000, "paid for 2025 and 2026 starts");
        assert_eq!(due.get("2026-03"), Some(&12_000));
    }

    #[test]
    fn the_month_table_shows_due_paid_and_remaining() {
        let due = due_by_month("MONTHLY", 5_000, day("2026-09-01"), None, day("2026-11-22"));
        let paid: BTreeMap<String, i64> = [("2026-09".to_string(), 5_000), ("2026-10".to_string(), 2_000), ("2026-12".to_string(), 5_000)].into();
        let rows = month_rows(&due, &paid);
        assert_eq!(
            rows.iter().map(|r| (r.period.as_str(), r.due_cents, r.paid_cents, r.remaining_cents)).collect::<Vec<_>>(),
            vec![("2026-09", 5_000, 5_000, 0), ("2026-10", 5_000, 2_000, 3_000), ("2026-11", 5_000, 0, 5_000), ("2026-12", 0, 5_000, -5_000)]
        );
    }

    #[test]
    fn an_expense_is_checked_and_cleaned() {
        let mut c = CostFields { category: " كهرباء ".into(), amount_cents: 500, date: "2026-11-03".into(), payee: Some("  ".into()), payment_method: Some("cash".into()), accrual_period: Some("2026-10".into()), ..Default::default() };
        c.normalise().unwrap();
        assert_eq!((c.category.as_str(), c.payee, c.payment_method.as_deref()), ("كهرباء", None, Some("CASH")));
        let bad = |f: &dyn Fn(&mut CostFields)| {
            let mut c = CostFields { category: "كهرباء".into(), amount_cents: 500, date: "2026-11-03".into(), ..Default::default() };
            f(&mut c);
            c.normalise().is_err()
        };
        assert!(bad(&|c| c.amount_cents = 0));
        assert!(bad(&|c| c.date = "nope".into()));
        assert!(bad(&|c| c.accrual_period = Some("2026-13".into())));
        assert!(bad(&|c| c.payment_method = Some("BITCOIN".into())));
        assert!(bad(&|c| c.category = " ".into()));
    }
}

#[cfg(test)]
mod ledger_tests {
    use super::*;
    use crate::profit;
    use std::path::Path;

    const T: &str = "t1";
    const B: &str = "b1";

    fn scope() -> Scope {
        Scope::Branch { tenant_id: T.into(), branch_id: B.into() }
    }

    /// The few tables the finance queries touch, with the real column names.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER, checksum TEXT);
             CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE categories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, last_modified TEXT);
             CREATE TABLE menu_items (id TEXT PRIMARY KEY, category_id TEXT, cost_cents INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE orders (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, status TEXT, closed_at TEXT, created_at TEXT,
                                  total_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, quantity INTEGER, unit_cost_cents INTEGER,
                                       weight_grams INTEGER, voided INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE refunds (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, order_id TEXT, amount_cents INTEGER, created_at TEXT);
             CREATE TABLE operational_costs (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, category TEXT NOT NULL, amount_cents INTEGER NOT NULL,
                                             date TEXT NOT NULL, notes TEXT, user_id TEXT, reference_type TEXT, reference_id TEXT, last_modified TEXT, sync_status TEXT);",
        )
        .unwrap();
        let mut conn = conn;
        crate::migrate_v3::run_finance_ledger_migration(&mut conn, Path::new("unused")).unwrap();
        conn
    }

    fn cost(conn: &Connection, category: &str, amount: i64, date: &str, f: impl FnOnce(&mut CostFields)) -> String {
        let mut c = CostFields { category: category.into(), amount_cents: amount, date: date.into(), ..Default::default() };
        f(&mut c);
        c.normalise().unwrap();
        insert_cost(conn, T, B, "u1", &c).unwrap()
    }

    fn category(conn: &Connection, id: &str, class: Option<&str>) {
        conn.execute("INSERT INTO categories (id, tenant_id, name) VALUES (?1, ?2, ?1)", params![id, T]).unwrap();
        if class.is_some() {
            set_category_cost_class(conn, T, id, class).unwrap();
        }
    }

    fn order(conn: &Connection, id: &str, total: i64, tax: i64, discount: i64, lines: &[(&str, i64, i64)]) {
        conn.execute(
            "INSERT INTO orders (id, tenant_id, branch_id, status, closed_at, created_at, total_cents, tax_cents, discount_cents) VALUES (?1, ?2, ?3, 'PAID', '2026-11-10T12:00:00Z', '2026-11-10T12:00:00Z', ?4, ?5, ?6)",
            params![id, T, B, total, tax, discount],
        )
        .unwrap();
        for (i, (item, qty, unit_cost)) in lines.iter().enumerate() {
            conn.execute("INSERT OR IGNORE INTO menu_items (id, category_id, cost_cents) VALUES (?1, ?1, 0)", params![item]).unwrap();
            conn.execute(
                "INSERT INTO order_items (id, order_id, menu_item_id, quantity, unit_cost_cents) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![format!("{id}-{i}"), id, item, qty, unit_cost],
            )
            .unwrap();
        }
    }

    const START: &str = "2026-11-01T00:00:00Z";
    const END: &str = "2026-11-30T23:59:59Z";

    /// Items 100, discount 10, tax 10% on the 90 left = 9, total 99 (stored as
    /// `subtotal + tax - discount`). Tax is not income; the discount is not income.
    #[test]
    fn tax_is_never_revenue_or_profit() {
        let conn = db();
        category(&conn, "c1", None);
        order(&conn, "o1", 99, 9, 10, &[("c1", 2, 20)]);
        cost(&conn, "إيجار", 20, "2026-11-10", |_| {});
        let p = profit::summary(&conn, &scope(), START, END, 0).unwrap();
        let t = p.totals;
        assert_eq!(t.gross_sales_cents, 100, "sales before discount, without tax");
        assert_eq!(t.discounts_cents, 10);
        assert_eq!(t.tax_cents, 9, "tax has its own line");
        assert_eq!(t.net_sales_cents, 90, "net sales exclude tax: 99 paid - 9 tax");
        assert_eq!(t.cogs_cents, 40);
        assert_eq!(t.margin_profit_cents, 50);
        assert_eq!(t.net_profit_cents, 30, "margin 50 - rent 20, tax nowhere in it");
        assert_eq!(t.expense_profit_cents, 70);
        assert_eq!(p.margin_bp, 5_555);

        // A refund of a third of the order hands back a third of the tax too: the sales fall
        // by the part without tax, the tax owed falls by the tax part.
        conn.execute("INSERT INTO refunds (id, tenant_id, branch_id, order_id, amount_cents, created_at) VALUES ('r1', ?1, ?2, 'o1', 33, '2026-11-11T09:00:00Z')", params![T, B]).unwrap();
        let t = profit::summary(&conn, &scope(), START, END, 0).unwrap().totals;
        assert_eq!((t.refunds_cents, t.tax_refunded_cents), (30, 3));
        assert_eq!(t.net_sales_cents, 60);
        assert_eq!(t.tax_cents - t.tax_refunded_cents, 6, "tax still owed");
        let days: i64 = profit::daily(&conn, &scope(), START, END, 0).unwrap().iter().map(|d| d.net_sales_cents).sum();
        assert_eq!(days, 60, "the day table adds up to the same");
    }

    #[test]
    fn untaxed_undiscounted_orders_read_as_before() {
        let conn = db();
        category(&conn, "c1", None);
        order(&conn, "o1", 10_000, 0, 0, &[("c1", 2, 2_000)]);
        let t = profit::summary(&conn, &scope(), START, END, 0).unwrap().totals;
        assert_eq!((t.gross_sales_cents, t.discounts_cents, t.tax_cents, t.net_sales_cents), (10_000, 0, 0, 10_000));
    }

    #[test]
    fn rent_counts_in_its_accrual_month_unless_the_owner_picks_payment_date() {
        let conn = db();
        // October's rent, paid on 3 November.
        cost(&conn, "إيجار", 3_100, "2026-11-03", |c| {
            c.accrual_period = Some("2026-10".into());
            c.payment_date = Some("2026-11-03".into());
        });
        let sum = |s: &str, e: &str| profit::summary(&conn, &scope(), s, e, 0).unwrap().totals.expenses_cents;
        assert_eq!(sum("2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z"), 3_100, "October carries it");
        assert_eq!(sum("2026-11-01T00:00:00Z", "2026-11-30T23:59:59Z"), 0, "November does not");
        assert_eq!(sum("2026-10-01T00:00:00Z", "2026-10-10T23:59:59Z"), 1_000, "10 days of 31 at 100 a day");
        assert_eq!(sum("2026-09-01T00:00:00Z", "2026-12-31T23:59:59Z"), 3_100, "counted once over a wide range");

        save_settings(&conn, "payment", &[]).unwrap();
        assert_eq!(sum("2026-10-01T00:00:00Z", "2026-10-31T23:59:59Z"), 0);
        assert_eq!(sum("2026-11-01T00:00:00Z", "2026-11-30T23:59:59Z"), 3_100, "now by the day it was paid");
    }

    #[test]
    fn rent_statement_shows_due_paid_and_outstanding() {
        let conn = db();
        let input = RentInput { label: "إيجار المحل".into(), period: "MONTHLY".into(), amount_cents: 5_000, start_date: "2026-09-01".into(), end_date: None, active: true };
        let id = save_rent_contract(&conn, T, B, &scope(), None, &input).unwrap();
        let pay = |amount: i64, month: Option<&str>, date: &str| {
            let f = CostFields { amount_cents: amount, date: date.into(), accrual_period: month.map(String::from), ..Default::default() };
            record_rent_payment(&conn, &scope(), "u1", &id, f).unwrap();
        };
        pay(5_000, Some("2026-09"), "2026-09-02");
        pay(2_000, None, "2026-10-05"); // no month given: the month of the payment date
        let list = rent_contracts(&conn, &scope(), "2026-11-22").unwrap();
        let c = &list[0];
        assert_eq!((c.due_cents, c.paid_cents, c.outstanding_cents, c.advance_cents), (15_000, 7_000, 8_000, 0));
        assert_eq!(
            c.months.iter().map(|m| (m.period.as_str(), m.due_cents, m.paid_cents, m.remaining_cents)).collect::<Vec<_>>(),
            vec![("2026-09", 5_000, 5_000, 0), ("2026-10", 5_000, 2_000, 3_000), ("2026-11", 5_000, 0, 5_000)]
        );
        // The payments are ordinary expenses under إيجار linked to the contract.
        let rows = list_costs(&conn, &scope(), &CostFilter::default(), 50).unwrap();
        assert!(rows.iter().all(|r| r.category == "إيجار" && r.reference_type.as_deref() == Some("rent") && r.reference_id.as_deref() == Some(id.as_str())));
        // Stopping the contract stops it accruing.
        let mut stop = RentInput { active: false, end_date: None, ..input.clone() };
        stop.validate("2026-10-15").unwrap();
        assert_eq!(stop.end_date.as_deref(), Some("2026-10-15"));
        save_rent_contract(&conn, T, B, &scope(), Some(&id), &stop).unwrap();
        let c = &rent_contracts(&conn, &scope(), "2026-11-22").unwrap()[0];
        assert_eq!((c.due_cents, c.outstanding_cents, c.active), (10_000, 3_000, false));
        // Another branch sees nothing.
        let other = Scope::Branch { tenant_id: T.into(), branch_id: "b2".into() };
        assert!(rent_contracts(&conn, &other, "2026-11-22").unwrap().is_empty());
        assert!(record_rent_payment(&conn, &other, "u1", &id, CostFields { amount_cents: 1, date: "2026-11-01".into(), ..Default::default() }).is_err());
    }

    #[test]
    fn costs_group_by_category_period_and_centre_with_old_names_counted() {
        let conn = db();
        cost(&conn, "إنترنت", 100, "2026-10-05", |c| c.cost_centre = Some("المطبخ".into()));
        cost(&conn, "هاتف واتصالات", 50, "2026-11-05", |c| c.cost_centre = Some("المطبخ".into()));
        cost(&conn, "أخرى", 30, "2026-11-06", |_| {});
        cost(&conn, "كهرباء", 400, "2026-11-07", |c| c.accrual_period = Some("2026-10".into()));
        let all = CostFilter::default();
        let r = cost_report(&conn, &scope(), &all, "category").unwrap();
        assert_eq!(r.total_cents, 580);
        assert_eq!(r.groups.iter().map(|g| (g.label.as_str(), g.total_cents)).collect::<Vec<_>>(), vec![("كهرباء", 400), ("هاتف واتصالات", 150), ("نثريات", 30)]);
        let r = cost_report(&conn, &scope(), &all, "period").unwrap();
        assert_eq!(r.groups.iter().map(|g| (g.key.as_str(), g.total_cents)).collect::<Vec<_>>(), vec![("2026-10", 500), ("2026-11", 80)], "the electricity bill is filed under October");
        let r = cost_report(&conn, &scope(), &all, "cost_centre").unwrap();
        assert_eq!(r.groups.iter().map(|g| (g.label.as_str(), g.total_cents)).collect::<Vec<_>>(), vec![(NO_COST_CENTRE, 430), ("المطبخ", 150)]);
        // Filters.
        let f = CostFilter { category: Some("هاتف واتصالات".into()), ..Default::default() };
        assert_eq!(list_costs(&conn, &scope(), &f, 50).unwrap().len(), 2, "the old name is found under the new one");
        let f = CostFilter { from: Some("2026-11-01".into()), to: Some("2026-11-30".into()), ..Default::default() };
        assert_eq!(cost_report(&conn, &scope(), &f, "category").unwrap().total_cents, 80, "October's electricity is not in November");
        let f = CostFilter { cost_centre: Some("-".into()), ..Default::default() };
        assert_eq!(list_costs(&conn, &scope(), &f, 50).unwrap().len(), 2);
        assert!(cost_report(&conn, &scope(), &all, "nonsense").is_err());
        // A stored row is never rewritten.
        let stored: String = conn.query_row("SELECT category FROM operational_costs WHERE amount_cents = 100", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "إنترنت");
    }

    #[test]
    fn an_expense_can_be_edited_but_not_a_salary() {
        let conn = db();
        let id = cost(&conn, "مياه", 100, "2026-11-01", |_| {});
        let mut c = CostFields { category: "مياه".into(), amount_cents: 120, date: "2026-11-01".into(), payee: Some("شركة المياه".into()), payment_method: Some("transfer".into()), ..Default::default() };
        c.normalise().unwrap();
        update_cost(&conn, &scope(), &id, &c).unwrap();
        let row = &list_costs(&conn, &scope(), &CostFilter::default(), 5).unwrap()[0];
        assert_eq!((row.amount_cents, row.payee.as_deref(), row.payment_method.as_deref()), (120, Some("شركة المياه"), Some("TRANSFER")));
        let salary = cost(&conn, "رواتب", 500, "2026-11-01", |c| {
            c.reference_type = Some("payroll".into());
        });
        assert!(update_cost(&conn, &scope(), &salary, &c).is_err());
        assert!(update_cost(&conn, &Scope::Branch { tenant_id: "x".into(), branch_id: B.into() }, &id, &c).is_err());
    }

    #[test]
    fn cost_classes_split_the_cost_of_sales_and_show_labour() {
        let conn = db();
        category(&conn, "food", None); // no class reads as FOOD
        category(&conn, "drinks", Some("BEVERAGE"));
        category(&conn, "shisha", Some("SHISHA"));
        // net sales 1,000 (no tax): food 2 x 150, drinks 3 x 50, shisha 1 x 100.
        order(&conn, "o1", 1_000, 0, 0, &[("food", 2, 150), ("drinks", 3, 50), ("shisha", 1, 100)]);
        cost(&conn, "رواتب", 250, "2026-11-12", |_| {});
        let r = cost_of_sales(&conn, &scope(), START, END, 0).unwrap();
        assert_eq!(r.net_sales_cents, 1_000);
        assert_eq!(r.classes.iter().map(|c| (c.class.as_str(), c.cost_cents, c.bp)).collect::<Vec<_>>(), vec![("FOOD", 300, 3_000), ("BEVERAGE", 150, 1_500), ("SHISHA", 100, 1_000), ("OTHER", 0, 0)]);
        assert_eq!((r.total_cost_cents, r.total_bp), (550, 5_500));
        assert_eq!((r.labour_cents, r.labour_bp), (250, 2_500));
        assert!(set_category_cost_class(&conn, T, "food", Some("WAT")).is_err());
        assert!(set_category_cost_class(&conn, "other-shop", "food", Some("OTHER")).is_err());
        set_category_cost_class(&conn, T, "shisha", None).unwrap();
        let r = cost_of_sales(&conn, &scope(), START, END, 0).unwrap();
        assert_eq!(r.classes[0].cost_cents, 400, "a cleared class goes back to FOOD");
    }

    #[test]
    fn the_migration_runs_twice_and_keeps_existing_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER, checksum TEXT);
             CREATE TABLE categories (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT);
             CREATE TABLE operational_costs (id TEXT PRIMARY KEY, category TEXT NOT NULL, amount_cents INTEGER NOT NULL, date TEXT NOT NULL);
             INSERT INTO operational_costs VALUES ('c1', 'إنترنت', 70, '2026-01-01');",
        )
        .unwrap();
        let p = Path::new("unused");
        crate::migrate_v3::run_finance_ledger_migration(&mut conn, p).unwrap();
        crate::migrate_v3::run_finance_ledger_migration(&mut conn, p).unwrap();
        // Even with the version row gone (a half-applied copy) the column guards hold.
        conn.execute("DELETE FROM schema_migrations", []).unwrap();
        crate::migrate_v3::run_finance_ledger_migration(&mut conn, p).unwrap();
        let cols = |t: &str| -> Vec<String> {
            conn.prepare(&format!("PRAGMA table_info({t})")).unwrap().query_map([], |r| r.get::<_, String>(1)).unwrap().map(|c| c.unwrap()).collect()
        };
        let costs = cols("operational_costs");
        for c in ["payment_date", "payee", "payment_method", "reference_no", "cost_centre", "attachment_path", "accrual_period"] {
            assert_eq!(costs.iter().filter(|x| *x == c).count(), 1, "{c}");
        }
        assert!(cols("categories").contains(&"cost_class".to_string()));
        assert!(!cols("rent_contracts").is_empty());
        let (n, v): (i64, i64) = conn.query_row("SELECT COUNT(*), MAX(version) FROM schema_migrations", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((n, v), (1, 50));
        let amount: i64 = conn.query_row("SELECT amount_cents FROM operational_costs WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(amount, 70);
    }
}
