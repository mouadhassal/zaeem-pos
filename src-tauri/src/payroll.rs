//! Payroll: what each person earns in a month, from their pay, their punches
//! and the rules the OWNER chose.
//!
//! Nothing here is decided for the owner. Every deduction (lateness, absence,
//! leaving early) and the overtime rate is a setting the owner picks, and a
//! fresh install deducts nothing until they do. A person's month is worked out
//! from the raw punch log (`attendance_punches`), day by day, in the till's
//! local time (the page sends `tz_offset_minutes`, minutes east of UTC).
//!
//! * A **draft** payslip is always recomputed from the live data.
//! * **Approving** freezes it (the numbers and the rules used are stored, and
//!   any advance instalments are taken off the advances). Nothing changes it
//!   after that except re-opening it, which is only possible before it is paid.
//! * **Paying** records the salary as an expense (category `رواتب`), so it
//!   shows up in the profit pages. The expense is what the person *earned*;
//!   an advance they already took was cash handed over earlier, repaid out of
//!   the net, and is not an expense a second time.

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS payroll_settings (
    tenant_id TEXT PRIMARY KEY,
    configured INTEGER NOT NULL DEFAULT 0,
    weekly_off_days TEXT NOT NULL DEFAULT '5',
    days_per_month INTEGER NOT NULL DEFAULT 26,
    shift_minutes INTEGER NOT NULL DEFAULT 480,
    late_rule TEXT NOT NULL DEFAULT 'NONE',
    late_counts_from_start INTEGER NOT NULL DEFAULT 1,
    late_multiplier_pct INTEGER NOT NULL DEFAULT 100,
    late_fixed_cents INTEGER NOT NULL DEFAULT 0,
    late_tiers TEXT NOT NULL DEFAULT '[]',
    absence_rule TEXT NOT NULL DEFAULT 'NONE',
    absence_multiplier_pct INTEGER NOT NULL DEFAULT 100,
    absence_fixed_cents INTEGER NOT NULL DEFAULT 0,
    early_rule TEXT NOT NULL DEFAULT 'NONE',
    early_multiplier_pct INTEGER NOT NULL DEFAULT 100,
    overtime_rule TEXT NOT NULL DEFAULT 'NONE',
    overtime_multiplier_pct INTEGER NOT NULL DEFAULT 150,
    overtime_after_minutes INTEGER NOT NULL DEFAULT 30,
    manager_access TEXT NOT NULL DEFAULT 'NONE',
    extra_day_rule TEXT NOT NULL DEFAULT 'NONE',
    holiday_multiplier_pct INTEGER NOT NULL DEFAULT 150,
    holidays TEXT NOT NULL DEFAULT '[]',
    require_attendance_approval INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payroll_employees (
    user_id TEXT PRIMARY KEY REFERENCES staff(id),
    tenant_id TEXT NOT NULL,
    branch_id TEXT,
    pay_type TEXT NOT NULL CHECK (pay_type IN ('MONTHLY','DAILY','HOURLY')),
    rate_cents INTEGER NOT NULL,
    shift_start TEXT,
    shift_minutes INTEGER,
    start_date TEXT,
    end_date TEXT,
    track_attendance INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS payroll_day_marks (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    day TEXT NOT NULL,
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, day)
);
CREATE TABLE IF NOT EXISTS payroll_adjustments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    month TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('BONUS','FINE')),
    amount_cents INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payroll_advances (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT,
    user_id TEXT NOT NULL REFERENCES staff(id),
    amount_cents INTEGER NOT NULL,
    instalment_cents INTEGER NOT NULL,
    repaid_cents INTEGER NOT NULL DEFAULT 0,
    given_on TEXT NOT NULL,
    reason TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payroll_payslips (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT,
    user_id TEXT NOT NULL REFERENCES staff(id),
    month TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('APPROVED','PAID')),
    earned_cents INTEGER NOT NULL,
    net_cents INTEGER NOT NULL,
    details TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    paid_by TEXT,
    paid_at TEXT,
    expense_id TEXT,
    UNIQUE (user_id, month)
);
CREATE INDEX IF NOT EXISTS idx_payroll_punch_lookup ON payroll_payslips (tenant_id, month);
CREATE TABLE IF NOT EXISTS payroll_day_deductions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    month TEXT NOT NULL,
    days_x100 INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payroll_day_overrides (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    day TEXT NOT NULL,
    absent INTEGER NOT NULL DEFAULT 0,
    in_time TEXT,
    out_time TEXT,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, day)
);
CREATE TABLE IF NOT EXISTS payroll_attendance_approvals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    month TEXT NOT NULL,
    summary TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    UNIQUE (user_id, month)
);";

// ---------------------------------------------------------------------------
// Who may do what (the hierarchy)
// ---------------------------------------------------------------------------

/// What the person asking may see and do in payroll. The owner has everything. A branch manager only gets what the
/// owner switched on (`manager_access`), and only for the staff under them in their own branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PayrollScope {
    pub is_owner: bool,
    /// None = every branch.
    pub branch_id: Option<String>,
    /// Only people ranked below this (a manager never reaches the owner or other managers).
    pub below_rank: Option<i64>,
    /// May edit the rules, the access setting and each person's pay.
    pub can_edit_rules: bool,
    /// May approve, pay and re-open payslips.
    pub can_approve: bool,
}

impl PayrollScope {
    /// The owner: everything. Anyone else is refused unless this is a manager the owner has switched payroll on for.
    pub fn for_actor(role: crate::security::Role, branch_id: Option<&str>, manager_access: &str) -> Result<PayrollScope, String> {
        use crate::security::Role;
        match role {
            Role::Owner | Role::Platform => Ok(PayrollScope { is_owner: true, branch_id: None, below_rank: None, can_edit_rules: true, can_approve: true }),
            Role::Manager => match manager_access {
                "PREPARE" | "FULL" => Ok(PayrollScope {
                    is_owner: false,
                    branch_id: Some(branch_id.ok_or("المشرف بلا فرع")?.to_string()),
                    below_rank: Some(Role::Manager.rank() as i64),
                    can_edit_rules: false,
                    can_approve: manager_access == "FULL",
                }),
                _ => Err("لم يفعّل المالك الرواتب للمشرفين. يستطيع ذلك من الرواتب ← القواعد".to_string()),
            },
            _ => Err("الرواتب للمالك والمشرف فقط".to_string()),
        }
    }
}

/// The person must be somebody this scope may deal with: this business, and for a manager their own branch and
/// ranked below them.
pub fn person_in_scope(conn: &Connection, tenant_id: &str, user_id: &str, scope: &PayrollScope) -> Result<(), String> {
    let row: Option<(String, Option<String>, i64)> = conn
        .query_row("SELECT tenant_id, branch_id, role_rank FROM staff WHERE id = ?1 AND deleted_at IS NULL", params![user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let refuse = || "هذا الموظف خارج صلاحياتك في الرواتب".to_string();
    let Some((tenant, branch, rank)) = row else { return Err("الموظف غير موجود".into()) };
    if tenant != tenant_id {
        return Err(refuse());
    }
    if let Some(b) = scope.branch_id.as_deref() {
        if branch.as_deref() != Some(b) {
            return Err(refuse());
        }
    }
    if let Some(r) = scope.below_rank {
        if rank >= r {
            return Err(refuse());
        }
    }
    Ok(())
}

/// The payslip's person must be in scope (a payslip id is only ever looked up by this).
pub fn payslip_person_in_scope(conn: &Connection, tenant_id: &str, payslip_id: &str, scope: &PayrollScope) -> Result<(), String> {
    let user: Option<String> = conn
        .query_row("SELECT user_id FROM payroll_payslips WHERE id = ?1 AND tenant_id = ?2", params![payslip_id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(user_id) = user else { return Err("كشف الراتب غير موجود".into()) };
    person_in_scope(conn, tenant_id, &user_id, scope)
}

pub fn adjustment_person_in_scope(conn: &Connection, tenant_id: &str, adjustment_id: &str, scope: &PayrollScope) -> Result<(), String> {
    let user: Option<String> = conn
        .query_row("SELECT user_id FROM payroll_adjustments WHERE id = ?1 AND tenant_id = ?2", params![adjustment_id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(user_id) = user else { return Err("التسوية غير موجودة".into()) };
    person_in_scope(conn, tenant_id, &user_id, scope)
}

pub fn advance_person_in_scope(conn: &Connection, tenant_id: &str, advance_id: &str, scope: &PayrollScope) -> Result<(), String> {
    let user: Option<String> = conn
        .query_row("SELECT user_id FROM payroll_advances WHERE id = ?1 AND tenant_id = ?2", params![advance_id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(user_id) = user else { return Err("السلفة غير موجودة".into()) };
    person_in_scope(conn, tenant_id, &user_id, scope)
}

// ---------------------------------------------------------------------------
// Settings (the owner's rules)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LateTier {
    /// From this many minutes late (counted from the start of the shift) ...
    pub from_minutes: i64,
    /// ... deduct this percent of one day's pay.
    pub day_pct: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayrollSettings {
    /// The owner has gone through the setup.
    pub configured: bool,
    /// Weekdays that are not working days, 0 = Sunday ... 6 = Saturday.
    pub weekly_off_days: Vec<u8>,
    /// Working days a monthly salary is divided by to get one day's pay (usually 26).
    pub days_per_month: i64,
    /// Length of a normal working day, in minutes.
    pub shift_minutes: i64,
    /// NONE | PER_MINUTE | FIXED_PER_LATE | TIERS
    pub late_rule: String,
    /// Late minutes are counted from the start of the shift (true) or only the ones past the grace (false).
    pub late_counts_from_start: bool,
    /// PER_MINUTE: percent of the person's per-minute pay deducted (100 = exactly the time missed).
    pub late_multiplier_pct: i64,
    /// FIXED_PER_LATE: the amount deducted each late day.
    pub late_fixed_cents: i64,
    pub late_tiers: Vec<LateTier>,
    /// NONE | DAY_PAY | FIXED (monthly salaries only; a daily or hourly worker is simply not paid for a day missed)
    pub absence_rule: String,
    /// DAY_PAY: percent of one day's pay deducted per absent day (100 = one day, 200 = two days).
    pub absence_multiplier_pct: i64,
    pub absence_fixed_cents: i64,
    /// NONE | PER_MINUTE
    pub early_rule: String,
    pub early_multiplier_pct: i64,
    /// NONE | PER_HOUR
    pub overtime_rule: String,
    /// Percent of the normal rate paid for overtime (150 = time and a half).
    pub overtime_multiplier_pct: i64,
    /// Extra minutes past the end of the shift that do not count as overtime.
    pub overtime_after_minutes: i64,
    /// What a branch manager may do in payroll. The owner decides. NONE: nothing (the default).
    /// PREPARE: see the pay of the staff under them in their branch and prepare it (excused days, bonuses and
    /// fines, advances, missed punches); the owner approves and pays. FULL: also approve and pay it.
    /// Pay rates and these rules stay with the owner either way, and a manager never sees the owner's or
    /// another manager's pay.
    pub manager_access: String,
    /// NONE | DAY_PAY. DAY_PAY: a day worked on a weekly day off or on a holiday the owner marked is paid as an
    /// extra day at `holiday_multiplier_pct` of one day's pay (and its minutes are no longer counted as overtime).
    /// NONE (the default): such a day is paid by the overtime rule only, as before.
    #[serde(default = "default_extra_day_rule")]
    pub extra_day_rule: String,
    /// Percent of one day's pay paid for an extra day (150 = a day and a half).
    #[serde(default = "default_holiday_pct")]
    pub holiday_multiplier_pct: i64,
    /// Official holidays (`YYYY-MM-DD`), marked by the owner. A holiday is a non-working day like the weekly day off.
    #[serde(default)]
    pub holidays: Vec<String>,
    /// ON: a person's month must have its attendance approved ("اعتماد الحضور") before the payslip can be approved.
    /// OFF (the default): payroll uses the attendance as it is, as before.
    #[serde(default)]
    pub require_attendance_approval: bool,
}

fn default_extra_day_rule() -> String {
    "NONE".to_string()
}

fn default_holiday_pct() -> i64 {
    150
}

impl Default for PayrollSettings {
    fn default() -> Self {
        PayrollSettings {
            configured: false,
            weekly_off_days: vec![5],
            days_per_month: 26,
            shift_minutes: 480,
            late_rule: "NONE".into(),
            late_counts_from_start: true,
            late_multiplier_pct: 100,
            late_fixed_cents: 0,
            late_tiers: vec![],
            absence_rule: "NONE".into(),
            absence_multiplier_pct: 100,
            absence_fixed_cents: 0,
            early_rule: "NONE".into(),
            early_multiplier_pct: 100,
            overtime_rule: "NONE".into(),
            overtime_multiplier_pct: 150,
            overtime_after_minutes: 30,
            manager_access: "NONE".into(),
            extra_day_rule: "NONE".into(),
            holiday_multiplier_pct: 150,
            holidays: vec![],
            require_attendance_approval: false,
        }
    }
}

fn one_of(value: &str, allowed: &[&str], what: &str) -> Result<(), String> {
    if allowed.contains(&value) { Ok(()) } else { Err(format!("قيمة غير صالحة لـ {what}")) }
}

impl PayrollSettings {
    pub fn validate(&self) -> Result<(), String> {
        one_of(&self.late_rule, &["NONE", "PER_MINUTE", "FIXED_PER_LATE", "TIERS"], "قاعدة التأخير")?;
        one_of(&self.absence_rule, &["NONE", "DAY_PAY", "FIXED"], "قاعدة الغياب")?;
        one_of(&self.early_rule, &["NONE", "PER_MINUTE"], "قاعدة الخروج المبكر")?;
        one_of(&self.overtime_rule, &["NONE", "PER_HOUR"], "قاعدة الوقت الإضافي")?;
        one_of(&self.manager_access, &["NONE", "PREPARE", "FULL"], "صلاحية المشرف")?;
        one_of(&self.extra_day_rule, &["NONE", "DAY_PAY"], "قاعدة أجر العطلة")?;
        if !(100..=1000).contains(&self.holiday_multiplier_pct) {
            return Err("نسبة أجر يوم العطلة يجب أن تكون بين 100 و1000".into());
        }
        if self.holidays.len() > 400 {
            return Err("عدد أيام العطل كبير جداً".into());
        }
        if self.holidays.iter().any(|h| parse_date(h).is_none()) {
            return Err("تاريخ عطلة غير صالح، اكتبه بصيغة 2026-11-01".into());
        }
        if self.weekly_off_days.iter().any(|d| *d > 6) || self.weekly_off_days.len() > 6 {
            return Err("أيام العطلة الأسبوعية غير صالحة".into());
        }
        if !(1..=31).contains(&self.days_per_month) {
            return Err("عدد أيام العمل في الشهر يجب أن يكون بين 1 و 31".into());
        }
        if !(60..=1080).contains(&self.shift_minutes) {
            return Err("طول الدوام يجب أن يكون بين ساعة و18 ساعة".into());
        }
        for (v, what) in [
            (self.late_multiplier_pct, "نسبة خصم التأخير"),
            (self.absence_multiplier_pct, "نسبة خصم الغياب"),
            (self.early_multiplier_pct, "نسبة خصم الخروج المبكر"),
        ] {
            if !(0..=1000).contains(&v) {
                return Err(format!("{what} يجب أن تكون بين 0 و1000"));
            }
        }
        if !(100..=1000).contains(&self.overtime_multiplier_pct) {
            return Err("نسبة أجر الوقت الإضافي يجب أن تكون بين 100 و1000".into());
        }
        if !(0..=600).contains(&self.overtime_after_minutes) {
            return Err("مهلة الوقت الإضافي يجب أن تكون بين 0 و600 دقيقة".into());
        }
        if self.late_fixed_cents < 0 || self.absence_fixed_cents < 0 {
            return Err("المبالغ الثابتة لا يمكن أن تكون سالبة".into());
        }
        if self.late_tiers.len() > 8 {
            return Err("الشرائح حتى 8 فقط".into());
        }
        let mut last = 0;
        for t in &self.late_tiers {
            if t.from_minutes <= last || t.from_minutes > 720 {
                return Err("شرائح التأخير يجب أن تتزايد دقائقها (1 إلى 720)".into());
            }
            if !(1..=300).contains(&t.day_pct) {
                return Err("نسبة خصم الشريحة يجب أن تكون بين 1 و300".into());
            }
            last = t.from_minutes;
        }
        if self.late_rule == "TIERS" && self.late_tiers.is_empty() {
            return Err("أضف شريحة تأخير واحدة على الأقل".into());
        }
        Ok(())
    }
}

pub fn load_settings(conn: &Connection, tenant_id: &str) -> Result<PayrollSettings, String> {
    let row = conn
        .query_row(
            "SELECT configured, weekly_off_days, days_per_month, shift_minutes, late_rule, late_counts_from_start, late_multiplier_pct, \
                    late_fixed_cents, late_tiers, absence_rule, absence_multiplier_pct, absence_fixed_cents, early_rule, early_multiplier_pct, \
                    overtime_rule, overtime_multiplier_pct, overtime_after_minutes, manager_access, \
                    extra_day_rule, holiday_multiplier_pct, holidays, require_attendance_approval FROM payroll_settings WHERE tenant_id = ?1",
            params![tenant_id],
            |r| {
                Ok(PayrollSettings {
                    configured: r.get::<_, i64>(0)? != 0,
                    weekly_off_days: r.get::<_, String>(1)?.split(',').filter_map(|d| d.trim().parse::<u8>().ok()).filter(|d| *d <= 6).collect(),
                    days_per_month: r.get(2)?,
                    shift_minutes: r.get(3)?,
                    late_rule: r.get(4)?,
                    late_counts_from_start: r.get::<_, i64>(5)? != 0,
                    late_multiplier_pct: r.get(6)?,
                    late_fixed_cents: r.get(7)?,
                    late_tiers: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
                    absence_rule: r.get(9)?,
                    absence_multiplier_pct: r.get(10)?,
                    absence_fixed_cents: r.get(11)?,
                    early_rule: r.get(12)?,
                    early_multiplier_pct: r.get(13)?,
                    overtime_rule: r.get(14)?,
                    overtime_multiplier_pct: r.get(15)?,
                    overtime_after_minutes: r.get(16)?,
                    manager_access: r.get(17)?,
                    extra_day_rule: r.get(18)?,
                    holiday_multiplier_pct: r.get(19)?,
                    holidays: serde_json::from_str(&r.get::<_, String>(20)?).unwrap_or_default(),
                    require_attendance_approval: r.get::<_, i64>(21)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or_default())
}

/// Saves the owner's rules and marks the setup as done.
pub fn save_settings(conn: &Connection, tenant_id: &str, s: &PayrollSettings) -> Result<(), String> {
    s.validate()?;
    let off = s.weekly_off_days.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
    let tiers = serde_json::to_string(&s.late_tiers).map_err(|e| e.to_string())?;
    let mut holidays = s.holidays.clone();
    holidays.sort();
    holidays.dedup();
    let holidays = serde_json::to_string(&holidays).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO payroll_settings (tenant_id, configured, weekly_off_days, days_per_month, shift_minutes, late_rule, late_counts_from_start, \
            late_multiplier_pct, late_fixed_cents, late_tiers, absence_rule, absence_multiplier_pct, absence_fixed_cents, early_rule, early_multiplier_pct, \
            overtime_rule, overtime_multiplier_pct, overtime_after_minutes, manager_access, extra_day_rule, holiday_multiplier_pct, holidays, require_attendance_approval) \
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22) \
         ON CONFLICT(tenant_id) DO UPDATE SET configured = 1, weekly_off_days = ?2, days_per_month = ?3, shift_minutes = ?4, late_rule = ?5, \
            late_counts_from_start = ?6, late_multiplier_pct = ?7, late_fixed_cents = ?8, late_tiers = ?9, absence_rule = ?10, \
            absence_multiplier_pct = ?11, absence_fixed_cents = ?12, early_rule = ?13, early_multiplier_pct = ?14, overtime_rule = ?15, \
            overtime_multiplier_pct = ?16, overtime_after_minutes = ?17, manager_access = ?18, extra_day_rule = ?19, holiday_multiplier_pct = ?20, \
            holidays = ?21, require_attendance_approval = ?22",
        params![
            tenant_id, off, s.days_per_month, s.shift_minutes, s.late_rule, s.late_counts_from_start as i64, s.late_multiplier_pct, s.late_fixed_cents,
            tiers, s.absence_rule, s.absence_multiplier_pct, s.absence_fixed_cents, s.early_rule, s.early_multiplier_pct, s.overtime_rule,
            s.overtime_multiplier_pct, s.overtime_after_minutes, s.manager_access, s.extra_day_rule, s.holiday_multiplier_pct, holidays,
            s.require_attendance_approval as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// One person's pay
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmployeePay {
    pub user_id: String,
    /// MONTHLY | DAILY | HOURLY
    pub pay_type: String,
    /// The monthly salary, the pay for one day, or the pay for one hour.
    pub rate_cents: i64,
    /// Their own start of shift ("09:00"); empty = the attendance setting.
    pub shift_start: Option<String>,
    /// Their own length of day in minutes; empty = the payroll setting.
    pub shift_minutes: Option<i64>,
    /// First and last day of employment (YYYY-MM-DD), for people who join or leave mid-month.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Lateness, absence, leaving early and overtime come from their punches. Off = their pay is the base only.
    pub track_attendance: bool,
}

pub fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

impl EmployeePay {
    pub fn validate(&self) -> Result<(), String> {
        one_of(&self.pay_type, &["MONTHLY", "DAILY", "HOURLY"], "نوع الراتب")?;
        if !(1..=1_000_000_000_000).contains(&self.rate_cents) {
            return Err("مبلغ الراتب غير صالح".into());
        }
        if let Some(s) = self.shift_start.as_deref().filter(|s| !s.is_empty()) {
            if crate::attendance::parse_hhmm(s).is_none() {
                return Err("وقت بداية الدوام غير صالح، اكتبه بصيغة 09:00".into());
            }
        }
        if let Some(m) = self.shift_minutes {
            if !(60..=1080).contains(&m) {
                return Err("طول الدوام يجب أن يكون بين ساعة و18 ساعة".into());
            }
        }
        for d in [&self.start_date, &self.end_date].into_iter().flatten().filter(|d| !d.is_empty()) {
            if parse_date(d).is_none() {
                return Err("تاريخ غير صالح، اكتبه بصيغة 2026-11-01".into());
            }
        }
        if let (Some(a), Some(b)) = (self.start_date.as_deref().and_then(parse_date), self.end_date.as_deref().and_then(parse_date)) {
            if b < a {
                return Err("تاريخ نهاية العمل قبل تاريخ بدايته".into());
            }
        }
        Ok(())
    }
}

pub fn load_employee_pay(conn: &Connection, user_id: &str) -> Result<Option<EmployeePay>, String> {
    conn.query_row(
        "SELECT user_id, pay_type, rate_cents, shift_start, shift_minutes, start_date, end_date, track_attendance FROM payroll_employees WHERE user_id = ?1",
        params![user_id],
        |r| {
            Ok(EmployeePay {
                user_id: r.get(0)?, pay_type: r.get(1)?, rate_cents: r.get(2)?, shift_start: r.get(3)?, shift_minutes: r.get(4)?,
                start_date: r.get(5)?, end_date: r.get(6)?, track_attendance: r.get::<_, i64>(7)? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn save_employee_pay(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, p: &EmployeePay) -> Result<(), String> {
    p.validate()?;
    let clean = |o: &Option<String>| o.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string());
    conn.execute(
        "INSERT INTO payroll_employees (user_id, tenant_id, branch_id, pay_type, rate_cents, shift_start, shift_minutes, start_date, end_date, track_attendance) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(user_id) DO UPDATE SET pay_type = ?4, rate_cents = ?5, shift_start = ?6, shift_minutes = ?7, start_date = ?8, end_date = ?9, track_attendance = ?10",
        params![p.user_id, tenant_id, branch_id, p.pay_type, p.rate_cents, clean(&p.shift_start), p.shift_minutes, clean(&p.start_date), clean(&p.end_date), p.track_attendance as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct EmployeeRow {
    pub user_id: String,
    pub name: String,
    pub role: String,
    pub branch_id: Option<String>,
    pub pay: Option<EmployeePay>,
    /// What the person is (cleaner, chef...). None on a database before Migration AP.
    pub job_title: Option<String>,
}

/// Everyone who could be on the payroll: active staff of this business (not the platform account).
pub fn list_employees(conn: &Connection, tenant_id: &str, scope: &PayrollScope) -> Result<Vec<EmployeeRow>, String> {
    let mut sql = String::from("SELECT id, name, role, branch_id FROM staff WHERE tenant_id = ?1 AND is_active = 1 AND deleted_at IS NULL AND role != 'PLATFORM'");
    let mut args = vec![tenant_id.to_string()];
    if let Some(b) = scope.branch_id.as_deref() {
        args.push(b.to_string());
        sql.push_str(&format!(" AND branch_id = ?{}", args.len()));
    }
    if let Some(rank) = scope.below_rank {
        sql.push_str(&format!(" AND role_rank < {}", rank));
    }
    sql.push_str(" ORDER BY name");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows: Vec<(String, String, String, Option<String>)> = stmt
        .query_map(refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for (user_id, name, role, branch_id) in rows {
        let pay = load_employee_pay(conn, &user_id)?;
        // Read on its own so an older database (no job_title column) still lists everyone.
        let job_title: Option<String> = conn
            .query_row("SELECT job_title FROM staff WHERE id = ?1", rusqlite::params![user_id], |r| r.get(0))
            .unwrap_or(None);
        out.push(EmployeeRow { user_id, name, role, branch_id, pay, job_title });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Adjustments, advances, paid-leave days
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdjustmentRow {
    pub id: String,
    pub month: String,
    pub kind: String,
    pub amount_cents: i64,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdvanceRow {
    pub id: String,
    pub user_id: String,
    pub amount_cents: i64,
    pub instalment_cents: i64,
    pub repaid_cents: i64,
    pub remaining_cents: i64,
    pub given_on: String,
    pub reason: Option<String>,
}

pub fn valid_month(m: &str) -> Option<NaiveDate> {
    parse_date(&format!("{m}-01"))
}

fn month_is_locked(conn: &Connection, user_id: &str, month: &str) -> Result<bool, String> {
    conn.query_row("SELECT COUNT(*) > 0 FROM payroll_payslips WHERE user_id = ?1 AND month = ?2", params![user_id, month], |r| r.get(0)).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn add_adjustment(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, kind: &str, amount_cents: i64, reason: &str, actor_id: &str) -> Result<String, String> {
    one_of(kind, &["BONUS", "FINE"], "نوع التسوية")?;
    if valid_month(month).is_none() {
        return Err("الشهر غير صالح".into());
    }
    if amount_cents <= 0 {
        return Err("المبلغ يجب أن يكون أكبر من صفر".into());
    }
    if reason.trim().is_empty() {
        return Err("اكتب سبب المكافأة أو الغرامة".into());
    }
    if month_is_locked(conn, user_id, month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً لتعديله".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO payroll_adjustments (id, tenant_id, user_id, month, kind, amount_cents, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, tenant_id, user_id, month, kind, amount_cents, reason.trim(), actor_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn delete_adjustment(conn: &Connection, tenant_id: &str, adjustment_id: &str) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT user_id, month FROM payroll_adjustments WHERE id = ?1 AND tenant_id = ?2", params![adjustment_id, tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((user_id, month)) = row else { return Err("التسوية غير موجودة".into()) };
    if month_is_locked(conn, &user_id, &month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً لتعديله".into());
    }
    conn.execute("DELETE FROM payroll_adjustments WHERE id = ?1", params![adjustment_id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn list_adjustments(conn: &Connection, user_id: &str, month: &str) -> Result<Vec<AdjustmentRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, month, kind, amount_cents, reason, created_at FROM payroll_adjustments WHERE user_id = ?1 AND month = ?2 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id, month], |r| Ok(AdjustmentRow { id: r.get(0)?, month: r.get(1)?, kind: r.get(2)?, amount_cents: r.get(3)?, reason: r.get(4)?, created_at: r.get(5)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn add_advance(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, user_id: &str, amount_cents: i64, instalment_cents: i64, given_on: &str, reason: Option<&str>, actor_id: &str) -> Result<String, String> {
    if amount_cents <= 0 {
        return Err("مبلغ السلفة يجب أن يكون أكبر من صفر".into());
    }
    if instalment_cents <= 0 || instalment_cents > amount_cents {
        return Err("القسط الشهري يجب أن يكون بين 1 ومبلغ السلفة".into());
    }
    if parse_date(given_on).is_none() {
        return Err("تاريخ السلفة غير صالح".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO payroll_advances (id, tenant_id, branch_id, user_id, amount_cents, instalment_cents, given_on, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, tenant_id, branch_id, user_id, amount_cents, instalment_cents, given_on, reason.map(str::trim).filter(|r| !r.is_empty()), actor_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// An advance nothing has been repaid on can be cancelled (entered by mistake).
pub fn cancel_advance(conn: &Connection, tenant_id: &str, advance_id: &str) -> Result<(), String> {
    let repaid: Option<i64> = conn
        .query_row("SELECT repaid_cents FROM payroll_advances WHERE id = ?1 AND tenant_id = ?2", params![advance_id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match repaid {
        None => Err("السلفة غير موجودة".into()),
        Some(r) if r > 0 => Err("بدأ تسديد هذه السلفة من الراتب، لا يمكن إلغاؤها".into()),
        Some(_) => {
            // The expense recorded for it goes with it (nothing was ever taken back, so nothing was spent).
            conn.execute(
                "DELETE FROM operational_costs WHERE reference_type = ?1 AND reference_id = ?2",
                params![crate::finance::ADVANCE_REFERENCE, advance_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM payroll_advances WHERE id = ?1", params![advance_id]).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

pub fn list_advances(conn: &Connection, tenant_id: &str, user_id: Option<&str>, only_open: bool) -> Result<Vec<AdvanceRow>, String> {
    let mut sql = String::from("SELECT id, user_id, amount_cents, instalment_cents, repaid_cents, given_on, reason FROM payroll_advances WHERE tenant_id = ?1");
    let mut args = vec![tenant_id.to_string()];
    if let Some(u) = user_id {
        args.push(u.to_string());
        sql.push_str(&format!(" AND user_id = ?{}", args.len()));
    }
    if only_open {
        sql.push_str(" AND repaid_cents < amount_cents");
    }
    sql.push_str(" ORDER BY given_on, created_at");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let (amount, repaid): (i64, i64) = (r.get(2)?, r.get(4)?);
            Ok(AdvanceRow { id: r.get(0)?, user_id: r.get(1)?, amount_cents: amount, instalment_cents: r.get(3)?, repaid_cents: repaid, remaining_cents: amount - repaid, given_on: r.get(5)?, reason: r.get(6)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn mark_paid_leave(conn: &Connection, tenant_id: &str, user_id: &str, day: &str, note: Option<&str>, actor_id: &str) -> Result<(), String> {
    let Some(d) = parse_date(day) else { return Err("التاريخ غير صالح".into()) };
    let month = d.format("%Y-%m").to_string();
    attendance_edit_guard(conn, user_id, &month)?;
    conn.execute(
        "INSERT INTO payroll_day_marks (id, tenant_id, user_id, day, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(user_id, day) DO UPDATE SET note = ?5",
        params![uuid::Uuid::now_v7().to_string(), tenant_id, user_id, day, note.map(str::trim).filter(|n| !n.is_empty()), actor_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn unmark_paid_leave(conn: &Connection, user_id: &str, day: &str) -> Result<(), String> {
    let Some(d) = parse_date(day) else { return Err("التاريخ غير صالح".into()) };
    attendance_edit_guard(conn, user_id, &d.format("%Y-%m").to_string())?;
    conn.execute("DELETE FROM payroll_day_marks WHERE user_id = ?1 AND day = ?2", params![user_id, day]).map_err(|e| e.to_string())?;
    Ok(())
}

/// A missing or forgotten punch added by hand, for a time in the past. The punch log is append-only,
/// so this is a new row marked MANUAL with who added it.
#[allow(clippy::too_many_arguments)]
pub fn add_manual_punch(conn: &Connection, tenant_id: &str, branch_id: &str, user_id: &str, at: DateTime<Utc>, direction: &str, actor_id: &str, now: DateTime<Utc>) -> Result<String, String> {
    let dir = match direction {
        "IN" => crate::attendance::Direction::In,
        "OUT" => crate::attendance::Direction::Out,
        _ => return Err("اتجاه البصمة غير صالح".into()),
    };
    if at > now + Duration::minutes(5) {
        return Err("لا يمكن تسجيل وقت في المستقبل".into());
    }
    if at < now - Duration::days(400) {
        return Err("الوقت قديم جداً".into());
    }
    // A day near a month's edge may belong to either month in the till's local time, so both are checked.
    for edge in [at - Duration::days(1), at + Duration::days(1)] {
        if attendance_is_approved(conn, user_id, &edge.format("%Y-%m").to_string())? {
            return Err("حضور هذا الشهر معتمد، ألغِ اعتماد الحضور أولاً لتعديله".into());
        }
    }
    crate::attendance::log_punch(conn, tenant_id, branch_id, user_id, dir, crate::attendance::Source::Manual, None, Some(actor_id), at)
}

// ---------------------------------------------------------------------------
// Deduction days, corrected days, attendance approval
// ---------------------------------------------------------------------------

/// Days the owner deducted by hand ("deduction days"), kept apart from absence. Hundredths of a day, so a half day is 50.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DayDeductionRow {
    pub id: String,
    pub month: String,
    pub days_x100: i64,
    pub reason: String,
    pub created_at: String,
}

pub fn add_day_deduction(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, days_x100: i64, reason: &str, actor_id: &str) -> Result<String, String> {
    if valid_month(month).is_none() {
        return Err("الشهر غير صالح".into());
    }
    if !(1..=3100).contains(&days_x100) {
        return Err("عدد أيام الخصم يجب أن يكون بين ربع يوم و31 يوماً".into());
    }
    if reason.trim().is_empty() {
        return Err("اكتب سبب خصم الأيام".into());
    }
    if month_is_locked(conn, user_id, month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً لتعديله".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO payroll_day_deductions (id, tenant_id, user_id, month, days_x100, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, tenant_id, user_id, month, days_x100, reason.trim(), actor_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn delete_day_deduction(conn: &Connection, tenant_id: &str, id: &str) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT user_id, month FROM payroll_day_deductions WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((user_id, month)) = row else { return Err("خصم الأيام غير موجود".into()) };
    if month_is_locked(conn, &user_id, &month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً لتعديله".into());
    }
    conn.execute("DELETE FROM payroll_day_deductions WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn day_deduction_person_in_scope(conn: &Connection, tenant_id: &str, id: &str, scope: &PayrollScope) -> Result<(), String> {
    let user: Option<String> = conn
        .query_row("SELECT user_id FROM payroll_day_deductions WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(user_id) = user else { return Err("خصم الأيام غير موجود".into()) };
    person_in_scope(conn, tenant_id, &user_id, scope)
}

fn list_day_deductions(conn: &Connection, user_id: &str, month: &str) -> Result<Vec<DayDeductionRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, month, days_x100, reason, created_at FROM payroll_day_deductions WHERE user_id = ?1 AND month = ?2 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id, month], |r| Ok(DayDeductionRow { id: r.get(0)?, month: r.get(1)?, days_x100: r.get(2)?, reason: r.get(3)?, created_at: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// A day the attendance review corrected: the day's own in/out times replace what the punches say (or the day is
/// forced absent). The punch log is never edited; this sits on top of it and says who and why.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DayOverride {
    pub day: String,
    pub absent: bool,
    pub in_time: Option<String>,
    pub out_time: Option<String>,
    pub reason: String,
}

pub fn attendance_is_approved(conn: &Connection, user_id: &str, month: &str) -> Result<bool, String> {
    conn.query_row("SELECT COUNT(*) > 0 FROM payroll_attendance_approvals WHERE user_id = ?1 AND month = ?2", params![user_id, month], |r| r.get(0)).map_err(|e| e.to_string())
}

/// What may not change any more: a frozen payslip, or attendance the owner/manager approved.
fn attendance_edit_guard(conn: &Connection, user_id: &str, month: &str) -> Result<(), String> {
    if month_is_locked(conn, user_id, month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً لتعديله".into());
    }
    if attendance_is_approved(conn, user_id, month)? {
        return Err("حضور هذا الشهر معتمد، ألغِ اعتماد الحضور أولاً لتعديله".into());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn set_day_override(conn: &Connection, tenant_id: &str, user_id: &str, day: &str, absent: bool, in_time: Option<&str>, out_time: Option<&str>, reason: &str, actor_id: &str) -> Result<(), String> {
    let Some(d) = parse_date(day) else { return Err("التاريخ غير صالح".into()) };
    attendance_edit_guard(conn, user_id, &d.format("%Y-%m").to_string())?;
    if reason.trim().is_empty() {
        return Err("اكتب سبب تصحيح اليوم".into());
    }
    let (in_time, out_time) = if absent {
        (None, None)
    } else {
        let i = in_time.map(str::trim).filter(|s| !s.is_empty()).ok_or("اكتب وقت الدخول")?;
        if crate::attendance::parse_hhmm(i).is_none() {
            return Err("وقت الدخول غير صالح، اكتبه بصيغة 09:00".into());
        }
        let o = out_time.map(str::trim).filter(|s| !s.is_empty());
        if let Some(o) = o {
            if crate::attendance::parse_hhmm(o).is_none() {
                return Err("وقت الخروج غير صالح، اكتبه بصيغة 17:00".into());
            }
        }
        (Some(i.to_string()), o.map(str::to_string))
    };
    conn.execute(
        "INSERT INTO payroll_day_overrides (id, tenant_id, user_id, day, absent, in_time, out_time, reason, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
         ON CONFLICT(user_id, day) DO UPDATE SET absent = ?5, in_time = ?6, out_time = ?7, reason = ?8, created_by = ?9, created_at = ?10",
        params![uuid::Uuid::now_v7().to_string(), tenant_id, user_id, day, absent as i64, in_time, out_time, reason.trim(), actor_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_day_override(conn: &Connection, user_id: &str, day: &str) -> Result<(), String> {
    let Some(d) = parse_date(day) else { return Err("التاريخ غير صالح".into()) };
    attendance_edit_guard(conn, user_id, &d.format("%Y-%m").to_string())?;
    conn.execute("DELETE FROM payroll_day_overrides WHERE user_id = ?1 AND day = ?2", params![user_id, day]).map_err(|e| e.to_string())?;
    Ok(())
}

fn list_day_overrides(conn: &Connection, user_id: &str, month: &str) -> Result<Vec<DayOverride>, String> {
    let mut stmt = conn
        .prepare("SELECT day, absent, in_time, out_time, reason FROM payroll_day_overrides WHERE user_id = ?1 AND substr(day, 1, 7) = ?2 ORDER BY day")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id, month], |r| Ok(DayOverride { day: r.get(0)?, absent: r.get::<_, i64>(1)? != 0, in_time: r.get(2)?, out_time: r.get(3)?, reason: r.get(4)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// NOT_REQUIRED (the owner did not turn the approval on and nothing was approved) | PENDING | APPROVED.
pub fn attendance_state(conn: &Connection, user_id: &str, month: &str, required: bool) -> Result<String, String> {
    Ok(if attendance_is_approved(conn, user_id, month)? {
        "APPROVED"
    } else if required {
        "PENDING"
    } else {
        "NOT_REQUIRED"
    }
    .to_string())
}

/// A person's month of attendance, day by day, for the owner or manager to check and correct before payroll.
#[derive(Debug, Clone, Serialize)]
pub struct AttendanceReview {
    pub user_id: String,
    pub user_name: String,
    pub month: String,
    /// The owner requires approval before a payslip can be approved.
    pub required: bool,
    pub approved: bool,
    pub approved_at: Option<String>,
    /// The payslip is already approved: nothing about the month can change.
    pub payslip_locked: bool,
    pub days: Vec<DayLine>,
    pub overrides: Vec<DayOverride>,
    pub present_days: i64,
    pub absent_days: i64,
    pub late_days: i64,
    pub late_minutes: i64,
    pub early_minutes: i64,
    pub overtime_minutes: i64,
    pub extra_days: i64,
    pub paid_leave_days: i64,
    pub warnings: Vec<String>,
}

pub fn attendance_review(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, tz_offset_minutes: i64, as_of: NaiveDate) -> Result<AttendanceReview, String> {
    let settings = load_settings(conn, tenant_id)?;
    let p = compute_draft(conn, tenant_id, user_id, month, tz_offset_minutes, as_of)?;
    let approved_at: Option<String> = conn
        .query_row("SELECT approved_at FROM payroll_attendance_approvals WHERE user_id = ?1 AND month = ?2", params![user_id, month], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let count = |f: &dyn Fn(&DayLine) -> bool| p.days.iter().filter(|d| f(d)).count() as i64;
    Ok(AttendanceReview {
        user_id: user_id.to_string(),
        user_name: p.user_name.clone(),
        month: month.to_string(),
        required: settings.require_attendance_approval,
        approved: approved_at.is_some(),
        approved_at,
        payslip_locked: month_is_locked(conn, user_id, month)?,
        present_days: count(&|d| matches!(d.status.as_str(), "PRESENT" | "LATE")),
        absent_days: p.absent_days,
        late_days: p.late_days,
        late_minutes: p.late_minutes,
        early_minutes: p.days.iter().map(|d| d.early_minutes).sum(),
        overtime_minutes: p.days.iter().map(|d| d.overtime_minutes).sum(),
        extra_days: count(&|d| d.status == "OFF_WORKED"),
        paid_leave_days: p.paid_leave_days,
        warnings: p.warnings.iter().filter(|w| !w.contains("اعتماد")).cloned().collect(),
        overrides: list_day_overrides(conn, user_id, month)?,
        days: p.days,
    })
}

/// "اعتماد الحضور": the person's month of attendance is checked and frozen. Only a finished month.
pub fn approve_attendance(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, tz_offset_minutes: i64, as_of: NaiveDate, actor_id: &str) -> Result<AttendanceReview, String> {
    let (_, last) = month_bounds(month)?;
    if as_of < last {
        return Err("لا يمكن اعتماد حضور شهر لم ينتهِ بعد. انتظر آخر يوم من الشهر".into());
    }
    if attendance_is_approved(conn, user_id, month)? {
        return Err("حضور هذا الشهر معتمد بالفعل".into());
    }
    let mut review = attendance_review(conn, tenant_id, user_id, month, tz_offset_minutes, as_of)?;
    let summary = serde_json::json!({
        "present_days": review.present_days, "absent_days": review.absent_days, "late_days": review.late_days, "late_minutes": review.late_minutes,
        "early_minutes": review.early_minutes, "overtime_minutes": review.overtime_minutes, "extra_days": review.extra_days, "paid_leave_days": review.paid_leave_days,
        "corrected_days": review.overrides.len(),
    });
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO payroll_attendance_approvals (id, tenant_id, user_id, month, summary, approved_by, approved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![uuid::Uuid::now_v7().to_string(), tenant_id, user_id, month, summary.to_string(), actor_id, now],
    )
    .map_err(|e| e.to_string())?;
    review.approved = true;
    review.approved_at = Some(now);
    Ok(review)
}

/// Takes the approval back so the month can be corrected again. Not possible once the payslip is approved.
pub fn unapprove_attendance(conn: &Connection, user_id: &str, month: &str) -> Result<(), String> {
    if month_is_locked(conn, user_id, month)? {
        return Err("راتب هذا الشهر معتمد، أعد فتحه أولاً".into());
    }
    conn.execute("DELETE FROM payroll_attendance_approvals WHERE user_id = ?1 AND month = ?2", params![user_id, month]).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Advances that are also an expense (once)
// ---------------------------------------------------------------------------

/// Is there already an expense for this advance? (The expense carries the advance's id as its reference.)
pub fn advance_has_cost(conn: &Connection, advance_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM operational_costs WHERE reference_type = ?1 AND reference_id = ?2",
        params![crate::finance::ADVANCE_REFERENCE, advance_id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Records the expense for an advance, unless it already has one (checked by reference, so the two ways of entering
/// an advance, from Payroll and from Finance, can never both record it). `fields` is what the Finance form typed.
/// Returns the new expense's id, or None when the advance already had its expense.
pub fn ensure_advance_cost(conn: &Connection, tenant_id: &str, branch_id: &str, advance_id: &str, actor_id: &str, fields: Option<crate::finance::CostFields>) -> Result<Option<String>, String> {
    if advance_has_cost(conn, advance_id)? {
        return Ok(None);
    }
    let (user_id, amount, given_on, reason): (String, i64, String, Option<String>) = conn
        .query_row("SELECT user_id, amount_cents, given_on, reason FROM payroll_advances WHERE id = ?1 AND tenant_id = ?2", params![advance_id, tenant_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("السلفة غير موجودة")?;
    let name = staff_name(conn, &user_id)?;
    let mut f = fields.unwrap_or_default();
    f.category = crate::finance::ADVANCE_CATEGORY.to_string();
    f.amount_cents = amount;
    f.date = given_on;
    f.reference_type = Some(crate::finance::ADVANCE_REFERENCE.to_string());
    f.reference_id = Some(advance_id.to_string());
    f.payee = Some(name.clone());
    if f.notes.as_deref().map(str::trim).unwrap_or("").is_empty() {
        f.notes = Some(match reason.as_deref().filter(|r| !r.trim().is_empty()) {
            Some(r) => format!("سلفة {name}: {r}"),
            None => format!("سلفة {name}"),
        });
    }
    f.normalise()?;
    let id = crate::finance::insert_cost(conn, tenant_id, branch_id, actor_id, &f).map_err(|e| e.to_string())?;
    Ok(Some(id))
}

/// A new advance and its expense, together. Returns (advance id, expense id when one was recorded).
#[allow(clippy::too_many_arguments)]
pub fn add_advance_with_cost(conn: &Connection, tenant_id: &str, branch_id: &str, user_id: &str, amount_cents: i64, instalment_cents: i64, given_on: &str, reason: Option<&str>, actor_id: &str, fields: Option<crate::finance::CostFields>) -> Result<(String, Option<String>), String> {
    let advance_id = add_advance(conn, tenant_id, Some(branch_id), user_id, amount_cents, instalment_cents, given_on, reason, actor_id)?;
    let cost_id = ensure_advance_cost(conn, tenant_id, branch_id, &advance_id, actor_id, fields)?;
    Ok((advance_id, cost_id))
}

/// One line of a worker's account with the business.
#[derive(Debug, Clone, Serialize)]
pub struct StatementLine {
    pub date: String,
    /// ADVANCE (given to the worker) | REPAYMENT (taken off a payslip)
    pub kind: String,
    pub label: String,
    /// Positive: the worker owes more. Negative: they paid some back.
    pub amount_cents: i64,
    /// What the worker owes after this line.
    pub balance_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatementPayslip {
    pub month: String,
    pub status: String,
    pub earned_cents: i64,
    pub advance_repaid_cents: i64,
    pub net_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkerStatement {
    pub user_id: String,
    pub user_name: String,
    pub lines: Vec<StatementLine>,
    pub total_advanced_cents: i64,
    pub total_repaid_cents: i64,
    pub owed_cents: i64,
    pub payslips: Vec<StatementPayslip>,
}

/// The worker's statement: every advance given, every instalment taken off an approved payslip, and what is still owed.
pub fn worker_statement(conn: &Connection, tenant_id: &str, user_id: &str) -> Result<WorkerStatement, String> {
    let name = staff_name(conn, user_id)?;
    let advances = list_advances(conn, tenant_id, Some(user_id), false)?;
    // (date, order within a day, label, amount, kind)
    let mut raw: Vec<(String, u8, String, i64, &'static str)> = Vec::new();
    for a in &advances {
        let label = match a.reason.as_deref() {
            Some(r) => format!("سلفة: {r}"),
            None => "سلفة".to_string(),
        };
        raw.push((a.given_on.clone(), 0, label, a.amount_cents, "ADVANCE"));
    }
    let mut payslips = Vec::new();
    let mut stmt = conn
        .prepare("SELECT month, status, earned_cents, net_cents, details, approved_at FROM payroll_payslips WHERE user_id = ?1 AND tenant_id = ?2 ORDER BY month")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![user_id, tenant_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (month, status, earned, net, details, approved_at) = row.map_err(|e| e.to_string())?;
        let p: Payslip = serde_json::from_str(&details).map_err(|e| e.to_string())?;
        for (_, amount) in &p.advance_repayments {
            raw.push((approved_at.chars().take(10).collect(), 1, format!("قسط من راتب {month}"), -amount, "REPAYMENT"));
        }
        payslips.push(StatementPayslip { month, status, earned_cents: earned, advance_repaid_cents: p.advance_repaid_cents, net_cents: net });
    }
    raw.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    let mut balance = 0;
    let lines: Vec<StatementLine> = raw
        .into_iter()
        .map(|(date, _, label, amount, kind)| {
            balance += amount;
            StatementLine { date, kind: kind.to_string(), label, amount_cents: amount, balance_cents: balance }
        })
        .collect();
    let total_advanced: i64 = advances.iter().map(|a| a.amount_cents).sum();
    let total_repaid: i64 = advances.iter().map(|a| a.repaid_cents).sum();
    Ok(WorkerStatement { user_id: user_id.to_string(), user_name: name, lines, total_advanced_cents: total_advanced, total_repaid_cents: total_repaid, owed_cents: total_advanced - total_repaid, payslips })
}

// ---------------------------------------------------------------------------
// The month, day by day
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DayLine {
    pub date: String,
    /// PRESENT | LATE | ABSENT | OFF | OFF_WORKED | PAID_LEAVE | MISSING_OUT | PENDING | NO_RECORD
    pub status: String,
    pub first_in: Option<String>,
    pub last_out: Option<String>,
    pub worked_minutes: i64,
    /// Late minutes that count toward the deduction (0 when within the grace).
    pub late_minutes: i64,
    pub early_minutes: i64,
    pub overtime_minutes: i64,
    pub note: Option<String>,
    /// An official holiday the owner marked.
    #[serde(default)]
    pub holiday: bool,
    /// The day was corrected by hand in the attendance review (the punch log itself is never edited).
    #[serde(default)]
    pub corrected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payslip {
    pub id: Option<String>,
    pub user_id: String,
    pub user_name: String,
    pub month: String,
    /// DRAFT | APPROVED | PAID
    pub status: String,
    pub pay_type: String,
    pub rate_cents: i64,
    pub day_pay_cents: i64,
    pub base_cents: i64,
    pub late_days: i64,
    pub late_minutes: i64,
    pub late_deduction_cents: i64,
    pub absent_days: i64,
    pub absence_deduction_cents: i64,
    pub early_minutes: i64,
    pub early_deduction_cents: i64,
    pub overtime_minutes: i64,
    pub overtime_pay_cents: i64,
    pub paid_leave_days: i64,
    /// Days worked on a weekly day off or a holiday, paid as extra days (rule `DAY_PAY`).
    #[serde(default)]
    pub extra_days: i64,
    #[serde(default)]
    pub extra_day_pay_cents: i64,
    /// The percent of a day's pay each extra day was paid at (frozen with the payslip).
    #[serde(default)]
    pub extra_day_multiplier_pct: i64,
    /// Days the owner deducted by hand (hundredths of a day: 150 = one and a half), separate from absence.
    #[serde(default)]
    pub deduction_days_x100: i64,
    #[serde(default)]
    pub deduction_days_cents: i64,
    #[serde(default)]
    pub day_deductions: Vec<DayDeductionRow>,
    pub bonus_cents: i64,
    pub fine_cents: i64,
    /// Everything added before any deduction: base + overtime + extra days + bonuses.
    #[serde(default)]
    pub gross_cents: i64,
    /// Everything deducted: late + absence + early + deduction days + fines.
    #[serde(default)]
    pub total_deductions_cents: i64,
    /// What the person earned this month (gross − deductions, never below 0).
    pub earned_cents: i64,
    pub advance_repaid_cents: i64,
    /// What is handed over: earned minus the advance instalments.
    pub net_cents: i64,
    /// (advance id, amount) taken off the advances when the payslip is approved.
    pub advance_repayments: Vec<(String, i64)>,
    pub days: Vec<DayLine>,
    pub adjustments: Vec<AdjustmentRow>,
    pub warnings: Vec<String>,
    pub approved_at: Option<String>,
    pub paid_at: Option<String>,
    /// NOT_REQUIRED | PENDING | APPROVED: whether this month's attendance is approved (see `attendance_state`).
    #[serde(default = "default_attendance_state")]
    pub attendance_status: String,
}

fn default_attendance_state() -> String {
    "NOT_REQUIRED".to_string()
}

impl Payslip {
    /// Works out `gross_cents` and `total_deductions_cents` from the components (also for a payslip stored before
    /// those two existed, so every payslip shows every component and both totals).
    pub fn fill_totals(&mut self) {
        self.gross_cents = self.base_cents + self.overtime_pay_cents + self.extra_day_pay_cents + self.bonus_cents;
        self.total_deductions_cents = self.late_deduction_cents + self.absence_deduction_cents + self.early_deduction_cents + self.deduction_days_cents + self.fine_cents;
    }
}

fn muldiv(a: i64, b: i64, c: i64) -> i64 {
    if c <= 0 {
        return 0;
    }
    ((a as i128 * b as i128 + c as i128 / 2) / c as i128) as i64
}

fn month_bounds(month: &str) -> Result<(NaiveDate, NaiveDate), String> {
    let first = valid_month(month).ok_or_else(|| "الشهر غير صالح".to_string())?;
    let next = if first.month() == 12 { NaiveDate::from_ymd_opt(first.year() + 1, 1, 1) } else { NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1) }.ok_or("الشهر غير صالح")?;
    Ok((first, next - Duration::days(1)))
}

struct Interval {
    start: NaiveDateTime,
    end: Option<NaiveDateTime>,
}

/// Pairs the IN/OUT punches of one person (oldest first) into intervals. A second IN before an OUT, or an OUT more than
/// `MAX_OPEN_SHIFT_HOURS` after its IN, leaves the earlier interval without a departure (a forgotten clock-out).
fn pair_punches(punches: &[(NaiveDateTime, bool)]) -> Vec<Interval> {
    let max_open = Duration::hours(crate::attendance::MAX_OPEN_SHIFT_HOURS);
    let mut out: Vec<Interval> = Vec::new();
    let mut open: Option<NaiveDateTime> = None;
    for (at, is_in) in punches {
        if *is_in {
            if let Some(prev) = open.replace(*at) {
                out.push(Interval { start: prev, end: None });
            }
        } else if let Some(start) = open {
            if *at - start <= max_open {
                out.push(Interval { start, end: Some(*at) });
                open = None;
            }
            // else: an orphan departure, ignored; the arrival stays open
        }
    }
    if let Some(prev) = open {
        out.push(Interval { start: prev, end: None });
    }
    out
}

fn hhmm(t: NaiveDateTime) -> String {
    t.format("%H:%M").to_string()
}

fn staff_name(conn: &Connection, user_id: &str) -> Result<String, String> {
    conn.query_row("SELECT name FROM staff WHERE id = ?1", params![user_id], |r| r.get(0)).map_err(|e| e.to_string())
}

/// The month's payslip, recomputed from live data. `as_of` is today's date in the till's local time:
/// days from it on are not judged (no absence for a day that has not finished).
pub fn compute_draft(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, tz_offset_minutes: i64, as_of: NaiveDate) -> Result<Payslip, String> {
    let settings = load_settings(conn, tenant_id)?;
    let attendance = crate::attendance::load_settings(conn, tenant_id)?;
    let pay = load_employee_pay(conn, user_id)?.ok_or_else(|| "لم يُحدَّد راتب هذا الموظف بعد".to_string())?;
    let name = staff_name(conn, user_id)?;
    let (first, last) = month_bounds(month)?;
    let tz = Duration::minutes(tz_offset_minutes.clamp(-14 * 60, 14 * 60));
    let mut warnings: Vec<String> = Vec::new();

    let shift_minutes = pay.shift_minutes.unwrap_or(settings.shift_minutes).max(1);
    let shift_start_str = pay.shift_start.as_deref().filter(|s| !s.is_empty()).unwrap_or(&attendance.shift_start).to_string();
    let shift_start = crate::attendance::parse_hhmm(&shift_start_str).unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).expect("valid"));
    let grace = attendance.late_grace_minutes;

    // The punches, in local time, from a day before the month to a day after (a shift can cross midnight).
    let window_start = (first - Duration::days(1)).format("%Y-%m-%dT00:00:00").to_string();
    let window_end = (last + Duration::days(2)).format("%Y-%m-%dT00:00:00").to_string();
    let mut stmt = conn
        .prepare("SELECT punched_at, direction FROM attendance_punches WHERE user_id = ?1 AND punched_at >= ?2 AND punched_at < ?3 ORDER BY punched_at")
        .map_err(|e| e.to_string())?;
    let raw: Vec<(String, String)> = stmt
        .query_map(params![user_id, window_start, window_end], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let punches: Vec<(NaiveDateTime, bool)> = raw
        .iter()
        .filter_map(|(at, dir)| DateTime::parse_from_rfc3339(at).ok().map(|t| (t.naive_utc() + tz, dir == "IN")))
        .collect();
    let mut intervals = pair_punches(&punches);

    // Days corrected by hand in the attendance review replace what the punches say for that day.
    let overrides = list_day_overrides(conn, user_id, month)?;
    for o in &overrides {
        let Some(od) = parse_date(&o.day) else { continue };
        intervals.retain(|iv| iv.start.date() != od);
        if o.absent {
            continue;
        }
        let Some(start_t) = o.in_time.as_deref().and_then(crate::attendance::parse_hhmm) else { continue };
        let start = NaiveDateTime::new(od, start_t);
        let end = o.out_time.as_deref().and_then(crate::attendance::parse_hhmm).map(|t| {
            let e = NaiveDateTime::new(od, t);
            if e > start { e } else { e + Duration::days(1) }
        });
        intervals.push(Interval { start, end });
    }
    let corrected_days: std::collections::BTreeSet<NaiveDate> = overrides.iter().filter_map(|o| parse_date(&o.day)).collect();
    let holidays: std::collections::BTreeSet<NaiveDate> = settings.holidays.iter().filter_map(|h| parse_date(h)).collect();

    // Group the intervals by the local day they started on.
    let mut by_day: BTreeMap<NaiveDate, Vec<&Interval>> = BTreeMap::new();
    for iv in &intervals {
        by_day.entry(iv.start.date()).or_default().push(iv);
    }

    // Paid-leave marks.
    let mut leave: BTreeMap<NaiveDate, Option<String>> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT day, note FROM payroll_day_marks WHERE user_id = ?1 AND substr(day, 1, 7) = ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![user_id, month], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (d, note) = row.map_err(|e| e.to_string())?;
            if let Some(date) = parse_date(&d) {
                leave.insert(date, note);
            }
        }
    }

    let emp_start = pay.start_date.as_deref().and_then(parse_date);
    let emp_end = pay.end_date.as_deref().and_then(parse_date);
    let in_employment = |d: NaiveDate| emp_start.map_or(true, |s| d >= s) && emp_end.map_or(true, |e| d <= e);
    let is_off_day = |d: NaiveDate| holidays.contains(&d) || settings.weekly_off_days.contains(&(d.weekday().num_days_from_sunday() as u8));

    let any_punch_in_month = by_day.keys().any(|d| *d >= first && *d <= last) || corrected_days.iter().any(|d| *d >= first && *d <= last);
    let tracked = pay.track_attendance;
    if tracked && !any_punch_in_month && as_of > first {
        warnings.push("لا توجد أي بصمة لهذا الشهر، لذلك لا تُحسب الغيابات. سجّل الحضور أو أوقف «احتساب الحضور» لهذا الموظف.".into());
    }
    // Absence is only judged when attendance exists for the month at all.
    let judge_absence = tracked && any_punch_in_month;

    let hour_rate = pay.rate_cents;
    let day_pay = match pay.pay_type.as_str() {
        "MONTHLY" => muldiv(pay.rate_cents, 1, settings.days_per_month.max(1)),
        "DAILY" => pay.rate_cents,
        _ => muldiv(hour_rate, shift_minutes, 60),
    };
    let minute_pay = |minutes: i64, pct: i64| muldiv(muldiv(day_pay, minutes, shift_minutes), pct, 100);

    let mut days: Vec<DayLine> = Vec::new();
    let (mut late_days, mut late_minutes_total, mut late_deduction) = (0i64, 0i64, 0i64);
    let (mut absent_days, mut early_total, mut overtime_total, mut paid_leave_days) = (0i64, 0i64, 0i64, 0i64);
    let (mut worked_total, mut present_scheduled_days, mut scheduled_days, mut employed_scheduled_days) = (0i64, 0i64, 0i64, 0i64);
    let mut missing_out_days = 0i64;
    let extra_day_pay_on = settings.extra_day_rule == "DAY_PAY";
    let (mut extra_days, mut extra_minutes) = (0i64, 0i64);

    let mut day = first;
    while day <= last {
        let scheduled = !is_off_day(day);
        if scheduled {
            scheduled_days += 1;
            if in_employment(day) {
                employed_scheduled_days += 1;
            }
        }
        let employed = in_employment(day);
        let ivs = by_day.get(&day).cloned().unwrap_or_default();
        let has_leave = leave.contains_key(&day);
        let note = leave.get(&day).cloned().flatten();
        let finished = day < as_of;
        let mut line = DayLine { date: day.format("%Y-%m-%d").to_string(), status: "OFF".into(), first_in: None, last_out: None, worked_minutes: 0, late_minutes: 0, early_minutes: 0, overtime_minutes: 0, note, holiday: holidays.contains(&day), corrected: corrected_days.contains(&day) };

        if !employed {
            // not employed that day: nothing
        } else if !ivs.is_empty() {
            let first_in = ivs.iter().map(|i| i.start).min().expect("non-empty");
            let closed: Vec<&&Interval> = ivs.iter().filter(|i| i.end.is_some()).collect();
            let last_out = closed.iter().filter_map(|i| i.end).max();
            let has_open = ivs.iter().any(|i| i.end.is_none());
            let worked: i64 = closed.iter().map(|i| (i.end.expect("closed") - i.start).num_minutes()).sum();
            line.first_in = Some(hhmm(first_in));
            line.last_out = last_out.map(hhmm);
            line.worked_minutes = worked;
            worked_total += worked;
            if has_open && finished {
                missing_out_days += 1;
            }

            if !scheduled {
                // Worked on a weekly day off or a holiday: the whole time is extra, paid either as an extra day
                // (when the owner chose that) or as overtime, never both.
                line.status = "OFF_WORKED".into();
                if tracked && extra_day_pay_on {
                    if worked > 0 {
                        extra_days += 1;
                        extra_minutes += worked;
                    }
                } else if tracked && settings.overtime_rule == "PER_HOUR" {
                    line.overtime_minutes = worked;
                    overtime_total += worked;
                }
            } else {
                present_scheduled_days += 1;
                let expected_start = NaiveDateTime::new(day, shift_start);
                let late_raw = (first_in - expected_start).num_minutes().max(0);
                let counted = if late_raw <= grace { 0 } else if settings.late_counts_from_start { late_raw } else { late_raw - grace };
                let expected_end = expected_start + Duration::minutes(shift_minutes);
                let early = match last_out {
                    Some(out) if !has_open => (expected_end - out).num_minutes().max(0),
                    _ => 0,
                };
                let overtime_raw = if has_open { 0 } else { (worked - shift_minutes).max(0) };
                let overtime = if overtime_raw > settings.overtime_after_minutes { overtime_raw } else { 0 };

                line.status = if has_open && finished { "MISSING_OUT".into() } else if counted > 0 { "LATE".into() } else { "PRESENT".into() };
                if has_leave {
                    // An accepted excuse waives the deductions of that day, not the overtime.
                    line.status = "PAID_LEAVE".into();
                    paid_leave_days += 1;
                    present_scheduled_days -= 1;
                } else if tracked {
                    if counted > 0 {
                        line.late_minutes = counted;
                        late_days += 1;
                        late_minutes_total += counted;
                        late_deduction += match settings.late_rule.as_str() {
                            "PER_MINUTE" => minute_pay(counted, settings.late_multiplier_pct),
                            "FIXED_PER_LATE" => settings.late_fixed_cents,
                            "TIERS" => settings.late_tiers.iter().rev().find(|t| late_raw >= t.from_minutes).map(|t| muldiv(day_pay, t.day_pct, 100)).unwrap_or(0),
                            _ => 0,
                        };
                    }
                    if early > 0 {
                        line.early_minutes = early;
                        if settings.early_rule == "PER_MINUTE" {
                            early_total += early;
                        }
                    }
                }
                if tracked && overtime > 0 {
                    line.overtime_minutes = overtime;
                    if settings.overtime_rule == "PER_HOUR" {
                        overtime_total += overtime;
                    }
                }
            }
        } else if has_leave && scheduled {
            line.status = "PAID_LEAVE".into();
            paid_leave_days += 1;
        } else if scheduled && finished && judge_absence {
            line.status = "ABSENT".into();
            absent_days += 1;
        } else if scheduled {
            // A working day with no punches that is not judged: still to come, or there is no attendance record to judge by.
            line.status = if finished { "NO_RECORD".into() } else { "PENDING".into() };
        }
        days.push(line);
        day += Duration::days(1);
    }
    if missing_out_days > 0 {
        warnings.push(format!("{missing_out_days} يوم بدون بصمة خروج. أضف بصمة الخروج الناقصة حتى يُحسب الخروج المبكر والوقت الإضافي بدقة."));
    }
    if as_of <= last {
        warnings.push("الشهر لم ينتهِ بعد: الحساب حتى اليوم، ولا تُعدّ الأيام القادمة غياباً.".into());
    }

    // Base pay.
    let base = match pay.pay_type.as_str() {
        "MONTHLY" => {
            if scheduled_days > 0 { muldiv(pay.rate_cents, employed_scheduled_days, scheduled_days) } else { 0 }
        }
        "DAILY" => {
            // Days worked, plus the days the owner marked as paid leave. With attendance not tracked, every working day counts.
            let counted_days = if tracked { present_scheduled_days + paid_leave_days } else { employed_scheduled_days };
            pay.rate_cents * counted_days
        }
        _ => {
            let leave_minutes = paid_leave_days * shift_minutes;
            if tracked {
                muldiv(hour_rate, worked_total + leave_minutes, 60)
            } else {
                muldiv(hour_rate, employed_scheduled_days * shift_minutes, 60)
            }
        }
    };
    let deducts_time = pay.pay_type != "HOURLY";

    let late_ded = if deducts_time { late_deduction } else { 0 };
    let absence_ded = if pay.pay_type == "MONTHLY" {
        match settings.absence_rule.as_str() {
            "DAY_PAY" => muldiv(day_pay * absent_days, settings.absence_multiplier_pct, 100),
            "FIXED" => settings.absence_fixed_cents * absent_days,
            _ => 0,
        }
    } else {
        0
    };
    let early_ded = if deducts_time && settings.early_rule == "PER_MINUTE" { minute_pay(early_total, settings.early_multiplier_pct) } else { 0 };
    let overtime_pay = if settings.overtime_rule == "PER_HOUR" {
        if pay.pay_type == "HOURLY" {
            // Their normal pay already covers the hours worked; only the extra share is added.
            minute_pay(overtime_total, (settings.overtime_multiplier_pct - 100).max(0))
        } else {
            minute_pay(overtime_total, settings.overtime_multiplier_pct)
        }
    } else {
        0
    };

    // Extra days (worked on a day off or a holiday). A monthly or daily person's base never includes those days, so
    // each is paid at the owner's multiplier of a day's pay; an hourly person's base already paid the hours, so only
    // the extra share is added (as overtime does).
    let extra_day_pay = if !extra_day_pay_on {
        0
    } else if pay.pay_type == "HOURLY" {
        minute_pay(extra_minutes, (settings.holiday_multiplier_pct - 100).max(0))
    } else {
        muldiv(day_pay * extra_days, settings.holiday_multiplier_pct, 100)
    };

    let adjustments = list_adjustments(conn, user_id, month)?;
    let bonus: i64 = adjustments.iter().filter(|a| a.kind == "BONUS").map(|a| a.amount_cents).sum();
    let fine: i64 = adjustments.iter().filter(|a| a.kind == "FINE").map(|a| a.amount_cents).sum();

    // Days the owner deducted by hand, on top of (and separate from) any absence.
    let day_deductions = list_day_deductions(conn, user_id, month)?;
    let deduction_days_x100: i64 = day_deductions.iter().map(|d| d.days_x100).sum();
    let deduction_days_cents = muldiv(day_pay, deduction_days_x100, 100);

    let gross = base + overtime_pay + extra_day_pay + bonus;
    let total_deductions = late_ded + absence_ded + early_ded + deduction_days_cents + fine;
    let raw_earned = gross - total_deductions;
    if raw_earned < 0 {
        warnings.push("الخصومات والغرامات أكبر من الراتب، فصار المستحق صفراً.".into());
    }
    let earned = raw_earned.max(0);

    // Advances: take each open advance's instalment while there is pay left to take it from.
    let mut left = earned;
    let mut repayments: Vec<(String, i64)> = Vec::new();
    for adv in list_advances(conn, tenant_id, Some(user_id), true)? {
        if left <= 0 {
            break;
        }
        let take = adv.instalment_cents.min(adv.remaining_cents).min(left);
        if take > 0 {
            repayments.push((adv.id, take));
            left -= take;
        }
    }
    let advance_repaid: i64 = repayments.iter().map(|(_, a)| a).sum();

    let required = settings.require_attendance_approval;
    let attendance_status = attendance_state(conn, user_id, month, required)?;
    if attendance_status == "PENDING" {
        warnings.push("حضور هذا الشهر لم يُعتمد بعد. اعتمده من «مراجعة الحضور» قبل اعتماد الراتب.".into());
    }

    let mut payslip = Payslip {
        id: None,
        user_id: user_id.to_string(),
        user_name: name,
        month: month.to_string(),
        status: "DRAFT".into(),
        pay_type: pay.pay_type.clone(),
        rate_cents: pay.rate_cents,
        day_pay_cents: day_pay,
        base_cents: base,
        late_days,
        late_minutes: late_minutes_total,
        late_deduction_cents: late_ded,
        absent_days,
        absence_deduction_cents: absence_ded,
        early_minutes: early_total,
        early_deduction_cents: early_ded,
        overtime_minutes: overtime_total,
        overtime_pay_cents: overtime_pay,
        paid_leave_days,
        extra_days,
        extra_day_pay_cents: extra_day_pay,
        extra_day_multiplier_pct: settings.holiday_multiplier_pct,
        deduction_days_x100,
        deduction_days_cents,
        day_deductions,
        bonus_cents: bonus,
        fine_cents: fine,
        gross_cents: gross,
        total_deductions_cents: total_deductions,
        earned_cents: earned,
        advance_repaid_cents: advance_repaid,
        net_cents: earned - advance_repaid,
        advance_repayments: repayments,
        days,
        adjustments,
        warnings,
        approved_at: None,
        paid_at: None,
        attendance_status,
    };
    payslip.fill_totals();
    Ok(payslip)
}

/// The stored payslip when the month is approved or paid, else a fresh draft.
pub fn payslip(conn: &Connection, tenant_id: &str, user_id: &str, month: &str, tz_offset_minutes: i64, as_of: NaiveDate) -> Result<Payslip, String> {
    let stored: Option<(String, String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, status, details, approved_at, paid_at FROM payroll_payslips WHERE user_id = ?1 AND month = ?2",
            params![user_id, month],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((id, status, details, approved_at, paid_at)) = stored {
        let mut p: Payslip = serde_json::from_str(&details).map_err(|e| e.to_string())?;
        p.id = Some(id);
        p.status = status;
        p.approved_at = Some(approved_at);
        p.paid_at = paid_at;
        p.fill_totals();
        return Ok(p);
    }
    compute_draft(conn, tenant_id, user_id, month, tz_offset_minutes, as_of)
}

/// Freezes the month's payslip for one person and takes the advance instalments.
#[allow(clippy::too_many_arguments)]
pub fn approve(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, user_id: &str, month: &str, tz_offset_minutes: i64, as_of: NaiveDate, actor_id: &str) -> Result<Payslip, String> {
    if month_is_locked(conn, user_id, month)? {
        return Err("راتب هذا الشهر معتمد بالفعل".into());
    }
    let (_, last) = month_bounds(month)?;
    if as_of < last {
        return Err("لا يمكن اعتماد راتب شهر لم ينتهِ بعد. انتظر آخر يوم من الشهر".into());
    }
    let mut p = compute_draft(conn, tenant_id, user_id, month, tz_offset_minutes, as_of)?;
    if p.attendance_status == "PENDING" {
        return Err("اعتمد حضور هذا الشهر أولاً من «مراجعة الحضور» ثم اعتمد الراتب".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    let now = Utc::now().to_rfc3339();
    p.status = "APPROVED".into();
    p.id = Some(id.clone());
    p.approved_at = Some(now.clone());
    let details = serde_json::to_string(&p).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO payroll_payslips (id, tenant_id, branch_id, user_id, month, status, earned_cents, net_cents, details, approved_by, approved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, 'APPROVED', ?6, ?7, ?8, ?9, ?10)",
        params![id, tenant_id, branch_id, user_id, month, p.earned_cents, p.net_cents, details, actor_id, now],
    )
    .map_err(|e| e.to_string())?;
    for (advance_id, amount) in &p.advance_repayments {
        conn.execute("UPDATE payroll_advances SET repaid_cents = repaid_cents + ?1 WHERE id = ?2", params![amount, advance_id]).map_err(|e| e.to_string())?;
    }
    Ok(p)
}

/// Pays the approved salary: the earned amount becomes an expense under `رواتب`.
pub fn pay(conn: &Connection, tenant_id: &str, payslip_id: &str, pay_date: NaiveDate, actor_id: &str) -> Result<(), String> {
    let row: Option<(String, String, Option<String>, String, i64, String)> = conn
        .query_row(
            "SELECT status, user_id, branch_id, month, earned_cents, details FROM payroll_payslips WHERE id = ?1 AND tenant_id = ?2",
            params![payslip_id, tenant_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, user_id, branch_id, month, earned, details)) = row else { return Err("كشف الراتب غير موجود".into()) };
    if status == "PAID" {
        return Err("هذا الراتب مصروف بالفعل".into());
    }
    // An advance that was already recorded as an expense when it was handed over (category «سلفة موظف») is not an
    // expense a second time when it is taken back off the salary: only the rest of what was earned is.
    let stored: Payslip = serde_json::from_str(&details).map_err(|e| e.to_string())?;
    let mut already_expensed = 0;
    for (advance_id, amount) in &stored.advance_repayments {
        if advance_has_cost(conn, advance_id)? {
            already_expensed += amount;
        }
    }
    let earned = (earned - already_expensed).max(0);
    let name = staff_name(conn, &user_id)?;
    let now = Utc::now().to_rfc3339();
    let expense_id = if earned > 0 {
        let id = uuid::Uuid::now_v7().to_string();
        conn.execute(
            "INSERT INTO operational_costs (id, tenant_id, branch_id, category, amount_cents, date, notes, user_id, reference_type, reference_id, last_modified, sync_status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'payroll', ?9, ?10, 'pending')",
            params![id, tenant_id, branch_id, crate::profit::SALARY_CATEGORY, earned, pay_date.format("%Y-%m-%d").to_string(), format!("راتب {name} عن شهر {month}"), actor_id, payslip_id, now],
        )
        .map_err(|e| e.to_string())?;
        Some(id)
    } else {
        None
    };
    conn.execute(
        "UPDATE payroll_payslips SET status = 'PAID', paid_by = ?1, paid_at = ?2, expense_id = ?3 WHERE id = ?4",
        params![actor_id, now, expense_id, payslip_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Takes an approved (not yet paid) payslip back to a draft: the advance instalments go back on the advances.
pub fn reopen(conn: &Connection, tenant_id: &str, payslip_id: &str) -> Result<(), String> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT status, details FROM payroll_payslips WHERE id = ?1 AND tenant_id = ?2", params![payslip_id, tenant_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((status, details)) = row else { return Err("كشف الراتب غير موجود".into()) };
    if status == "PAID" {
        return Err("هذا الراتب مصروف ولا يمكن إعادة فتحه".into());
    }
    let p: Payslip = serde_json::from_str(&details).map_err(|e| e.to_string())?;
    for (advance_id, amount) in &p.advance_repayments {
        conn.execute("UPDATE payroll_advances SET repaid_cents = MAX(0, repaid_cents - ?1) WHERE id = ?2", params![amount, advance_id]).map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM payroll_payslips WHERE id = ?1", params![payslip_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct MonthRow {
    pub user_id: String,
    pub name: String,
    pub role: String,
    /// False when the person's pay has not been set yet.
    pub pay_set: bool,
    pub pay_type: Option<String>,
    pub status: String,
    pub base_cents: i64,
    pub deductions_cents: i64,
    pub additions_cents: i64,
    pub earned_cents: i64,
    pub advance_repaid_cents: i64,
    pub net_cents: i64,
    pub warnings: usize,
    pub payslip_id: Option<String>,
    pub gross_cents: i64,
    pub extra_day_pay_cents: i64,
    pub deduction_days_cents: i64,
    /// NOT_REQUIRED | PENDING | APPROVED (attendance approval).
    pub attendance_status: String,
}

/// Everyone's month at a glance.
pub fn month_overview(conn: &Connection, tenant_id: &str, scope: &PayrollScope, month: &str, tz_offset_minutes: i64, as_of: NaiveDate) -> Result<Vec<MonthRow>, String> {
    month_bounds(month)?;
    let mut out = Vec::new();
    for e in list_employees(conn, tenant_id, scope)? {
        if e.pay.is_none() {
            out.push(MonthRow { user_id: e.user_id, name: e.name, role: e.role, pay_set: false, pay_type: None, status: "NO_PAY".into(), base_cents: 0, deductions_cents: 0, additions_cents: 0, earned_cents: 0, advance_repaid_cents: 0, net_cents: 0, warnings: 0, payslip_id: None, gross_cents: 0, extra_day_pay_cents: 0, deduction_days_cents: 0, attendance_status: "NOT_REQUIRED".into() });
            continue;
        }
        let p = payslip(conn, tenant_id, &e.user_id, month, tz_offset_minutes, as_of)?;
        out.push(MonthRow {
            user_id: e.user_id,
            name: e.name,
            role: e.role,
            pay_set: true,
            pay_type: Some(p.pay_type.clone()),
            status: p.status.clone(),
            base_cents: p.base_cents,
            deductions_cents: p.total_deductions_cents,
            additions_cents: p.gross_cents - p.base_cents,
            earned_cents: p.earned_cents,
            advance_repaid_cents: p.advance_repaid_cents,
            net_cents: p.net_cents,
            warnings: p.warnings.len(),
            payslip_id: p.id.clone(),
            gross_cents: p.gross_cents,
            extra_day_pay_cents: p.extra_day_pay_cents,
            deduction_days_cents: p.deduction_days_cents,
            attendance_status: p.attendance_status.clone(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT, role TEXT NOT NULL, role_rank INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, deleted_at TEXT);
             CREATE TABLE operational_costs (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, category TEXT NOT NULL, amount_cents INTEGER NOT NULL, date TEXT NOT NULL, notes TEXT, user_id TEXT NOT NULL, reference_type TEXT, reference_id TEXT, last_modified TEXT, sync_status TEXT, payment_date TEXT, payee TEXT, payment_method TEXT, reference_no TEXT, cost_centre TEXT, attachment_path TEXT, accrual_period TEXT);",
        )
        .unwrap();
        conn.execute_batch(crate::attendance::SCHEMA_SQL).unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn.execute("INSERT INTO staff (id, tenant_id, branch_id, role, role_rank, name) VALUES ('u1', 't1', 'b1', 'CASHIER', 1, 'Sami'), ('boss', 't1', NULL, 'OWNER', 3, 'Owner'), ('mgr', 't1', 'b1', 'MANAGER', 2, 'Manager'), ('mgr2', 't1', 'b2', 'MANAGER', 2, 'Other Manager'), ('c2', 't1', 'b2', 'CASHIER', 1, 'Other Cashier')", []).unwrap();
        conn
    }

    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    /// Punches a person in/out on a local day at fixed offset 0 (UTC = local).
    fn punch(conn: &Connection, day: &str, time_in: &str, time_out: Option<&str>) {
        for (t, dir) in std::iter::once((time_in, "IN")).chain(time_out.map(|o| (o, "OUT"))) {
            conn.execute(
                "INSERT INTO attendance_punches (id, tenant_id, branch_id, user_id, punched_at, direction, source) VALUES (?1, 't1', 'b1', 'u1', ?2, ?3, 'MANUAL')",
                params![uuid::Uuid::now_v7().to_string(), format!("{day}T{t}:00+00:00"), dir],
            )
            .unwrap();
        }
    }

    fn monthly(conn: &Connection, rate: i64) {
        save_employee_pay(conn, "t1", Some("b1"), &EmployeePay { user_id: "u1".into(), pay_type: "MONTHLY".into(), rate_cents: rate, shift_start: None, shift_minutes: None, start_date: None, end_date: None, track_attendance: true }).unwrap();
    }

    /// November 2026: the 1st is a Sunday. Fridays (the default day off) are the 6th, 13th, 20th, 27th: 26 working days.
    const MONTH: &str = "2026-11";
    fn after_month() -> NaiveDate {
        d("2026-12-02")
    }

    /// A full month of on-time days (every working day 09:00-17:00), to build cases on.
    fn full_attendance(conn: &Connection, skip: &[&str]) {
        let mut day = d("2026-11-01");
        while day <= d("2026-11-30") {
            let s = day.format("%Y-%m-%d").to_string();
            if day.weekday().num_days_from_sunday() != 5 && !skip.contains(&s.as_str()) {
                punch(conn, &s, "09:00", Some("17:00"));
            }
            day += Duration::days(1);
        }
    }

    #[test]
    fn a_fresh_install_deducts_nothing_and_a_full_month_pays_the_salary() {
        let conn = db();
        assert_eq!(load_settings(&conn, "t1").unwrap(), PayrollSettings::default());
        assert!(!load_settings(&conn, "t1").unwrap().configured);
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-10"]); // one absence
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        // The owner chose no rules yet: not a single pound is deducted, whatever happened.
        assert_eq!((p.base_cents, p.late_deduction_cents, p.absence_deduction_cents, p.early_deduction_cents, p.overtime_pay_cents), (780_000, 0, 0, 0, 0));
        assert_eq!(p.earned_cents, 780_000);
        assert_eq!(p.absent_days, 1, "the absence is still reported, just not charged");
    }

    #[test]
    fn the_owners_late_rule_decides_what_is_deducted() {
        let conn = db();
        monthly(&conn, 780_000); // one day = 30,000; one minute of a 480-minute day = 62.5
        full_attendance(&conn, &["2026-11-02", "2026-11-03"]);
        punch(&conn, "2026-11-02", "09:20", Some("17:00")); // 20 min late
        punch(&conn, "2026-11-03", "09:05", Some("17:00")); // within the 10-minute grace
        let mut s = PayrollSettings { configured: true, late_rule: "PER_MINUTE".into(), ..PayrollSettings::default() };
        save_settings(&conn, "t1", &s).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.late_days, p.late_minutes), (1, 20));
        assert_eq!(p.late_deduction_cents, 1_250, "20 minutes x 62.5");
        assert_eq!(p.earned_cents, 780_000 - 1_250);

        // Counting only the minutes past the grace.
        s.late_counts_from_start = false;
        save_settings(&conn, "t1", &s).unwrap();
        assert_eq!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().late_deduction_cents, 625, "10 minutes past the grace");

        // A fixed amount per late day.
        s = PayrollSettings { configured: true, late_rule: "FIXED_PER_LATE".into(), late_fixed_cents: 5_000, ..PayrollSettings::default() };
        save_settings(&conn, "t1", &s).unwrap();
        assert_eq!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().late_deduction_cents, 5_000);

        // Tiers: 15+ minutes costs a quarter of a day, 60+ a whole day.
        s = PayrollSettings { configured: true, late_rule: "TIERS".into(), late_tiers: vec![LateTier { from_minutes: 15, day_pct: 25 }, LateTier { from_minutes: 60, day_pct: 100 }], ..PayrollSettings::default() };
        save_settings(&conn, "t1", &s).unwrap();
        assert_eq!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().late_deduction_cents, 7_500, "20 minutes late = 25% of 30,000");

        // A paid-leave mark (an accepted excuse) waives that day.
        mark_paid_leave(&conn, "t1", "u1", "2026-11-02", Some("مراجعة طبية"), "boss").unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.late_deduction_cents, p.paid_leave_days), (0, 1));
    }

    #[test]
    fn absence_early_leave_and_overtime_follow_the_rules() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-02", "2026-11-03", "2026-11-04"]);
        // absent on the 2nd; left 60 minutes early on the 3rd; stayed 90 minutes extra on the 4th.
        punch(&conn, "2026-11-03", "09:00", Some("16:00"));
        punch(&conn, "2026-11-04", "09:00", Some("18:30"));
        // worked on a Friday (day off): 4 hours.
        punch(&conn, "2026-11-06", "10:00", Some("14:00"));
        let s = PayrollSettings {
            configured: true,
            absence_rule: "DAY_PAY".into(),
            absence_multiplier_pct: 200,
            early_rule: "PER_MINUTE".into(),
            overtime_rule: "PER_HOUR".into(),
            overtime_multiplier_pct: 150,
            ..PayrollSettings::default()
        };
        save_settings(&conn, "t1", &s).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.absent_days, 1);
        assert_eq!(p.absence_deduction_cents, 60_000, "two days' pay for one absence");
        assert_eq!((p.early_minutes, p.early_deduction_cents), (60, 3_750));
        // 90 min on the 4th + 240 min on the Friday = 330 minutes at 62.5 x 150%.
        assert_eq!(p.overtime_minutes, 90 + 240);
        assert_eq!(p.overtime_pay_cents, 30_938, "330 x 62.5 x 1.5 = 30,937.5");
        assert_eq!(p.earned_cents, 780_000 - 60_000 - 3_750 + 30_938);
    }

    #[test]
    fn daily_and_hourly_workers_are_paid_for_what_they_worked() {
        let conn = db();
        save_employee_pay(&conn, "t1", Some("b1"), &EmployeePay { user_id: "u1".into(), pay_type: "DAILY".into(), rate_cents: 30_000, shift_start: None, shift_minutes: None, start_date: None, end_date: None, track_attendance: true }).unwrap();
        full_attendance(&conn, &["2026-11-02", "2026-11-03"]); // two days not worked
        save_settings(&conn, "t1", &PayrollSettings { configured: true, absence_rule: "DAY_PAY".into(), ..PayrollSettings::default() }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.base_cents, 30_000 * 24, "26 working days minus the 2 not worked");
        assert_eq!(p.absence_deduction_cents, 0, "a day not worked is simply not paid, no extra penalty");

        save_employee_pay(&conn, "t1", Some("b1"), &EmployeePay { user_id: "u1".into(), pay_type: "HOURLY".into(), rate_cents: 4_000, shift_start: None, shift_minutes: None, start_date: None, end_date: None, track_attendance: true }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.base_cents, 4_000 * 8 * 24, "hours actually worked");
    }

    #[test]
    fn a_month_with_no_punches_never_wipes_a_salary_and_an_untracked_person_gets_the_base() {
        let conn = db();
        monthly(&conn, 780_000);
        save_settings(&conn, "t1", &PayrollSettings { configured: true, absence_rule: "DAY_PAY".into(), ..PayrollSettings::default() }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.absent_days, p.absence_deduction_cents, p.earned_cents), (0, 0, 780_000));
        assert!(p.warnings.iter().any(|w| w.contains("لا توجد أي بصمة")), "{:?}", p.warnings);
    }

    #[test]
    fn a_person_who_joins_mid_month_is_paid_for_their_days() {
        let conn = db();
        save_employee_pay(&conn, "t1", Some("b1"), &EmployeePay { user_id: "u1".into(), pay_type: "MONTHLY".into(), rate_cents: 780_000, shift_start: None, shift_minutes: None, start_date: Some("2026-11-16".into()), end_date: None, track_attendance: false }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        // Working days from the 16th: 13 of the month's 26 (the 20th and 27th are Fridays).
        assert_eq!(p.base_cents, 780_000 * 13 / 26);
    }

    #[test]
    fn bonuses_fines_and_advances_flow_into_the_net_and_approving_freezes_it() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &[]);
        add_adjustment(&conn, "t1", "u1", MONTH, "BONUS", 50_000, "ممتاز", "boss").unwrap();
        add_adjustment(&conn, "t1", "u1", MONTH, "FINE", 10_000, "كسر أطباق", "boss").unwrap();
        assert!(add_adjustment(&conn, "t1", "u1", MONTH, "FINE", 10_000, "  ", "boss").is_err(), "a reason is required");
        add_advance(&conn, "t1", Some("b1"), "u1", 300_000, 100_000, "2026-10-20", Some("ظرف طارئ"), "boss").unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.bonus_cents, p.fine_cents), (50_000, 10_000));
        assert_eq!(p.earned_cents, 780_000 + 50_000 - 10_000);
        assert_eq!((p.advance_repaid_cents, p.net_cents), (100_000, 820_000 - 100_000));

        // The month cannot be approved while it is still running.
        assert!(approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, d("2026-11-15"), "boss").is_err());
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(a.status, "APPROVED");
        assert_eq!(list_advances(&conn, "t1", Some("u1"), false).unwrap()[0].repaid_cents, 100_000);
        // Frozen: more bonuses are refused, and the stored payslip is returned even if the rules change.
        assert!(add_adjustment(&conn, "t1", "u1", MONTH, "BONUS", 1, "x", "boss").is_err());
        save_settings(&conn, "t1", &PayrollSettings { configured: true, absence_rule: "FIXED".into(), absence_fixed_cents: 999, ..PayrollSettings::default() }).unwrap();
        let again = payslip(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((again.status.as_str(), again.net_cents), ("APPROVED", 720_000));

        // Paying records the earned amount as a salary expense, once.
        pay(&conn, "t1", a.id.as_deref().unwrap(), d("2026-12-02"), "boss").unwrap();
        let (cat, amount): (String, i64) = conn.query_row("SELECT category, amount_cents FROM operational_costs WHERE reference_type = 'payroll'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((cat.as_str(), amount), ("رواتب", 820_000), "the expense is what was earned; the advance was cash given earlier");
        assert!(pay(&conn, "t1", a.id.as_deref().unwrap(), d("2026-12-02"), "boss").is_err(), "no double payment");
        assert!(reopen(&conn, "t1", a.id.as_deref().unwrap()).is_err(), "a paid month cannot be reopened");
    }

    #[test]
    fn reopening_an_approved_month_gives_the_advance_instalment_back() {
        let conn = db();
        monthly(&conn, 100_000);
        full_attendance(&conn, &[]);
        add_advance(&conn, "t1", Some("b1"), "u1", 60_000, 30_000, "2026-10-20", None, "boss").unwrap();
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(a.advance_repaid_cents, 30_000);
        assert_eq!(list_advances(&conn, "t1", Some("u1"), false).unwrap()[0].remaining_cents, 30_000);
        reopen(&conn, "t1", a.id.as_deref().unwrap()).unwrap();
        assert_eq!(list_advances(&conn, "t1", Some("u1"), false).unwrap()[0].remaining_cents, 60_000);
        assert!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).is_ok());
        // An advance with repayments cannot be cancelled; one with none can.
        let fresh = add_advance(&conn, "t1", None, "u1", 1_000, 1_000, "2026-11-01", None, "boss").unwrap();
        cancel_advance(&conn, "t1", &fresh).unwrap();
    }

    #[test]
    fn a_forgotten_clock_out_is_flagged_and_a_manual_punch_fixes_it() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-02"]);
        punch(&conn, "2026-11-02", "09:00", None);
        save_settings(&conn, "t1", &PayrollSettings { configured: true, early_rule: "PER_MINUTE".into(), ..PayrollSettings::default() }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert!(p.warnings.iter().any(|w| w.contains("بدون بصمة خروج")), "{:?}", p.warnings);
        assert_eq!(p.days.iter().find(|x| x.date == "2026-11-02").unwrap().status, "MISSING_OUT");
        let now = DateTime::parse_from_rfc3339("2026-12-02T10:00:00+00:00").unwrap().with_timezone(&Utc);
        add_manual_punch(&conn, "t1", "b1", "u1", DateTime::parse_from_rfc3339("2026-11-02T17:00:00+00:00").unwrap().with_timezone(&Utc), "OUT", "boss", now).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert!(add_manual_punch(&conn, "t1", "b1", "u1", now + Duration::hours(2), "IN", "boss", now).is_err(), "no punches in the future");
    }

    #[test]
    fn the_till_clock_is_local_time() {
        let conn = db();
        monthly(&conn, 780_000);
        // 06:20 UTC is 09:20 for a till three hours east: 20 minutes late.
        punch(&conn, "2026-11-02", "06:20", Some("14:00"));
        save_settings(&conn, "t1", &PayrollSettings { configured: true, late_rule: "PER_MINUTE".into(), ..PayrollSettings::default() }).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 180, after_month()).unwrap();
        let day = p.days.iter().find(|x| x.date == "2026-11-02").unwrap();
        assert_eq!((day.first_in.as_deref(), day.late_minutes), (Some("09:20"), 20));
    }

    #[test]
    fn the_overview_lists_everyone_and_marks_who_has_no_pay_yet() {
        let conn = db();
        monthly(&conn, 780_000);
        let rows = month_overview(&conn, "t1", &PayrollScope::for_actor(crate::security::Role::Owner, None, "NONE").unwrap(), MONTH, 0, after_month()).unwrap();
        assert_eq!(rows.len(), 5, "the owner sees everyone");
        assert!(rows.iter().find(|r| r.user_id == "boss").map(|r| !r.pay_set).unwrap());
        assert_eq!(rows.iter().find(|r| r.user_id == "u1").unwrap().status, "DRAFT");
        // A branch manager only sees the staff under them in their own branch.
        let mine = month_overview(&conn, "t1", &PayrollScope::for_actor(crate::security::Role::Manager, Some("b1"), "PREPARE").unwrap(), MONTH, 0, after_month()).unwrap();
        assert_eq!(mine.iter().map(|r| r.user_id.as_str()).collect::<Vec<_>>(), vec!["u1"]);
    }

    #[test]
    fn the_owner_decides_what_a_manager_may_do_and_a_manager_never_reaches_up_or_sideways() {
        use crate::security::Role;
        // Nothing is switched on by default: a manager is refused with a message that says why.
        assert!(PayrollScope::for_actor(Role::Manager, Some("b1"), "NONE").unwrap_err().contains("لم يفعّل المالك"));
        assert!(PayrollScope::for_actor(Role::Cashier, Some("b1"), "FULL").is_err());
        assert!(PayrollScope::for_actor(Role::Kitchen, Some("b1"), "FULL").is_err());
        let owner = PayrollScope::for_actor(Role::Owner, None, "NONE").unwrap();
        assert!(owner.is_owner && owner.can_edit_rules && owner.can_approve && owner.branch_id.is_none());
        let prepare = PayrollScope::for_actor(Role::Manager, Some("b1"), "PREPARE").unwrap();
        assert!(!prepare.can_edit_rules && !prepare.can_approve);
        let full = PayrollScope::for_actor(Role::Manager, Some("b1"), "FULL").unwrap();
        assert!(!full.can_edit_rules && full.can_approve, "full lets a manager approve and pay, never change the rules");

        let conn = db();
        // The owner reaches everyone.
        for id in ["u1", "boss", "mgr", "mgr2", "c2"] {
            assert!(person_in_scope(&conn, "t1", id, &owner).is_ok(), "{id}");
        }
        // A manager reaches only the people under them in their own branch.
        assert!(person_in_scope(&conn, "t1", "u1", &full).is_ok());
        for (id, why) in [("boss", "the owner"), ("mgr", "themselves / a peer"), ("mgr2", "another manager"), ("c2", "another branch")] {
            assert!(person_in_scope(&conn, "t1", id, &full).is_err(), "a manager must not reach {why}");
        }
        assert!(person_in_scope(&conn, "other-tenant", "u1", &owner).is_err(), "another business is never in scope");
        // Ids found through a payslip, an adjustment or an advance are checked the same way.
        monthly(&conn, 100_000);
        let adj = add_adjustment(&conn, "t1", "u1", MONTH, "BONUS", 10, "x", "boss").unwrap();
        let adv = add_advance(&conn, "t1", Some("b1"), "u1", 100, 50, "2026-11-01", None, "boss").unwrap();
        assert!(adjustment_person_in_scope(&conn, "t1", &adj, &full).is_ok());
        assert!(advance_person_in_scope(&conn, "t1", &adv, &full).is_ok());
        conn.execute("UPDATE payroll_adjustments SET user_id = 'mgr2'", []).unwrap();
        conn.execute("UPDATE payroll_advances SET user_id = 'mgr2'", []).unwrap();
        assert!(adjustment_person_in_scope(&conn, "t1", &adj, &full).is_err());
        assert!(advance_person_in_scope(&conn, "t1", &adv, &full).is_err());
        // The owner's choice is stored with the rules.
        let mut s = PayrollSettings::default();
        assert_eq!(s.manager_access, "NONE");
        s.manager_access = "FULL".into();
        save_settings(&conn, "t1", &s).unwrap();
        assert_eq!(load_settings(&conn, "t1").unwrap().manager_access, "FULL");
        s.manager_access = "EVERYTHING".into();
        assert!(s.validate().is_err());
    }

    #[test]
    fn settings_are_validated() {
        let mut s = PayrollSettings::default();
        assert!(s.validate().is_ok());
        s.late_rule = "TIERS".into();
        assert!(s.validate().is_err(), "tiers rule needs a tier");
        s.late_tiers = vec![LateTier { from_minutes: 30, day_pct: 50 }, LateTier { from_minutes: 20, day_pct: 80 }];
        assert!(s.validate().is_err(), "tiers must grow");
        s.late_tiers = vec![LateTier { from_minutes: 20, day_pct: 50 }, LateTier { from_minutes: 30, day_pct: 80 }];
        assert!(s.validate().is_ok());
        s.late_rule = "WHATEVER".into();
        assert!(s.validate().is_err());
        let bad = EmployeePay { user_id: "u".into(), pay_type: "MONTHLY".into(), rate_cents: 0, shift_start: None, shift_minutes: None, start_date: None, end_date: None, track_attendance: true };
        assert!(bad.validate().is_err());
    }

    // ---- holiday / extra-day pay, deduction days, gross and net -------------------------------------------------

    fn extra_rules(pct: i64) -> PayrollSettings {
        PayrollSettings { configured: true, extra_day_rule: "DAY_PAY".into(), holiday_multiplier_pct: pct, ..PayrollSettings::default() }
    }

    #[test]
    fn a_day_worked_on_a_holiday_or_a_day_off_is_an_extra_day_paid_at_the_owners_multiplier() {
        let conn = db();
        monthly(&conn, 780_000); // one day = 30,000
        // The 10th and 11th are holidays: the 10th is worked, nobody comes on the 11th. The Friday the 6th is worked too.
        full_attendance(&conn, &["2026-11-11"]);
        punch(&conn, "2026-11-06", "10:00", Some("14:00"));
        let mut s = PayrollSettings { absence_rule: "DAY_PAY".into(), overtime_rule: "PER_HOUR".into(), holidays: vec!["2026-11-10".into(), "2026-11-11".into()], ..extra_rules(200) };
        save_settings(&conn, "t1", &s).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        // A holiday nobody works is not an absence, and it does not shrink a full month's salary.
        assert_eq!((p.absent_days, p.absence_deduction_cents, p.base_cents), (0, 0, 780_000));
        assert_eq!((p.extra_days, p.extra_day_pay_cents, p.extra_day_multiplier_pct), (2, 120_000, 200), "2 days x 30,000 x 200%");
        assert_eq!(p.overtime_pay_cents, 0, "an extra day is not also overtime");
        assert_eq!(p.gross_cents, 900_000);
        assert_eq!(p.earned_cents, 900_000);
        let holiday = p.days.iter().find(|d| d.date == "2026-11-10").unwrap();
        assert_eq!((holiday.status.as_str(), holiday.holiday), ("OFF_WORKED", true));
        assert_eq!(p.days.iter().find(|d| d.date == "2026-11-11").unwrap().status, "OFF");

        // The owner's default is no extra-day pay: the same two days are overtime, exactly as before.
        s.extra_day_rule = "NONE".into();
        save_settings(&conn, "t1", &s).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.extra_days, p.extra_day_pay_cents), (0, 0));
        assert_eq!(p.overtime_minutes, 480 + 240, "the holiday's 8 hours and the Friday's 4");
        assert!(p.overtime_pay_cents > 0);
    }

    #[test]
    fn an_hourly_person_gets_only_the_extra_share_on_top_of_the_hours_already_paid() {
        let conn = db();
        save_employee_pay(&conn, "t1", Some("b1"), &EmployeePay { user_id: "u1".into(), pay_type: "HOURLY".into(), rate_cents: 4_000, shift_start: None, shift_minutes: None, start_date: None, end_date: None, track_attendance: true }).unwrap();
        full_attendance(&conn, &[]); // 26 working days, 8 hours each
        punch(&conn, "2026-11-06", "09:00", Some("17:00")); // a Friday: 8 hours
        save_settings(&conn, "t1", &extra_rules(150)).unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.base_cents, 4_000 * 8 * 27, "every hour worked, the Friday's included");
        assert_eq!(p.extra_day_pay_cents, 16_000, "the half that the plain hours did not pay: 8h x 4,000 x 50%");
    }

    #[test]
    fn deduction_days_are_their_own_line_apart_from_absence() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-02"]); // one absence
        save_settings(&conn, "t1", &PayrollSettings { configured: true, absence_rule: "DAY_PAY".into(), ..PayrollSettings::default() }).unwrap();
        add_day_deduction(&conn, "t1", "u1", MONTH, 150, "تجاوز تعليمات", "boss").unwrap(); // a day and a half
        assert!(add_day_deduction(&conn, "t1", "u1", MONTH, 0, "x", "boss").is_err());
        assert!(add_day_deduction(&conn, "t1", "u1", MONTH, 100, "  ", "boss").is_err(), "a reason is required");
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.absent_days, p.absence_deduction_cents), (1, 30_000));
        assert_eq!((p.deduction_days_x100, p.deduction_days_cents), (150, 45_000));
        assert_eq!(p.day_deductions.len(), 1);
        assert_eq!(p.total_deductions_cents, 75_000);
        assert_eq!(p.earned_cents, 780_000 - 75_000);
        // The register row shows it too.
        let owner = PayrollScope::for_actor(crate::security::Role::Owner, None, "NONE").unwrap();
        let row = month_overview(&conn, "t1", &owner, MONTH, 0, after_month()).unwrap().into_iter().find(|r| r.user_id == "u1").unwrap();
        assert_eq!((row.deduction_days_cents, row.deductions_cents), (45_000, 75_000));
        // Frozen with the payslip, and taken off the draft only while it is still a draft.
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(a.deduction_days_cents, 45_000);
        assert!(add_day_deduction(&conn, "t1", "u1", MONTH, 100, "x", "boss").is_err());
        assert!(delete_day_deduction(&conn, "t1", &a.day_deductions[0].id).is_err());
        reopen(&conn, "t1", a.id.as_deref().unwrap()).unwrap();
        delete_day_deduction(&conn, "t1", &a.day_deductions[0].id).unwrap();
        assert_eq!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().deduction_days_cents, 0);
    }

    #[test]
    fn gross_deductions_earned_and_net_always_add_up() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-02", "2026-11-03"]);
        punch(&conn, "2026-11-03", "09:30", Some("19:00")); // late 30 and 2 hours past the shift
        punch(&conn, "2026-11-13", "10:00", Some("18:00")); // a Friday: an extra day
        let s = PayrollSettings {
            absence_rule: "DAY_PAY".into(),
            late_rule: "PER_MINUTE".into(),
            overtime_rule: "PER_HOUR".into(),
            ..extra_rules(150)
        };
        save_settings(&conn, "t1", &s).unwrap();
        add_adjustment(&conn, "t1", "u1", MONTH, "BONUS", 20_000, "ممتاز", "boss").unwrap();
        add_adjustment(&conn, "t1", "u1", MONTH, "FINE", 5_000, "كسر", "boss").unwrap();
        add_day_deduction(&conn, "t1", "u1", MONTH, 50, "نصف يوم", "boss").unwrap();
        add_advance(&conn, "t1", Some("b1"), "u1", 100_000, 40_000, "2026-10-20", None, "boss").unwrap();
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.gross_cents, p.base_cents + p.overtime_pay_cents + p.extra_day_pay_cents + p.bonus_cents);
        assert_eq!(p.total_deductions_cents, p.late_deduction_cents + p.absence_deduction_cents + p.early_deduction_cents + p.deduction_days_cents + p.fine_cents);
        assert_eq!(p.earned_cents, (p.gross_cents - p.total_deductions_cents).max(0));
        assert_eq!(p.net_cents, p.earned_cents - p.advance_repaid_cents);
        assert_eq!(p.advance_repaid_cents, 40_000);
        assert!(p.extra_day_pay_cents > 0 && p.overtime_pay_cents > 0 && p.deduction_days_cents > 0 && p.late_deduction_cents > 0 && p.absence_deduction_cents > 0);
    }

    #[test]
    fn a_payslip_stored_before_these_lines_existed_still_opens_and_shows_gross() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &[]);
        add_adjustment(&conn, "t1", "u1", MONTH, "BONUS", 10_000, "x", "boss").unwrap();
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        // Strip everything the new version added, as an old install's stored JSON would look.
        let mut v: serde_json::Value = serde_json::to_value(&a).unwrap();
        for k in ["extra_days", "extra_day_pay_cents", "extra_day_multiplier_pct", "deduction_days_x100", "deduction_days_cents", "day_deductions", "gross_cents", "total_deductions_cents", "attendance_status"] {
            v.as_object_mut().unwrap().remove(k);
        }
        for d in v["days"].as_array_mut().unwrap() {
            d.as_object_mut().unwrap().remove("holiday");
            d.as_object_mut().unwrap().remove("corrected");
        }
        conn.execute("UPDATE payroll_payslips SET details = ?1", params![v.to_string()]).unwrap();
        let again = payslip(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((again.gross_cents, again.total_deductions_cents, again.earned_cents), (790_000, 0, 790_000));
        assert_eq!(again.attendance_status, "NOT_REQUIRED");
    }

    // ---- attendance review and approval -------------------------------------------------------------------------

    fn require_approval(conn: &Connection) {
        save_settings(conn, "t1", &PayrollSettings { configured: true, absence_rule: "DAY_PAY".into(), require_attendance_approval: true, ..PayrollSettings::default() }).unwrap();
    }

    #[test]
    fn by_default_no_attendance_approval_is_needed_and_nothing_changes() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &[]);
        assert!(!PayrollSettings::default().require_attendance_approval);
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.attendance_status, "NOT_REQUIRED");
        assert!(p.warnings.is_empty());
        approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
    }

    #[test]
    fn payroll_waits_for_the_attendance_approval_when_the_owner_turns_it_on() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &["2026-11-02"]);
        require_approval(&conn);
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.attendance_status, "PENDING");
        assert!(p.warnings.iter().any(|w| w.contains("اعتماد")), "{:?}", p.warnings);
        assert_eq!(p.absent_days, 1);
        let err = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap_err();
        assert!(err.contains("اعتمد حضور"), "{err}");

        // The review shows the month; the manager corrects the 2nd (he came, the fingerprint failed).
        let r = attendance_review(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((r.required, r.approved, r.absent_days, r.present_days), (true, false, 1, 25));
        set_day_override(&conn, "t1", "u1", "2026-11-02", false, Some("09:00"), Some("17:00"), "البصمة معطلة", "mgr").unwrap();
        let r = attendance_review(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((r.absent_days, r.present_days, r.overrides.len()), (0, 26, 1));
        let day = r.days.iter().find(|d| d.date == "2026-11-02").unwrap();
        assert_eq!((day.status.as_str(), day.corrected, day.first_in.as_deref(), day.last_out.as_deref()), ("PRESENT", true, Some("09:00"), Some("17:00")));
        // A day can also be forced absent, and a correction cleared.
        set_day_override(&conn, "t1", "u1", "2026-11-04", true, None, None, "لم يحضر", "mgr").unwrap();
        assert_eq!(attendance_review(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().absent_days, 1);
        clear_day_override(&conn, "u1", "2026-11-04").unwrap();
        assert!(set_day_override(&conn, "t1", "u1", "2026-11-02", false, Some("9"), None, "x", "mgr").is_err(), "a bad time is refused");
        assert!(set_day_override(&conn, "t1", "u1", "2026-11-02", false, Some("09:00"), None, "  ", "mgr").is_err(), "a reason is required");

        // Not before the month is over.
        assert!(approve_attendance(&conn, "t1", "u1", MONTH, 0, d("2026-11-15"), "mgr").is_err());
        approve_attendance(&conn, "t1", "u1", MONTH, 0, after_month(), "mgr").unwrap();
        assert!(approve_attendance(&conn, "t1", "u1", MONTH, 0, after_month(), "mgr").is_err(), "once");
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!(p.attendance_status, "APPROVED");
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!((p.absent_days, p.absence_deduction_cents), (0, 0));

        // Approved attendance does not move: no new corrections, excuses or punches until it is taken back.
        for r in [
            set_day_override(&conn, "t1", "u1", "2026-11-05", true, None, None, "x", "mgr"),
            clear_day_override(&conn, "u1", "2026-11-02"),
            mark_paid_leave(&conn, "t1", "u1", "2026-11-05", None, "mgr"),
            unmark_paid_leave(&conn, "u1", "2026-11-05"),
        ] {
            assert!(r.unwrap_err().contains("معتمد"));
        }
        let now = DateTime::parse_from_rfc3339("2026-12-02T10:00:00+00:00").unwrap().with_timezone(&Utc);
        let at = DateTime::parse_from_rfc3339("2026-11-05T17:00:00+00:00").unwrap().with_timezone(&Utc);
        assert!(add_manual_punch(&conn, "t1", "b1", "u1", at, "OUT", "mgr", now).is_err());

        // Now the payslip can be approved, and the attendance approval cannot be taken back under it.
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(a.attendance_status, "APPROVED");
        assert!(unapprove_attendance(&conn, "u1", MONTH).is_err());
        reopen(&conn, "t1", a.id.as_deref().unwrap()).unwrap();
        unapprove_attendance(&conn, "u1", MONTH).unwrap();
        assert_eq!(compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap().attendance_status, "PENDING");
        set_day_override(&conn, "t1", "u1", "2026-11-05", true, None, None, "x", "mgr").unwrap();
    }

    #[test]
    fn the_register_row_says_where_each_persons_attendance_stands() {
        let conn = db();
        monthly(&conn, 780_000);
        full_attendance(&conn, &[]);
        require_approval(&conn);
        let owner = PayrollScope::for_actor(crate::security::Role::Owner, None, "NONE").unwrap();
        let status = |c: &Connection| month_overview(c, "t1", &owner, MONTH, 0, after_month()).unwrap().into_iter().find(|r| r.user_id == "u1").unwrap().attendance_status;
        assert_eq!(status(&conn), "PENDING");
        approve_attendance(&conn, "t1", "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(status(&conn), "APPROVED");
    }

    // ---- advances once, from either side ------------------------------------------------------------------------

    fn costs(conn: &Connection, category: &str) -> Vec<(i64, Option<String>)> {
        let mut stmt = conn.prepare("SELECT amount_cents, reference_id FROM operational_costs WHERE category = ?1 ORDER BY amount_cents").unwrap();
        stmt.query_map(params![category], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|x| x.unwrap()).collect()
    }

    #[test]
    fn an_advance_entered_in_payroll_records_its_expense_once() {
        let conn = db();
        let (advance, cost) = add_advance_with_cost(&conn, "t1", "b1", "u1", 60_000, 30_000, "2026-11-03", Some("ظرف طارئ"), "boss", None).unwrap();
        assert!(cost.is_some());
        let rows = costs(&conn, crate::finance::ADVANCE_CATEGORY);
        assert_eq!(rows, vec![(60_000, Some(advance.clone()))]);
        let (reference_type, payee, date): (String, String, String) = conn
            .query_row("SELECT reference_type, payee, date FROM operational_costs WHERE reference_id = ?1", params![advance], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert_eq!((reference_type.as_str(), payee.as_str(), date.as_str()), ("payroll_advance", "Sami", "2026-11-03"));
        // Asking again, from either side, never makes a second expense.
        assert_eq!(ensure_advance_cost(&conn, "t1", "b1", &advance, "boss", None).unwrap(), None);
        assert_eq!(costs(&conn, crate::finance::ADVANCE_CATEGORY).len(), 1);
        // Cancelling the advance (nothing was taken back) takes its expense with it.
        cancel_advance(&conn, "t1", &advance).unwrap();
        assert!(costs(&conn, crate::finance::ADVANCE_CATEGORY).is_empty());
    }

    #[test]
    fn an_advance_paid_in_finance_creates_the_payroll_advance_once() {
        let conn = db();
        let fields = crate::finance::CostFields { category: crate::finance::ADVANCE_CATEGORY.into(), amount_cents: 50_000, date: "2026-11-04".into(), payment_method: Some("cash".into()), notes: Some("سلفة نقدية".into()), ..Default::default() };
        let (advance, cost) = add_advance_with_cost(&conn, "t1", "b1", "u1", 50_000, 25_000, "2026-11-04", Some("سلفة نقدية"), "boss", Some(fields)).unwrap();
        assert!(cost.is_some());
        let adv = list_advances(&conn, "t1", Some("u1"), false).unwrap();
        assert_eq!(adv.len(), 1);
        assert_eq!((adv[0].id.as_str(), adv[0].amount_cents, adv[0].instalment_cents), (advance.as_str(), 50_000, 25_000));
        let notes: String = conn.query_row("SELECT notes FROM operational_costs WHERE reference_id = ?1", params![advance], |r| r.get(0)).unwrap();
        assert_eq!(notes, "سلفة نقدية", "what the Finance form typed is kept");
        // The payroll side asking for the same advance's expense finds it there already.
        assert_eq!(ensure_advance_cost(&conn, "t1", "b1", &advance, "boss", None).unwrap(), None);
        assert_eq!(costs(&conn, crate::finance::ADVANCE_CATEGORY).len(), 1);
        // The instalment is then taken off the next payslip like any advance.
        monthly(&conn, 100_000);
        full_attendance(&conn, &[]);
        let p = compute_draft(&conn, "t1", "u1", MONTH, 0, after_month()).unwrap();
        assert_eq!((p.advance_repaid_cents, p.net_cents), (25_000, 75_000));
    }

    #[test]
    fn the_salary_expense_leaves_out_what_was_already_an_advance_expense() {
        let conn = db();
        monthly(&conn, 100_000);
        full_attendance(&conn, &[]);
        let (advance, _) = add_advance_with_cost(&conn, "t1", "b1", "u1", 60_000, 30_000, "2026-10-20", None, "boss", None).unwrap();
        // An older advance, entered before this existed: no expense of its own, so the salary expense still covers it.
        let old = add_advance(&conn, "t1", Some("b1"), "u1", 20_000, 10_000, "2026-09-01", None, "boss").unwrap();
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        assert_eq!(a.advance_repaid_cents, 40_000, "30,000 of the new advance and 10,000 of the old one");
        pay(&conn, "t1", a.id.as_deref().unwrap(), d("2026-12-02"), "boss").unwrap();
        let salary = costs(&conn, "رواتب");
        assert_eq!(salary.iter().map(|c| c.0).sum::<i64>(), 100_000 - 30_000, "the 30,000 was spent when the advance was handed over");
        assert_eq!(costs(&conn, crate::finance::ADVANCE_CATEGORY), vec![(60_000, Some(advance.clone()))]);
        assert!(old != advance);
    }

    #[test]
    fn the_workers_statement_shows_each_advance_and_each_instalment_and_what_is_left() {
        let conn = db();
        monthly(&conn, 100_000);
        full_attendance(&conn, &[]);
        add_advance_with_cost(&conn, "t1", "b1", "u1", 60_000, 30_000, "2025-10-20", Some("ظرف"), "boss", None).unwrap();
        let before = worker_statement(&conn, "t1", "u1").unwrap();
        assert_eq!((before.lines.len(), before.owed_cents, before.total_advanced_cents, before.total_repaid_cents), (1, 60_000, 60_000, 0));
        let a = approve(&conn, "t1", Some("b1"), "u1", MONTH, 0, after_month(), "boss").unwrap();
        let st = worker_statement(&conn, "t1", "u1").unwrap();
        assert_eq!(st.lines.iter().map(|l| (l.kind.as_str(), l.amount_cents, l.balance_cents)).collect::<Vec<_>>(), vec![("ADVANCE", 60_000, 60_000), ("REPAYMENT", -30_000, 30_000)]);
        assert_eq!((st.owed_cents, st.total_repaid_cents), (30_000, 30_000));
        assert_eq!(st.payslips.len(), 1);
        assert_eq!((st.payslips[0].advance_repaid_cents, st.payslips[0].net_cents), (30_000, a.net_cents));
        // Reopening the payslip gives the instalment back, and the statement follows.
        reopen(&conn, "t1", a.id.as_deref().unwrap()).unwrap();
        assert_eq!(worker_statement(&conn, "t1", "u1").unwrap().owed_cents, 60_000);
    }

    #[test]
    fn the_new_rules_are_saved_validated_and_default_to_no_change() {
        let conn = db();
        let d0 = load_settings(&conn, "t1").unwrap();
        assert_eq!((d0.extra_day_rule.as_str(), d0.holiday_multiplier_pct, d0.holidays.len(), d0.require_attendance_approval), ("NONE", 150, 0, false));
        let s = PayrollSettings { configured: true, extra_day_rule: "DAY_PAY".into(), holiday_multiplier_pct: 175, holidays: vec!["2026-11-10".into(), "2026-11-10".into(), "2026-10-06".into()], require_attendance_approval: true, ..PayrollSettings::default() };
        save_settings(&conn, "t1", &s).unwrap();
        let back = load_settings(&conn, "t1").unwrap();
        assert_eq!((back.extra_day_rule.as_str(), back.holiday_multiplier_pct, back.require_attendance_approval), ("DAY_PAY", 175, true));
        assert_eq!(back.holidays, vec!["2026-10-06".to_string(), "2026-11-10".to_string()], "sorted, no repeats");
        let mut bad = PayrollSettings::default();
        bad.holidays = vec!["10/11/2026".into()];
        assert!(bad.validate().is_err());
        bad.holidays.clear();
        bad.holiday_multiplier_pct = 50;
        assert!(bad.validate().is_err());
        bad.holiday_multiplier_pct = 150;
        bad.extra_day_rule = "ALWAYS".into();
        assert!(bad.validate().is_err());
        // Rules saved by an older screen (without the new keys) still load.
        let old: PayrollSettings = serde_json::from_str(&serde_json::to_string(&PayrollSettings::default()).unwrap().replace(",\"extra_day_rule\":\"NONE\",\"holiday_multiplier_pct\":150,\"holidays\":[],\"require_attendance_approval\":false", "")).unwrap();
        assert_eq!(old, PayrollSettings::default());
    }
}
