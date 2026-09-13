//! 2026-08-02: manual database backup/export. Before this, an owner had
//! no way to get a copy of their own data off a single machine -- a dead
//! laptop or a corrupted DB file meant losing every order/payment/
//! customer record with no recovery path.
//!
//! 2026-09-13 audit fix: the "on-demand only, same disk" gap above is
//! closed here. `create_backup` now also copies the fresh backup file to a
//! user-configured secondary path (any filesystem path -- a mapped network
//! share or a USB drive mount point is a real off-machine destination that
//! needs no cloud credentials this task doesn't have) when one is set in
//! `backup_settings`, and `run_scheduled_backup_if_due` gives `lib.rs` a
//! real background-timer entry point so a backup happens once a day
//! (configurable) regardless of which frontend page is open -- see this
//! function's own doc comment, and `lib.rs::run`'s `setup` closure for the
//! actual timer, for why this replaces the old "runs only while Settings is
//! mounted" `setInterval` in `settings/page.tsx`.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Keep the last N backups and quietly prune older ones on every new
/// backup -- otherwise a POS left running for a year accumulates one
/// file per click forever. 20 is generous for a manual, occasional
/// action; nothing here runs on a timer.
const MAX_BACKUPS_KEPT: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub path: String,
    pub size_bytes: u64,
    pub created_at: String,
}

fn backups_dir(db_path: &Path) -> Result<PathBuf, String> {
    let dir = db_path.parent().ok_or_else(|| "database path has no parent directory".to_string())?.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("failed to create backups directory: {e}"))?;
    Ok(dir)
}

/// `VACUUM INTO` (not a raw file copy) -- SQLite's own documented way to
/// get a consistent, compacted snapshot of a live database, including
/// one with an open WAL file, without stopping anything or risking a
/// torn read of a page mid-write.
pub fn create_backup(conn: &Connection) -> Result<BackupInfo, String> {
    let db_path_str = conn.path().ok_or_else(|| "database connection has no file path (in-memory?)".to_string())?;
    let db_path = PathBuf::from(db_path_str);
    let dir = backups_dir(&db_path)?;

    let timestamp = chrono::Utc::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let backup_path = dir.join(format!("backup-{timestamp}.db"));
    let backup_path_str = backup_path.to_string_lossy().to_string();

    conn.execute("VACUUM INTO ?1", [&backup_path_str]).map_err(|e| format!("backup failed: {e}"))?;

    let metadata = std::fs::metadata(&backup_path).map_err(|e| format!("backup written but couldn't stat it: {e}"))?;
    prune_old_backups(&dir)?;

    // Off-machine copy: best-effort, never fails the backup itself. A
    // local backup that already exists on this same disk is strictly more
    // valuable than none, so an unreachable/unplugged secondary path (a
    // USB drive not currently plugged in, a network share temporarily
    // down) must not turn a successful local backup into a reported
    // failure -- it's logged and swallowed instead.
    if let Ok(settings) = get_backup_settings(conn) {
        if let Some(secondary) = settings.secondary_path.as_ref().filter(|p| !p.trim().is_empty()) {
            if let Err(e) = copy_to_secondary(&backup_path, secondary) {
                eprintln!("backup: secondary copy to {secondary:?} failed (local backup still succeeded): {e}");
            }
        }
    }

    Ok(BackupInfo {
        path: backup_path_str,
        size_bytes: metadata.len(),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn copy_to_secondary(backup_path: &Path, secondary_dir: &str) -> Result<(), String> {
    let dir = PathBuf::from(secondary_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create/reach secondary backup directory: {e}"))?;
    let file_name = backup_path.file_name().ok_or_else(|| "backup path has no file name".to_string())?;
    let dest = dir.join(file_name);
    std::fs::copy(backup_path, &dest).map_err(|e| format!("could not copy backup to secondary path: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSettings {
    /// Any filesystem path this machine can write to -- a mapped network
    /// drive letter/UNC path or a USB drive mount point are the realistic
    /// "off this machine" options without a real cloud provider account.
    /// `None`/empty means local-only, the original behavior.
    pub secondary_path: Option<String>,
    pub frequency_hours: i64,
    pub last_auto_backup_at: Option<String>,
}

pub fn get_backup_settings(conn: &Connection) -> Result<BackupSettings, String> {
    conn.query_row(
        "SELECT secondary_path, frequency_hours, last_auto_backup_at FROM backup_settings WHERE id = 'default'",
        [],
        |r| {
            Ok(BackupSettings {
                secondary_path: r.get(0)?,
                frequency_hours: r.get(1)?,
                last_auto_backup_at: r.get(2)?,
            })
        },
    )
    .map_err(|e| format!("failed to read backup settings: {e}"))
}

pub fn update_backup_settings(conn: &Connection, secondary_path: Option<String>, frequency_hours: i64) -> Result<(), String> {
    if frequency_hours < 1 {
        return Err("frequency_hours must be at least 1".to_string());
    }
    let normalized = secondary_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    conn.execute(
        "UPDATE backup_settings SET secondary_path = ?1, frequency_hours = ?2 WHERE id = 'default'",
        params![normalized, frequency_hours],
    )
    .map_err(|e| format!("failed to update backup settings: {e}"))?;
    Ok(())
}

/// The real background-scheduler entry point (called from a timer loop in
/// `lib.rs::run`, NOT from anything frontend-driven) -- runs a backup and
/// stamps `last_auto_backup_at` only when `frequency_hours` have actually
/// elapsed since the last automatic run, so calling this often (e.g. every
/// 15 minutes, to stay responsive to a just-changed frequency setting) is
/// cheap and idempotent. Returns `Ok(None)` when not yet due -- not an
/// error, just "nothing to do right now."
pub fn run_scheduled_backup_if_due(conn: &Connection) -> Result<Option<BackupInfo>, String> {
    let settings = get_backup_settings(conn)?;
    let due = match &settings.last_auto_backup_at {
        None => true,
        Some(last) => {
            let last_at = chrono::DateTime::parse_from_rfc3339(last)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC);
            let elapsed = chrono::Utc::now().signed_duration_since(last_at);
            elapsed >= chrono::Duration::hours(settings.frequency_hours)
        }
    };
    if !due {
        return Ok(None);
    }

    let info = create_backup(conn)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE backup_settings SET last_auto_backup_at = ?1 WHERE id = 'default'",
        params![now],
    )
    .map_err(|e| format!("backup succeeded but failed to record last_auto_backup_at: {e}"))?;
    Ok(Some(info))
}

fn prune_old_backups(dir: &Path) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read backups directory: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db"))
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (e.path(), t)))
        .collect();
    if entries.len() <= MAX_BACKUPS_KEPT {
        return Ok(());
    }
    entries.sort_by_key(|(_, modified)| *modified);
    let excess = entries.len() - MAX_BACKUPS_KEPT;
    for (path, _) in entries.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

pub fn list_backups(conn: &Connection) -> Result<Vec<BackupInfo>, String> {
    let db_path_str = conn.path().ok_or_else(|| "database connection has no file path (in-memory?)".to_string())?;
    let dir = backups_dir(&PathBuf::from(db_path_str))?;
    let mut out: Vec<BackupInfo> = std::fs::read_dir(&dir)
        .map_err(|e| format!("failed to read backups directory: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db"))
        .filter_map(|e| {
            let metadata = e.metadata().ok()?;
            let modified = metadata.modified().ok()?;
            let created_at: chrono::DateTime<chrono::Utc> = modified.into();
            Some(BackupInfo {
                path: e.path().to_string_lossy().to_string(),
                size_bytes: metadata.len(),
                created_at: created_at.to_rfc3339(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_db(tag: &str) -> PathBuf {
        let temp = std::env::temp_dir().join(format!("backup_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        temp.join("test.db")
    }

    #[test]
    fn create_backup_produces_a_readable_copy_with_the_same_data() {
        let db_path = temp_db("create_backup");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('hello');").unwrap();

        let info = create_backup(&conn).unwrap();
        assert!(info.size_bytes > 0);
        assert!(std::path::Path::new(&info.path).exists());

        let backup_conn = Connection::open(&info.path).unwrap();
        let v: String = backup_conn.query_row("SELECT v FROM t WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "hello");

        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn create_backup_prunes_beyond_max_kept() {
        let db_path = temp_db("prune");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);").unwrap();

        let dir = db_path.parent().unwrap().join("backups");
        fs::create_dir_all(&dir).unwrap();
        // Pre-seed more than MAX_BACKUPS_KEPT fake backup files directly
        // (bypassing the real timestamp granularity, which is 1-second --
        // creating that many real backups in a test would be slow).
        for i in 0..(MAX_BACKUPS_KEPT + 5) {
            fs::write(dir.join(format!("backup-fake-{i}.db")), b"x").unwrap();
        }

        create_backup(&conn).unwrap();

        let remaining = fs::read_dir(&dir).unwrap().filter(|e| e.is_ok()).count();
        assert_eq!(remaining, MAX_BACKUPS_KEPT, "must prune down to exactly MAX_BACKUPS_KEPT after a new backup");
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }

    #[test]
    fn list_backups_returns_newest_first() {
        let db_path = temp_db("list");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);").unwrap();

        let first = create_backup(&conn).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = create_backup(&conn).unwrap();

        let listed = list_backups(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].path, second.path, "most recent backup must be first");
        assert_eq!(listed[1].path, first.path);
        let _ = fs::remove_dir_all(db_path.parent().unwrap());
    }
}
