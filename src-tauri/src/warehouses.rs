//! Warehouses (مخازن): a branch may keep its stock in more than one store room.
//!
//! The rule that keeps this simple and safe:
//! * `ingredients.current_stock` is ALWAYS the total over every warehouse, so every report, alert
//!   and recipe deduction keeps working exactly as before. Sales take from the default warehouse
//!   (the kitchen) and simply lower the total.
//! * `warehouse_stock` holds rows only for the NON-default warehouses. The default warehouse holds
//!   whatever is left: `current_stock - sum(other warehouses)`. So a shop with one warehouse has no
//!   rows at all and nothing here ever runs for it.
//! * The average cost stays one per ingredient.
//! * Every function that moves stock between shelves is called BEFORE the total changes (the default
//!   warehouse's quantity is worked out from the total).

use crate::inventory_ops::{apply_movement, get_ingredient, round3};
use crate::repo::Repo;
use crate::security::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS warehouses (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_default ON warehouses (branch_id) WHERE is_default = 1;
CREATE TABLE IF NOT EXISTS warehouse_stock (
    warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    qty REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (warehouse_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_ingredient ON warehouse_stock (ingredient_id);";

pub const DEFAULT_NAME: &str = "المخزن الرئيسي";
/// `inventory_logs.reason` of a move between warehouses (its change is 0, the note says where from and to).
pub const REASON_TRANSFER: &str = "TRANSFER";

fn db(e: rusqlite::Error) -> String {
    e.to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct Warehouse {
    pub id: String,
    pub branch_id: String,
    pub name: String,
    pub is_default: bool,
    pub active: bool,
    pub sort: i64,
}

const COLS: &str = "id, branch_id, name, is_default, active, sort";

fn read_warehouse(r: &rusqlite::Row) -> rusqlite::Result<Warehouse> {
    Ok(Warehouse { id: r.get(0)?, branch_id: r.get(1)?, name: r.get(2)?, is_default: r.get::<_, i64>(3)? != 0, active: r.get::<_, i64>(4)? != 0, sort: r.get(5)? })
}

// ---------------------------------------------------------------------------
// The list of warehouses
// ---------------------------------------------------------------------------

/// Makes the branch's first warehouse («المخزن الرئيسي», the default) when it is missing.
pub fn ensure_default(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO warehouses (id, tenant_id, branch_id, name, is_default, active, sort) VALUES (?1, ?2, ?3, ?4, 1, 1, 0)",
        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, DEFAULT_NAME],
    )
    .map_err(db)?;
    Ok(())
}

/// The branch's warehouses (hidden ones too), the default first.
pub fn list(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<Vec<Warehouse>, String> {
    ensure_default(conn, tenant_id, branch_id)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM warehouses WHERE branch_id = ?1 ORDER BY is_default DESC, sort, name"))
        .map_err(db)?;
    let rows = stmt.query_map(params![branch_id], read_warehouse).map_err(db)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db)
}

fn get(conn: &Connection, branch_id: &str, id: &str) -> Result<Warehouse, String> {
    conn.query_row(&format!("SELECT {COLS} FROM warehouses WHERE id = ?1 AND branch_id = ?2"), params![id, branch_id], read_warehouse)
        .optional()
        .map_err(db)?
        .ok_or_else(|| "المخزن غير موجود".to_string())
}

/// The warehouse a movement was asked to use. `None` (nothing chosen) means the default warehouse,
/// exactly the behaviour before warehouses existed. A chosen one must belong to the branch and be shown.
pub fn pick(conn: &Connection, branch_id: &str, warehouse_id: Option<&str>) -> Result<Option<Warehouse>, String> {
    let Some(id) = warehouse_id.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(None) };
    let w = get(conn, branch_id, id)?;
    if !w.active {
        return Err(format!("المخزن «{}» مخفي", w.name));
    }
    Ok(Some(w))
}

/// Adds a warehouse (`warehouse_id` None) or renames / hides / shows one. Returns its id.
pub fn save(conn: &Connection, tenant_id: &str, branch_id: &str, warehouse_id: Option<&str>, name: &str, active: bool) -> Result<String, String> {
    ensure_default(conn, tenant_id, branch_id)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("اكتب اسم المخزن (حتى 40 حرفاً)".to_string());
    }
    let same_name: Option<String> = conn
        .query_row("SELECT id FROM warehouses WHERE branch_id = ?1 AND name = ?2", params![branch_id, name], |r| r.get(0))
        .optional()
        .map_err(db)?;
    if same_name.is_some_and(|other| Some(other.as_str()) != warehouse_id) {
        return Err("يوجد مخزن بنفس الاسم".to_string());
    }
    let Some(id) = warehouse_id else {
        let id = uuid::Uuid::now_v7().to_string();
        conn.execute(
            "INSERT INTO warehouses (id, tenant_id, branch_id, name, is_default, active, sort) \
             VALUES (?1, ?2, ?3, ?4, 0, 1, (SELECT COALESCE(MAX(sort), 0) + 1 FROM warehouses WHERE branch_id = ?3))",
            params![id, tenant_id, branch_id, name],
        )
        .map_err(db)?;
        return Ok(id);
    };
    let w = get(conn, branch_id, id)?;
    if w.active && !active {
        if w.is_default {
            return Err("لا يمكن إخفاء المخزن الرئيسي".to_string());
        }
        let holds: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM warehouse_stock WHERE warehouse_id = ?1 AND ABS(qty) > 0.0005)", params![id], |r| r.get(0))
            .map_err(db)?;
        if holds {
            return Err("في هذا المخزن مواد -- انقلها إلى مخزن آخر قبل إخفائه".to_string());
        }
    }
    conn.execute("UPDATE warehouses SET name = ?1, active = ?2 WHERE id = ?3", params![name, active as i64, id]).map_err(db)?;
    Ok(id.to_string())
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/// How much of an ingredient sits in a warehouse.
pub fn available(conn: &Connection, wh: &Warehouse, ingredient_id: &str) -> Result<f64, String> {
    if !wh.is_default {
        let qty: Option<f64> = conn
            .query_row("SELECT qty FROM warehouse_stock WHERE warehouse_id = ?1 AND ingredient_id = ?2", params![wh.id, ingredient_id], |r| r.get(0))
            .optional()
            .map_err(db)?;
        return Ok(qty.unwrap_or(0.0));
    }
    // The default warehouse holds the total minus what the other warehouses hold.
    let total: f64 = conn.query_row("SELECT current_stock FROM ingredients WHERE id = ?1", params![ingredient_id], |r| r.get(0)).map_err(db)?;
    let others: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(s.qty), 0) FROM warehouse_stock s JOIN warehouses w ON w.id = s.warehouse_id \
             WHERE s.ingredient_id = ?1 AND w.branch_id = ?2 AND w.is_default = 0",
            params![ingredient_id, wh.branch_id],
            |r| r.get(0),
        )
        .map_err(db)?;
    Ok(round3(total - others))
}

fn add_row(conn: &Connection, warehouse_id: &str, ingredient_id: &str, change: f64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO warehouse_stock (warehouse_id, ingredient_id, qty) VALUES (?1, ?2, ?3) \
         ON CONFLICT (warehouse_id, ingredient_id) DO UPDATE SET qty = ROUND(qty + excluded.qty, 3)",
        params![warehouse_id, ingredient_id, change],
    )
    .map_err(db)?;
    Ok(())
}

fn not_enough(conn: &Connection, wh: &Warehouse, ingredient_id: &str, have: f64) -> String {
    let name: String = conn.query_row("SELECT name FROM ingredients WHERE id = ?1", params![ingredient_id], |r| r.get(0)).unwrap_or_default();
    format!("لا يوجد من «{name}» في «{}» إلا {}", wh.name, round3(have.max(0.0)))
}

/// Puts `change` (negative = takes out) into / out of one warehouse. Call it BEFORE the total changes.
/// A non-default warehouse never goes below zero. The default one may, unless `strict` (a person typing
/// a correction or a transfer must not take out more than there is; sales and production never block).
pub fn move_in(conn: &Connection, wh: &Warehouse, ingredient_id: &str, change: f64, strict: bool) -> Result<(), String> {
    let change = round3(change);
    if change < 0.0 && (!wh.is_default || strict) {
        let have = available(conn, wh, ingredient_id)?;
        if have + change < -0.0005 {
            return Err(not_enough(conn, wh, ingredient_id, have));
        }
    }
    if !wh.is_default {
        add_row(conn, &wh.id, ingredient_id, change)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct StockCell {
    pub ingredient_id: String,
    pub warehouse_id: String,
    pub qty: f64,
}

/// Per ingredient and shown warehouse, how much is there (the default one derived from the total).
pub fn stock_table(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<Vec<StockCell>, String> {
    let warehouses = list(conn, tenant_id, branch_id)?;
    let mut rows: HashMap<(String, String), f64> = HashMap::new();
    let mut elsewhere: HashMap<String, f64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT s.warehouse_id, s.ingredient_id, s.qty FROM warehouse_stock s JOIN warehouses w ON w.id = s.warehouse_id \
                 WHERE w.branch_id = ?1 AND w.is_default = 0",
            )
            .map_err(db)?;
        let found = stmt.query_map(params![branch_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))).map_err(db)?;
        for row in found {
            let (wid, iid, qty) = row.map_err(db)?;
            *elsewhere.entry(iid.clone()).or_insert(0.0) += qty;
            rows.insert((wid, iid), qty);
        }
    }
    let mut stmt = conn.prepare("SELECT id, current_stock FROM ingredients WHERE tenant_id = ?1 AND branch_id = ?2 AND is_active = 1").map_err(db)?;
    let ingredients = stmt
        .query_map(params![tenant_id, branch_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    let mut cells = Vec::new();
    for (ingredient_id, total) in ingredients {
        for w in warehouses.iter().filter(|w| w.active) {
            let qty = if w.is_default {
                round3(total - elsewhere.get(&ingredient_id).copied().unwrap_or(0.0))
            } else {
                rows.get(&(w.id.clone(), ingredient_id.clone())).copied().unwrap_or(0.0)
            };
            cells.push(StockCell { ingredient_id: ingredient_id.clone(), warehouse_id: w.id.clone(), qty });
        }
    }
    Ok(cells)
}

// ---------------------------------------------------------------------------
// Transfer, correction and count
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TransferOutcome {
    pub log_id: String,
    pub quantity: f64,
    pub from_name: String,
    pub to_name: String,
}

/// Moves `quantity` of an ingredient from one warehouse to another. The total does not change; it is
/// refused when the first warehouse does not hold that much. Logged with reason TRANSFER.
#[allow(clippy::too_many_arguments)]
pub fn transfer(conn: &Connection, scope: &Scope, actor_id: &str, ingredient_id: &str, from_id: &str, to_id: &str, quantity: f64, now: &str) -> Result<TransferOutcome, String> {
    let ing = get_ingredient(conn, scope, ingredient_id)?;
    if from_id == to_id {
        return Err("اختر مخزنين مختلفين".to_string());
    }
    let qty = round3(quantity);
    if !qty.is_finite() || qty <= 0.0 {
        return Err("الكمية يجب أن تكون أكبر من صفر".to_string());
    }
    let from = pick(conn, &ing.branch_id, Some(from_id))?.ok_or("اختر المخزن الذي ستنقل منه")?;
    let to = pick(conn, &ing.branch_id, Some(to_id))?.ok_or("اختر المخزن الذي ستنقل إليه")?;
    move_in(conn, &from, &ing.id, -qty, true)?;
    move_in(conn, &to, &ing.id, qty, false)?;
    let note = format!("من {} إلى {}: {} {}", from.name, to.name, qty, ing.unit);
    let log_id = apply_movement(conn, &ing, 0.0, REASON_TRANSFER, Some(&note), 0, actor_id, now)?;
    Ok(TransferOutcome { log_id, quantity: qty, from_name: from.name, to_name: to.name })
}

/// A typed stock correction (`change` may be negative) in a chosen warehouse. With no warehouse chosen
/// it is the plain `adjust_stock`.
#[allow(clippy::too_many_arguments)]
pub fn adjust(conn: &Connection, scope: &Scope, tenant_id: &str, branch_id: &str, ingredient_id: &str, change: f64, reason: &str, actor_id: &str, warehouse_id: Option<&str>) -> Result<String, String> {
    if warehouse_id.is_some() {
        let ing = get_ingredient(conn, scope, ingredient_id)?;
        if let Some(w) = pick(conn, &ing.branch_id, warehouse_id)? {
            move_in(conn, &w, &ing.id, change, true)?;
        }
    }
    Repo::new(conn).adjust_stock(scope, tenant_id, branch_id, ingredient_id, change, reason, actor_id).map_err(|e| e.to_string())
}

/// A physical count of one warehouse (`counted` is what is on ITS shelf). The total moves by the
/// difference and the count is recorded against the new total, so the variance report stays right.
/// With no warehouse chosen it is the plain `record_stock_count`.
#[allow(clippy::too_many_arguments)]
pub fn count(conn: &Connection, scope: &Scope, tenant_id: &str, branch_id: &str, ingredient_id: &str, counted: f64, actor_id: &str, note: Option<&str>, warehouse_id: Option<&str>) -> Result<String, String> {
    let repo = Repo::new(conn);
    if warehouse_id.is_none() {
        return repo.record_stock_count(scope, tenant_id, branch_id, ingredient_id, counted, actor_id, note).map_err(|e| e.to_string());
    }
    let ing = get_ingredient(conn, scope, ingredient_id)?;
    let Some(w) = pick(conn, &ing.branch_id, warehouse_id)? else { return Err("المخزن غير موجود".to_string()) };
    if !counted.is_finite() || counted < 0.0 {
        return Err("الكمية المعدودة لا يمكن أن تكون سالبة".to_string());
    }
    let have = available(conn, &w, &ing.id)?;
    let total_after = round3(ing.stock + (counted - have));
    if total_after < 0.0 {
        return Err("الكمية لا تتفق مع باقي المخازن -- راجع كميات المخازن الأخرى أولاً".to_string());
    }
    let note_text = match note.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("المخزن «{}»: {n}", w.name),
        None => format!("المخزن «{}»", w.name),
    };
    let id = repo.record_stock_count(scope, tenant_id, branch_id, ingredient_id, total_after, actor_id, Some(&note_text)).map_err(|e| e.to_string())?;
    if !w.is_default {
        add_row(conn, &w.id, &ing.id, round3(counted - have))?;
    }
    Ok(id)
}
