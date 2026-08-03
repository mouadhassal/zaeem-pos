//! 2026-08-02: manual database backup/export. Before this, an owner had
//! no way to get a copy of their own data off a single machine -- a dead
//! laptop or a corrupted DB file meant losing every order/payment/
//! customer record with no recovery path. On-demand only (an owner
//! presses a button in Settings), not a scheduled job -- see this
//! module's design note in commands_v3.rs's `backup_database_v3` for why.
use rusqlite::Connection;
use serde::Serialize;
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

    Ok(BackupInfo {
        path: backup_path_str,
        size_bytes: metadata.len(),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
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
