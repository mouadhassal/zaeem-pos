//! Restaurant inventory: units of measure, packs, weighted average cost, production of base
//! products (sauce, dough ...), waste and the stock report.
//!
//! * `units` is the small table of standard units (g, kg, ml, l, piece). Two units can be converted
//!   only inside one kind (mass, volume, count); anything else is refused with a clear Arabic message.
//! * A pack (`ingredient_units`) is a per-ingredient unit such as a carton or a sack that holds a
//!   fixed amount of the stock unit. Purchase lines and recipes may be written in a pack.
//! * Stock is kept in the ingredient's own unit, rounded to 3 decimals. Money is whole pounds in
//!   `*_cents` columns, so a cost per stock unit is a whole number; the weighted average is computed
//!   in f64 and rounded once.
//! * A produced ingredient (`is_produced`) has a batch recipe (`ingredient_recipes`) and a
//!   `batch_yield`; producing deducts the components, adds what really came out and re-averages
//!   its cost. Components may go below zero (restaurants forget to receive stock), exactly like sales.
//! * Every movement writes an `inventory_logs` row with its `value_cents` (signed like the change).

use crate::security::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS units (
    code TEXT PRIMARY KEY,
    name_ar TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('MASS','VOLUME','COUNT')),
    factor REAL NOT NULL
);
INSERT OR IGNORE INTO units (code, name_ar, kind, factor) VALUES
    ('g', 'غرام', 'MASS', 1), ('kg', 'كيلوغرام', 'MASS', 1000),
    ('ml', 'مل', 'VOLUME', 1), ('l', 'لتر', 'VOLUME', 1000),
    ('piece', 'حبة', 'COUNT', 1);
CREATE TABLE IF NOT EXISTS ingredient_units (
    id TEXT PRIMARY KEY,
    ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
    name_ar TEXT NOT NULL,
    factor_to_stock_unit REAL NOT NULL CHECK(factor_to_stock_unit > 0),
    UNIQUE (ingredient_id, name_ar)
);
CREATE TABLE IF NOT EXISTS ingredient_recipes (
    id TEXT PRIMARY KEY,
    produced_id TEXT NOT NULL REFERENCES ingredients(id),
    component_id TEXT NOT NULL REFERENCES ingredients(id),
    quantity REAL NOT NULL CHECK(quantity > 0),
    unit TEXT,
    UNIQUE (produced_id, component_id)
);
CREATE TABLE IF NOT EXISTS production_runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    produced_id TEXT NOT NULL REFERENCES ingredients(id),
    batches REAL NOT NULL,
    expected_qty REAL NOT NULL,
    actual_qty REAL NOT NULL,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    staff_id TEXT,
    created_at TEXT NOT NULL,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_production_runs_produced ON production_runs (produced_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ingredient_recipes_produced ON ingredient_recipes (produced_id);
CREATE INDEX IF NOT EXISTS idx_ingredient_units_ingredient ON ingredient_units (ingredient_id);";

/// `inventory_logs.reason` values written here (the older ones are the Arabic phrases already in use).
pub const REASON_PRODUCTION: &str = "PRODUCTION";
pub const REASON_WASTE: &str = "WASTE";
const REASON_SALE: &str = "بيع";
const REASON_SALE_VOID: &str = "إلغاء صنف بعد الدفع";

/// The short list a waste entry must pick from.
pub const WASTE_REASONS: [&str; 4] = ["تالف", "منتهي الصلاحية", "انسكاب", "أخرى"];

// ---------------------------------------------------------------------------
// Pure part: units, conversion, rounding, average cost
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnitKind {
    Mass,
    Volume,
    Count,
}

impl UnitKind {
    pub fn from_db(s: &str) -> Option<UnitKind> {
        match s {
            "MASS" => Some(UnitKind::Mass),
            "VOLUME" => Some(UnitKind::Volume),
            "COUNT" => Some(UnitKind::Count),
            _ => None,
        }
    }
    pub fn label_ar(self) -> &'static str {
        match self {
            UnitKind::Mass => "وزن",
            UnitKind::Volume => "حجم",
            UnitKind::Count => "عدد",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UnitDef {
    pub code: String,
    pub name_ar: String,
    pub kind: String,
    pub factor: f64,
}

/// The standard units, loaded from `units` (or the built-in copy when no database is at hand).
pub struct UnitTable {
    map: HashMap<String, (UnitKind, f64, String)>,
}

impl UnitTable {
    pub fn builtin() -> UnitTable {
        let mut map = HashMap::new();
        for (code, name, kind, factor) in [
            ("g", "غرام", UnitKind::Mass, 1.0),
            ("kg", "كيلوغرام", UnitKind::Mass, 1000.0),
            ("ml", "مل", UnitKind::Volume, 1.0),
            ("l", "لتر", UnitKind::Volume, 1000.0),
            ("piece", "حبة", UnitKind::Count, 1.0),
        ] {
            map.insert(code.to_string(), (kind, factor, name.to_string()));
        }
        UnitTable { map }
    }

    pub fn load(conn: &Connection) -> Result<UnitTable, String> {
        let defs = list_units(conn)?;
        let mut map = HashMap::new();
        for d in defs {
            if let Some(kind) = UnitKind::from_db(&d.kind) {
                map.insert(d.code, (kind, d.factor, d.name_ar));
            }
        }
        if map.is_empty() {
            return Ok(UnitTable::builtin());
        }
        Ok(UnitTable { map })
    }

    /// (code, kind, factor to the kind's base unit, Arabic name) of a unit written as a code or as common free text.
    fn resolve(&self, text: &str) -> Option<(String, UnitKind, f64, String)> {
        let code = canonical_code(text).map(str::to_string).or_else(|| {
            let t = text.trim();
            if self.map.contains_key(t) { Some(t.to_string()) } else { None }
        })?;
        let (kind, factor, name) = self.map.get(&code)?;
        Some((code, *kind, *factor, name.clone()))
    }
}

/// The code of a standard unit for the free text people typed ("كغ", "كيلو", "Kg", "لتر", "حبة" ...).
/// `None` when the text is not obviously one of them -- such text is left alone everywhere.
pub fn canonical_code(text: &str) -> Option<&'static str> {
    let t = text.trim().to_lowercase();
    let t = t.trim_end_matches('.');
    match t {
        "kg" | "كغ" | "كغم" | "كجم" | "كيلو" | "كيلوغرام" | "كيلوجرام" | "كلغ" => Some("kg"),
        "g" | "gr" | "gram" | "غ" | "غرام" | "جرام" | "جم" | "غم" => Some("g"),
        "l" | "lt" | "liter" | "litre" | "ل" | "لتر" | "ليتر" => Some("l"),
        "ml" | "مل" | "ملل" | "ميلي" | "مليلتر" => Some("ml"),
        "piece" | "pieces" | "pcs" | "pc" | "unit" | "قطعة" | "حبة" | "حبه" | "قطع" | "وحدة" => Some("piece"),
        _ => None,
    }
}

/// What to store for a unit the user typed: the standard code when it is one, else the text trimmed.
pub fn canonical_unit_text(text: &str) -> String {
    canonical_code(text).map(str::to_string).unwrap_or_else(|| text.trim().to_string())
}

/// Stock quantities are kept to 3 decimals.
pub fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn cross_kind_error(from_name: &str, from_kind: UnitKind, to_name: &str, to_kind: UnitKind) -> String {
    format!(
        "لا يمكن التحويل بين «{from_name}» ({}) و«{to_name}» ({}) -- اختر وحدة من نفس النوع",
        from_kind.label_ar(),
        to_kind.label_ar()
    )
}

/// The number to multiply a quantity in `from` by to get it in `to`.
/// Same standard unit -> 1; same kind -> the ratio; two different kinds -> an Arabic error; two
/// unknown texts are only compatible when they are the same text.
pub fn conversion_factor(table: &UnitTable, from: &str, to: &str) -> Result<f64, String> {
    let (f, t) = (from.trim(), to.trim());
    if f.is_empty() || f == t {
        return Ok(1.0);
    }
    match (table.resolve(f), table.resolve(t)) {
        (Some((fc, fk, ff, fname)), Some((tc, tk, tf, tname))) => {
            if fc == tc {
                Ok(1.0)
            } else if fk == tk {
                Ok(ff / tf)
            } else {
                Err(cross_kind_error(&fname, fk, &tname, tk))
            }
        }
        _ if f.eq_ignore_ascii_case(t) => Ok(1.0),
        _ => Err(format!("لا يمكن التحويل من «{f}» إلى «{t}» -- الوحدتان غير معروفتين، عرّف عبوة أولاً")),
    }
}

/// `qty` written in `from`, expressed in `to` (not rounded; round the stock when it is written).
#[cfg(test)]
pub fn convert(table: &UnitTable, qty: f64, from: &str, to: &str) -> Result<f64, String> {
    Ok(qty * conversion_factor(table, from, to)?)
}

/// New cost per stock unit after adding `add_qty` bought at `add_unit_cost`:
/// (old_qty x old_cost + qty x cost) / (old_qty + qty) when there was stock, else just the new cost
/// (nothing, or a negative balance, carries no value worth averaging with).
pub fn weighted_average_cost(old_qty: f64, old_cost_cents: i64, add_qty: f64, add_unit_cost: f64) -> i64 {
    if add_qty.is_nan() || add_qty <= 0.0 {
        return old_cost_cents;
    }
    if old_qty <= 0.0 {
        return add_unit_cost.round() as i64;
    }
    ((old_qty * old_cost_cents as f64 + add_qty * add_unit_cost) / (old_qty + add_qty)).round() as i64
}

/// Which column of the stock report a movement belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovementClass {
    Received,
    Sales,
    Produced,
    UsedInProduction,
    Wasted,
    Adjusted,
}

pub fn classify_movement(reason: &str, change: f64) -> MovementClass {
    match reason {
        REASON_WASTE => MovementClass::Wasted,
        REASON_PRODUCTION if change >= 0.0 => MovementClass::Produced,
        REASON_PRODUCTION => MovementClass::UsedInProduction,
        REASON_SALE | REASON_SALE_VOID => MovementClass::Sales,
        r if r.starts_with("استلام") => MovementClass::Received,
        _ => MovementClass::Adjusted,
    }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

fn db(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn list_units(conn: &Connection) -> Result<Vec<UnitDef>, String> {
    let mut stmt = conn.prepare("SELECT code, name_ar, kind, factor FROM units ORDER BY kind, factor").map_err(db)?;
    let rows = stmt
        .query_map([], |r| Ok(UnitDef { code: r.get(0)?, name_ar: r.get(1)?, kind: r.get(2)?, factor: r.get(3)? }))
        .map_err(db)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db)
}

fn scope_allows(scope: &Scope, tenant_id: &str, branch_id: &str) -> bool {
    match scope {
        Scope::Platform => true,
        Scope::Tenant { tenant_id: t } => t == tenant_id,
        Scope::Branch { tenant_id: t, branch_id: b } => t == tenant_id && b == branch_id,
    }
}

/// `(where clause, binds)` for a scope with `?1`/`?2` placeholders; callers number their own binds after.
fn scope_where(scope: &Scope, prefix: &str) -> (String, Vec<String>) {
    match scope {
        Scope::Platform => ("1=1".to_string(), vec![]),
        Scope::Tenant { tenant_id } => (format!("{prefix}tenant_id = ?1"), vec![tenant_id.clone()]),
        Scope::Branch { tenant_id, branch_id } => (format!("{prefix}tenant_id = ?1 AND {prefix}branch_id = ?2"), vec![tenant_id.clone(), branch_id.clone()]),
    }
}

#[derive(Debug, Clone)]
pub struct Ing {
    pub id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub name: String,
    pub unit: String,
    pub cost_cents: i64,
    pub stock: f64,
    pub is_produced: bool,
    pub batch_yield: f64,
}

pub fn get_ingredient(conn: &Connection, scope: &Scope, id: &str) -> Result<Ing, String> {
    let row = conn
        .query_row(
            "SELECT id, tenant_id, branch_id, name, unit, cost_cents_per_unit, current_stock, is_produced, batch_yield FROM ingredients WHERE id = ?1",
            params![id],
            |r| {
                Ok(Ing {
                    id: r.get(0)?,
                    tenant_id: r.get(1)?,
                    branch_id: r.get(2)?,
                    name: r.get(3)?,
                    unit: r.get(4)?,
                    cost_cents: r.get(5)?,
                    stock: r.get(6)?,
                    is_produced: r.get::<_, i64>(7)? != 0,
                    batch_yield: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(db)?;
    match row {
        Some(i) if scope_allows(scope, &i.tenant_id, &i.branch_id) => Ok(i),
        _ => Err("المكوّن غير موجود".to_string()),
    }
}

/// One movement: stock and its log row together. `change` is already rounded; the stock is rounded again after the add.
#[allow(clippy::too_many_arguments)]
fn apply_movement(conn: &Connection, ing: &Ing, change: f64, reason: &str, note: Option<&str>, value_cents: i64, actor_id: &str, now: &str) -> Result<String, String> {
    conn.execute(
        "UPDATE ingredients SET current_stock = ROUND(current_stock + ?1, 3), last_modified = ?2 WHERE id = ?3",
        params![change, now, ing.id],
    )
    .map_err(db)?;
    let log_id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO inventory_logs (id, tenant_id, branch_id, ingredient_id, change_amount, reason, user_id, created_at, last_modified, sync_status, value_cents, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'pending', ?9, ?10)",
        params![log_id, ing.tenant_id, ing.branch_id, ing.id, change, reason, actor_id, now, value_cents, note],
    )
    .map_err(db)?;
    Ok(log_id)
}

// ---------------------------------------------------------------------------
// Packs (per-ingredient units)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PackRow {
    pub id: String,
    pub ingredient_id: String,
    pub ingredient_name: String,
    pub stock_unit: String,
    pub name_ar: String,
    pub factor_to_stock_unit: f64,
}

pub fn list_packs(conn: &Connection, scope: &Scope) -> Result<Vec<PackRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.ingredient_id, i.name, i.unit, p.name_ar, p.factor_to_stock_unit, i.tenant_id, i.branch_id \
             FROM ingredient_units p JOIN ingredients i ON i.id = p.ingredient_id WHERE i.is_active = 1 ORDER BY i.name, p.name_ar",
        )
        .map_err(db)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                PackRow { id: r.get(0)?, ingredient_id: r.get(1)?, ingredient_name: r.get(2)?, stock_unit: r.get(3)?, name_ar: r.get(4)?, factor_to_stock_unit: r.get(5)? },
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(db)?;
    let mut out = Vec::new();
    for row in rows {
        let (pack, t, b) = row.map_err(db)?;
        if scope_allows(scope, &t, &b) {
            out.push(pack);
        }
    }
    Ok(out)
}

pub fn save_pack(conn: &Connection, scope: &Scope, ingredient_id: &str, pack_id: Option<&str>, name_ar: &str, factor: f64) -> Result<(String, Vec<String>), String> {
    let ing = get_ingredient(conn, scope, ingredient_id)?;
    let name = name_ar.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("اكتب اسم العبوة (مثل كرتونة أو كيس)".to_string());
    }
    if canonical_code(name).is_some() {
        return Err(format!("«{name}» اسم وحدة قياسية جاهزة -- اختر اسماً آخر للعبوة"));
    }
    if !factor.is_finite() || factor <= 0.0 {
        return Err("كمية العبوة يجب أن تكون أكبر من صفر".to_string());
    }
    let id = match pack_id {
        Some(pid) => {
            let own: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM ingredient_units WHERE id = ?1 AND ingredient_id = ?2", params![pid, ing.id], |r| r.get(0))
                .map_err(db)?;
            if !own {
                return Err("العبوة غير موجودة".to_string());
            }
            let old_name: String = conn.query_row("SELECT name_ar FROM ingredient_units WHERE id = ?1", params![pid], |r| r.get(0)).map_err(db)?;
            if old_name != name && pack_in_use(conn, &ing.id, &old_name)? {
                return Err("لا يمكن تغيير اسم عبوة مستعملة في وصفة أو طلبية -- أضف عبوة جديدة بدلاً منها".to_string());
            }
            conn.execute("UPDATE ingredient_units SET name_ar = ?1, factor_to_stock_unit = ?2 WHERE id = ?3", params![name, factor, pid])
                .map_err(|e| if is_unique(&e) { "هذه العبوة موجودة مسبقاً لهذا المكوّن".to_string() } else { db(e) })?;
            pid.to_string()
        }
        None => {
            let pid = uuid::Uuid::now_v7().to_string();
            conn.execute(
                "INSERT INTO ingredient_units (id, ingredient_id, name_ar, factor_to_stock_unit) VALUES (?1, ?2, ?3, ?4)",
                params![pid, ing.id, name, factor],
            )
            .map_err(|e| if is_unique(&e) { "هذه العبوة موجودة مسبقاً لهذا المكوّن".to_string() } else { db(e) })?;
            pid
        }
    };
    // A recipe written in this pack now means a different amount of stock.
    recompute_recipe_factors(conn, &ing)?;
    Ok((id, vec![ing.id]))
}

fn is_unique(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation)
}

/// Is a pack name used by a recipe, a batch recipe or a pending purchase line of this ingredient?
fn pack_in_use(conn: &Connection, ingredient_id: &str, name: &str) -> Result<bool, String> {
    let used: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM recipes WHERE ingredient_id = ?1 AND unit = ?2) \
                 OR EXISTS(SELECT 1 FROM ingredient_recipes WHERE component_id = ?1 AND unit = ?2) \
                 OR EXISTS(SELECT 1 FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id \
                           WHERE poi.ingredient_id = ?1 AND poi.unit_label = ?2 AND po.status = 'PENDING')",
            params![ingredient_id, name],
            |r| r.get(0),
        )
        .map_err(db)?;
    Ok(used)
}

pub fn delete_pack(conn: &Connection, scope: &Scope, pack_id: &str) -> Result<Vec<String>, String> {
    let row: Option<(String, String)> = conn
        .query_row("SELECT ingredient_id, name_ar FROM ingredient_units WHERE id = ?1", params![pack_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(db)?;
    let Some((ingredient_id, name)) = row else { return Err("العبوة غير موجودة".to_string()) };
    let ing = get_ingredient(conn, scope, &ingredient_id)?;
    if pack_in_use(conn, &ing.id, &name)? {
        return Err("لا يمكن حذف عبوة مستعملة في وصفة أو طلبية شراء قيد الانتظار".to_string());
    }
    conn.execute("DELETE FROM ingredient_units WHERE id = ?1", params![pack_id]).map_err(db)?;
    Ok(vec![ing.id])
}

/// The stored label and the multiplier that turn a quantity written in `unit_text` into the ingredient's
/// stock unit. Empty text or the stock unit itself is 1; then the ingredient's own packs; then the
/// standard units (same kind only).
pub fn resolve_unit(conn: &Connection, table: &UnitTable, ingredient_id: &str, stock_unit: &str, unit_text: Option<&str>) -> Result<(String, f64), String> {
    let text = unit_text.map(str::trim).unwrap_or("");
    if text.is_empty() {
        return Ok((stock_unit.to_string(), 1.0));
    }
    let pack: Option<f64> = conn
        .query_row("SELECT factor_to_stock_unit FROM ingredient_units WHERE ingredient_id = ?1 AND name_ar = ?2", params![ingredient_id, text], |r| r.get(0))
        .optional()
        .map_err(db)?;
    if let Some(f) = pack {
        return Ok((text.to_string(), f));
    }
    let factor = conversion_factor(table, text, stock_unit)?;
    Ok((canonical_unit_text(text), factor))
}

fn same_unit(table: &UnitTable, a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    a == b || matches!((table.resolve(a), table.resolve(b)), (Some(x), Some(y)) if x.0 == y.0)
}

// ---------------------------------------------------------------------------
// Menu recipes: the unit of a recipe line
// ---------------------------------------------------------------------------

/// Saves the unit of one menu recipe line (`None` = the ingredient's own unit). Refuses a unit of
/// another kind. Stores `stock_factor`, the multiplier the sale deduction uses.
pub fn set_recipe_unit(conn: &Connection, scope: &Scope, recipe_id: &str, unit: Option<&str>) -> Result<(), String> {
    let ingredient_id: String = conn
        .query_row("SELECT ingredient_id FROM recipes WHERE id = ?1", params![recipe_id], |r| r.get(0))
        .optional()
        .map_err(db)?
        .ok_or_else(|| "سطر الوصفة غير موجود".to_string())?;
    let ing = get_ingredient(conn, scope, &ingredient_id)?;
    let table = UnitTable::load(conn)?;
    let (label, factor) = resolve_unit(conn, &table, &ing.id, &ing.unit, unit)?;
    let store: Option<String> = if same_unit(&table, &label, &ing.unit) { None } else { Some(label) };
    conn.execute(
        "UPDATE recipes SET unit = ?1, stock_factor = ?2, last_modified = datetime('now') WHERE id = ?3",
        params![store, if store.is_some() { factor } else { 1.0 }, recipe_id],
    )
    .map_err(db)?;
    Ok(())
}

/// Recomputes `recipes.stock_factor` of every line that names a unit, after the ingredient's unit or a pack changed.
pub fn recompute_recipe_factors(conn: &Connection, ing: &Ing) -> Result<(), String> {
    let table = UnitTable::load(conn)?;
    let lines: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT id, unit FROM recipes WHERE ingredient_id = ?1 AND unit IS NOT NULL").map_err(db)?;
        let rows = stmt.query_map(params![ing.id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db)?
    };
    for (id, unit) in lines {
        let (_, factor) = resolve_unit(conn, &table, &ing.id, &ing.unit, Some(&unit))
            .map_err(|e| format!("وصفة تستعمل «{unit}» مع «{}»: {e}", ing.name))?;
        conn.execute("UPDATE recipes SET stock_factor = ?1 WHERE id = ?2", params![factor, id]).map_err(db)?;
    }
    Ok(())
}

/// After an ingredient's unit text changed: the lines of the recipes must still convert.
pub fn after_ingredient_unit_change(conn: &Connection, scope: &Scope, ingredient_id: &str) -> Result<(), String> {
    let ing = get_ingredient(conn, scope, ingredient_id)?;
    recompute_recipe_factors(conn, &ing)?;
    // Batch recipes that use this ingredient as a component must still convert too.
    let table = UnitTable::load(conn)?;
    let lines: Vec<(String, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT id, unit FROM ingredient_recipes WHERE component_id = ?1").map_err(db)?;
        let rows = stmt.query_map(params![ing.id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db)?
    };
    for (_, unit) in lines {
        resolve_unit(conn, &table, &ing.id, &ing.unit, unit.as_deref()).map_err(|e| format!("وصفة إنتاج تستعمل «{}»: {e}", ing.name))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Purchase lines in a pack
// ---------------------------------------------------------------------------

/// A purchase line's unit: the label to show and the multiplier into the ingredient's stock unit.
pub fn resolve_po_unit(conn: &Connection, ingredient_id: &str, stock_unit: &str, unit: Option<&str>) -> Result<(Option<String>, f64), String> {
    let table = UnitTable::load(conn)?;
    let (label, factor) = resolve_unit(conn, &table, ingredient_id, stock_unit, unit)?;
    if same_unit(&table, &label, stock_unit) {
        Ok((None, 1.0))
    } else {
        Ok((Some(label), factor))
    }
}

// ---------------------------------------------------------------------------
// Batch recipes and production
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct BatchLineInput {
    pub component_id: String,
    pub quantity: f64,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchLineRow {
    pub id: String,
    pub component_id: String,
    pub component_name: String,
    pub component_unit: String,
    pub quantity: f64,
    pub unit: Option<String>,
    pub component_stock: f64,
    pub component_cost_cents: i64,
    /// What this line costs for one batch at the component's current average cost.
    pub line_cost_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchRecipe {
    pub ingredient_id: String,
    pub name: String,
    pub unit: String,
    pub batch_yield: f64,
    pub current_stock: f64,
    pub cost_cents_per_unit: i64,
    pub lines: Vec<BatchLineRow>,
    pub batch_cost_cents: i64,
}

/// Defines (or removes, with no lines) the batch recipe of an ingredient. `batch_yield` is the output of one batch, in the ingredient's stock unit.
pub fn save_batch_recipe(conn: &Connection, scope: &Scope, produced_id: &str, batch_yield: f64, lines: &[BatchLineInput]) -> Result<Vec<String>, String> {
    let ing = get_ingredient(conn, scope, produced_id)?;
    if lines.is_empty() {
        conn.execute("DELETE FROM ingredient_recipes WHERE produced_id = ?1", params![ing.id]).map_err(db)?;
        conn.execute("UPDATE ingredients SET is_produced = 0, batch_yield = 0, last_modified = datetime('now') WHERE id = ?1", params![ing.id]).map_err(db)?;
        return Ok(vec![ing.id]);
    }
    if !batch_yield.is_finite() || batch_yield <= 0.0 {
        return Err("اكتب كمية الناتج من الدفعة الواحدة (أكبر من صفر)".to_string());
    }
    let table = UnitTable::load(conn)?;
    let mut seen: Vec<&str> = Vec::new();
    let mut prepared: Vec<(String, f64, Option<String>)> = Vec::new();
    for line in lines {
        if line.component_id == ing.id {
            return Err("لا يمكن أن يدخل المنتج في تركيب نفسه".to_string());
        }
        if seen.contains(&line.component_id.as_str()) {
            return Err("المكوّن مكرر في التركيبة".to_string());
        }
        seen.push(&line.component_id);
        if !line.quantity.is_finite() || line.quantity <= 0.0 {
            return Err("كمية كل مكوّن يجب أن تكون أكبر من صفر".to_string());
        }
        let comp = get_ingredient(conn, scope, &line.component_id)?;
        if comp.tenant_id != ing.tenant_id || comp.branch_id != ing.branch_id {
            return Err("المكوّن من فرع آخر".to_string());
        }
        let (label, _) = resolve_unit(conn, &table, &comp.id, &comp.unit, line.unit.as_deref())?;
        let store = if same_unit(&table, &label, &comp.unit) { None } else { Some(label) };
        prepared.push((comp.id, line.quantity, store));
    }
    conn.execute("DELETE FROM ingredient_recipes WHERE produced_id = ?1", params![ing.id]).map_err(db)?;
    for (component_id, quantity, unit) in prepared {
        conn.execute(
            "INSERT INTO ingredient_recipes (id, produced_id, component_id, quantity, unit) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![uuid::Uuid::now_v7().to_string(), ing.id, component_id, quantity, unit],
        )
        .map_err(db)?;
    }
    conn.execute(
        "UPDATE ingredients SET is_produced = 1, batch_yield = ?1, last_modified = datetime('now') WHERE id = ?2",
        params![batch_yield, ing.id],
    )
    .map_err(db)?;
    Ok(vec![ing.id])
}

/// Every produced ingredient in scope with its batch recipe and what one batch costs now.
pub fn list_batch_recipes(conn: &Connection, scope: &Scope) -> Result<Vec<BatchRecipe>, String> {
    let (pred, binds) = scope_where(scope, "");
    let sql = format!(
        "SELECT id, name, unit, batch_yield, current_stock, cost_cents_per_unit FROM ingredients WHERE {pred} AND is_active = 1 AND is_produced = 1 ORDER BY name"
    );
    let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(db)?;
    let heads: Vec<(String, String, String, f64, f64, i64)> = stmt
        .query_map(refs.as_slice(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    drop(stmt);
    let table = UnitTable::load(conn)?;
    let mut out = Vec::new();
    for (id, name, unit, batch_yield, current_stock, cost) in heads {
        let mut stmt = conn
            .prepare(
                "SELECT l.id, l.component_id, c.name, c.unit, l.quantity, l.unit, c.current_stock, c.cost_cents_per_unit \
                 FROM ingredient_recipes l JOIN ingredients c ON c.id = l.component_id WHERE l.produced_id = ?1 ORDER BY c.name",
            )
            .map_err(db)?;
        type RawLine = (String, String, String, String, f64, Option<String>, f64, i64);
        let raw: Vec<RawLine> = stmt
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))
            .map_err(db)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db)?;
        drop(stmt);
        let mut lines = Vec::new();
        let mut batch_cost = 0.0;
        for (lid, cid, cname, cunit, qty, lunit, cstock, ccost) in raw {
            let (_, factor) = resolve_unit(conn, &table, &cid, &cunit, lunit.as_deref()).unwrap_or((cunit.clone(), 1.0));
            let line_cost = qty * factor * ccost as f64;
            batch_cost += line_cost;
            lines.push(BatchLineRow {
                id: lid,
                component_id: cid,
                component_name: cname,
                component_unit: cunit,
                quantity: qty,
                unit: lunit,
                component_stock: cstock,
                component_cost_cents: ccost,
                line_cost_cents: line_cost.round() as i64,
            });
        }
        out.push(BatchRecipe { ingredient_id: id, name, unit, batch_yield, current_stock, cost_cents_per_unit: cost, lines, batch_cost_cents: batch_cost.round() as i64 });
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct NegativeStock {
    pub ingredient_id: String,
    pub name: String,
    pub unit: String,
    pub stock_after: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProduceOutcome {
    pub run_id: String,
    pub expected_qty: f64,
    pub actual_qty: f64,
    pub cost_cents: i64,
    /// What this batch cost per stock unit of the produced ingredient.
    pub batch_unit_cost_cents: i64,
    /// The produced ingredient's new average cost after mixing with what was already on the shelf.
    pub new_avg_cost_cents: i64,
    /// Components that are now below zero (stock was never received); the production still went through.
    pub negative_components: Vec<NegativeStock>,
    /// Every ingredient whose stock changed, for sync.
    pub touched: Vec<String>,
}

/// Runs a production: `batches` x the batch recipe, `actual_qty` is what really came out (defaults to the expected output).
#[allow(clippy::too_many_arguments)]
pub fn produce(conn: &Connection, scope: &Scope, actor_id: &str, produced_id: &str, batches: f64, actual_qty: Option<f64>, notes: Option<&str>, now: &str) -> Result<ProduceOutcome, String> {
    let ing = get_ingredient(conn, scope, produced_id)?;
    if !ing.is_produced || ing.batch_yield <= 0.0 {
        return Err("هذا المكوّن ليس له تركيبة إنتاج -- عرّفها أولاً".to_string());
    }
    if !batches.is_finite() || batches <= 0.0 {
        return Err("عدد الدفعات يجب أن يكون أكبر من صفر".to_string());
    }
    let expected = round3(ing.batch_yield * batches);
    let actual = round3(actual_qty.unwrap_or(expected));
    if !actual.is_finite() || actual <= 0.0 {
        return Err("اكتب الكمية الفعلية الناتجة (أكبر من صفر)".to_string());
    }
    let table = UnitTable::load(conn)?;
    let lines: Vec<(String, f64, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT component_id, quantity, unit FROM ingredient_recipes WHERE produced_id = ?1").map_err(db)?;
        let rows = stmt.query_map(params![ing.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db)?
    };
    if lines.is_empty() {
        return Err("تركيبة الإنتاج فارغة".to_string());
    }

    // Work out every deduction first so a conversion error leaves nothing half done.
    let mut plan: Vec<(Ing, f64)> = Vec::new();
    for (component_id, quantity, unit) in &lines {
        let comp = get_ingredient(conn, scope, component_id)?;
        let (_, factor) = resolve_unit(conn, &table, &comp.id, &comp.unit, unit.as_deref())?;
        let need = round3(quantity * batches * factor);
        if need > 0.0 {
            plan.push((comp, need));
        }
    }

    let run_id = uuid::Uuid::now_v7().to_string();
    let mut total_cost = 0.0;
    let mut touched = Vec::new();
    let mut negative = Vec::new();
    for (comp, need) in &plan {
        let line_cost = need * comp.cost_cents as f64;
        total_cost += line_cost;
        apply_movement(conn, comp, -need, REASON_PRODUCTION, Some(&run_id), -(line_cost.round() as i64), actor_id, now)?;
        let after: f64 = conn.query_row("SELECT current_stock FROM ingredients WHERE id = ?1", params![comp.id], |r| r.get(0)).map_err(db)?;
        if after < 0.0 {
            negative.push(NegativeStock { ingredient_id: comp.id.clone(), name: comp.name.clone(), unit: comp.unit.clone(), stock_after: after });
        }
        touched.push(comp.id.clone());
    }

    let batch_unit_cost = total_cost / actual;
    let new_cost = weighted_average_cost(ing.stock, ing.cost_cents, actual, batch_unit_cost);
    apply_movement(conn, &ing, actual, REASON_PRODUCTION, Some(&run_id), total_cost.round() as i64, actor_id, now)?;
    conn.execute("UPDATE ingredients SET cost_cents_per_unit = ?1 WHERE id = ?2", params![new_cost, ing.id]).map_err(db)?;
    touched.push(ing.id.clone());

    conn.execute(
        "INSERT INTO production_runs (id, tenant_id, branch_id, produced_id, batches, expected_qty, actual_qty, cost_cents, staff_id, created_at, notes) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![run_id, ing.tenant_id, ing.branch_id, ing.id, batches, expected, actual, total_cost.round() as i64, actor_id, now, notes],
    )
    .map_err(db)?;

    Ok(ProduceOutcome {
        run_id,
        expected_qty: expected,
        actual_qty: actual,
        cost_cents: total_cost.round() as i64,
        batch_unit_cost_cents: batch_unit_cost.round() as i64,
        new_avg_cost_cents: new_cost,
        negative_components: negative,
        touched,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ProductionRunRow {
    pub id: String,
    pub produced_id: String,
    pub produced_name: String,
    pub unit: String,
    pub batches: f64,
    pub expected_qty: f64,
    pub actual_qty: f64,
    /// actual / expected x 100
    pub yield_pct: f64,
    pub cost_cents: i64,
    pub unit_cost_cents: i64,
    pub staff_name: Option<String>,
    pub created_at: String,
    pub notes: Option<String>,
}

pub fn list_production_runs(conn: &Connection, scope: &Scope, ingredient_id: Option<&str>, limit: i64) -> Result<Vec<ProductionRunRow>, String> {
    let (pred, mut binds) = scope_where(scope, "p.");
    let mut sql = format!(
        "SELECT p.id, p.produced_id, i.name, i.unit, p.batches, p.expected_qty, p.actual_qty, p.cost_cents, s.name, p.created_at, p.notes \
         FROM production_runs p JOIN ingredients i ON i.id = p.produced_id LEFT JOIN staff s ON s.id = p.staff_id WHERE {pred}"
    );
    if let Some(id) = ingredient_id {
        binds.push(id.to_string());
        sql.push_str(&format!(" AND p.produced_id = ?{}", binds.len()));
    }
    sql.push_str(&format!(" ORDER BY p.created_at DESC LIMIT {}", limit.clamp(1, 1000)));
    let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(db)?;
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let expected: f64 = r.get(5)?;
            let actual: f64 = r.get(6)?;
            let cost: i64 = r.get(7)?;
            Ok(ProductionRunRow {
                id: r.get(0)?,
                produced_id: r.get(1)?,
                produced_name: r.get(2)?,
                unit: r.get(3)?,
                batches: r.get(4)?,
                expected_qty: expected,
                actual_qty: actual,
                yield_pct: if expected > 0.0 { (actual / expected * 1000.0).round() / 10.0 } else { 0.0 },
                cost_cents: cost,
                unit_cost_cents: if actual > 0.0 { (cost as f64 / actual).round() as i64 } else { 0 },
                staff_name: r.get(8)?,
                created_at: r.get(9)?,
                notes: r.get(10)?,
            })
        })
        .map_err(db)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db)
}

// ---------------------------------------------------------------------------
// Waste
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WasteOutcome {
    pub log_id: String,
    /// What was taken off the stock, in the ingredient's unit.
    pub quantity: f64,
    pub value_cents: i64,
    pub stock_after: f64,
    /// True when the stock is now below zero (it was never received): the waste is still recorded.
    pub below_zero: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn record_waste(conn: &Connection, scope: &Scope, actor_id: &str, ingredient_id: &str, quantity: f64, unit: Option<&str>, reason: &str, note: Option<&str>, now: &str) -> Result<WasteOutcome, String> {
    let ing = get_ingredient(conn, scope, ingredient_id)?;
    if !WASTE_REASONS.contains(&reason) {
        return Err("اختر سبب الهدر من القائمة".to_string());
    }
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err("الكمية يجب أن تكون أكبر من صفر".to_string());
    }
    let table = UnitTable::load(conn)?;
    let (_, factor) = resolve_unit(conn, &table, &ing.id, &ing.unit, unit)?;
    let qty = round3(quantity * factor);
    if qty <= 0.0 {
        return Err("الكمية صغيرة جداً".to_string());
    }
    let value = (qty * ing.cost_cents as f64).round() as i64;
    let note_text = match note.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("{reason}: {n}"),
        None => reason.to_string(),
    };
    let log_id = apply_movement(conn, &ing, -qty, REASON_WASTE, Some(&note_text), -value, actor_id, now)?;
    let after: f64 = conn.query_row("SELECT current_stock FROM ingredients WHERE id = ?1", params![ing.id], |r| r.get(0)).map_err(db)?;
    Ok(WasteOutcome { log_id, quantity: qty, value_cents: value, stock_after: after, below_zero: after < 0.0 })
}

#[derive(Debug, Clone, Serialize)]
pub struct WasteRow {
    pub id: String,
    pub ingredient_id: String,
    pub ingredient_name: String,
    pub unit: String,
    pub quantity: f64,
    pub reason: String,
    pub value_cents: i64,
    pub staff_name: Option<String>,
    pub created_at: String,
}

pub fn list_waste(conn: &Connection, scope: &Scope, range_start_iso: &str, range_end_iso: &str) -> Result<Vec<WasteRow>, String> {
    let (pred, mut binds) = scope_where(scope, "l.");
    binds.push(range_start_iso.to_string());
    binds.push(range_end_iso.to_string());
    let (a, b) = (binds.len() - 1, binds.len());
    let sql = format!(
        "SELECT l.id, l.ingredient_id, i.name, i.unit, l.change_amount, COALESCE(l.note, ''), COALESCE(l.value_cents, 0), s.name, l.created_at \
         FROM inventory_logs l JOIN ingredients i ON i.id = l.ingredient_id LEFT JOIN staff s ON s.id = l.user_id \
         WHERE {pred} AND l.reason = 'WASTE' AND l.created_at >= ?{a} AND l.created_at < ?{b} ORDER BY l.created_at DESC"
    );
    let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|x| x as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(db)?;
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let note: String = r.get(5)?;
            let change: f64 = r.get(4)?;
            let value: i64 = r.get(6)?;
            // The note is "reason" or "reason: details".
            let reason = note.split(':').next().unwrap_or("").trim().to_string();
            Ok(WasteRow {
                id: r.get(0)?,
                ingredient_id: r.get(1)?,
                ingredient_name: r.get(2)?,
                unit: r.get(3)?,
                quantity: -change,
                reason: if reason.is_empty() { "أخرى".to_string() } else { reason },
                value_cents: -value,
                staff_name: r.get(7)?,
                created_at: r.get(8)?,
            })
        })
        .map_err(db)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db)
}

// ---------------------------------------------------------------------------
// Stock report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct StockReportRow {
    pub ingredient_id: String,
    pub name: String,
    pub unit: String,
    pub is_produced: bool,
    pub on_hand: f64,
    pub min_stock: f64,
    pub avg_cost_cents: i64,
    /// on hand x average cost (a negative balance counts as 0).
    pub value_cents: i64,
    pub received: f64,
    pub used_sales: f64,
    pub produced: f64,
    pub used_production: f64,
    pub wasted: f64,
    pub wasted_value_cents: i64,
    /// Counts, corrections and anything else, signed.
    pub adjusted: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockReport {
    pub rows: Vec<StockReportRow>,
    pub total_value_cents: i64,
    pub waste_value_cents: i64,
    pub received_value_cents: i64,
}

pub fn stock_report(conn: &Connection, scope: &Scope, range_start_iso: &str, range_end_iso: &str) -> Result<StockReport, String> {
    let (pred, binds) = scope_where(scope, "");
    let sql = format!(
        "SELECT id, name, unit, is_produced, current_stock, min_stock, cost_cents_per_unit FROM ingredients WHERE {pred} AND is_active = 1 ORDER BY name"
    );
    let refs: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(db)?;
    let mut rows: Vec<StockReportRow> = stmt
        .query_map(refs.as_slice(), |r| {
            let on_hand: f64 = r.get(4)?;
            let cost: i64 = r.get(6)?;
            Ok(StockReportRow {
                ingredient_id: r.get(0)?,
                name: r.get(1)?,
                unit: r.get(2)?,
                is_produced: r.get::<_, i64>(3)? != 0,
                on_hand,
                min_stock: r.get(5)?,
                avg_cost_cents: cost,
                value_cents: (on_hand.max(0.0) * cost as f64).round() as i64,
                ..Default::default()
            })
        })
        .map_err(db)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db)?;
    drop(stmt);
    let index: HashMap<String, usize> = rows.iter().enumerate().map(|(i, r)| (r.ingredient_id.clone(), i)).collect();

    let (lpred, mut lbinds) = scope_where(scope, "l.");
    lbinds.push(range_start_iso.to_string());
    lbinds.push(range_end_iso.to_string());
    let (a, b) = (lbinds.len() - 1, lbinds.len());
    let sql = format!(
        "SELECT l.ingredient_id, l.reason, l.change_amount, COALESCE(l.value_cents, 0) FROM inventory_logs l \
         WHERE {lpred} AND l.created_at >= ?{a} AND l.created_at < ?{b}"
    );
    let refs: Vec<&dyn rusqlite::ToSql> = lbinds.iter().map(|x| x as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(db)?;
    let mut waste_value = 0i64;
    let mut received_value = 0i64;
    let moves = stmt
        .query_map(refs.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, i64>(3)?)))
        .map_err(db)?;
    for m in moves {
        let (ingredient_id, reason, change, value) = m.map_err(db)?;
        let Some(&i) = index.get(&ingredient_id) else { continue };
        let row = &mut rows[i];
        match classify_movement(&reason, change) {
            MovementClass::Received => {
                row.received += change;
                received_value += value;
            }
            MovementClass::Sales => row.used_sales -= change,
            MovementClass::Produced => row.produced += change,
            MovementClass::UsedInProduction => row.used_production -= change,
            MovementClass::Wasted => {
                row.wasted -= change;
                row.wasted_value_cents -= value;
                waste_value -= value;
            }
            MovementClass::Adjusted => row.adjusted += change,
        }
    }
    drop(stmt);
    for r in rows.iter_mut() {
        r.received = round3(r.received);
        r.used_sales = round3(r.used_sales);
        r.produced = round3(r.produced);
        r.used_production = round3(r.used_production);
        r.wasted = round3(r.wasted);
        r.adjusted = round3(r.adjusted);
    }
    let total_value_cents: i64 = rows.iter().map(|r| r.value_cents).sum();
    Ok(StockReport { rows, total_value_cents, waste_value_cents: waste_value, received_value_cents: received_value })
}

// ---------------------------------------------------------------------------
// Tests (the pure part; the whole receive -> produce -> sell chain is tested in repo.rs against a real migrated database)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> UnitTable {
        UnitTable::builtin()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn converts_inside_one_kind() {
        assert!(close(convert(&t(), 150.0, "g", "kg").unwrap(), 0.15));
        assert!(close(convert(&t(), 2.0, "kg", "g").unwrap(), 2000.0));
        assert!(close(convert(&t(), 500.0, "ml", "l").unwrap(), 0.5));
        assert!(close(convert(&t(), 3.0, "l", "ml").unwrap(), 3000.0));
        assert!(close(convert(&t(), 7.0, "piece", "piece").unwrap(), 7.0));
        // the same unit written two ways
        assert!(close(convert(&t(), 5.0, "كيلو", "kg").unwrap(), 5.0));
        assert!(close(convert(&t(), 250.0, "غرام", "كغ").unwrap(), 0.25));
        // and what ends up in stock is the rounded value
        assert_eq!(round3(convert(&t(), 150.0, "g", "kg").unwrap()), 0.15);
    }

    #[test]
    fn refuses_across_kinds_with_an_arabic_message() {
        let e = conversion_factor(&t(), "g", "l").unwrap_err();
        assert!(e.contains("غرام") && e.contains("لتر") && e.contains("وزن") && e.contains("حجم"), "{e}");
        assert!(conversion_factor(&t(), "piece", "kg").is_err());
        assert!(conversion_factor(&t(), "ml", "piece").is_err());
    }

    #[test]
    fn unknown_units_only_match_themselves() {
        assert_eq!(conversion_factor(&t(), "علبة", "علبة").unwrap(), 1.0);
        assert_eq!(conversion_factor(&t(), "", "علبة").unwrap(), 1.0);
        assert!(conversion_factor(&t(), "علبة", "kg").is_err());
        assert!(conversion_factor(&t(), "g", "علبة").is_err());
    }

    #[test]
    fn free_text_maps_to_codes_and_unknown_stays() {
        for (text, code) in [("كغ", "kg"), (" كيلو ", "kg"), ("Kg", "kg"), ("غ", "g"), ("غرام", "g"), ("لتر", "l"), ("مل", "ml"), ("حبة", "piece"), ("قطعة", "piece"), ("piece", "piece"), ("pcs", "piece")] {
            assert_eq!(canonical_code(text), Some(code), "{text}");
        }
        assert_eq!(canonical_code("علبة"), None);
        assert_eq!(canonical_unit_text("علبة "), "علبة");
        assert_eq!(canonical_unit_text("كغ"), "kg");
    }

    #[test]
    fn rounds_stock_to_three_decimals() {
        assert_eq!(round3(0.1 + 0.2), 0.3);
        assert_eq!(round3(1.23456), 1.235);
        assert_eq!(round3(-0.0004), 0.0);
        // 150 g x 3 portions taken out of kg stock
        assert_eq!(round3(convert(&t(), 150.0 * 3.0, "g", "kg").unwrap()), 0.45);
    }

    #[test]
    fn weighted_average_mixes_old_and_new() {
        // 10 kg at 100 + 10 kg at 200 -> 150
        assert_eq!(weighted_average_cost(10.0, 100, 10.0, 200.0), 150);
        // 3 at 100 + 1 at 200 -> 125
        assert_eq!(weighted_average_cost(3.0, 100, 1.0, 200.0), 125);
        // rounded once at the end
        assert_eq!(weighted_average_cost(2.0, 100, 1.0, 101.0), 100);
        assert_eq!(weighted_average_cost(1.0, 100, 2.0, 101.0), 101);
    }

    #[test]
    fn weighted_average_takes_the_new_cost_when_nothing_to_average() {
        assert_eq!(weighted_average_cost(0.0, 100, 5.0, 300.0), 300);
        assert_eq!(weighted_average_cost(-4.0, 100, 5.0, 300.0), 300);
        // nothing received: cost stays
        assert_eq!(weighted_average_cost(5.0, 100, 0.0, 999.0), 100);
        assert_eq!(weighted_average_cost(5.0, 100, f64::NAN, 999.0), 100);
    }

    #[test]
    fn classifies_movements_for_the_report() {
        assert_eq!(classify_movement("بيع", -1.0), MovementClass::Sales);
        assert_eq!(classify_movement("إلغاء صنف بعد الدفع", 1.0), MovementClass::Sales);
        assert_eq!(classify_movement("استلام طلبية شراء", 5.0), MovementClass::Received);
        assert_eq!(classify_movement("PRODUCTION", 5.0), MovementClass::Produced);
        assert_eq!(classify_movement("PRODUCTION", -2.0), MovementClass::UsedInProduction);
        assert_eq!(classify_movement("WASTE", -1.0), MovementClass::Wasted);
        assert_eq!(classify_movement("physical_count", -1.0), MovementClass::Adjusted);
        assert_eq!(classify_movement("تصحيح", 1.0), MovementClass::Adjusted);
    }
}
