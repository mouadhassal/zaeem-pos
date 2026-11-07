//! A supplier that sells through both the WENZDES Marketplace and its own POS: the two stocks follow each other.
//!
//! * **Marketplace -> POS.** A buyer orders on the marketplace; once the supplier accepts it, the order's
//!   products leave the POS stock (`apply_order`). Each marketplace product is *linked* to one POS product
//!   (`supplier_product_link`); an order line with no link is shown to the owner and takes nothing out.
//!   Applying is idempotent per order (`supplier_order_local`) and then acknowledged to the cloud
//!   (`pos_mark_supplier_order_applied`), retried until the cloud answers.
//! * **POS -> marketplace.** What the POS counts for each linked product is published as the marketplace
//!   stock (`pos_push_supplier_stock`), so a sale at the counter stops the marketplace selling what is gone.
//!
//! The SQL half is `supabase/migrations/ecosystem_supplier_pos_link.sql`. Only terminals with a cloud
//! `device_token` use this.

use crate::stockroom;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS supplier_product_link (
    tenant_id TEXT NOT NULL,
    supplier_product_id TEXT NOT NULL,
    menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
    PRIMARY KEY (tenant_id, supplier_product_id)
);
CREATE TABLE IF NOT EXISTS supplier_order_local (
    order_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    applied_by TEXT,
    lines_json TEXT NOT NULL,
    note TEXT,
    applied_at TEXT NOT NULL,
    cloud_status TEXT NOT NULL DEFAULT 'PENDING',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_supplier_order_local_status ON supplier_order_local (cloud_status, next_attempt_at);
";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SupplierProduct {
    pub supplier_product_id: String,
    pub name: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub price_cents: i64,
    #[serde(default)]
    pub stock_qty: i64,
    #[serde(default = "yes")]
    pub is_active: bool,
    /// Filled locally: the POS product linked to it.
    #[serde(default)]
    pub linked_menu_item_id: Option<String>,
    #[serde(default)]
    pub linked_name: Option<String>,
    /// Filled locally for an unlinked product: the POS product whose name matches best.
    #[serde(default)]
    pub suggested_menu_item_id: Option<String>,
    #[serde(default)]
    pub suggested_name: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SupplierOrderItem {
    pub order_item_id: String,
    #[serde(default)]
    pub supplier_product_id: Option<String>,
    pub product_name: String,
    #[serde(default)]
    pub unit: Option<String>,
    pub qty: f64,
    #[serde(default)]
    pub unit_price_cents: i64,
    #[serde(default)]
    pub line_total_cents: i64,
    #[serde(default)]
    pub linked_menu_item_id: Option<String>,
    #[serde(default)]
    pub linked_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SupplierOrder {
    pub order_id: String,
    #[serde(default)]
    pub buyer_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub placed_at: Option<String>,
    #[serde(default)]
    pub total_cents: i64,
    #[serde(default)]
    pub delivery_address: Option<String>,
    #[serde(default)]
    pub items: Vec<SupplierOrderItem>,
}

/// What the cloud lists for a supplier (`pos_list_supplier_orders`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SupplierOrdersResponse {
    #[serde(default)]
    pub supplier: bool,
    #[serde(default)]
    pub orders: Vec<SupplierOrder>,
}

/// What the cloud lists for a supplier (`pos_list_supplier_products`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SupplierProductsResponse {
    #[serde(default)]
    pub supplier: bool,
    #[serde(default)]
    pub products: Vec<SupplierProduct>,
}

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Names compared loosely: case, spaces, the Arabic "ال", hamza and ta marbuta do not matter.
pub fn normalize_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        let c = match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => 'ا',
            'ى' => 'ي',
            'ة' => 'ه',
            '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0640}' => continue,
            c if c.is_whitespace() => ' ',
            c => c.to_lowercase().next().unwrap_or(c),
        };
        out.push(c);
    }
    let words: Vec<String> = out.split_whitespace().map(|w| if w.chars().count() > 3 { w.strip_prefix("ال").unwrap_or(w).to_string() } else { w.to_string() }).collect();
    words.join(" ")
}

/// The POS product whose name is the same as (or contains, or is contained in) a marketplace product name.
pub fn suggest_match(conn: &Connection, tenant_id: &str, product_name: &str) -> Result<Option<(String, String)>, String> {
    let wanted = normalize_name(product_name);
    if wanted.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT id, name FROM menu_items WHERE tenant_id = ?1 AND is_active = 1").map_err(db_err)?;
    let rows: Vec<(String, String)> = stmt.query_map(params![tenant_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(db_err)?.collect::<Result<_, _>>().map_err(db_err)?;
    let mut best: Option<(u8, usize, String, String)> = None;
    for (id, name) in rows {
        let n = normalize_name(&name);
        if n.is_empty() {
            continue;
        }
        let rank = if n == wanted { 3 } else if wanted.contains(&n) || n.contains(&wanted) { 2 } else { continue };
        let closeness = n.chars().count().abs_diff(wanted.chars().count());
        if best.as_ref().map_or(true, |(r, c, _, _)| rank > *r || (rank == *r && closeness < *c)) {
            best = Some((rank, closeness, id, name));
        }
    }
    Ok(best.map(|(_, _, id, name)| (id, name)))
}

pub fn links(conn: &Connection, tenant_id: &str) -> Result<HashMap<String, (String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT l.supplier_product_id, l.menu_item_id, m.name FROM supplier_product_link l JOIN menu_items m ON m.id = l.menu_item_id WHERE l.tenant_id = ?1")
        .map_err(db_err)?;
    let rows = stmt.query_map(params![tenant_id], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?)))).map_err(db_err)?;
    rows.collect::<Result<HashMap<_, _>, _>>().map_err(db_err)
}

/// Links a marketplace product to a POS product (or removes the link with `None`). A linked product
/// starts tracking its stock: the stock is what the marketplace will show.
pub fn set_link(conn: &Connection, tenant_id: &str, supplier_product_id: &str, menu_item_id: Option<&str>) -> Result<(), String> {
    match menu_item_id {
        None => {
            conn.execute("DELETE FROM supplier_product_link WHERE tenant_id = ?1 AND supplier_product_id = ?2", params![tenant_id, supplier_product_id]).map_err(db_err)?;
        }
        Some(item) => {
            let exists: bool = conn
                .query_row("SELECT COUNT(*) > 0 FROM menu_items WHERE id = ?1 AND tenant_id = ?2", params![item, tenant_id], |r| r.get(0))
                .map_err(db_err)?;
            if !exists {
                return Err("المنتج غير موجود".into());
            }
            // One POS product feeds one marketplace product, so the stock cannot be counted twice.
            let taken: Option<String> = conn
                .query_row("SELECT supplier_product_id FROM supplier_product_link WHERE tenant_id = ?1 AND menu_item_id = ?2 AND supplier_product_id <> ?3", params![tenant_id, item, supplier_product_id], |r| r.get(0))
                .optional()
                .map_err(db_err)?;
            if taken.is_some() {
                return Err("هذا المنتج مربوط بمنتج آخر في السوق".into());
            }
            conn.execute(
                "INSERT INTO supplier_product_link (tenant_id, supplier_product_id, menu_item_id) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(tenant_id, supplier_product_id) DO UPDATE SET menu_item_id = ?3",
                params![tenant_id, supplier_product_id, item],
            )
            .map_err(db_err)?;
            conn.execute("UPDATE menu_items SET track_stock = 1 WHERE id = ?1", params![item]).map_err(db_err)?;
        }
    }
    Ok(())
}

/// Fills the local link (and a suggestion for an unlinked one) onto the cloud's product list.
pub fn decorate_products(conn: &Connection, tenant_id: &str, products: Vec<SupplierProduct>) -> Result<Vec<SupplierProduct>, String> {
    let linked = links(conn, tenant_id)?;
    let mut out = Vec::with_capacity(products.len());
    for mut p in products {
        if let Some((id, name)) = linked.get(&p.supplier_product_id) {
            p.linked_menu_item_id = Some(id.clone());
            p.linked_name = Some(name.clone());
        } else if let Some((id, name)) = suggest_match(conn, tenant_id, &p.name)? {
            p.suggested_menu_item_id = Some(id);
            p.suggested_name = Some(name);
        }
        out.push(p);
    }
    Ok(out)
}

/// Drops orders already applied here and shows, per line, which POS product it will leave.
pub fn decorate_orders(conn: &Connection, tenant_id: &str, orders: Vec<SupplierOrder>) -> Result<Vec<SupplierOrder>, String> {
    let linked = links(conn, tenant_id)?;
    let mut kept = Vec::with_capacity(orders.len());
    for mut order in orders {
        if is_applied_locally(conn, &order.order_id)? {
            continue;
        }
        for item in &mut order.items {
            if let Some((id, name)) = item.supplier_product_id.as_ref().and_then(|p| linked.get(p)) {
                item.linked_menu_item_id = Some(id.clone());
                item.linked_name = Some(name.clone());
            }
        }
        kept.push(order);
    }
    Ok(kept)
}

pub fn is_applied_locally(conn: &Connection, order_id: &str) -> Result<bool, String> {
    conn.query_row("SELECT COUNT(*) > 0 FROM supplier_order_local WHERE order_id = ?1", params![order_id], |r| r.get(0)).map_err(db_err)
}

/// One line of an applied order, sent to the cloud as `p_lines`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppliedLine {
    pub order_item_id: String,
    pub menu_item_id: Option<String>,
    pub qty: f64,
    pub applied: bool,
}

#[derive(Debug, PartialEq)]
pub enum ApplyOutcome {
    Applied { lines: Vec<AppliedLine>, unlinked: usize },
    AlreadyApplied,
}

/// Takes the order's linked products out of the POS stock, in the caller's transaction, and queues the
/// acknowledgement. Idempotent per order. Lines without a link are recorded as not applied.
#[allow(clippy::too_many_arguments)]
pub fn apply_order(conn: &Connection, tenant_id: &str, branch_id: &str, actor_id: &str, order: &SupplierOrder, note: Option<&str>, now: &str) -> Result<ApplyOutcome, String> {
    if is_applied_locally(conn, &order.order_id)? {
        return Ok(ApplyOutcome::AlreadyApplied);
    }
    let linked = links(conn, tenant_id)?;
    let reason_note = format!("طلبية السوق #{}", order.order_id.chars().take(8).collect::<String>());
    let mut lines = Vec::with_capacity(order.items.len());
    let mut unlinked = 0;
    for item in &order.items {
        if !(item.qty.is_finite() && item.qty >= 0.0) {
            return Err("كمية غير صالحة في الطلبية".into());
        }
        let target = item.supplier_product_id.as_ref().and_then(|p| linked.get(p)).map(|(id, _)| id.clone());
        match target {
            Some(menu_item_id) if item.qty > 0.0 => {
                stockroom::apply_change(conn, tenant_id, branch_id, &menu_item_id, -item.qty, "MARKET_SALE", Some(&reason_note), None, Some(actor_id), now)?;
                lines.push(AppliedLine { order_item_id: item.order_item_id.clone(), menu_item_id: Some(menu_item_id), qty: item.qty, applied: true });
            }
            other => {
                unlinked += 1;
                lines.push(AppliedLine { order_item_id: item.order_item_id.clone(), menu_item_id: other, qty: item.qty, applied: false });
            }
        }
    }
    let lines_json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO supplier_order_local (order_id, tenant_id, branch_id, applied_by, lines_json, note, applied_at, cloud_status, attempt_count) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', 0)",
        params![order.order_id, tenant_id, branch_id, actor_id, lines_json, note, now],
    )
    .map_err(db_err)?;
    Ok(ApplyOutcome::Applied { lines, unlinked })
}

/// An order whose every line has a link can be taken out of the stock without asking anyone.
pub fn fully_linked(order: &SupplierOrder) -> bool {
    !order.items.is_empty() && order.items.iter().all(|i| i.linked_menu_item_id.is_some())
}

/// The stock of each linked product, as the marketplace should show it (never negative, whole units).
pub fn stock_to_publish(conn: &Connection, tenant_id: &str, branch_id: &str) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.supplier_product_id, COALESCE(ps.quantity, 0) FROM supplier_product_link l \
             LEFT JOIN product_stock ps ON ps.menu_item_id = l.menu_item_id AND ps.branch_id = ?2 WHERE l.tenant_id = ?1 ORDER BY l.supplier_product_id",
        )
        .map_err(db_err)?;
    let rows = stmt.query_map(params![tenant_id, branch_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))).map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, q) = row.map_err(db_err)?;
        out.push((id, q.max(0.0).floor() as i64));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The acknowledgement queue and the network
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum MarkOutcome {
    Sent,
    Retry,
    Rejected(String),
}

const PERMANENT_ERRORS: [&str; 4] = ["order_not_found", "order_not_confirmed", "invalid_lines", "not_a_supplier"];

pub fn classify_mark_response(status: u16, body: &str) -> MarkOutcome {
    if (200..300).contains(&status) {
        let ok = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("ok").and_then(|o| o.as_bool())).unwrap_or(false);
        return if ok { MarkOutcome::Sent } else { MarkOutcome::Retry };
    }
    if let Some(code) = PERMANENT_ERRORS.iter().find(|c| body.contains(**c)) {
        return MarkOutcome::Rejected((*code).to_string());
    }
    MarkOutcome::Retry
}

#[derive(Debug, Clone)]
pub struct QueuedApply {
    pub order_id: String,
    pub lines_json: String,
    pub note: Option<String>,
    pub attempt_count: i64,
}

pub fn due_acks(conn: &Connection, limit: i64) -> Result<Vec<QueuedApply>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT order_id, lines_json, note, attempt_count FROM supplier_order_local \
         WHERE cloud_status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) ORDER BY applied_at ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![chrono::Utc::now().to_rfc3339(), limit], |r| {
        Ok(QueuedApply { order_id: r.get(0)?, lines_json: r.get(1)?, note: r.get(2)?, attempt_count: r.get(3)? })
    })?;
    rows.collect()
}

pub fn record_ack_outcome(conn: &Connection, order_id: &str, attempt_count: i64, outcome: &MarkOutcome) -> Result<(), rusqlite::Error> {
    match outcome {
        MarkOutcome::Sent => {
            conn.execute("UPDATE supplier_order_local SET cloud_status = 'SENT', last_error = NULL WHERE order_id = ?1", params![order_id])?;
        }
        MarkOutcome::Rejected(code) => {
            conn.execute("UPDATE supplier_order_local SET cloud_status = 'REJECTED', last_error = ?1 WHERE order_id = ?2", params![code, order_id])?;
        }
        MarkOutcome::Retry => {
            let delay = crate::sync::with_jitter(crate::sync::backoff_base(attempt_count));
            let next = chrono::Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
            conn.execute("UPDATE supplier_order_local SET attempt_count = ?1, next_attempt_at = ?2 WHERE order_id = ?3", params![attempt_count, next.to_rfc3339(), order_id])?;
        }
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

async fn rpc(name: &str, body: serde_json::Value) -> Result<(u16, String), String> {
    use crate::license::cloud::{supabase_anon_key, supabase_url};
    let anon = supabase_anon_key();
    let resp = http_client()?
        .post(format!("{}/rest/v1/rpc/{name}", supabase_url()))
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {anon}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

pub async fn fetch_orders(device_token: &str, limit: i64) -> Result<SupplierOrdersResponse, String> {
    let (status, text) = rpc("pos_list_supplier_orders", serde_json::json!({ "p_device_token": device_token, "p_limit": limit })).await?;
    if !(200..300).contains(&status) {
        return Err(format!("pos_list_supplier_orders returned {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad supplier-orders payload: {e}"))
}

pub async fn fetch_products(device_token: &str) -> Result<SupplierProductsResponse, String> {
    let (status, text) = rpc("pos_list_supplier_products", serde_json::json!({ "p_device_token": device_token })).await?;
    if !(200..300).contains(&status) {
        return Err(format!("pos_list_supplier_products returned {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad supplier-products payload: {e}"))
}

pub async fn push_stock(device_token: &str, items: &[(String, i64)]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let payload: Vec<serde_json::Value> = items.iter().map(|(id, q)| serde_json::json!({ "supplier_product_id": id, "qty": q })).collect();
    let (status, text) = rpc("pos_push_supplier_stock", serde_json::json!({ "p_device_token": device_token, "p_items": payload })).await?;
    if !(200..300).contains(&status) {
        return Err(format!("pos_push_supplier_stock returned {status}: {text}"));
    }
    Ok(())
}

/// Drains the acknowledgement queue. Never holds the DB lock across a network call.
pub async fn run_ack_tick(db: &std::sync::Mutex<Connection>, device_token: &str) -> Result<usize, rusqlite::Error> {
    let due = {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        due_acks(&conn, 20)?
    };
    let mut sent = 0;
    for q in due {
        let lines: serde_json::Value = serde_json::from_str(&q.lines_json).unwrap_or(serde_json::Value::Null);
        let body = serde_json::json!({ "p_device_token": device_token, "p_order_id": q.order_id, "p_lines": lines, "p_note": q.note });
        let outcome = match rpc("pos_mark_supplier_order_applied", body).await {
            Ok((status, text)) => classify_mark_response(status, &text),
            Err(_) => MarkOutcome::Retry,
        };
        if outcome == MarkOutcome::Sent {
            sent += 1;
        }
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        record_ack_outcome(&conn, &q.order_id, q.attempt_count + 1, &outcome)?;
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-05T10:00:00Z";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE menu_items (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, is_active INTEGER DEFAULT 1, track_stock INTEGER DEFAULT 0, cost_cents INTEGER DEFAULT 0, barcode TEXT, category_id TEXT, price_cents INTEGER DEFAULT 0, sold_by TEXT DEFAULT 'unit', last_modified TEXT);
             INSERT INTO menu_items (id, tenant_id, name) VALUES ('p1', 't1', 'طحين أبيض'), ('p2', 't1', 'سكر'), ('p3', 't1', 'زيت');",
        )
        .unwrap();
        conn.execute_batch(stockroom::SCHEMA_SQL).unwrap_or(());
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    fn order(id: &str, items: Vec<(&str, Option<&str>, f64)>) -> SupplierOrder {
        SupplierOrder {
            order_id: id.into(), buyer_name: Some("مطعم".into()), status: Some("confirmed".into()), placed_at: None, total_cents: 0, delivery_address: None,
            items: items.into_iter().enumerate().map(|(i, (name, sp, qty))| SupplierOrderItem {
                order_item_id: format!("oi{i}"), supplier_product_id: sp.map(str::to_string), product_name: name.into(), unit: None, qty,
                unit_price_cents: 0, line_total_cents: 0, linked_menu_item_id: None, linked_name: None,
            }).collect(),
        }
    }

    #[test]
    fn names_match_loosely_and_prefer_the_closest() {
        let conn = db();
        assert_eq!(suggest_match(&conn, "t1", "الطحين الأبيض").unwrap().map(|m| m.0), Some("p1".into()), "ال and spacing do not matter");
        assert_eq!(suggest_match(&conn, "t1", "سكر ناعم 50 كغ").unwrap().map(|m| m.0), Some("p2".into()), "a longer marketplace name that contains ours");
        assert_eq!(suggest_match(&conn, "t1", "شاي").unwrap(), None);
        assert_eq!(suggest_match(&conn, "t2", "سكر").unwrap(), None, "another shop's products are never offered");
    }

    #[test]
    fn a_product_links_to_one_marketplace_product_only() {
        let conn = db();
        set_link(&conn, "t1", "sp-flour", Some("p1")).unwrap();
        assert!(set_link(&conn, "t1", "sp-other", Some("p1")).is_err(), "the same POS product cannot feed two marketplace products");
        assert!(set_link(&conn, "t1", "sp-x", Some("nope")).is_err());
        set_link(&conn, "t1", "sp-flour", Some("p2")).unwrap();
        assert_eq!(links(&conn, "t1").unwrap().get("sp-flour").map(|l| l.0.clone()), Some("p2".into()), "re-linking moves it");
        set_link(&conn, "t1", "sp-flour", None).unwrap();
        assert!(links(&conn, "t1").unwrap().is_empty());
        let tracked: i64 = conn.query_row("SELECT track_stock FROM menu_items WHERE id = 'p2'", [], |r| r.get(0)).unwrap();
        assert_eq!(tracked, 1, "linking starts tracking its stock");
    }

    #[test]
    fn applying_an_order_lowers_linked_stock_once_and_skips_unlinked_lines() {
        let conn = db();
        set_link(&conn, "t1", "sp-flour", Some("p1")).unwrap();
        stockroom::apply_change(&conn, "t1", "b1", "p1", 100.0, "RECEIVE", None, None, Some("u1"), NOW).unwrap();
        let o = order("order-1", vec![("طحين", Some("sp-flour"), 30.0), ("ملح", Some("sp-salt"), 5.0)]);
        let out = apply_order(&conn, "t1", "b1", "u1", &o, None, NOW).unwrap();
        match out {
            ApplyOutcome::Applied { unlinked, lines } => {
                assert_eq!(unlinked, 1);
                assert!(lines[0].applied && !lines[1].applied);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(stockroom::quantity_of(&conn, "b1", "p1").unwrap(), 70.0);
        assert_eq!(apply_order(&conn, "t1", "b1", "u1", &o, None, NOW).unwrap(), ApplyOutcome::AlreadyApplied);
        assert_eq!(stockroom::quantity_of(&conn, "b1", "p1").unwrap(), 70.0, "applying twice takes nothing more");
        let log: i64 = conn.query_row("SELECT COUNT(*) FROM product_stock_log WHERE reason = 'MARKET_SALE'", [], |r| r.get(0)).unwrap();
        assert_eq!(log, 1);
    }

    #[test]
    fn decorating_hides_applied_orders_and_marks_links() {
        let conn = db();
        set_link(&conn, "t1", "sp-flour", Some("p1")).unwrap();
        let o1 = order("order-1", vec![("طحين", Some("sp-flour"), 1.0)]);
        let o2 = order("order-2", vec![("طحين", Some("sp-flour"), 1.0), ("ملح", Some("sp-salt"), 1.0)]);
        apply_order(&conn, "t1", "b1", "u1", &o1, None, NOW).unwrap();
        let shown = decorate_orders(&conn, "t1", vec![o1, o2]).unwrap();
        assert_eq!(shown.len(), 1);
        assert!(!fully_linked(&shown[0]), "one line has no link");
        assert_eq!(shown[0].items[0].linked_name.as_deref(), Some("طحين أبيض"));
    }

    #[test]
    fn the_published_stock_is_whole_and_never_negative() {
        let conn = db();
        set_link(&conn, "t1", "sp-flour", Some("p1")).unwrap();
        set_link(&conn, "t1", "sp-sugar", Some("p2")).unwrap();
        stockroom::apply_change(&conn, "t1", "b1", "p1", 12.7, "RECEIVE", None, None, Some("u1"), NOW).unwrap();
        stockroom::apply_change(&conn, "t1", "b1", "p2", -3.0, "ADJUST", None, None, Some("u1"), NOW).unwrap();
        let out = stock_to_publish(&conn, "t1", "b1").unwrap();
        assert_eq!(out, vec![("sp-flour".to_string(), 12), ("sp-sugar".to_string(), 0)]);
    }

    #[test]
    fn the_acknowledgement_queue_retries_and_stops_on_a_permanent_no() {
        let conn = db();
        let o = order("order-1", vec![("سكر", None, 1.0)]);
        apply_order(&conn, "t1", "b1", "u1", &o, None, NOW).unwrap();
        assert_eq!(due_acks(&conn, 10).unwrap().len(), 1);
        record_ack_outcome(&conn, "order-1", 1, &MarkOutcome::Retry).unwrap();
        assert!(due_acks(&conn, 10).unwrap().is_empty(), "backing off");
        assert_eq!(classify_mark_response(200, r#"{"ok":true}"#), MarkOutcome::Sent);
        assert_eq!(classify_mark_response(400, "order_not_confirmed"), MarkOutcome::Rejected("order_not_confirmed".into()));
        assert_eq!(classify_mark_response(503, "down"), MarkOutcome::Retry);
        record_ack_outcome(&conn, "order-1", 2, &MarkOutcome::Sent).unwrap();
        let st: String = conn.query_row("SELECT cloud_status FROM supplier_order_local WHERE order_id = 'order-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(st, "SENT");
    }
}
