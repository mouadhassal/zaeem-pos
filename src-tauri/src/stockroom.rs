//! Shop stock: what is on the shelf, per product.
//!
//! A restaurant's stock is raw ingredients lowered by recipes (inventory). A
//! shop sells finished products with a barcode, so each product can instead
//! **track its own stock** (`menu_items.track_stock`), per branch
//! (`product_stock`). A paid sale lowers it, receiving goods raises it, a count
//! sets it, and every movement is a row in `product_stock_log` with the balance
//! after it, so nothing changes silently.
//!
//! * Quantity is in pieces, or in kilograms for a product sold by weight.
//! * Stock may go negative (goods get sold before the delivery is entered);
//!   the owner can instead choose to refuse a sale that stock cannot cover
//!   (`retail_settings.block_sale_when_empty`).
//! * A product can have **more barcodes** than its main one (`product_barcodes`):
//!   a carton code that adds 12 pieces, a second supplier's code, ...
//! * **Scale barcodes** (a deli scale prints `prefix + item code + weight or price`)
//!   are configured in `retail_settings`; the till decodes them.
//! * Products can be brought in from a spreadsheet (`import_products`).

use crate::repo::{Repo, RepoError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS product_stock (
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0,
    min_quantity REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (menu_item_id, branch_id)
);
CREATE TABLE IF NOT EXISTS product_stock_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    change REAL NOT NULL,
    balance_after REAL NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    order_id TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_stock_log_item ON product_stock_log (menu_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_product_stock_log_branch ON product_stock_log (tenant_id, branch_id, created_at);
CREATE TABLE IF NOT EXISTS product_barcodes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    barcode TEXT NOT NULL,
    units REAL NOT NULL DEFAULT 1,
    UNIQUE (tenant_id, barcode)
);
CREATE TABLE IF NOT EXISTS retail_settings (
    tenant_id TEXT PRIMARY KEY,
    scale_prefix TEXT NOT NULL DEFAULT '',
    scale_plu_digits INTEGER NOT NULL DEFAULT 6,
    scale_value_digits INTEGER NOT NULL DEFAULT 5,
    scale_value_kind TEXT NOT NULL DEFAULT 'WEIGHT_G',
    block_sale_when_empty INTEGER NOT NULL DEFAULT 0
);";

/// Why a quantity changed.
pub const REASONS: &[&str] = &["SALE", "RECEIVE", "ADJUST", "COUNT", "OPENING", "RETURN"];

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn repo_err(e: RepoError) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetailSettings {
    /// What a scale's barcode starts with ("" = scale barcodes are off). Example: "2" or "28".
    pub scale_prefix: String,
    /// Digits that identify the product (its code, matched against the product's barcode).
    pub scale_plu_digits: i64,
    /// Digits that carry the weight or the price.
    pub scale_value_digits: i64,
    /// WEIGHT_G (the value is grams) | PRICE (the value is the amount to charge, in the currency's smallest unit)
    pub scale_value_kind: String,
    /// Refuse a sale that tracked stock cannot cover. Off by default: the till keeps selling.
    pub block_sale_when_empty: bool,
}

impl Default for RetailSettings {
    fn default() -> Self {
        RetailSettings { scale_prefix: String::new(), scale_plu_digits: 6, scale_value_digits: 5, scale_value_kind: "WEIGHT_G".into(), block_sale_when_empty: false }
    }
}

impl RetailSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.scale_prefix.chars().all(|c| c.is_ascii_digit()) || self.scale_prefix.len() > 4 {
            return Err("بادئة باركود الميزان أرقام فقط (حتى 4)".into());
        }
        if !["WEIGHT_G", "PRICE"].contains(&self.scale_value_kind.as_str()) {
            return Err("نوع قيمة باركود الميزان غير صالح".into());
        }
        if !(1..=8).contains(&self.scale_plu_digits) || !(1..=8).contains(&self.scale_value_digits) {
            return Err("عدد خانات الصنف والقيمة بين 1 و8".into());
        }
        if !self.scale_prefix.is_empty() && self.scale_prefix.len() as i64 + self.scale_plu_digits + self.scale_value_digits > 12 {
            return Err("البادئة وخانات الصنف والقيمة يجب ألا تتجاوز 12 خانة (الخانة 13 للتحقق)".into());
        }
        Ok(())
    }
}

pub fn load_settings(conn: &Connection, tenant_id: &str) -> Result<RetailSettings, String> {
    let row = conn
        .query_row(
            "SELECT scale_prefix, scale_plu_digits, scale_value_digits, scale_value_kind, block_sale_when_empty FROM retail_settings WHERE tenant_id = ?1",
            params![tenant_id],
            |r| Ok(RetailSettings { scale_prefix: r.get(0)?, scale_plu_digits: r.get(1)?, scale_value_digits: r.get(2)?, scale_value_kind: r.get(3)?, block_sale_when_empty: r.get::<_, i64>(4)? != 0 }),
        )
        .optional()
        .map_err(db_err)?;
    Ok(row.unwrap_or_default())
}

pub fn save_settings(conn: &Connection, tenant_id: &str, s: &RetailSettings) -> Result<(), String> {
    s.validate()?;
    conn.execute(
        "INSERT INTO retail_settings (tenant_id, scale_prefix, scale_plu_digits, scale_value_digits, scale_value_kind, block_sale_when_empty) VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(tenant_id) DO UPDATE SET scale_prefix = ?2, scale_plu_digits = ?3, scale_value_digits = ?4, scale_value_kind = ?5, block_sale_when_empty = ?6",
        params![tenant_id, s.scale_prefix, s.scale_plu_digits, s.scale_value_digits, s.scale_value_kind, s.block_sale_when_empty as i64],
    )
    .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

/// Codes the till makes for products that have none.
pub const INTERNAL_PREFIX: &str = "29";

/// The EAN-13 check digit for the first 12 digits.
pub fn ean13_check_digit(first12: &str) -> Option<u32> {
    if first12.len() != 12 || !first12.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let sum: u32 = first12.chars().enumerate().map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 }).sum();
    Some((10 - sum % 10) % 10)
}

/// Whether the barcode is a well-formed EAN-13 (13 digits with the right last digit).
#[cfg(test)]
pub fn ean13_ok(code: &str) -> bool {
    code.len() == 13 && ean13_check_digit(&code[..12]).map(|d| d.to_string() == code[12..]).unwrap_or(false)
}

/// Another product (not `except_item`) already uses this barcode, as its main one or as an extra.
pub fn barcode_taken(conn: &Connection, tenant_id: &str, code: &str, except_item: Option<&str>) -> Result<bool, String> {
    let except = except_item.unwrap_or("");
    let main: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM menu_items WHERE tenant_id = ?1 AND barcode = ?2 AND id != ?3", params![tenant_id, code, except], |r| r.get(0))
        .map_err(db_err)?;
    let extra: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM product_barcodes WHERE tenant_id = ?1 AND barcode = ?2 AND menu_item_id != ?3", params![tenant_id, code, except], |r| r.get(0))
        .map_err(db_err)?;
    Ok(main || extra)
}

/// The next unused code of ours: `29` + a running number + the EAN-13 check digit.
pub fn generate_barcode(conn: &Connection, tenant_id: &str) -> Result<String, String> {
    let mut n: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(CAST(substr(code, 3, 10) AS INTEGER)), 0) FROM (SELECT barcode AS code FROM menu_items WHERE tenant_id = ?1 AND barcode LIKE '29__________' UNION ALL SELECT barcode FROM product_barcodes WHERE tenant_id = ?1 AND barcode LIKE '29__________')",
            params![tenant_id],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    loop {
        n += 1;
        let body = format!("{INTERNAL_PREFIX}{n:010}");
        let check = ean13_check_digit(&body).ok_or("تعذّر توليد باركود")?;
        let code = format!("{body}{check}");
        if !barcode_taken(conn, tenant_id, &code, None)? {
            return Ok(code);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraBarcode {
    pub id: String,
    pub barcode: String,
    /// How many pieces one scan adds (a carton of 12 = 12).
    pub units: f64,
}

pub fn list_extra_barcodes(conn: &Connection, tenant_id: &str, item_id: &str) -> Result<Vec<ExtraBarcode>, String> {
    let mut stmt = conn.prepare("SELECT id, barcode, units FROM product_barcodes WHERE tenant_id = ?1 AND menu_item_id = ?2 ORDER BY barcode").map_err(db_err)?;
    let rows = stmt.query_map(params![tenant_id, item_id], |r| Ok(ExtraBarcode { id: r.get(0)?, barcode: r.get(1)?, units: r.get(2)? })).map_err(db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

fn assert_item(conn: &Connection, tenant_id: &str, item_id: &str) -> Result<(), String> {
    let ok: bool = conn.query_row("SELECT COUNT(*) > 0 FROM menu_items WHERE id = ?1 AND tenant_id = ?2", params![item_id, tenant_id], |r| r.get(0)).map_err(db_err)?;
    if ok { Ok(()) } else { Err("الصنف غير موجود".into()) }
}

pub fn add_extra_barcode(conn: &Connection, tenant_id: &str, item_id: &str, barcode: &str, units: f64) -> Result<String, String> {
    assert_item(conn, tenant_id, item_id)?;
    let code = barcode.trim();
    if code.is_empty() || code.len() > 64 || code.chars().any(|c| c.is_whitespace()) {
        return Err("الباركود غير صالح".into());
    }
    if !(1.0..=100_000.0).contains(&units) || units.fract() != 0.0 {
        return Err("عدد القطع لكل مسحة عدد صحيح من 1 إلى 100000".into());
    }
    if barcode_taken(conn, tenant_id, code, Some(item_id))? {
        return Err("هذا الباركود مستخدم لصنف آخر".into());
    }
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute("INSERT OR REPLACE INTO product_barcodes (id, tenant_id, menu_item_id, barcode, units) VALUES (?1, ?2, ?3, ?4, ?5)", params![id, tenant_id, item_id, code, units]).map_err(db_err)?;
    Ok(id)
}

pub fn delete_extra_barcode(conn: &Connection, tenant_id: &str, id: &str) -> Result<(), String> {
    let n = conn.execute("DELETE FROM product_barcodes WHERE id = ?1 AND tenant_id = ?2", params![id, tenant_id]).map_err(db_err)?;
    if n == 0 { Err("الباركود غير موجود".into()) } else { Ok(()) }
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

fn ensure_row(conn: &Connection, tenant_id: &str, branch_id: &str, item_id: &str) -> Result<(), String> {
    conn.execute("INSERT OR IGNORE INTO product_stock (menu_item_id, tenant_id, branch_id, quantity, min_quantity) VALUES (?1, ?2, ?3, 0, 0)", params![item_id, tenant_id, branch_id]).map_err(db_err)?;
    Ok(())
}

pub fn quantity_of(conn: &Connection, branch_id: &str, item_id: &str) -> Result<f64, String> {
    Ok(conn.query_row("SELECT quantity FROM product_stock WHERE menu_item_id = ?1 AND branch_id = ?2", params![item_id, branch_id], |r| r.get(0)).optional().map_err(db_err)?.unwrap_or(0.0))
}

/// Changes a product's stock by `change` and writes the movement. Returns the balance after.
#[allow(clippy::too_many_arguments)]
pub fn apply_change(conn: &Connection, tenant_id: &str, branch_id: &str, item_id: &str, change: f64, reason: &str, note: Option<&str>, order_id: Option<&str>, user_id: Option<&str>, now: &str) -> Result<f64, String> {
    if !REASONS.contains(&reason) {
        return Err("سبب حركة المخزون غير صالح".into());
    }
    if !change.is_finite() {
        return Err("الكمية غير صالحة".into());
    }
    ensure_row(conn, tenant_id, branch_id, item_id)?;
    let before = quantity_of(conn, branch_id, item_id)?;
    let after = round3(before + change);
    conn.execute("UPDATE product_stock SET quantity = ?1 WHERE menu_item_id = ?2 AND branch_id = ?3", params![after, item_id, branch_id]).map_err(db_err)?;
    conn.execute(
        "INSERT INTO product_stock_log (id, tenant_id, branch_id, menu_item_id, change, balance_after, reason, note, order_id, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, item_id, round3(change), after, reason, note, order_id, user_id, now],
    )
    .map_err(db_err)?;
    Ok(after)
}

/// Turns tracking on or off for a product and sets its alert level. An opening quantity
/// is recorded the first time (only when the shelf is empty on paper).
#[allow(clippy::too_many_arguments)]
pub fn set_tracking(conn: &Connection, tenant_id: &str, branch_id: &str, item_id: &str, track: bool, min_quantity: f64, opening: Option<f64>, user_id: &str, now: &str) -> Result<(), String> {
    assert_item(conn, tenant_id, item_id)?;
    if !(min_quantity >= 0.0 && min_quantity.is_finite()) {
        return Err("الحد الأدنى غير صالح".into());
    }
    conn.execute("UPDATE menu_items SET track_stock = ?1, last_modified = datetime('now') WHERE id = ?2", params![track as i64, item_id]).map_err(db_err)?;
    if track {
        ensure_row(conn, tenant_id, branch_id, item_id)?;
        conn.execute("UPDATE product_stock SET min_quantity = ?1 WHERE menu_item_id = ?2 AND branch_id = ?3", params![round3(min_quantity), item_id, branch_id]).map_err(db_err)?;
        if let Some(q) = opening {
            if q != 0.0 && quantity_of(conn, branch_id, item_id)? == 0.0 {
                apply_change(conn, tenant_id, branch_id, item_id, q, "OPENING", Some("رصيد افتتاحي"), None, Some(user_id), now)?;
            }
        }
    }
    Ok(())
}

/// Sets the quantity to what was counted on the shelf; the difference is the movement.
#[allow(clippy::too_many_arguments)]
pub fn count(conn: &Connection, tenant_id: &str, branch_id: &str, item_id: &str, counted: f64, note: Option<&str>, user_id: &str, now: &str) -> Result<f64, String> {
    assert_item(conn, tenant_id, item_id)?;
    if !(counted >= 0.0 && counted.is_finite()) {
        return Err("الكمية المجرودة غير صالحة".into());
    }
    let before = quantity_of(conn, branch_id, item_id)?;
    conn.execute("UPDATE menu_items SET track_stock = 1 WHERE id = ?1", params![item_id]).map_err(db_err)?;
    apply_change(conn, tenant_id, branch_id, item_id, counted - before, "COUNT", note, None, Some(user_id), now)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReceiveLine {
    pub menu_item_id: String,
    pub quantity: f64,
    /// The new cost price of one piece (or kilo), if the delivery changed it.
    pub cost_cents: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReceiveOutcome {
    pub lines: usize,
    pub pieces: f64,
}

/// Goods arrive: each product's stock goes up (and starts being tracked), its cost price can be updated.
pub fn receive(conn: &Connection, tenant_id: &str, branch_id: &str, lines: &[ReceiveLine], note: Option<&str>, user_id: &str, now: &str) -> Result<ReceiveOutcome, String> {
    if lines.is_empty() {
        return Err("أضف صنفاً واحداً على الأقل".into());
    }
    if lines.len() > 1000 {
        return Err("حتى 1000 صنف في الاستلام الواحد".into());
    }
    let mut total = 0.0;
    for l in lines {
        assert_item(conn, tenant_id, &l.menu_item_id)?;
        if !(l.quantity > 0.0 && l.quantity.is_finite()) {
            return Err("كمية الاستلام يجب أن تكون أكبر من صفر".into());
        }
        conn.execute("UPDATE menu_items SET track_stock = 1 WHERE id = ?1", params![l.menu_item_id]).map_err(db_err)?;
        apply_change(conn, tenant_id, branch_id, &l.menu_item_id, l.quantity, "RECEIVE", note, None, Some(user_id), now)?;
        if let Some(c) = l.cost_cents.filter(|c| *c > 0) {
            conn.execute("UPDATE menu_items SET cost_cents = ?1, last_modified = datetime('now') WHERE id = ?2", params![c, l.menu_item_id]).map_err(db_err)?;
        }
        total += l.quantity;
    }
    Ok(ReceiveOutcome { lines: lines.len(), pieces: round3(total) })
}

/// Lowers the stock of every tracked product on a paid order. A weighed line takes its kilos.
/// With `block_sale_when_empty` on, a sale the stock cannot cover is refused (the caller's
/// transaction then rolls the whole payment back).
pub fn deduct_for_order(conn: &Connection, tenant_id: &str, branch_id: &str, order_id: &str, user_id: &str, now: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT oi.menu_item_id, mi.name, SUM(CASE WHEN oi.weight_grams IS NOT NULL THEN oi.weight_grams / 1000.0 ELSE oi.quantity END) \
             FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id \
             WHERE oi.order_id = ?1 AND oi.voided = 0 AND mi.track_stock = 1 GROUP BY oi.menu_item_id",
        )
        .map_err(db_err)?;
    let needed: Vec<(String, String, f64)> = stmt.query_map(params![order_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
    drop(stmt);
    if needed.is_empty() {
        return Ok(());
    }
    let block = load_settings(conn, tenant_id)?.block_sale_when_empty;
    for (item_id, name, qty) in needed {
        if qty <= 0.0 {
            continue;
        }
        if block && quantity_of(conn, branch_id, &item_id)? < qty {
            return Err(format!("لا يكفي المخزون من «{name}»"));
        }
        apply_change(conn, tenant_id, branch_id, &item_id, -qty, "SALE", None, Some(order_id), Some(user_id), now)?;
    }
    Ok(())
}

/// Puts the refunded lines of a refund back on the shelf (the cashier chose "return to stock").
pub fn restock_for_refund(conn: &Connection, tenant_id: &str, branch_id: &str, refund_id: &str, user_id: &str, now: &str) -> Result<usize, String> {
    let mut stmt = conn
        .prepare(
            "SELECT oi.menu_item_id, oi.order_id, CASE WHEN oi.weight_grams IS NOT NULL THEN oi.weight_grams / 1000.0 ELSE ri.quantity END \
             FROM refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id JOIN menu_items mi ON mi.id = oi.menu_item_id \
             WHERE ri.refund_id = ?1 AND mi.track_stock = 1",
        )
        .map_err(db_err)?;
    let back: Vec<(String, String, f64)> = stmt.query_map(params![refund_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
    drop(stmt);
    for (item_id, order_id, qty) in &back {
        apply_change(conn, tenant_id, branch_id, item_id, *qty, "RETURN", Some("مرتجع إلى المخزون"), Some(order_id), Some(user_id), now)?;
    }
    Ok(back.len())
}

#[derive(Debug, Clone, Serialize)]
pub struct StockRow {
    pub menu_item_id: String,
    pub name: String,
    pub barcode: Option<String>,
    pub category: Option<String>,
    pub price_cents: i64,
    pub cost_cents: i64,
    pub sold_by: String,
    pub track_stock: bool,
    pub quantity: f64,
    pub min_quantity: f64,
    /// Quantity at or below the alert level (tracked products only).
    pub low: bool,
    /// Stock value at cost.
    pub value_cents: i64,
}

/// The products of the branch with their stock. `only_low`: the ones at or below their alert level.
pub fn list_stock(conn: &Connection, tenant_id: &str, branch_id: &str, search: Option<&str>, only_low: bool, include_untracked: bool, limit: usize) -> Result<Vec<StockRow>, String> {
    let mut sql = String::from(
        "SELECT mi.id, mi.name, mi.barcode, c.name, mi.price_cents, mi.cost_cents, mi.sold_by, mi.track_stock, COALESCE(ps.quantity, 0), COALESCE(ps.min_quantity, 0) \
         FROM menu_items mi LEFT JOIN categories c ON c.id = mi.category_id LEFT JOIN product_stock ps ON ps.menu_item_id = mi.id AND ps.branch_id = ?2 \
         WHERE mi.tenant_id = ?1 AND mi.is_active = 1",
    );
    let mut args: Vec<String> = vec![tenant_id.to_string(), branch_id.to_string()];
    if !include_untracked {
        sql.push_str(" AND mi.track_stock = 1");
    }
    if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
        args.push(format!("%{q}%"));
        let n = args.len();
        sql.push_str(&format!(" AND (mi.name LIKE ?{n} OR mi.barcode LIKE ?{n} OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.menu_item_id = mi.id AND pb.barcode LIKE ?{n}))"));
    }
    sql.push_str(" ORDER BY mi.name");
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            let track = r.get::<_, i64>(7)? != 0;
            let quantity: f64 = r.get(8)?;
            let min_quantity: f64 = r.get(9)?;
            let cost: i64 = r.get(5)?;
            Ok(StockRow {
                menu_item_id: r.get(0)?,
                name: r.get(1)?,
                barcode: r.get(2)?,
                category: r.get(3)?,
                price_cents: r.get(4)?,
                cost_cents: cost,
                sold_by: r.get(6)?,
                track_stock: track,
                quantity,
                min_quantity,
                low: track && quantity <= min_quantity,
                value_cents: if track { (quantity.max(0.0) * cost as f64).round() as i64 } else { 0 },
            })
        })
        .map_err(db_err)?;
    let mut out: Vec<StockRow> = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
    if only_low {
        out.retain(|r| r.low);
    }
    out.truncate(limit);
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct LogRow {
    pub id: String,
    pub menu_item_id: String,
    pub name: String,
    pub change: f64,
    pub balance_after: f64,
    pub reason: String,
    pub note: Option<String>,
    pub user_name: Option<String>,
    pub created_at: String,
}

pub fn list_log(conn: &Connection, tenant_id: &str, branch_id: &str, item_id: Option<&str>, limit: usize) -> Result<Vec<LogRow>, String> {
    let mut sql = String::from(
        "SELECT l.id, l.menu_item_id, mi.name, l.change, l.balance_after, l.reason, l.note, s.name, l.created_at \
         FROM product_stock_log l JOIN menu_items mi ON mi.id = l.menu_item_id LEFT JOIN staff s ON s.id = l.user_id \
         WHERE l.tenant_id = ?1 AND l.branch_id = ?2",
    );
    let mut args: Vec<String> = vec![tenant_id.to_string(), branch_id.to_string()];
    if let Some(i) = item_id {
        args.push(i.to_string());
        sql.push_str(&format!(" AND l.menu_item_id = ?{}", args.len()));
    }
    sql.push_str(&format!(" ORDER BY l.created_at DESC, l.rowid DESC LIMIT {}", limit.clamp(1, 1000)));
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| Ok(LogRow { id: r.get(0)?, menu_item_id: r.get(1)?, name: r.get(2)?, change: r.get(3)?, balance_after: r.get(4)?, reason: r.get(5)?, note: r.get(6)?, user_name: r.get(7)?, created_at: r.get(8)? }))
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

/// What the till needs about stock for the menu it is showing. `branch_id` None = no stock figures.
pub fn attach_flags(conn: &Connection, tenant_id: &str, branch_id: Option<&str>, rows: &mut [crate::repo::MenuItemRow]) -> Result<(), String> {
    if let Some(branch) = branch_id {
        let mut stmt = conn
            .prepare("SELECT ps.menu_item_id, ps.quantity, ps.min_quantity FROM product_stock ps JOIN menu_items mi ON mi.id = ps.menu_item_id WHERE ps.branch_id = ?1 AND mi.track_stock = 1")
            .map_err(db_err)?;
        let found: Vec<(String, f64, f64)> = stmt.query_map(params![branch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        for (id, q, m) in found {
            if let Some(row) = rows.iter_mut().find(|r| r.id == id) {
                row.stock_quantity = Some(q);
                row.stock_min = Some(m);
            }
        }
    }
    let mut stmt = conn.prepare("SELECT menu_item_id, id, barcode, units FROM product_barcodes WHERE tenant_id = ?1").map_err(db_err)?;
    let extras: Vec<(String, ExtraBarcode)> = stmt
        .query_map(params![tenant_id], |r| Ok((r.get(0)?, ExtraBarcode { id: r.get(1)?, barcode: r.get(2)?, units: r.get(3)? })))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    for (item, bc) in extras {
        if let Some(row) = rows.iter_mut().find(|r| r.id == item) {
            row.extra_barcodes.push(bc);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ImportRow {
    /// The row's number in the file, for error messages.
    pub row: usize,
    pub name: String,
    pub barcode: Option<String>,
    pub price_cents: i64,
    pub cost_cents: Option<i64>,
    pub category: Option<String>,
    /// The quantity on the shelf now (counted). None leaves the stock as it is.
    pub stock: Option<f64>,
    pub min_stock: Option<f64>,
    /// "unit" | "weight"
    pub sold_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportProblem {
    pub row: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ImportSummary {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub problems: Vec<ImportProblem>,
}

pub const MAX_IMPORT_ROWS: usize = 5000;

fn category_id(conn: &Connection, repo: &Repo, tenant_id: &str, name: &str, cache: &mut std::collections::HashMap<String, String>) -> Result<String, String> {
    let key = name.trim().to_lowercase();
    if let Some(id) = cache.get(&key) {
        return Ok(id.clone());
    }
    let found: Option<String> = conn
        .query_row("SELECT id FROM categories WHERE tenant_id = ?1 AND lower(name) = ?2", params![tenant_id, key], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    let id = match found {
        Some(id) => id,
        None => repo.create_category(tenant_id, name.trim(), None, 0, None).map_err(repo_err)?,
    };
    cache.insert(key, id.clone());
    Ok(id)
}

/// Brings products in from rows of a spreadsheet. A product is matched by its barcode (else by its exact
/// name) and updated, otherwise created. Valid rows are imported and invalid ones listed with the reason.
#[allow(clippy::too_many_arguments)]
pub fn import_products(conn: &Connection, tenant_id: &str, branch_id: &str, rows: &[ImportRow], user_id: &str, now: &str) -> Result<ImportSummary, String> {
    if rows.is_empty() {
        return Err("الملف فارغ".into());
    }
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(format!("حتى {MAX_IMPORT_ROWS} صنف في الملف الواحد. قسّم الملف"));
    }
    let repo = Repo::new(conn);
    let mut summary = ImportSummary::default();
    let mut cats = std::collections::HashMap::new();
    let mut seen_barcodes = std::collections::HashSet::new();
    let default_category = category_id(conn, &repo, tenant_id, "عام", &mut cats)?;
    let problem = |s: &mut ImportSummary, row: usize, message: &str| {
        s.problems.push(ImportProblem { row, message: message.to_string() });
        s.skipped += 1;
    };
    for r in rows {
        let name = r.name.trim();
        if name.is_empty() {
            problem(&mut summary, r.row, "اسم الصنف فارغ");
            continue;
        }
        if r.price_cents < 0 {
            problem(&mut summary, r.row, "السعر غير صالح");
            continue;
        }
        let barcode = r.barcode.as_deref().map(str::trim).filter(|b| !b.is_empty());
        if let Some(b) = barcode {
            if b.chars().any(|c| c.is_whitespace()) || b.len() > 64 {
                problem(&mut summary, r.row, "الباركود غير صالح");
                continue;
            }
            if !seen_barcodes.insert(b.to_string()) {
                problem(&mut summary, r.row, "الباركود مكرر في الملف");
                continue;
            }
        }
        let sold_by = match r.sold_by.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("unit") => "unit",
            Some("weight") => "weight",
            Some(_) => {
                problem(&mut summary, r.row, "طريقة البيع: قطعة أو وزن");
                continue;
            }
        };
        if let Some(s) = r.stock {
            if !(s >= 0.0 && s.is_finite()) {
                problem(&mut summary, r.row, "الكمية غير صالحة");
                continue;
            }
        }
        if let Some(m) = r.min_stock {
            if !(m >= 0.0 && m.is_finite()) {
                problem(&mut summary, r.row, "الحد الأدنى غير صالح");
                continue;
            }
        }
        let category = match r.category.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => category_id(conn, &repo, tenant_id, c, &mut cats)?,
            None => default_category.clone(),
        };

        // Which product is this? Barcode first (also an extra barcode), then the exact name.
        let existing: Option<String> = match barcode {
            Some(b) => {
                let by_main: Option<String> = conn.query_row("SELECT id FROM menu_items WHERE tenant_id = ?1 AND barcode = ?2", params![tenant_id, b], |r| r.get(0)).optional().map_err(db_err)?;
                match by_main {
                    Some(id) => Some(id),
                    None => {
                        if barcode_taken(conn, tenant_id, b, None)? {
                            problem(&mut summary, r.row, "الباركود مستخدم كباركود إضافي لصنف آخر");
                            continue;
                        }
                        conn.query_row("SELECT id FROM menu_items WHERE tenant_id = ?1 AND lower(name) = lower(?2) AND (barcode IS NULL OR barcode = '')", params![tenant_id, name], |r| r.get(0)).optional().map_err(db_err)?
                    }
                }
            }
            None => conn.query_row("SELECT id FROM menu_items WHERE tenant_id = ?1 AND lower(name) = lower(?2)", params![tenant_id, name], |r| r.get(0)).optional().map_err(db_err)?,
        };

        let outcome: Result<(String, bool), String> = match &existing {
            Some(id) => {
                let cost = match r.cost_cents {
                    Some(c) => c,
                    None => conn.query_row("SELECT cost_cents FROM menu_items WHERE id = ?1", params![id], |x| x.get(0)).map_err(db_err)?,
                };
                let (keep_barcode, keep_description): (Option<String>, Option<String>) = conn.query_row("SELECT barcode, description FROM menu_items WHERE id = ?1", params![id], |x| Ok((x.get(0)?, x.get(1)?))).map_err(db_err)?;
                repo.update_menu_item(tenant_id, id, name, &category, r.price_cents, cost, keep_description.as_deref(), barcode.or(keep_barcode.as_deref())).map(|_| (id.clone(), false)).map_err(repo_err)
            }
            None => repo.create_menu_item(tenant_id, name, &category, r.price_cents, r.cost_cents.unwrap_or(0), None, barcode).map(|id| (id, true)).map_err(repo_err),
        };
        let (item_id, created) = match outcome {
            Ok(v) => v,
            Err(e) => {
                problem(&mut summary, r.row, &format!("تعذّر الحفظ: {e}"));
                continue;
            }
        };
        if sold_by == "weight" {
            repo.set_menu_item_sold_by(tenant_id, &item_id, "weight").map_err(repo_err)?;
        } else if !created {
            repo.set_menu_item_sold_by(tenant_id, &item_id, "unit").map_err(repo_err)?;
        }
        if r.stock.is_some() || r.min_stock.is_some() {
            let min = r.min_stock.unwrap_or_else(|| conn.query_row("SELECT COALESCE(min_quantity, 0) FROM product_stock WHERE menu_item_id = ?1 AND branch_id = ?2", params![item_id, branch_id], |x| x.get(0)).unwrap_or(0.0));
            set_tracking(conn, tenant_id, branch_id, &item_id, true, min, None, user_id, now)?;
            if let Some(counted) = r.stock {
                let before = quantity_of(conn, branch_id, &item_id)?;
                if (counted - before).abs() > f64::EPSILON {
                    apply_change(conn, tenant_id, branch_id, &item_id, counted - before, if created { "OPENING" } else { "COUNT" }, Some("استيراد من ملف"), None, Some(user_id), now)?;
                }
            }
        }
        if created {
            summary.created += 1;
        } else {
            summary.updated += 1;
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, name TEXT);
             CREATE TABLE categories (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT);
             CREATE TABLE menu_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0, category_id TEXT, barcode TEXT, sold_by TEXT NOT NULL DEFAULT 'unit', is_active INTEGER NOT NULL DEFAULT 1, track_stock INTEGER NOT NULL DEFAULT 0, description TEXT, last_modified TEXT);
             CREATE TABLE orders (id TEXT PRIMARY KEY);
             CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT, menu_item_id TEXT, quantity INTEGER NOT NULL DEFAULT 1, voided INTEGER NOT NULL DEFAULT 0, weight_grams INTEGER);
             CREATE TABLE refund_items (id TEXT PRIMARY KEY, refund_id TEXT, order_item_id TEXT, quantity INTEGER);
             INSERT INTO categories VALUES ('c1', 't1', 'Food');
             INSERT INTO menu_items (id, tenant_id, name, price_cents, cost_cents, category_id, barcode) VALUES ('p1', 't1', 'Biscuits', 500, 300, 'c1', '6001'), ('p2', 't1', 'Cheese', 9000, 6000, 'c1', '6002');
             UPDATE menu_items SET sold_by = 'weight' WHERE id = 'p2';",
        )
        .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    const NOW: &str = "2026-11-04T10:00:00Z";

    #[test]
    fn ean13_check_digits_are_right() {
        // 4006381333931 is a well-known valid EAN-13.
        assert_eq!(ean13_check_digit("400638133393"), Some(1));
        assert!(ean13_ok("4006381333931"));
        assert!(!ean13_ok("4006381333932"));
        assert!(!ean13_ok("123"));
        assert_eq!(ean13_check_digit("12345"), None);
    }

    #[test]
    fn generated_codes_are_valid_unique_and_ours() {
        let conn = db();
        let a = generate_barcode(&conn, "t1").unwrap();
        assert!(ean13_ok(&a) && a.starts_with("29"), "{a}");
        conn.execute("UPDATE menu_items SET barcode = ?1 WHERE id = 'p1'", params![a]).unwrap();
        let b = generate_barcode(&conn, "t1").unwrap();
        assert_ne!(a, b);
        assert!(ean13_ok(&b));
        add_extra_barcode(&conn, "t1", "p2", &b, 1.0).unwrap();
        let c = generate_barcode(&conn, "t1").unwrap();
        assert!(c != a && c != b, "a code used as an extra barcode is not handed out again");
    }

    #[test]
    fn stock_moves_are_logged_with_the_balance_and_a_count_sets_it() {
        let conn = db();
        set_tracking(&conn, "t1", "b1", "p1", true, 5.0, Some(20.0), "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 20.0);
        // an opening quantity is only taken while the shelf is empty on paper
        set_tracking(&conn, "t1", "b1", "p1", true, 5.0, Some(99.0), "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 20.0);
        assert_eq!(apply_change(&conn, "t1", "b1", "p1", -4.0, "ADJUST", Some("تالف"), None, Some("u1"), NOW).unwrap(), 16.0);
        assert_eq!(count(&conn, "t1", "b1", "p1", 15.0, None, "u1", NOW).unwrap(), 15.0);
        let log = list_log(&conn, "t1", "b1", Some("p1"), 10).unwrap();
        assert_eq!(log.iter().map(|l| (l.reason.as_str(), l.change, l.balance_after)).collect::<Vec<_>>(), vec![("COUNT", -1.0, 15.0), ("ADJUST", -4.0, 16.0), ("OPENING", 20.0, 20.0)]);
        assert!(apply_change(&conn, "t1", "b1", "p1", 1.0, "NONSENSE", None, None, None, NOW).is_err());
        // another branch has its own shelf
        assert_eq!(quantity_of(&conn, "b2", "p1").unwrap(), 0.0);
        // the product list shows low stock
        set_tracking(&conn, "t1", "b1", "p1", true, 20.0, None, "u1", NOW).unwrap();
        let low = list_stock(&conn, "t1", "b1", None, true, false, 100).unwrap();
        assert_eq!(low.len(), 1);
        assert!(low[0].low);
        assert_eq!(low[0].value_cents, 15 * 300);
    }

    #[test]
    fn receiving_raises_stock_starts_tracking_and_can_update_the_cost() {
        let conn = db();
        let out = receive(&conn, "t1", "b1", &[ReceiveLine { menu_item_id: "p1".into(), quantity: 24.0, cost_cents: Some(350) }, ReceiveLine { menu_item_id: "p2".into(), quantity: 2.5, cost_cents: None }], Some("فاتورة 17"), "u1", NOW).unwrap();
        assert_eq!((out.lines, out.pieces), (2, 26.5));
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 24.0);
        assert_eq!(quantity_of(&conn, "b1", "p2").unwrap(), 2.5, "kilos for a weighed product");
        let (track, cost): (i64, i64) = conn.query_row("SELECT track_stock, cost_cents FROM menu_items WHERE id = 'p1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((track, cost), (1, 350));
        assert!(receive(&conn, "t1", "b1", &[], None, "u1", NOW).is_err());
        assert!(receive(&conn, "t1", "b1", &[ReceiveLine { menu_item_id: "p1".into(), quantity: 0.0, cost_cents: None }], None, "u1", NOW).is_err());
        assert!(receive(&conn, "t1", "b1", &[ReceiveLine { menu_item_id: "nope".into(), quantity: 1.0, cost_cents: None }], None, "u1", NOW).is_err());
        assert!(receive(&conn, "other", "b1", &[ReceiveLine { menu_item_id: "p1".into(), quantity: 1.0, cost_cents: None }], None, "u1", NOW).is_err(), "another business's product");
    }

    #[test]
    fn a_paid_order_lowers_tracked_stock_only_and_weighed_lines_take_kilos() {
        let conn = db();
        set_tracking(&conn, "t1", "b1", "p1", true, 0.0, Some(10.0), "u1", NOW).unwrap();
        set_tracking(&conn, "t1", "b1", "p2", true, 0.0, Some(5.0), "u1", NOW).unwrap();
        conn.execute_batch(
            "INSERT INTO orders VALUES ('o1');
             INSERT INTO order_items (id, order_id, menu_item_id, quantity, voided, weight_grams) VALUES ('i1', 'o1', 'p1', 3, 0, NULL), ('i2', 'o1', 'p2', 1, 0, 750), ('i3', 'o1', 'p1', 2, 1, NULL);",
        )
        .unwrap();
        deduct_for_order(&conn, "t1", "b1", "o1", "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 7.0, "3 sold, the voided 2 never left");
        assert_eq!(quantity_of(&conn, "b1", "p2").unwrap(), 4.25, "750 g off the kilos");
        // an untracked product is never touched
        conn.execute("UPDATE menu_items SET track_stock = 0 WHERE id = 'p1'", []).unwrap();
        conn.execute_batch("INSERT INTO orders VALUES ('o3'); INSERT INTO order_items (id, order_id, menu_item_id, quantity) VALUES ('i5', 'o3', 'p1', 5);").unwrap();
        deduct_for_order(&conn, "t1", "b1", "o3", "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 7.0);
        // stock may go negative unless the owner chose to block
        conn.execute("UPDATE menu_items SET track_stock = 1 WHERE id = 'p1'", []).unwrap();
        conn.execute_batch("INSERT INTO orders VALUES ('o4'); INSERT INTO order_items (id, order_id, menu_item_id, quantity) VALUES ('i6', 'o4', 'p1', 10);").unwrap();
        deduct_for_order(&conn, "t1", "b1", "o4", "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), -3.0);
        save_settings(&conn, "t1", &RetailSettings { block_sale_when_empty: true, ..Default::default() }).unwrap();
        conn.execute_batch("INSERT INTO orders VALUES ('o5'); INSERT INTO order_items (id, order_id, menu_item_id, quantity) VALUES ('i7', 'o5', 'p1', 1);").unwrap();
        let err = deduct_for_order(&conn, "t1", "b1", "o5", "u1", NOW).unwrap_err();
        assert!(err.contains("Biscuits"), "{err}");
    }

    #[test]
    fn a_return_puts_the_goods_back() {
        let conn = db();
        set_tracking(&conn, "t1", "b1", "p1", true, 0.0, Some(10.0), "u1", NOW).unwrap();
        conn.execute_batch(
            "INSERT INTO orders VALUES ('o1');
             INSERT INTO order_items (id, order_id, menu_item_id, quantity) VALUES ('i1', 'o1', 'p1', 4);
             INSERT INTO refund_items VALUES ('ri1', 'r1', 'i1', 2);",
        )
        .unwrap();
        deduct_for_order(&conn, "t1", "b1", "o1", "u1", NOW).unwrap();
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 6.0);
        assert_eq!(restock_for_refund(&conn, "t1", "b1", "r1", "u1", NOW).unwrap(), 1);
        assert_eq!(quantity_of(&conn, "b1", "p1").unwrap(), 8.0, "2 of the 4 came back");
    }

    #[test]
    fn extra_barcodes_cannot_clash_with_any_other_product() {
        let conn = db();
        add_extra_barcode(&conn, "t1", "p1", "CARTON-12", 12.0).unwrap();
        assert!(add_extra_barcode(&conn, "t1", "p2", "CARTON-12", 1.0).is_err(), "already another product's extra");
        assert!(add_extra_barcode(&conn, "t1", "p2", "6001", 1.0).is_err(), "already another product's main barcode");
        assert!(add_extra_barcode(&conn, "t1", "p1", "6001", 1.0).is_ok(), "a product's own main barcode is not a clash with itself");
        assert!(add_extra_barcode(&conn, "t1", "p1", "with space", 1.0).is_err());
        assert!(add_extra_barcode(&conn, "t1", "p1", "X", 0.0).is_err());
        assert!(add_extra_barcode(&conn, "t1", "p1", "Y", 2.5).is_err(), "whole pieces only");
        let list = list_extra_barcodes(&conn, "t1", "p1").unwrap();
        assert_eq!(list.iter().find(|b| b.barcode == "CARTON-12").unwrap().units, 12.0);
        delete_extra_barcode(&conn, "t1", &list[0].id).unwrap();
        assert!(delete_extra_barcode(&conn, "t1", "nope").is_err());
    }

    #[test]
    fn scale_settings_are_validated() {
        let ok = RetailSettings { scale_prefix: "2".into(), ..Default::default() };
        assert!(ok.validate().is_ok());
        assert!(RetailSettings { scale_prefix: "2".into(), scale_plu_digits: 6, scale_value_digits: 6, ..Default::default() }.validate().is_err(), "too many digits");
        assert!(RetailSettings { scale_prefix: "x".into(), ..Default::default() }.validate().is_err());
        assert!(RetailSettings { scale_value_kind: "KG".into(), ..Default::default() }.validate().is_err());
        assert!(RetailSettings::default().validate().is_ok(), "scale barcodes off by default");
        let conn = db();
        save_settings(&conn, "t1", &ok).unwrap();
        assert_eq!(load_settings(&conn, "t1").unwrap(), ok);
        assert_eq!(load_settings(&conn, "other").unwrap(), RetailSettings::default());
    }
}
