//! P0 follow-up (2026-07-23, "database is not there anymore" after ~1h):
//! makes the NEXT occurrence of a DB-unreachable report diagnosable from
//! the persisted log file alone, without a live debugging session. Purely
//! additive -- nothing here changes any command's behavior or return
//! value, it only observes and records.
//!
//! Three things land in the same rotating log file (via the `log` crate +
//! `tauri-plugin-log`'s file target, enabled in every build now, not just
//! debug):
//! 1. App start time (`log_app_start`).
//! 2. Every SQLite error, process-wide, with its real numeric result code
//!    and message -- `install_sqlite_error_log` registers SQLite's own
//!    C-level error/warning log callback (`sqlite3_config(SQLITE_CONFIG_LOG)`),
//!    so this fires for ANY connection (`Db`, the AI upload queue,
//!    `AppState`) and ANY error SQLite itself reports, not just the ones a
//!    Rust call site happens to check for -- no per-command changes needed.
//! 3. Every sync tick and license refresh outcome (`log_sync_tick`,
//!    `log_license_refresh`), called from their existing timer loops.
//!
//! Every log line includes uptime (time since `log_app_start()` was
//! called), so a line like "SQLite error 5 (database is locked) at uptime
//! 61m32s" is immediately actionable without cross-referencing timestamps.

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

fn uptime_str() -> String {
    let elapsed = START.get().map(|s| s.elapsed()).unwrap_or_default();
    let total_secs = elapsed.as_secs();
    let h = total_secs / 3600;
    let m = (total_secs % 3600) / 60;
    let s = total_secs % 60;
    format!("{h}h{m:02}m{s:02}s")
}

/// Call once, as early as possible in `setup()`. Idempotent (a second call
/// is a no-op) so it's safe even if something ever calls it twice.
pub fn log_app_start(app_version: &str) {
    let _ = START.set(Instant::now());
    log::info!(
        "app start: version={app_version} at {}",
        chrono::Utc::now().to_rfc3339()
    );
}

/// Registers SQLite's process-wide error/warning log callback. Unsafe per
/// rusqlite's own contract (must be called before any other SQLite activity
/// on this process, and the callback itself must never call back into
/// SQLite) -- called once, first thing in `setup()`, before any
/// `Connection::open` anywhere in this app.
pub fn install_sqlite_error_log() {
    unsafe {
        let _ = rusqlite::trace::config_log(Some(sqlite_log_callback));
    }
}

fn sqlite_log_callback(result_code: std::os::raw::c_int, msg: &str) {
    log::error!(
        "SQLite error (code {result_code}): {msg} [uptime {}]",
        uptime_str()
    );
}

pub fn log_sync_tick_result(outcome: &Result<usize, rusqlite::Error>) {
    match outcome {
        Ok(sent) => log::info!("sync tick: sent={sent} [uptime {}]", uptime_str()),
        Err(e) => log::warn!("sync tick failed: {e} [uptime {}]", uptime_str()),
    }
}

pub fn log_license_refresh(kind: &str, outcome: &str) {
    log::info!("license refresh ({kind}): {outcome} [uptime {}]", uptime_str());
}

/// Called from the frontend's `invoke` wrapper when any command call
/// rejects -- the frontend is the one place that already knows the exact
/// command name for every call, so this is where "which command failed"
/// gets attached to the same log file the SQLite/sync/license lines land
/// in. Frontend-original error text is logged verbatim, not summarized.
pub fn log_frontend_command_error(command: &str, error: &str) {
    log::error!(
        "command \"{command}\" failed: {error} [uptime {}]",
        uptime_str()
    );
}
