//! T1.5 -- the hash-chained audit log, per ARCHITECTURE_V2.md §2 and
//! SCHEMA_V3.md §7. The `audit_log` table and its UPDATE/DELETE-blocking
//! triggers already exist (created by T1.1's Migration A); this module is
//! the write path (`append`) and the tamper-detection path (`verify_chain`).
//!
//! Scope decision, stated plainly: the per-device Ed25519 signature + OS
//! keystore storage described in ARCHITECTURE_V2.md §2 is NOT implemented in
//! this batch. The hash chain itself (SHA256, canonical JSON, prev_hash
//! linking) is the mechanism that makes tampering detectable at all -- an
//! attacker who edits one historical row must recompute every hash after it
//! to hide the edit, and `verify_chain` is exactly the check that catches a
//! chain where that wasn't done. The Ed25519 signature adds non-repudiation
//! (proving WHICH device produced a given chain state) on top of that, which
//! matters most once sync/multi-device reporting exists (S5+) -- deferred,
//! not silently dropped, and flagged in PROGRESS.md.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug)]
pub enum AuditError {
    Db(rusqlite::Error),
    Serialize(serde_json::Error),
    ChainBroken { device_id: String, at_seq: i64, reason: String },
}

impl fmt::Display for AuditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Serialize(e) => write!(f, "serialization error: {e}"),
            Self::ChainBroken { device_id, at_seq, reason } => {
                write!(f, "audit chain for device {device_id} is broken at seq {at_seq}: {reason}")
            }
        }
    }
}
impl std::error::Error for AuditError {}
impl From<rusqlite::Error> for AuditError {
    fn from(e: rusqlite::Error) -> Self { Self::Db(e) }
}
impl From<serde_json::Error> for AuditError {
    fn from(e: serde_json::Error) -> Self { Self::Serialize(e) }
}
impl From<AuditError> for String {
    fn from(e: AuditError) -> String { e.to_string() }
}

/// Genesis hash for the first entry on any device's chain -- a fixed,
/// well-known zero value, not derived from anything (there is no entry -1).
const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Typed actions only -- per SCHEMA_V3.md §7, `action` is never a free
/// string. Extend as new mutating commands are added; the point is that this
/// enum, not ad hoc strings, is what a command is allowed to record.
#[derive(Debug, Clone, Copy, Serialize)]
pub enum Action {
    StaffCreated,
    StaffRoleUpdated,
    BranchCreated,
    OrderCreated,
    OrderStatusChanged,
    PasswordChanged,
    /// Batch 3b.
    PaymentTaken,
    MenuItemChanged,
    InventoryAdjusted,
    ShiftOpened,
    ShiftClosed,
    CustomerChanged,
    LoyaltyCardIssued,
    DebtRecorded,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Action::StaffCreated => "StaffCreated",
            Action::StaffRoleUpdated => "StaffRoleUpdated",
            Action::BranchCreated => "BranchCreated",
            Action::OrderCreated => "OrderCreated",
            Action::OrderStatusChanged => "OrderStatusChanged",
            Action::PasswordChanged => "PasswordChanged",
            Action::PaymentTaken => "PaymentTaken",
            Action::MenuItemChanged => "MenuItemChanged",
            Action::InventoryAdjusted => "InventoryAdjusted",
            Action::ShiftOpened => "ShiftOpened",
            Action::ShiftClosed => "ShiftClosed",
            Action::CustomerChanged => "CustomerChanged",
            Action::LoyaltyCardIssued => "LoyaltyCardIssued",
            Action::DebtRecorded => "DebtRecorded",
        }
    }
}

/// Canonical JSON: keys sorted, no whitespace, so the same logical value
/// always hashes identically regardless of which device/serde version wrote
/// it. `serde_json::Value`'s `BTreeMap`-backed object ordering (when parsed
/// through `Value`) already sorts keys; `to_string` (compact form) has no
/// extraneous whitespace. This is deliberately NOT `serde_json::to_string`
/// on the original struct directly, which would preserve field-declaration
/// order, not sorted order.
fn canonical_json<T: Serialize>(value: &T) -> Result<String, AuditError> {
    let v = serde_json::to_value(value)?;
    let sorted: serde_json::Value = serde_json::from_str(&serde_json::to_string(&v)?)?;
    Ok(serde_json::to_string(&sorted)?)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// Appends exactly one audit entry, in the SAME transaction as the mutation
/// it records (caller's responsibility -- `tx` is a live transaction, not a
/// fresh connection). Per T1.2's command shape: if this fails, the whole
/// command fails and rolls back; there is no code path that commits a
/// mutation without its audit entry.
#[allow(clippy::too_many_arguments)]
pub fn append(
    tx: &rusqlite::Transaction,
    device_id: &str,
    tenant_id: &str,
    branch_id: Option<&str>,
    actor_id: &str,
    action: Action,
    entity_type: &str,
    entity_id: &str,
    before: Option<&serde_json::Value>,
    after: Option<&serde_json::Value>,
) -> Result<(), AuditError> {
    let prev: Option<(i64, String)> = tx
        .query_row(
            "SELECT seq, hash FROM audit_log WHERE device_id = ?1 ORDER BY seq DESC LIMIT 1",
            params![device_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (next_seq, prev_hash) = match prev {
        Some((seq, hash)) => (seq + 1, hash),
        None => (1, GENESIS_HASH.to_string()),
    };

    let id = Uuid::now_v7().to_string();
    let ts = chrono::Utc::now().to_rfc3339();
    let before_json = before.map(canonical_json).transpose()?;
    let after_json = after.map(canonical_json).transpose()?;

    // The hash covers every field that identifies and dates this entry, plus
    // the chain link itself -- so a tamperer must forge ALL of these to make
    // a single field edit undetectable, not just the payload.
    #[derive(Serialize)]
    struct HashInput<'a> {
        device_id: &'a str, seq: i64, id: &'a str, ts: &'a str,
        tenant_id: &'a str, branch_id: Option<&'a str>, actor_id: &'a str,
        action: &'a str, entity_type: &'a str, entity_id: &'a str,
        before_json: &'a Option<String>, after_json: &'a Option<String>,
        prev_hash: &'a str,
    }
    let hash_input = HashInput {
        device_id, seq: next_seq, id: &id, ts: &ts, tenant_id, branch_id, actor_id,
        action: action.as_str(), entity_type, entity_id,
        before_json: &before_json, after_json: &after_json, prev_hash: &prev_hash,
    };
    let hash = sha256_hex(&canonical_json(&hash_input)?);

    tx.execute(
        "INSERT INTO audit_log (device_id, seq, id, ts, tenant_id, branch_id, actor_id, action, entity_type, entity_id, before_json, after_json, prev_hash, hash) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![device_id, next_seq, id, ts, tenant_id, branch_id, actor_id, action.as_str(), entity_type, entity_id, before_json, after_json, prev_hash, hash],
    )?;
    Ok(())
}

/// Walks one device's chain from seq 1, recomputing each entry's hash from
/// its stored fields and comparing against the stored `hash`, and confirming
/// each entry's `prev_hash` matches the PREVIOUS entry's stored `hash`. Per
/// SCHEMA_V3.md §7, verification is per-device -- there is no cross-device
/// chain to walk (multi-device history is ordered by `ts` for display only).
#[allow(dead_code)] // exercised by this module's own tests; not yet wired to a command (no "verify audit chain" admin command exists in this batch's vertical slice)
pub fn verify_chain(conn: &Connection, device_id: &str) -> Result<(), AuditError> {
    let mut stmt = conn.prepare(
        "SELECT seq, id, ts, tenant_id, branch_id, actor_id, action, entity_type, entity_id, before_json, after_json, prev_hash, hash \
         FROM audit_log WHERE device_id = ?1 ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(params![device_id], |r| {
        Ok((
            r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
            r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, String>(5)?,
            r.get::<_, String>(6)?, r.get::<_, String>(7)?, r.get::<_, String>(8)?,
            r.get::<_, Option<String>>(9)?, r.get::<_, Option<String>>(10)?,
            r.get::<_, String>(11)?, r.get::<_, String>(12)?,
        ))
    })?;

    let mut expected_prev_hash = GENESIS_HASH.to_string();
    for row in rows {
        let (seq, id, ts, tenant_id, branch_id, actor_id, action, entity_type, entity_id, before_json, after_json, stored_prev_hash, stored_hash) = row?;

        if stored_prev_hash != expected_prev_hash {
            return Err(AuditError::ChainBroken {
                device_id: device_id.to_string(), at_seq: seq,
                reason: format!("prev_hash mismatch: entry claims prev_hash={stored_prev_hash}, but the previous entry's hash was {expected_prev_hash}"),
            });
        }

        #[derive(Serialize)]
        struct HashInput<'a> {
            device_id: &'a str, seq: i64, id: &'a str, ts: &'a str,
            tenant_id: &'a str, branch_id: Option<&'a str>, actor_id: &'a str,
            action: &'a str, entity_type: &'a str, entity_id: &'a str,
            before_json: &'a Option<String>, after_json: &'a Option<String>,
            prev_hash: &'a str,
        }
        let recomputed = sha256_hex(&canonical_json(&HashInput {
            device_id, seq, id: &id, ts: &ts, tenant_id: &tenant_id, branch_id: branch_id.as_deref(),
            actor_id: &actor_id, action: &action, entity_type: &entity_type, entity_id: &entity_id,
            before_json: &before_json, after_json: &after_json, prev_hash: &stored_prev_hash,
        })?);

        if recomputed != stored_hash {
            return Err(AuditError::ChainBroken {
                device_id: device_id.to_string(), at_seq: seq,
                reason: format!("stored hash does not match recomputed hash from this row's own fields -- a field in seq {seq} was altered after it was written"),
            });
        }

        expected_prev_hash = stored_hash;
    }
    Ok(())
}

#[allow(dead_code)]
fn now_epoch() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

// Minimal hex encoding so this module doesn't need the `hex` crate for one call site.
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// A bare DB with just `audit_log` and its immutability triggers -- these
    /// come from T1.1's Migration A, so this recreates only what this module
    /// needs rather than running the full migration stack for a unit test.
    fn audit_only_db(tag: &str) -> (PathBuf, Connection) {
        let temp = std::env::temp_dir().join(format!("audit_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let db_path = temp.join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE audit_log (
                device_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
                ts TEXT NOT NULL, tenant_id TEXT NOT NULL, branch_id TEXT,
                actor_id TEXT NOT NULL, action TEXT NOT NULL,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
                before_json TEXT, after_json TEXT,
                prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
                PRIMARY KEY (device_id, seq)
            );
            CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN
                SELECT RAISE(ABORT, 'audit_log rows are immutable');
            END;
            CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN
                SELECT RAISE(ABORT, 'audit_log rows are immutable');
            END;",
        )
        .unwrap();
        (db_path, conn)
    }

    #[test]
    fn chain_verifies_after_several_entries_and_catches_a_tampered_row() {
        let (db_path, mut conn) = audit_only_db("chain");
        {
            let tx = conn.transaction().unwrap();
            append(&tx, "device-1", "tenant-1", Some("branch-1"), "actor-1", Action::StaffCreated, "staff", "s1", None, Some(&serde_json::json!({"name": "A"}))).unwrap();
            tx.commit().unwrap();
        }
        {
            let tx = conn.transaction().unwrap();
            append(&tx, "device-1", "tenant-1", Some("branch-1"), "actor-1", Action::OrderCreated, "order", "o1", None, Some(&serde_json::json!({"total": 500}))).unwrap();
            tx.commit().unwrap();
        }
        {
            let tx = conn.transaction().unwrap();
            append(&tx, "device-1", "tenant-1", Some("branch-1"), "actor-1", Action::OrderStatusChanged, "order", "o1", Some(&serde_json::json!({"status":"PENDING"})), Some(&serde_json::json!({"status":"READY"}))).unwrap();
            tx.commit().unwrap();
        }

        assert!(verify_chain(&conn, "device-1").is_ok());
        println!("chain of 3 entries on device-1 verifies cleanly");

        // Tampering "in place" isn't reachable through this connection at
        // all -- the immutability triggers reject it (proven in the sibling
        // test below). The realistic tamper scenario is an attacker editing
        // the .db file directly (no triggers involved, since they're part of
        // this connection's transaction log, not an intrinsic file property
        // once written raw). Simulate that here on a second DB with the
        // triggers dropped, and confirm `verify_chain`'s hash recomputation
        // -- not the trigger -- is what actually catches the edit.
        let (db_path2, mut conn2) = audit_only_db("tamper");
        let _ = db_path2;
        {
            let tx = conn2.transaction().unwrap();
            append(&tx, "device-2", "tenant-1", Some("branch-1"), "actor-1", Action::StaffCreated, "staff", "s1", None, Some(&serde_json::json!({"name": "A"}))).unwrap();
            tx.commit().unwrap();
        }
        // Simulate an attacker editing the row after the fact by disabling
        // this module's own trigger protection is not possible through this
        // connection (that's the point) -- so drop to raw SQL against a
        // schema WITHOUT the trigger to prove `verify_chain`'s recomputation
        // catches the divergence, independent of whether the trigger exists.
        conn2.execute_batch("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;").unwrap();
        conn2.execute("UPDATE audit_log SET after_json = '{\"name\":\"TAMPERED\"}' WHERE device_id = 'device-2' AND seq = 1", []).unwrap();

        match verify_chain(&conn2, "device-2") {
            Err(AuditError::ChainBroken { at_seq, reason, .. }) => {
                println!("verify_chain correctly detected tampering at seq {at_seq}: {reason}");
            }
            other => panic!("expected ChainBroken after tampering with a row's after_json, got {other:?}"),
        }

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
        let _ = fs::remove_dir_all(db_path2.parent().unwrap());
    }

    #[test]
    fn audit_log_rejects_direct_update_and_delete_through_the_triggers() {
        let (db_path, mut conn) = audit_only_db("triggers");
        {
            let tx = conn.transaction().unwrap();
            append(&tx, "device-1", "tenant-1", None, "actor-1", Action::BranchCreated, "branch", "b1", None, None).unwrap();
            tx.commit().unwrap();
        }

        let update_result = conn.execute("UPDATE audit_log SET action = 'HACKED' WHERE device_id = 'device-1' AND seq = 1", []);
        println!("direct UPDATE against audit_log: {update_result:?}");
        assert!(update_result.is_err(), "the audit_log_no_update trigger must reject this");

        let delete_result = conn.execute("DELETE FROM audit_log WHERE device_id = 'device-1' AND seq = 1", []);
        println!("direct DELETE against audit_log: {delete_result:?}");
        assert!(delete_result.is_err(), "the audit_log_no_delete trigger must reject this");

        let still_there: i64 = conn.query_row("SELECT COUNT(*) FROM audit_log WHERE device_id = 'device-1' AND seq = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(still_there, 1);

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}
