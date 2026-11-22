//! Dining areas, delivery apps (platforms) and receipt templates (Migration AT, v52). Plain
//! functions over a `Connection`; `commands/venue.rs` adds authentication, audit and the licence
//! gate.
//!
//!  * Areas group the tables on the POS grid ("الكل" + one tab per area). No areas = the grid is
//!    exactly what it always was.
//!  * A delivery app is a way an order can arrive (Talabat, Jahez...). The order carries its
//!    `platform_id`; the app keeps `commission_bp` basis points of the sale and pays the rest
//!    out. The account of a period is: sales (paid orders net of refunds), commission (sales x bp),
//!    net due (sales - commission), settled (what the app paid out for that period) and
//!    outstanding (net due - settled).
//!  * A receipt template changes how one printer's bill or kitchen slip looks. It is only data
//!    here (a validated JSON config); the layout itself lives in `src/lib/ticketLayout.ts`.

use crate::repo::Repo;
use crate::security::Scope;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// True when a row owned by (`tenant_id`, `branch_id`) is inside the caller's scope.
fn in_scope(scope: &Scope, tenant_id: &str, branch_id: &str) -> bool {
    match scope {
        Scope::Platform => true,
        Scope::Tenant { tenant_id: t } => t == tenant_id,
        Scope::Branch { tenant_id: t, branch_id: b } => t == tenant_id && b == branch_id,
    }
}

fn row_owner(conn: &Connection, table: &str, id: &str) -> Result<Option<(String, String)>, String> {
    conn.query_row(&format!("SELECT tenant_id, branch_id FROM {table} WHERE id = ?1"), params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())
}

/// The owner of `id` in `table`, refused when it is not there or not in scope.
fn owned(conn: &Connection, scope: &Scope, table: &str, id: &str, what: &str) -> Result<(String, String), String> {
    match row_owner(conn, table, id)? {
        Some((t, b)) if in_scope(scope, &t, &b) => Ok((t, b)),
        _ => Err(format!("{what} غير موجود")),
    }
}

// ---------------------------------------------------------------------------
// Dining areas
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DiningArea {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

pub fn list_areas(conn: &Connection, scope: &Scope) -> Result<Vec<DiningArea>, String> {
    let (pred, args) = Repo::scope_predicate(scope);
    let mut stmt = conn
        .prepare(&format!("SELECT id, name, sort_order FROM dining_areas WHERE {pred} ORDER BY sort_order, name"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| Ok(DiningArea { id: r.get(0)?, name: r.get(1)?, sort_order: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Creates an area (`id` None) in the branch, or renames / re-orders one.
pub fn save_area(conn: &Connection, scope: &Scope, tenant_id: &str, branch_id: &str, id: Option<&str>, name: &str, sort_order: Option<i64>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("اسم القسم مطلوب".to_string());
    }
    if name.chars().count() > 40 {
        return Err("اسم القسم طويل جداً".to_string());
    }
    match id {
        Some(id) => {
            let (_, branch) = owned(conn, scope, "dining_areas", id, "القسم")?;
            let dup: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM dining_areas WHERE branch_id = ?1 AND lower(name) = lower(?2) AND id != ?3", params![branch, name, id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if dup {
                return Err("يوجد قسم بهذا الاسم".to_string());
            }
            conn.execute(
                "UPDATE dining_areas SET name = ?1, sort_order = COALESCE(?2, sort_order) WHERE id = ?3",
                params![name, sort_order, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(id.to_string())
        }
        None => {
            let dup: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM dining_areas WHERE branch_id = ?1 AND lower(name) = lower(?2)", params![branch_id, name], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if dup {
                return Err("يوجد قسم بهذا الاسم".to_string());
            }
            let order = match sort_order {
                Some(o) => o,
                None => conn
                    .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM dining_areas WHERE branch_id = ?1", params![branch_id], |r| r.get(0))
                    .map_err(|e| e.to_string())?,
            };
            let new_id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO dining_areas (id, tenant_id, branch_id, name, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![new_id, tenant_id, branch_id, name, order],
            )
            .map_err(|e| e.to_string())?;
            Ok(new_id)
        }
    }
}

/// Deletes an area; its tables stay, with no area.
pub fn delete_area(conn: &Connection, scope: &Scope, id: &str) -> Result<(), String> {
    owned(conn, scope, "dining_areas", id, "القسم")?;
    conn.execute("UPDATE tables SET area_id = NULL, last_modified = ?1, sync_status = 'pending' WHERE area_id = ?2", params![chrono::Utc::now().to_rfc3339(), id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM dining_areas WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Puts a table in an area (or takes it out with `None`). The area must be in the table's branch.
pub fn set_table_area(conn: &Connection, scope: &Scope, table_id: &str, area_id: Option<&str>) -> Result<(), String> {
    let (_, table_branch) = owned(conn, scope, "tables", table_id, "الطاولة")?;
    if let Some(a) = area_id {
        let (_, area_branch) = owned(conn, scope, "dining_areas", a, "القسم")?;
        if area_branch != table_branch {
            return Err("القسم من فرع آخر".to_string());
        }
    }
    conn.execute(
        "UPDATE tables SET area_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
        params![area_id, chrono::Utc::now().to_rfc3339(), table_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Delivery apps
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Platform {
    pub id: String,
    pub name: String,
    /// The app's cut in basis points (100 = 1%).
    pub commission_bp: i64,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlatformInput {
    pub id: Option<String>,
    pub name: String,
    pub commission_bp: i64,
    pub active: bool,
}

pub fn list_platforms(conn: &Connection, scope: &Scope, include_inactive: bool) -> Result<Vec<Platform>, String> {
    let (pred, args) = Repo::scope_predicate(scope);
    let active = if include_inactive { "" } else { " AND active = 1" };
    let mut stmt = conn
        .prepare(&format!("SELECT id, name, commission_bp, active FROM delivery_platforms WHERE {pred}{active} ORDER BY name"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| Ok(Platform { id: r.get(0)?, name: r.get(1)?, commission_bp: r.get(2)?, active: r.get::<_, i64>(3)? != 0 }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn save_platform(conn: &Connection, scope: &Scope, tenant_id: &str, branch_id: &str, input: &PlatformInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("اسم التطبيق مطلوب".to_string());
    }
    if name.chars().count() > 40 {
        return Err("اسم التطبيق طويل جداً".to_string());
    }
    if !(0..=10_000).contains(&input.commission_bp) {
        return Err("العمولة يجب أن تكون بين 0% و100%".to_string());
    }
    match &input.id {
        Some(id) => {
            let (_, branch) = owned(conn, scope, "delivery_platforms", id, "التطبيق")?;
            let dup: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM delivery_platforms WHERE branch_id = ?1 AND lower(name) = lower(?2) AND id != ?3", params![branch, name, id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if dup {
                return Err("يوجد تطبيق بهذا الاسم".to_string());
            }
            conn.execute(
                "UPDATE delivery_platforms SET name = ?1, commission_bp = ?2, active = ?3 WHERE id = ?4",
                params![name, input.commission_bp, input.active as i64, id],
            )
            .map_err(|e| e.to_string())?;
            Ok(id.clone())
        }
        None => {
            let dup: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM delivery_platforms WHERE branch_id = ?1 AND lower(name) = lower(?2)", params![branch_id, name], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if dup {
                return Err("يوجد تطبيق بهذا الاسم".to_string());
            }
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO delivery_platforms (id, tenant_id, branch_id, name, commission_bp, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, tenant_id, branch_id, name, input.commission_bp, input.active as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// States the order as coming from a delivery app (or, with `None`, a direct order). Only an
/// order that is not finished yet; the app must be active and belong to the order's branch.
pub fn set_order_platform(conn: &Connection, scope: &Scope, order_id: &str, platform_id: Option<&str>) -> Result<(), String> {
    let (_, branch) = owned(conn, scope, "orders", order_id, "الطلب")?;
    let status: String = conn.query_row("SELECT status FROM orders WHERE id = ?1", params![order_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !matches!(status.as_str(), "DRAFT" | "PENDING" | "PREPARING" | "READY" | "SERVED") {
        return Err("الطلب لم يعد مفتوحاً، لا يمكن تغيير مصدره".to_string());
    }
    if let Some(p) = platform_id {
        let (_, pbranch) = owned(conn, scope, "delivery_platforms", p, "التطبيق")?;
        let active: bool = conn.query_row("SELECT active != 0 FROM delivery_platforms WHERE id = ?1", params![p], |r| r.get(0)).map_err(|e| e.to_string())?;
        if pbranch != branch || !active {
            return Err("هذا التطبيق غير متاح لهذا الطلب".to_string());
        }
    }
    conn.execute(
        "UPDATE orders SET platform_id = ?1, last_modified = ?2, sync_status = 'pending' WHERE id = ?3",
        params![platform_id, chrono::Utc::now().to_rfc3339(), order_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The app an order came from, None for a direct order (or a database from before Migration AT).
pub fn order_platform_id(conn: &Connection, order_id: &str) -> Option<String> {
    conn.query_row("SELECT platform_id FROM orders WHERE id = ?1", params![order_id], |r| r.get::<_, Option<String>>(0)).ok().flatten()
}

/// The app's cut of `sales_cents` at `commission_bp` basis points, rounded to the nearest whole
/// unit (half up). Taken from the period's total, not line by line, so the rounding happens once.
pub fn commission_cents(sales_cents: i64, commission_bp: i64) -> i64 {
    (sales_cents * commission_bp + 5_000).div_euclid(10_000)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlatformAccount {
    pub platform_id: String,
    pub name: String,
    pub commission_bp: i64,
    pub active: bool,
    pub orders: i64,
    pub sales_cents: i64,
    pub commission_cents: i64,
    pub net_due_cents: i64,
    pub settled_cents: i64,
    pub outstanding_cents: i64,
}

/// One app's account from its three raw numbers.
pub fn account_from(platform: &Platform, orders: i64, sales_cents: i64, settled_cents: i64) -> PlatformAccount {
    let commission = commission_cents(sales_cents, platform.commission_bp);
    let net_due = sales_cents - commission;
    PlatformAccount {
        platform_id: platform.id.clone(),
        name: platform.name.clone(),
        commission_bp: platform.commission_bp,
        active: platform.active,
        orders,
        sales_cents,
        commission_cents: commission,
        net_due_cents: net_due,
        settled_cents,
        outstanding_cents: net_due - settled_cents,
    }
}

/// Every app's account for `from`..`to` (local dates, both ends included, either may be open).
/// Sales are the PAID orders of the period net of what was refunded; a settlement belongs to the
/// period it names (`period_to`, else the day it was recorded).
pub fn platform_accounts(conn: &Connection, scope: &Scope, from: Option<&str>, to: Option<&str>) -> Result<Vec<PlatformAccount>, String> {
    let mut out = Vec::new();
    for p in list_platforms(conn, scope, true)? {
        let (orders, sales): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(total_cents - COALESCE(refunded_cents, 0)), 0) FROM orders \
                 WHERE platform_id = ?1 AND status = 'PAID' \
                   AND (?2 IS NULL OR date(created_at, 'localtime') >= ?2) AND (?3 IS NULL OR date(created_at, 'localtime') <= ?3)",
                params![p.id, from, to],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        let settled: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(amount_cents), 0) FROM platform_settlements \
                 WHERE platform_id = ?1 AND (?2 IS NULL OR COALESCE(period_to, date(created_at, 'localtime')) >= ?2) \
                   AND (?3 IS NULL OR COALESCE(period_to, date(created_at, 'localtime')) <= ?3)",
                params![p.id, from, to],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if p.active || orders > 0 || settled > 0 {
            out.push(account_from(&p, orders, sales, settled));
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformSettlement {
    pub id: String,
    pub platform_id: String,
    pub amount_cents: i64,
    pub period_from: Option<String>,
    pub period_to: Option<String>,
    pub note: Option<String>,
    pub staff_id: Option<String>,
    pub created_at: String,
}

fn valid_date(d: Option<&str>) -> Result<Option<String>, String> {
    match d.map(str::trim).filter(|d| !d.is_empty()) {
        None => Ok(None),
        Some(d) => chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").map(|x| Some(x.format("%Y-%m-%d").to_string())).map_err(|_| format!("تاريخ غير صالح: {d}")),
    }
}

/// Records what an app paid out. `amount_cents` is whole currency units like every other amount.
#[allow(clippy::too_many_arguments)]
pub fn record_settlement(conn: &Connection, scope: &Scope, platform_id: &str, amount_cents: i64, period_from: Option<&str>, period_to: Option<&str>, note: Option<&str>, staff_id: &str) -> Result<String, String> {
    if amount_cents <= 0 {
        return Err("المبلغ يجب أن يكون أكبر من صفر".to_string());
    }
    let (tenant, branch) = owned(conn, scope, "delivery_platforms", platform_id, "التطبيق")?;
    let from = valid_date(period_from)?;
    let to = valid_date(period_to)?;
    if let (Some(f), Some(t)) = (&from, &to) {
        if f > t {
            return Err("بداية الفترة بعد نهايتها".to_string());
        }
    }
    let id = uuid::Uuid::now_v7().to_string();
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    conn.execute(
        "INSERT INTO platform_settlements (id, tenant_id, branch_id, platform_id, amount_cents, period_from, period_to, note, staff_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, tenant, branch, platform_id, amount_cents, from, to, note, staff_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn list_settlements(conn: &Connection, scope: &Scope, platform_id: &str, limit: i64) -> Result<Vec<PlatformSettlement>, String> {
    owned(conn, scope, "delivery_platforms", platform_id, "التطبيق")?;
    let mut stmt = conn
        .prepare(
            "SELECT id, platform_id, amount_cents, period_from, period_to, note, staff_id, created_at FROM platform_settlements \
             WHERE platform_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![platform_id, limit.clamp(1, 500)], |r| {
            Ok(PlatformSettlement {
                id: r.get(0)?, platform_id: r.get(1)?, amount_cents: r.get(2)?, period_from: r.get(3)?, period_to: r.get(4)?,
                note: r.get(5)?, staff_id: r.get(6)?, created_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Receipt templates
// ---------------------------------------------------------------------------

/// What a template can change. The same JSON is read by `src/lib/ticketLayout.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct TemplateConfig {
    pub header_lines: Vec<String>,
    /// None = the usual thank-you lines; an empty list = no footer at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer_lines: Option<Vec<String>>,
    pub show_order_number: bool,
    pub show_table: bool,
    pub show_cashier: bool,
    pub show_customer: bool,
    pub show_tax_line: bool,
    pub show_item_notes: bool,
    /// "small" | "normal" | "large"
    pub font_size: String,
    /// How many copies one print makes (1-3).
    pub copies: i64,
}

impl Default for TemplateConfig {
    fn default() -> Self {
        TemplateConfig {
            header_lines: Vec::new(),
            footer_lines: None,
            show_order_number: true,
            show_table: true,
            show_cashier: true,
            show_customer: true,
            show_tax_line: true,
            show_item_notes: true,
            font_size: "normal".to_string(),
            copies: 1,
        }
    }
}

const MAX_TEMPLATE_LINES: usize = 8;
const MAX_TEMPLATE_LINE_CHARS: usize = 60;

fn clean_lines(lines: &[String], what: &str) -> Result<Vec<String>, String> {
    let kept: Vec<String> = lines.iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if kept.len() > MAX_TEMPLATE_LINES {
        return Err(format!("{what}: {MAX_TEMPLATE_LINES} أسطر على الأكثر"));
    }
    if kept.iter().any(|l| l.chars().count() > MAX_TEMPLATE_LINE_CHARS) {
        return Err(format!("{what}: السطر الواحد {MAX_TEMPLATE_LINE_CHARS} حرفاً على الأكثر"));
    }
    Ok(kept)
}

/// Parses and checks a template's config; returns it normalised (blank lines dropped).
pub fn validate_config(raw: &serde_json::Value) -> Result<TemplateConfig, String> {
    let mut c: TemplateConfig = serde_json::from_value(raw.clone()).map_err(|_| "إعدادات القالب غير صالحة".to_string())?;
    c.header_lines = clean_lines(&c.header_lines, "رأس الفاتورة")?;
    if let Some(f) = &c.footer_lines {
        c.footer_lines = Some(clean_lines(f, "ذيل الفاتورة")?);
    }
    if !matches!(c.font_size.as_str(), "small" | "normal" | "large") {
        return Err("حجم الخط غير صالح".to_string());
    }
    if !(1..=3).contains(&c.copies) {
        return Err("عدد النسخ من 1 إلى 3".to_string());
    }
    Ok(c)
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiptTemplate {
    pub id: String,
    pub name: String,
    /// "BILL" | "KITCHEN"
    pub kind: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TemplateInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub config: serde_json::Value,
}

pub fn list_templates(conn: &Connection, scope: &Scope) -> Result<Vec<ReceiptTemplate>, String> {
    let (pred, args) = Repo::scope_predicate(scope);
    let mut stmt = conn
        .prepare(&format!("SELECT id, name, kind, config FROM receipt_templates WHERE {pred} ORDER BY name"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            let raw: String = r.get(3)?;
            Ok(ReceiptTemplate { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, config: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})) })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn save_template(conn: &Connection, scope: &Scope, tenant_id: &str, branch_id: &str, input: &TemplateInput) -> Result<String, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("اسم القالب مطلوب".to_string());
    }
    if name.chars().count() > 40 {
        return Err("اسم القالب طويل جداً".to_string());
    }
    if !matches!(input.kind.as_str(), "BILL" | "KITCHEN") {
        return Err("نوع القالب غير صالح".to_string());
    }
    let config = serde_json::to_string(&validate_config(&input.config)?).map_err(|e| e.to_string())?;
    match &input.id {
        Some(id) => {
            owned(conn, scope, "receipt_templates", id, "القالب")?;
            let old_kind: String = conn.query_row("SELECT kind FROM receipt_templates WHERE id = ?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
            if old_kind != input.kind {
                return Err("لا يمكن تغيير نوع القالب بعد إنشائه".to_string());
            }
            conn.execute("UPDATE receipt_templates SET name = ?1, config = ?2 WHERE id = ?3", params![name, config, id]).map_err(|e| e.to_string())?;
            Ok(id.clone())
        }
        None => {
            let id = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO receipt_templates (id, tenant_id, branch_id, name, kind, config) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, tenant_id, branch_id, name, input.kind, config],
            )
            .map_err(|e| e.to_string())?;
            Ok(id)
        }
    }
}

/// Deletes a template; printers that used it go back to the standard layout.
pub fn delete_template(conn: &Connection, scope: &Scope, id: &str) -> Result<(), String> {
    owned(conn, scope, "receipt_templates", id, "القالب")?;
    conn.execute("UPDATE printers SET template_id = NULL WHERE template_id = ?1", params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM receipt_templates WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Chooses (or clears, with `None`) a printer's template. A bill template goes on a receipt
/// printer, a kitchen template on a kitchen printer.
pub fn set_printer_template(conn: &Connection, scope: &Scope, printer_id: &str, template_id: Option<&str>) -> Result<(), String> {
    let (printer_type, tenant, branch): (String, Option<String>, Option<String>) = conn
        .query_row("SELECT printer_type, tenant_id, branch_id FROM printers WHERE id = ?1", params![printer_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("الطابعة غير موجودة")?;
    if !in_scope(scope, tenant.as_deref().unwrap_or(""), branch.as_deref().unwrap_or("")) {
        return Err("الطابعة غير موجودة".to_string());
    }
    if let Some(t) = template_id {
        owned(conn, scope, "receipt_templates", t, "القالب")?;
        let kind: String = conn.query_row("SELECT kind FROM receipt_templates WHERE id = ?1", params![t], |r| r.get(0)).map_err(|e| e.to_string())?;
        let fits = matches!((printer_type.as_str(), kind.as_str()), ("RECEIPT", "BILL") | ("KITCHEN", "KITCHEN"));
        if !fits {
            return Err("هذا القالب لا يناسب نوع الطابعة".to_string());
        }
    }
    conn.execute("UPDATE printers SET template_id = ?1, last_modified = datetime('now') WHERE id = ?2", params![template_id, printer_id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate_v3::run_areas_platforms_templates_migration;
    use std::path::Path;

    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER, checksum TEXT);
             CREATE TABLE tables (id TEXT PRIMARY KEY, name TEXT, tenant_id TEXT, branch_id TEXT, area_id_unused TEXT, last_modified TEXT, sync_status TEXT);
             CREATE TABLE orders (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, status TEXT, total_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0, created_at TEXT, last_modified TEXT, sync_status TEXT);
             CREATE TABLE printers (id TEXT PRIMARY KEY, printer_type TEXT, tenant_id TEXT, branch_id TEXT, last_modified TEXT);",
        )
        .unwrap();
        run_areas_platforms_templates_migration(&mut c, Path::new("test.db")).unwrap();
        c
    }

    fn branch(t: &str, b: &str) -> Scope {
        Scope::Branch { tenant_id: t.into(), branch_id: b.into() }
    }

    #[test]
    fn migration_is_idempotent_and_adds_everything() {
        let mut c = db();
        run_areas_platforms_templates_migration(&mut c, Path::new("test.db")).unwrap();
        for (table, col) in [("tables", "area_id"), ("orders", "platform_id"), ("orders", "cancel_reason"), ("printers", "template_id")] {
            let has: bool = c.query_row(&format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = '{col}'"), [], |r| r.get(0)).unwrap();
            assert!(has, "{table}.{col}");
        }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = 52", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn areas_create_rename_assign_delete() {
        let c = db();
        let scope = branch("t1", "b1");
        c.execute("INSERT INTO tables (id, name, tenant_id, branch_id) VALUES ('tb1', 'T1', 't1', 'b1'), ('tb2', 'T2', 't1', 'b2')", []).unwrap();
        let hall = save_area(&c, &scope, "t1", "b1", None, " الصالة ", None).unwrap();
        let terrace = save_area(&c, &scope, "t1", "b1", None, "التراس", None).unwrap();
        assert!(save_area(&c, &scope, "t1", "b1", None, "الصالة", None).is_err(), "no two areas with one name");
        assert!(save_area(&c, &scope, "t1", "b1", None, "  ", None).is_err());
        let list = list_areas(&c, &scope).unwrap();
        assert_eq!(list.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["الصالة", "التراس"]);
        save_area(&c, &scope, "t1", "b1", Some(&terrace), "السطح", None).unwrap();
        set_table_area(&c, &scope, "tb1", Some(&hall)).unwrap();
        let area: Option<String> = c.query_row("SELECT area_id FROM tables WHERE id = 'tb1'", [], |r| r.get(0)).unwrap();
        assert_eq!(area.as_deref(), Some(hall.as_str()));
        // Another branch's table can not be reached from this branch.
        assert!(set_table_area(&c, &scope, "tb2", Some(&hall)).is_err());
        delete_area(&c, &scope, &hall).unwrap();
        let area: Option<String> = c.query_row("SELECT area_id FROM tables WHERE id = 'tb1'", [], |r| r.get(0)).unwrap();
        assert_eq!(area, None, "the table stays, without an area");
        assert_eq!(list_areas(&c, &scope).unwrap().len(), 1);
        assert!(list_areas(&c, &branch("t1", "b2")).unwrap().is_empty());
    }

    #[test]
    fn commission_rounds_once_half_up() {
        assert_eq!(commission_cents(10_000, 1_500), 1_500);
        assert_eq!(commission_cents(333, 1_000), 33); // 33.3 -> 33
        assert_eq!(commission_cents(335, 1_000), 34); // 33.5 -> 34
        assert_eq!(commission_cents(0, 2_500), 0);
        assert_eq!(commission_cents(12_345, 0), 0);
        assert_eq!(commission_cents(5_000, 10_000), 5_000);
    }

    fn order(c: &Connection, id: &str, platform: Option<&str>, status: &str, total: i64, refunded: i64, day: &str) {
        c.execute(
            "INSERT INTO orders (id, tenant_id, branch_id, status, total_cents, refunded_cents, created_at, platform_id) VALUES (?1, 't1', 'b1', ?2, ?3, ?4, ?5, ?6)",
            params![id, status, total, refunded, format!("{day}T12:00:00Z"), platform],
        )
        .unwrap();
    }

    #[test]
    fn platform_account_math() {
        let c = db();
        let scope = branch("t1", "b1");
        let talabat = save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "طلبات".into(), commission_bp: 2_000, active: true }).unwrap();
        let jahez = save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "جاهز".into(), commission_bp: 1_250, active: true }).unwrap();
        assert!(save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "طلبات".into(), commission_bp: 1, active: true }).is_err());
        assert!(save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "x".into(), commission_bp: 10_001, active: true }).is_err());
        order(&c, "o1", Some(&talabat), "PAID", 10_000, 0, "2026-11-10");
        order(&c, "o2", Some(&talabat), "PAID", 5_000, 1_000, "2026-11-11"); // 1000 refunded: sales 4000
        order(&c, "o3", Some(&talabat), "CANCELLED", 9_999, 0, "2026-11-11"); // not counted
        order(&c, "o4", Some(&talabat), "PENDING", 7_777, 0, "2026-11-11"); // not paid yet, not counted
        order(&c, "o5", Some(&talabat), "PAID", 3_000, 0, "2026-12-01"); // another period
        order(&c, "o6", Some(&jahez), "PAID", 8_000, 0, "2026-11-12");
        order(&c, "o7", None, "PAID", 99_000, 0, "2026-11-12"); // direct
        record_settlement(&c, &scope, &talabat, 8_000, Some("2026-11-01"), Some("2026-11-15"), Some("حوالة"), "s1").unwrap();
        record_settlement(&c, &scope, &talabat, 500, Some("2026-12-01"), Some("2026-12-15"), None, "s1").unwrap();

        let accounts = platform_accounts(&c, &scope, Some("2026-11-01"), Some("2026-11-30")).unwrap();
        let t = accounts.iter().find(|a| a.platform_id == talabat).unwrap();
        assert_eq!((t.orders, t.sales_cents), (2, 14_000));
        assert_eq!(t.commission_cents, 2_800); // 20%
        assert_eq!(t.net_due_cents, 11_200);
        assert_eq!(t.settled_cents, 8_000);
        assert_eq!(t.outstanding_cents, 3_200);
        let j = accounts.iter().find(|a| a.platform_id == jahez).unwrap();
        assert_eq!((j.orders, j.sales_cents, j.commission_cents, j.net_due_cents, j.settled_cents, j.outstanding_cents), (1, 8_000, 1_000, 7_000, 0, 7_000));
        // The December settlement and order only show in December.
        let dec = platform_accounts(&c, &scope, Some("2026-12-01"), Some("2026-12-31")).unwrap();
        let t = dec.iter().find(|a| a.platform_id == talabat).unwrap();
        assert_eq!((t.sales_cents, t.net_due_cents, t.settled_cents, t.outstanding_cents), (3_000, 2_400, 500, 1_900));
        // Open range = everything.
        let all = platform_accounts(&c, &scope, None, None).unwrap();
        assert_eq!(all.iter().find(|a| a.platform_id == talabat).unwrap().sales_cents, 17_000);
        // Another branch sees nothing of it.
        assert!(platform_accounts(&c, &branch("t1", "b2"), None, None).unwrap().is_empty());
    }

    #[test]
    fn settlement_rules() {
        let c = db();
        let scope = branch("t1", "b1");
        let p = save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "A".into(), commission_bp: 100, active: true }).unwrap();
        assert!(record_settlement(&c, &scope, &p, 0, None, None, None, "s").is_err());
        assert!(record_settlement(&c, &scope, &p, -5, None, None, None, "s").is_err());
        assert!(record_settlement(&c, &scope, &p, 5, Some("2026-11-20"), Some("2026-11-01"), None, "s").is_err());
        assert!(record_settlement(&c, &scope, &p, 5, Some("nonsense"), None, None, "s").is_err());
        assert!(record_settlement(&c, &branch("t1", "b2"), &p, 5, None, None, None, "s").is_err(), "another branch cannot settle it");
        record_settlement(&c, &scope, &p, 5, None, None, Some("  "), "s").unwrap();
        let list = list_settlements(&c, &scope, &p, 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].note, None);
    }

    #[test]
    fn order_platform_only_while_open_and_in_branch() {
        let c = db();
        let scope = branch("t1", "b1");
        let p = save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "A".into(), commission_bp: 100, active: true }).unwrap();
        let off = save_platform(&c, &scope, "t1", "b1", &PlatformInput { id: None, name: "B".into(), commission_bp: 100, active: false }).unwrap();
        order(&c, "o1", None, "PENDING", 100, 0, "2026-11-10");
        order(&c, "o2", None, "PAID", 100, 0, "2026-11-10");
        set_order_platform(&c, &scope, "o1", Some(&p)).unwrap();
        assert_eq!(order_platform_id(&c, "o1").as_deref(), Some(p.as_str()));
        assert!(set_order_platform(&c, &scope, "o1", Some(&off)).is_err(), "an inactive app cannot be chosen");
        assert!(set_order_platform(&c, &scope, "o2", Some(&p)).is_err(), "a paid order is history");
        set_order_platform(&c, &scope, "o1", None).unwrap();
        assert_eq!(order_platform_id(&c, "o1"), None);
        assert!(set_order_platform(&c, &branch("t1", "b2"), "o1", Some(&p)).is_err());
        assert_eq!(list_platforms(&c, &scope, false).unwrap().len(), 1);
        assert_eq!(list_platforms(&c, &scope, true).unwrap().len(), 2);
    }

    #[test]
    fn templates_validate_and_attach_to_the_right_printer() {
        let c = db();
        let scope = branch("t1", "b1");
        c.execute("INSERT INTO printers (id, printer_type, tenant_id, branch_id) VALUES ('p1', 'RECEIPT', 't1', 'b1'), ('p2', 'KITCHEN', 't1', 'b1')", []).unwrap();
        let bill = save_template(&c, &scope, "t1", "b1", &TemplateInput { id: None, name: "فاتورة".into(), kind: "BILL".into(), config: serde_json::json!({ "header_lines": ["  أهلاً  ", ""], "copies": 2, "font_size": "large" }) }).unwrap();
        let listed = list_templates(&c, &scope).unwrap();
        assert_eq!(listed[0].config["header_lines"], serde_json::json!(["أهلاً"]));
        assert_eq!(listed[0].config["copies"], 2);
        assert_eq!(listed[0].config["show_tax_line"], true, "unset switches stay on");
        for bad in [
            serde_json::json!({ "copies": 4 }),
            serde_json::json!({ "copies": 0 }),
            serde_json::json!({ "font_size": "huge" }),
            serde_json::json!({ "header_lines": ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
            serde_json::json!({ "footer_lines": ["x".repeat(61)] }),
        ] {
            assert!(validate_config(&bad).is_err(), "{bad}");
        }
        let kitchen = save_template(&c, &scope, "t1", "b1", &TemplateInput { id: None, name: "مطبخ".into(), kind: "KITCHEN".into(), config: serde_json::json!({}) }).unwrap();
        set_printer_template(&c, &scope, "p1", Some(&bill)).unwrap();
        assert!(set_printer_template(&c, &scope, "p1", Some(&kitchen)).is_err(), "a kitchen template does not fit a receipt printer");
        assert!(set_printer_template(&c, &scope, "p2", Some(&bill)).is_err());
        set_printer_template(&c, &scope, "p2", Some(&kitchen)).unwrap();
        assert!(set_printer_template(&c, &branch("t1", "b2"), "p1", None).is_err());
        // The kind never changes.
        assert!(save_template(&c, &scope, "t1", "b1", &TemplateInput { id: Some(bill.clone()), name: "x".into(), kind: "KITCHEN".into(), config: serde_json::json!({}) }).is_err());
        delete_template(&c, &scope, &bill).unwrap();
        let tpl: Option<String> = c.query_row("SELECT template_id FROM printers WHERE id = 'p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(tpl, None, "the printer is back on the standard layout");
    }
}
