//! Cloud sync outbox (CLOUD_AND_LICENSING_PLAN.md §5, Slice 2a). See
//! `migrate_v3::run_sync_outbox_migration` for the table. This module is the
//! ONLY place that reads/writes `sync_outbox`; nothing on the sale path
//! reads it -- `enqueue` is called from inside the same transaction as the
//! fact it queues (see `commands_v3::create_full_order_v3`/
//! `finalize_order_with_payment_v3`/`void_order_item_v3`), a single local
//! INSERT, no network. The actual network push (Slice 2c) lives entirely in
//! a background timer, never inline with a sale.
//!
//! Idempotency key: `(device_id, table_name, row_id, rev)`. Only the
//! originating branch device ever writes its own rows, and `rev` only ever
//! increases on that one device -- so replaying the same batch N times
//! upserts to the identical result every time (Slice 2b's `rev >` guard),
//! with no cross-device conflict possible.

use crate::license::signed::LicenseStatus;
use rusqlite::{params, Connection};
use std::time::Duration;

pub fn license_status_tag(status: &LicenseStatus) -> &'static str {
    match status {
        LicenseStatus::Active { .. } => "active",
        LicenseStatus::Grace { .. } => "grace",
        LicenseStatus::LockedBackOffice { .. } => "locked",
        LicenseStatus::Invalid { .. } => "invalid",
    }
}

/// Queues one fact. Must be called inside the same transaction as the fact's
/// own write -- if the caller's transaction rolls back, this row never
/// existed either.
#[allow(clippy::too_many_arguments)]
pub fn enqueue(
    conn: &Connection,
    table_name: &str,
    row_id: &str,
    tenant_id: &str,
    branch_id: &str,
    payload: &serde_json::Value,
    rev: i64,
    device_id: &str,
    license_status: &LicenseStatus,
) -> Result<(), rusqlite::Error> {
    let id = uuid::Uuid::now_v7().to_string();
    let hlc = crate::hlc::next();
    conn.execute(
        "INSERT INTO sync_outbox \
         (id, table_name, row_id, tenant_id, branch_id, payload_json, rev, hlc, device_id, license_status_at_enqueue, status, attempt_count, next_attempt_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'QUEUED', 0, NULL)",
        params![id, table_name, row_id, tenant_id, branch_id, payload.to_string(), rev, hlc, device_id, license_status_tag(license_status)],
    )?;
    Ok(())
}

// Every field except `id`/`attempt_count` is read only once Slice 2c builds
// the real request body from a batch of these -- not dead code, just not
// fully consumed yet in this slice.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: String,
    pub table_name: String,
    pub row_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub payload_json: String,
    pub rev: i64,
    pub hlc: String,
    pub device_id: String,
    pub license_status_at_enqueue: String,
    pub attempt_count: i64,
}

/// Rows eligible for a send attempt right now: `QUEUED`, or `FAILED` whose
/// backoff has elapsed. Ordered by `hlc` so a batch replays in creation
/// order (cosmetic today -- matters once the dashboard displays a feed).
pub fn due_batch(conn: &Connection, limit: i64) -> Result<Vec<OutboxRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, table_name, row_id, tenant_id, branch_id, payload_json, rev, hlc, device_id, license_status_at_enqueue, attempt_count \
         FROM sync_outbox \
         WHERE status = 'QUEUED' OR (status = 'FAILED' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))) \
         ORDER BY hlc ASC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(OutboxRow {
            id: r.get(0)?, table_name: r.get(1)?, row_id: r.get(2)?, tenant_id: r.get(3)?,
            branch_id: r.get(4)?, payload_json: r.get(5)?, rev: r.get(6)?, hlc: r.get(7)?,
            device_id: r.get(8)?, license_status_at_enqueue: r.get(9)?, attempt_count: r.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
}

/// Retention policy: SENT rows are deleted immediately, not kept. Nothing
/// downstream ever reads "recently sent" outbox rows -- the durable history
/// lives in the fact tables themselves (`orders`/`order_items`/`payments`)
/// and, once synced, in Supabase. Keeping a copy here would only grow
/// unbounded on a POS running for years for zero benefit.
pub fn mark_sent(conn: &Connection, ids: &[String]) -> Result<usize, rusqlite::Error> {
    let mut deleted = 0;
    for id in ids {
        deleted += conn.execute("DELETE FROM sync_outbox WHERE id = ?1", params![id])?;
    }
    Ok(deleted)
}

const BACKOFF_BASE: Duration = Duration::from_secs(5);
const BACKOFF_CAP: Duration = Duration::from_secs(15 * 60);

/// Exponential backoff, no jitter -- the deterministic part, unit-tested on
/// its own. `with_jitter` (below) is what callers actually use.
pub fn backoff_base(attempt_count: i64) -> Duration {
    let attempt = attempt_count.max(0) as u32;
    let scaled = BACKOFF_BASE.saturating_mul(1u32.checked_shl(attempt.min(20)).unwrap_or(u32::MAX));
    scaled.min(BACKOFF_CAP)
}

/// +/-20% jitter so many devices reconnecting after the same outage don't
/// all retry in lockstep.
pub fn with_jitter(base: Duration) -> Duration {
    use rand::Rng;
    let factor = rand::thread_rng().gen_range(0.8..=1.2);
    Duration::from_secs_f64(base.as_secs_f64() * factor)
}

pub fn mark_failed(conn: &Connection, id: &str, attempt_count: i64) -> Result<(), rusqlite::Error> {
    let next_attempt = with_jitter(backoff_base(attempt_count));
    let next_attempt_at = chrono::Utc::now() + chrono::Duration::from_std(next_attempt).unwrap_or_default();
    conn.execute(
        "UPDATE sync_outbox SET status = 'FAILED', attempt_count = ?1, next_attempt_at = ?2 WHERE id = ?3",
        params![attempt_count, next_attempt_at.to_rfc3339(), id],
    )?;
    Ok(())
}

/// `orders.status` -> `pos_order.status`. Lossy: the Edge Function's
/// `pos_order` table only recognizes `PENDING/COOKING/READY/SERVED/CANCELLED`
/// (see `supabase/schema.sql`'s check constraint), narrower than the local
/// POS vocabulary. `DRAFT`/`SCHEDULED` collapse to `PENDING` (nothing to show
/// on a dashboard yet), `PAID` collapses to `SERVED` (money already settled,
/// dashboard doesn't distinguish "served" from "served and paid"), `VOIDED`
/// collapses to `CANCELLED`.
fn map_status_to_pos_order(status: &str) -> &'static str {
    match status {
        "PREPARING" => "COOKING",
        "READY" => "READY",
        "SERVED" | "PAID" => "SERVED",
        "CANCELLED" | "VOIDED" => "CANCELLED",
        _ => "PENDING", // DRAFT, PENDING, SCHEDULED, anything unrecognized
    }
}

/// `orders.order_type` -> `pos_order.order_type`. Lossy: `pos_order` doesn't
/// have an `ONLINE` type (see schema check constraint), so it's folded into
/// `DELIVERY` -- both are off-premise orders from the dashboard's point of
/// view.
fn map_order_type_to_pos_order(order_type: &str) -> &'static str {
    match order_type {
        "DINE_IN" => "DINE_IN",
        "DELIVERY" | "ONLINE" => "DELIVERY",
        _ => "TAKEAWAY",
    }
}

/// Every `order_id` touched by this batch -- from `orders` rows directly, and
/// from the `order_id` field embedded in `order_items`/`payments` payloads.
fn order_ids_in_batch(batch: &[OutboxRow]) -> Vec<String> {
    let mut ids = Vec::new();
    for row in batch {
        let order_id = if row.table_name == "orders" {
            Some(row.row_id.clone())
        } else {
            serde_json::from_str::<serde_json::Value>(&row.payload_json)
                .ok()
                .and_then(|v| v.get("order_id").and_then(|s| s.as_str()).map(String::from))
        };
        if let Some(id) = order_id {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    ids
}

/// Re-reads each order's full CURRENT state straight from the local
/// `orders`/`order_items`/`menu_items`/`tables` tables -- not reconstructed
/// from the outbox's per-row-table payload snapshots, which are normalized
/// facts (one per `orders`/`order_items`/`payments` row) and don't carry
/// enough to build the Edge Function's one-object-per-order-with-embedded-
/// items shape on their own. An order can legitimately be missing here (e.g.
/// hard-deleted after being queued) -- skipped rather than erroring the whole
/// batch.
fn build_orders_payload(
    conn: &Connection,
    batch: &[OutboxRow],
) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
    let mut orders = Vec::new();
    for order_id in order_ids_in_batch(batch) {
        let order_row: Option<(String, String, i64, i64, Option<String>, Option<String>, Option<String>, Option<String>, String)> = conn
            .query_row(
                "SELECT o.status, o.order_type, o.total_cents, o.tax_cents, \
                        o.customer_name, o.customer_phone, o.delivery_address, t.name, o.created_at \
                 FROM orders o LEFT JOIN tables t ON t.id = o.table_id \
                 WHERE o.id = ?1",
                params![order_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .ok();
        let Some((status, order_type, total_cents, tax_cents, customer_name, customer_phone, delivery_address, table_name, created_at)) = order_row else {
            continue;
        };

        let mut item_stmt = conn.prepare(
            "SELECT m.name, oi.quantity, oi.unit_price_cents, oi.voided \
             FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id \
             WHERE oi.order_id = ?1",
        )?;
        let items: Vec<serde_json::Value> = item_stmt
            .query_map(params![order_id], |r| {
                let name: String = r.get(0)?;
                let quantity: i64 = r.get(1)?;
                let unit_price_cents: i64 = r.get(2)?;
                let voided: i64 = r.get(3)?;
                Ok(serde_json::json!({
                    "name": name, "quantity": quantity,
                    "unit_price_cents": unit_price_cents, "voided": voided != 0,
                }))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        orders.push(serde_json::json!({
            "pos_order_id": order_id,
            "order_type": map_order_type_to_pos_order(&order_type),
            "status": map_status_to_pos_order(&status),
            "total_cents": total_cents,
            "tax_cents": tax_cents,
            "items": items,
            "customer_name": customer_name,
            "customer_phone": customer_phone,
            "delivery_address": delivery_address,
            "table_id": table_name,
            "created_at": created_at,
        }));
    }
    Ok(orders)
}

/// "Supply movement" on the web owner dashboard (T2.0 follow-up): until
/// this, `supplier_payments` rows WERE enqueued (see
/// `commands_v3::sync_enqueue_supplier_payment`) but `build_orders_payload`
/// is the only thing `run_tick` ever called -- a supplier_payments row
/// contributed nothing to the request body and still got `mark_sent`,
/// vacuously. Builds two arrays from a batch's `supplier_payments` rows:
/// the payment/charge facts themselves (from each row's own outbox
/// payload, already complete -- no local table re-read needed), and a
/// CURRENT balance snapshot per supplier touched (re-read from `suppliers`,
/// same "always send the live state, not the snapshot at enqueue time"
/// reasoning as `build_orders_payload`). A supplier can legitimately be
/// missing (hard-deleted after being queued) -- skipped, not an error.
fn build_supplier_payload(
    conn: &Connection,
    batch: &[OutboxRow],
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>), rusqlite::Error> {
    let mut payments = Vec::new();
    let mut supplier_ids: Vec<String> = Vec::new();

    for row in batch {
        if row.table_name != "supplier_payments" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&row.payload_json) else { continue };
        let Some(supplier_id) = payload.get("supplier_id").and_then(|v| v.as_str()).map(String::from) else { continue };

        let supplier_name: Option<String> = conn
            .query_row("SELECT name FROM suppliers WHERE id = ?1", params![supplier_id], |r| r.get(0))
            .ok();
        let Some(supplier_name) = supplier_name else { continue };

        payments.push(serde_json::json!({
            "local_payment_id": row.row_id,
            "local_supplier_id": supplier_id,
            "supplier_name": supplier_name,
            "entry_type": payload.get("type").and_then(|v| v.as_str()),
            "amount_cents": payload.get("amount_cents"),
            "method": payload.get("method"),
            "notes": payload.get("notes"),
            "created_at": payload.get("created_at"),
        }));

        if !supplier_ids.contains(&supplier_id) {
            supplier_ids.push(supplier_id);
        }
    }

    let mut suppliers = Vec::new();
    for supplier_id in supplier_ids {
        let row: Option<(String, Option<String>, Option<String>, i64, i64, i64)> = conn
            .query_row(
                "SELECT name, phone, email, total_purchases_cents, total_paid_cents, balance_cents FROM suppliers WHERE id = ?1",
                params![supplier_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .ok();
        let Some((name, phone, email, total_purchases_cents, total_paid_cents, balance_cents)) = row else { continue };
        suppliers.push(serde_json::json!({
            "local_supplier_id": supplier_id,
            "name": name, "phone": phone, "email": email,
            "total_purchases_cents": total_purchases_cents,
            "total_paid_cents": total_paid_cents,
            "balance_cents": balance_cents,
        }));
    }

    Ok((payments, suppliers))
}

/// Slice 2c: real POST to the `sync-pos` Edge Function, the canonical POS
/// ingestion path (`pos_device`/`pos_order`, one denormalized row per order
/// with embedded `items` -- see `supabase/functions/sync-pos/index.ts`). The
/// function validates `device_token` against the `license` table itself, so
/// unlike the retired `ingest_sales_facts` RPC there's no separate
/// `license_id` in the request body. `suppliers`/`supplier_payments` ride
/// along in the same request -- one heartbeat, one auth check, same as
/// orders (see `build_supplier_payload`'s doc comment for why these two
/// arrays exist).
async fn send_batch(
    orders: &[serde_json::Value],
    suppliers: &[serde_json::Value],
    supplier_payments: &[serde_json::Value],
    config_dir: &std::path::Path,
) -> Result<(), String> {
    use crate::license::cloud::{load_config_from_file, supabase_anon_key, supabase_url};

    if orders.is_empty() && suppliers.is_empty() && supplier_payments.is_empty() {
        return Ok(());
    }

    let config = load_config_from_file(&config_dir.join("cloud_config.json"))
        .ok_or_else(|| "cloud_config.json missing or unreadable".to_string())?;

    let base = supabase_url();
    let anon = supabase_anon_key();

    let body = serde_json::json!({
        "device_token": config.device_token,
        "orders": orders,
        "suppliers": suppliers,
        "supplier_payments": supplier_payments,
        "device_name": "Zaeem POS",
        "version": env!("CARGO_PKG_VERSION"),
    });

    let url = format!("{}/functions/v1/sync-pos", base);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {}", &anon))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("sync-pos returned {status}: {text}"))
    }
}



/// One worker tick: pull whatever's due, attempt to send it, and either
/// delete (success) or back off (failure) every row in the batch together.
/// Never called from the sale path -- only from a background timer (see
/// `lib.rs`'s setup). Returns the number of rows successfully sent.
///
/// Takes the whole `Mutex`, not an already-locked `Connection`, and
/// DELIBERATELY re-locks around the network call rather than holding one
/// lock for the entire tick -- once Slice 2c replaces the send with
/// a real network request, holding the connection mutex across that await
/// would block every other command (including a sale in progress) for the
/// duration of the request. Pull the batch, release the lock, await the
/// send, then re-acquire only to record the result.
pub async fn run_tick(
    db: &std::sync::Mutex<Connection>,
    batch_limit: i64,
    config_dir: &std::path::Path,
) -> Result<usize, rusqlite::Error> {
    let (batch, orders_payload, suppliers_payload, supplier_payments_payload) = {
        let conn = db.lock().unwrap();
        let batch = due_batch(&conn, batch_limit)?;
        if batch.is_empty() {
            return Ok(0);
        }
        let orders_payload = build_orders_payload(&conn, &batch)?;
        let (supplier_payments_payload, suppliers_payload) = build_supplier_payload(&conn, &batch)?;
        (batch, orders_payload, suppliers_payload, supplier_payments_payload)
    };

    let result = send_batch(&orders_payload, &suppliers_payload, &supplier_payments_payload, config_dir).await;

    let conn = db.lock().unwrap();
    match result {
        Ok(()) => {
            let ids: Vec<String> = batch.iter().map(|r| r.id.clone()).collect();
            mark_sent(&conn, &ids)?;
            Ok(batch.len())
        }
        Err(_) => {
            for row in &batch {
                mark_failed(&conn, &row.id, row.attempt_count + 1)?;
            }
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sync_outbox (
                id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
                tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL, payload_json TEXT NOT NULL,
                rev INTEGER NOT NULL, hlc TEXT NOT NULL, device_id TEXT NOT NULL,
                license_status_at_enqueue TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED',
                attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE tables (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE orders (
                id TEXT PRIMARY KEY, table_id TEXT, status TEXT NOT NULL, order_type TEXT NOT NULL,
                total_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL,
                customer_name TEXT, customer_phone TEXT, delivery_address TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE order_items (
                id TEXT PRIMARY KEY, order_id TEXT NOT NULL, menu_item_id TEXT NOT NULL,
                quantity INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0
            );",
        ).unwrap();
        conn
    }

    fn active_status() -> LicenseStatus {
        LicenseStatus::Active { days_remaining: 1, plan: "p".into(), expires_at: 0 }
    }

    #[test]
    fn enqueue_then_due_batch_round_trips_every_field() {
        let conn = setup_conn();
        let payload = serde_json::json!({"total_cents": 1000});
        enqueue(&conn, "orders", "order-1", "tenant-1", "branch-1", &payload, 1, "device-1", &active_status()).unwrap();

        let batch = due_batch(&conn, 10).unwrap();
        assert_eq!(batch.len(), 1);
        let row = &batch[0];
        assert_eq!(row.table_name, "orders");
        assert_eq!(row.row_id, "order-1");
        assert_eq!(row.tenant_id, "tenant-1");
        assert_eq!(row.branch_id, "branch-1");
        assert_eq!(row.rev, 1);
        assert_eq!(row.device_id, "device-1");
        assert_eq!(row.license_status_at_enqueue, "active");
        assert_eq!(row.payload_json, payload.to_string());
    }

    #[tokio::test]
    async fn run_tick_is_a_no_op_on_an_empty_outbox() {
        let conn = setup_conn();
        let db = std::sync::Mutex::new(conn);
        let tmp = std::env::temp_dir();
        let sent = run_tick(&db, 10, &tmp).await.unwrap();
        assert_eq!(sent, 0);
    }

    /// The actual Slice 2a proof for the worker half: a failed send-attempt
    /// must back off EVERY row in the batch (not silently drop any of
    /// them), and the rows must still be visible in the outbox afterward --
    /// this is what makes surviving a week+ offline safe: nothing is ever
    /// lost on a failed attempt, only rescheduled.
    #[tokio::test]
    async fn run_tick_backs_off_every_row_in_the_batch_on_failure_without_dropping_any() {
        let conn = setup_conn();
        conn.execute(
            "INSERT INTO orders (id, table_id, status, order_type, total_cents, tax_cents, created_at) \
             VALUES ('row-1', NULL, 'PENDING', 'DINE_IN', 1000, 0, datetime('now'))",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO orders (id, table_id, status, order_type, total_cents, tax_cents, created_at) \
             VALUES ('row-2', NULL, 'PENDING', 'DINE_IN', 1000, 0, datetime('now'))",
            [],
        ).unwrap();
        enqueue(&conn, "orders", "row-1", "t1", "b1", &serde_json::json!({}), 1, "device-1", &active_status()).unwrap();
        enqueue(&conn, "orders", "row-2", "t1", "b1", &serde_json::json!({}), 1, "device-1", &active_status()).unwrap();

        let db = std::sync::Mutex::new(conn);
        let tmp = std::env::temp_dir();
        let sent = run_tick(&db, 10, &tmp).await.unwrap();
        assert_eq!(sent, 0, "should fail because cloud_config.json is missing -- nothing should be marked sent");

        let conn = db.into_inner().unwrap();
        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 2, "a failed send must never drop a fact -- both rows must still be present");

        let (status, attempt_count, next_attempt_at): (String, i64, Option<String>) = conn.query_row(
            "SELECT status, attempt_count, next_attempt_at FROM sync_outbox WHERE row_id = 'row-1'",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(status, "FAILED");
        assert_eq!(attempt_count, 1);
        assert!(next_attempt_at.is_some(), "a failed row must get a scheduled retry time, not retry immediately forever");
    }

    #[test]
    fn mark_sent_deletes_immediately_no_retention_window() {
        let conn = setup_conn();
        enqueue(&conn, "orders", "row-1", "t1", "b1", &serde_json::json!({}), 1, "device-1", &active_status()).unwrap();
        let batch = due_batch(&conn, 10).unwrap();
        let ids: Vec<String> = batch.iter().map(|r| r.id.clone()).collect();

        let deleted = mark_sent(&conn, &ids).unwrap();
        assert_eq!(deleted, 1);

        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 0, "SENT rows are deleted immediately -- no retention window, nothing downstream reads them");
    }

    #[test]
    fn backoff_grows_exponentially_then_caps() {
        assert_eq!(backoff_base(0), Duration::from_secs(5));
        assert_eq!(backoff_base(1), Duration::from_secs(10));
        assert_eq!(backoff_base(2), Duration::from_secs(20));
        assert_eq!(backoff_base(3), Duration::from_secs(40));
        // Keeps doubling until it would exceed the cap, then clamps.
        assert_eq!(backoff_base(10), BACKOFF_CAP);
        assert_eq!(backoff_base(1000), BACKOFF_CAP, "must never overflow or exceed the cap for a very large attempt count");
    }

    #[test]
    fn jitter_stays_within_plus_minus_20_percent() {
        let base = Duration::from_secs(100);
        for _ in 0..200 {
            let jittered = with_jitter(base);
            assert!(jittered >= Duration::from_secs(79) && jittered <= Duration::from_secs(121), "got {jittered:?}, expected roughly 80..120s");
        }
    }

    #[test]
    fn license_status_tag_covers_every_variant() {
        assert_eq!(license_status_tag(&LicenseStatus::Active { days_remaining: 1, plan: "p".into(), expires_at: 0 }), "active");
        assert_eq!(license_status_tag(&LicenseStatus::Grace { days_left_in_grace: 1, plan: "p".into(), expires_at: 0 }), "grace");
        assert_eq!(license_status_tag(&LicenseStatus::LockedBackOffice { days_since_grace_ended: 1, plan: "p".into(), expires_at: 0 }), "locked");
        assert_eq!(license_status_tag(&LicenseStatus::Invalid { reason: "x".into() }), "invalid");
    }
}
