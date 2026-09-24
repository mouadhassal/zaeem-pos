//! Marketplace goods received (ECOSYSTEM_CONTRACTS.md §6). Pulls delivered
//! marketplace orders via `pos_list_pending_receipts`, applies received stock
//! locally, and queues `pos_mark_order_received` in `marketplace_receipt_local`
//! (its own small outbox: one row per order, retried until the cloud says ok).
//! Only terminals with a cloud `device_token` use this.

use crate::repo::Repo;
use crate::security::Scope;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingItem {
    pub order_item_id: String,
    #[serde(default)]
    pub supplier_product_id: Option<String>,
    pub product_name: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub unit_size: Option<f64>,
    #[serde(default)]
    pub unit_measure: Option<String>,
    pub qty: f64,
    #[serde(default)]
    pub unit_price_cents: i64,
    #[serde(default)]
    pub line_total_cents: i64,
    #[serde(default)]
    pub suggested_local_ingredient_id: Option<String>,
    #[serde(default)]
    pub suggested_ingredient_name: Option<String>,
    #[serde(default)]
    pub suggested_ingredient_unit: Option<String>,
    #[serde(default)]
    pub suggested_match_score: Option<f64>,
    /// Filled locally: packages converted to the suggested ingredient's unit.
    #[serde(default)]
    pub suggested_stock_added: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingOrder {
    pub order_id: String,
    #[serde(default)]
    pub supplier_id: Option<String>,
    #[serde(default)]
    pub supplier_name: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<String>,
    #[serde(default)]
    pub total_cents: i64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub items: Vec<PendingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingReceipts {
    #[serde(default)]
    pub tenant_id: Option<String>,
    #[serde(default)]
    pub branch_id: Option<String>,
    #[serde(default)]
    pub orders: Vec<PendingOrder>,
}

/// One confirmed line, sent as-is in `p_lines`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReceiptLine {
    pub order_item_id: String,
    pub received_qty: f64,
    pub local_ingredient_id: Option<String>,
    pub stock_added: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dim {
    Mass,
    Volume,
    Count,
}

/// Unit -> (dimension, factor to base unit g/ml/piece). Arabic names included.
fn unit_info(unit: &str) -> Option<(Dim, f64)> {
    let u = unit.trim().to_lowercase();
    let u = u.trim_end_matches('.');
    match u {
        "kg" | "كغ" | "كجم" | "كيلو" | "كيلوغرام" | "كيلوجرام" | "كلغ" => Some((Dim::Mass, 1000.0)),
        "g" | "gr" | "غ" | "غرام" | "جرام" | "جم" | "غم" => Some((Dim::Mass, 1.0)),
        "l" | "lt" | "ل" | "لتر" | "ليتر" => Some((Dim::Volume, 1000.0)),
        "ml" | "مل" | "ملل" | "ميلي" | "مليلتر" => Some((Dim::Volume, 1.0)),
        "piece" | "pcs" | "pc" | "unit" | "قطعة" | "حبة" | "قطع" | "وحدة" => Some((Dim::Count, 1.0)),
        _ => None,
    }
}

/// Packages -> ingredient unit (`qty x unit_size`, kg<->g / l<->ml x1000).
/// `None` when the units don't share a dimension.
pub fn convert_packages(qty: f64, unit_size: Option<f64>, unit_measure: Option<&str>, ingredient_unit: &str) -> Option<f64> {
    let size = unit_size?;
    let (from_dim, from_factor) = unit_info(unit_measure?)?;
    let (to_dim, to_factor) = unit_info(ingredient_unit)?;
    if from_dim != to_dim || !(qty.is_finite() && size.is_finite()) {
        return None;
    }
    let v = qty * size * from_factor / to_factor;
    Some((v * 1000.0).round() / 1000.0)
}

/// Stock to add for an item: converted amount, else the package count.
pub fn suggested_stock(item: &PendingItem, ingredient_unit: Option<&str>) -> f64 {
    ingredient_unit
        .and_then(|u| convert_packages(item.qty, item.unit_size, item.unit_measure.as_deref(), u))
        .unwrap_or(item.qty)
}

/// Drops orders already received on this terminal (awaiting cloud ack) and
/// fills `suggested_stock_added` from the local ingredient units.
pub fn prepare_pending(conn: &Connection, mut resp: PendingReceipts) -> Result<PendingReceipts, rusqlite::Error> {
    let mut kept = Vec::with_capacity(resp.orders.len());
    for mut order in resp.orders {
        if is_received_locally(conn, &order.order_id)? {
            continue;
        }
        for item in &mut order.items {
            let unit: Option<String> = match item.suggested_local_ingredient_id.as_deref() {
                Some(id) => conn.query_row("SELECT unit FROM ingredients WHERE id = ?1", params![id], |r| r.get(0)).optional()?,
                None => None,
            };
            let unit = unit.or_else(|| item.suggested_ingredient_unit.clone());
            item.suggested_stock_added = Some(suggested_stock(item, unit.as_deref()));
        }
        kept.push(order);
    }
    resp.orders = kept;
    Ok(resp)
}

pub fn is_received_locally(conn: &Connection, order_id: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row("SELECT COUNT(*) > 0 FROM marketplace_receipt_local WHERE order_id = ?1", params![order_id], |r| r.get(0))
}

#[derive(Debug, PartialEq)]
pub enum ApplyOutcome {
    /// Stock added; ids of ingredients touched.
    Applied(Vec<String>),
    /// This order was already received here -- nothing changed.
    AlreadyReceived,
}

/// Adds stock and records the receipt in the caller's transaction.
/// Idempotent per `order_id`.
#[allow(clippy::too_many_arguments)]
pub fn apply_receipt(
    conn: &Connection,
    scope: &Scope,
    tenant_id: &str,
    branch_id: &str,
    actor_id: &str,
    order_id: &str,
    lines: &[ReceiptLine],
    note: Option<&str>,
) -> Result<ApplyOutcome, String> {
    if is_received_locally(conn, order_id).map_err(|e| e.to_string())? {
        return Ok(ApplyOutcome::AlreadyReceived);
    }
    if lines.iter().any(|l| !l.received_qty.is_finite() || l.received_qty < 0.0 || l.stock_added.is_some_and(|s| !s.is_finite() || s < 0.0)) {
        return Err("الكميات المستلمة يجب أن تكون أرقاماً غير سالبة".to_string());
    }
    let repo = Repo::new(conn);
    let reason = format!("استلام طلبية السوق #{}", order_id.chars().take(8).collect::<String>());
    let mut touched = Vec::new();
    for line in lines {
        let (Some(ingredient_id), Some(added)) = (line.local_ingredient_id.as_deref(), line.stock_added) else { continue };
        if added <= 0.0 {
            continue;
        }
        repo.adjust_stock(scope, tenant_id, branch_id, ingredient_id, added, &reason, actor_id).map_err(|e| e.to_string())?;
        if !touched.iter().any(|t: &String| t == ingredient_id) {
            touched.push(ingredient_id.to_string());
        }
    }
    let lines_json = serde_json::to_string(lines).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO marketplace_receipt_local (order_id, tenant_id, branch_id, received_by, lines_json, note, received_at, cloud_status, attempt_count) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', 0)",
        params![order_id, tenant_id, branch_id, actor_id, lines_json, note, chrono::Utc::now().to_rfc3339()],
    ).map_err(|e| e.to_string())?;
    Ok(ApplyOutcome::Applied(touched))
}

#[derive(Debug, PartialEq)]
pub enum MarkOutcome {
    Sent,
    Retry,
    /// Permanent cloud rejection (e.g. order_not_delivered) -- stop retrying.
    Rejected(String),
}

const PERMANENT_ERRORS: [&str; 3] = ["order_not_found", "order_not_delivered", "invalid_lines"];

/// Maps a `pos_mark_order_received` HTTP result to what the queue does next.
pub fn classify_mark_response(status: u16, body: &str) -> MarkOutcome {
    if (200..300).contains(&status) {
        let ok = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("ok").and_then(|o| o.as_bool()))
            .unwrap_or(false);
        return if ok { MarkOutcome::Sent } else { MarkOutcome::Retry };
    }
    if let Some(code) = PERMANENT_ERRORS.iter().find(|c| body.contains(**c)) {
        return MarkOutcome::Rejected((*code).to_string());
    }
    MarkOutcome::Retry
}

#[derive(Debug, Clone)]
pub struct QueuedReceipt {
    pub order_id: String,
    pub lines_json: String,
    pub note: Option<String>,
    pub attempt_count: i64,
}

pub fn due_receipts(conn: &Connection, limit: i64) -> Result<Vec<QueuedReceipt>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT order_id, lines_json, note, attempt_count FROM marketplace_receipt_local \
         WHERE cloud_status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1) \
         ORDER BY received_at ASC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![chrono::Utc::now().to_rfc3339(), limit], |r| {
        Ok(QueuedReceipt { order_id: r.get(0)?, lines_json: r.get(1)?, note: r.get(2)?, attempt_count: r.get(3)? })
    })?;
    rows.collect()
}

pub fn record_mark_outcome(conn: &Connection, order_id: &str, attempt_count: i64, outcome: &MarkOutcome) -> Result<(), rusqlite::Error> {
    match outcome {
        MarkOutcome::Sent => {
            conn.execute("UPDATE marketplace_receipt_local SET cloud_status = 'SENT', last_error = NULL WHERE order_id = ?1", params![order_id])?;
        }
        MarkOutcome::Rejected(code) => {
            conn.execute("UPDATE marketplace_receipt_local SET cloud_status = 'REJECTED', last_error = ?1 WHERE order_id = ?2", params![code, order_id])?;
        }
        MarkOutcome::Retry => {
            let delay = crate::sync::with_jitter(crate::sync::backoff_base(attempt_count));
            let next = chrono::Utc::now() + chrono::Duration::from_std(delay).unwrap_or_default();
            conn.execute(
                "UPDATE marketplace_receipt_local SET attempt_count = ?1, next_attempt_at = ?2 WHERE order_id = ?3",
                params![attempt_count, next.to_rfc3339(), order_id],
            )?;
        }
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|e| e.to_string())
}

/// `pos_list_pending_receipts` (network).
pub async fn fetch_pending(device_token: &str, limit: i64) -> Result<PendingReceipts, String> {
    use crate::license::cloud::{supabase_anon_key, supabase_url};
    let anon = supabase_anon_key();
    let resp = http_client()?
        .post(format!("{}/rest/v1/rpc/pos_list_pending_receipts", supabase_url()))
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {anon}"))
        .json(&serde_json::json!({ "p_device_token": device_token, "p_limit": limit }))
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("pos_list_pending_receipts returned {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("bad pending-receipts payload: {e}"))
}

/// Drains the receipt queue: one `pos_mark_order_received` call per order.
/// Never holds the DB lock across the network call.
pub async fn run_receipt_tick(db: &std::sync::Mutex<Connection>, device_token: &str) -> Result<usize, rusqlite::Error> {
    use crate::license::cloud::{supabase_anon_key, supabase_url};
    let due = {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        due_receipts(&conn, 20)?
    };
    if due.is_empty() {
        return Ok(0);
    }
    let anon = supabase_anon_key();
    let url = format!("{}/rest/v1/rpc/pos_mark_order_received", supabase_url());
    let mut sent = 0;
    for q in due {
        let lines: serde_json::Value = serde_json::from_str(&q.lines_json).unwrap_or(serde_json::Value::Null);
        let body = serde_json::json!({ "p_device_token": device_token, "p_order_id": q.order_id, "p_lines": lines, "p_note": q.note });
        let outcome = match http_client() {
            Ok(client) => match client.post(&url).header("apikey", &anon).header("Authorization", format!("Bearer {anon}")).json(&body).send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.unwrap_or_default();
                    classify_mark_response(status, &text)
                }
                Err(_) => MarkOutcome::Retry,
            },
            Err(_) => MarkOutcome::Retry,
        };
        if outcome == MarkOutcome::Sent {
            sent += 1;
        }
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        record_mark_outcome(&conn, &q.order_id, q.attempt_count + 1, &outcome)?;
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(qty: f64, size: Option<f64>, measure: Option<&str>) -> PendingItem {
        PendingItem {
            order_item_id: "oi-1".into(), supplier_product_id: None, product_name: "طحين".into(), unit: Some("كيس 10 كجم".into()),
            unit_size: size, unit_measure: measure.map(str::to_string), qty, unit_price_cents: 400, line_total_cents: 1200,
            suggested_local_ingredient_id: None, suggested_ingredient_name: None, suggested_ingredient_unit: None,
            suggested_match_score: None, suggested_stock_added: None,
        }
    }

    #[test]
    fn converts_packages_across_compatible_units() {
        assert_eq!(convert_packages(3.0, Some(10.0), Some("kg"), "kg"), Some(30.0));
        assert_eq!(convert_packages(3.0, Some(10.0), Some("kg"), "غرام"), Some(30_000.0));
        assert_eq!(convert_packages(2.0, Some(500.0), Some("g"), "كجم"), Some(1.0));
        assert_eq!(convert_packages(4.0, Some(1.5), Some("l"), "مل"), Some(6000.0));
        assert_eq!(convert_packages(2.0, Some(12.0), Some("piece"), "حبة"), Some(24.0));
        assert_eq!(convert_packages(2.0, Some(10.0), Some("kg"), "لتر"), None, "mass vs volume");
        assert_eq!(convert_packages(2.0, None, Some("kg"), "kg"), None);
        assert_eq!(convert_packages(2.0, Some(10.0), Some("kg"), "كرتونة"), None, "unknown unit");
    }

    #[test]
    fn suggested_stock_falls_back_to_package_count() {
        assert_eq!(suggested_stock(&item(3.0, Some(10.0), Some("kg")), Some("kg")), 30.0);
        assert_eq!(suggested_stock(&item(3.0, Some(10.0), Some("kg")), None), 3.0);
        assert_eq!(suggested_stock(&item(3.0, None, None), Some("kg")), 3.0);
    }

    #[test]
    fn parses_contract_payload() {
        let json = r#"{"tenant_id":"t","branch_id":"b","server_time":"2026-09-23T10:00:00Z","orders":[{"order_id":"o1","supplier_id":"s","supplier_name":"مطحنة","status":"delivered","delivered_at":"2026-09-22T10:00:00Z","total_cents":125000,"note":null,"delivery_address":null,"items":[{"order_item_id":"i1","supplier_product_id":null,"product_name":"طحين","unit":"كيس 10 كجم","unit_size":10,"unit_measure":"kg","qty":3,"unit_price_cents":40000,"line_total_cents":120000,"suggested_local_ingredient_id":"ing-1","suggested_ingredient_name":"طحين","suggested_ingredient_unit":"kg","suggested_match_score":0.8}]}]}"#;
        let parsed: PendingReceipts = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.orders.len(), 1);
        assert_eq!(parsed.orders[0].items[0].unit_size, Some(10.0));
        assert_eq!(parsed.orders[0].items[0].suggested_local_ingredient_id.as_deref(), Some("ing-1"));
    }

    #[test]
    fn classifies_mark_responses() {
        assert_eq!(classify_mark_response(200, r#"{"ok":true,"already_received":true}"#), MarkOutcome::Sent, "retry after success is still Sent");
        assert_eq!(classify_mark_response(200, r#"{"ok":false}"#), MarkOutcome::Retry);
        assert_eq!(classify_mark_response(400, r#"{"message":"order_not_delivered"}"#), MarkOutcome::Rejected("order_not_delivered".into()));
        assert_eq!(classify_mark_response(400, r#"{"message":"invalid_device_token"}"#), MarkOutcome::Retry);
        assert_eq!(classify_mark_response(503, ""), MarkOutcome::Retry);
    }
}
