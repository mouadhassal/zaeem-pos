//! 2026-08-02: manual, opt-in diagnostic report upload. Before this, an
//! error only ever landed in the local rotating log file (obslog.rs) --
//! diagnosable only if someone physically pulled the file off that one
//! machine. Nothing here runs automatically; a report is only ever sent
//! when someone presses the button in Settings.
//!
//! Same "app never holds the real key" shape as `ai::remote::RemoteAiProvider`
//! -- this posts to a Supabase Edge Function (`upload-diagnostics`), which
//! holds the service-role key server-side and does the actual Storage write.
use serde::Serialize;
use std::path::PathBuf;

/// Only the tail of the log matters for "what just happened" -- capped
/// well under the edge function's own MAX_LOG_BYTES so a slow connection
/// isn't asked to upload a multi-megabyte file for a report about one
/// error.
const MAX_UPLOAD_BYTES: usize = 500_000;

#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsResult {
    pub path: String,
}

/// Tauri's `LogDir` target (see lib.rs's `tauri_plugin_log::Builder`)
/// writes one active file plus size-rotated siblings (`RotationStrategy::
/// KeepAll`) -- the active one is always the most recently modified, so
/// picking that (rather than guessing a fixed filename) is robust to
/// whatever naming tauri-plugin-log happens to use internally.
fn find_active_log_file(log_dir: &std::path::Path) -> Result<PathBuf, String> {
    let mut candidates: Vec<(PathBuf, std::time::SystemTime)> = std::fs::read_dir(log_dir)
        .map_err(|e| format!("failed to read log directory: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("log"))
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (e.path(), t)))
        .collect();
    candidates.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    candidates
        .into_iter()
        .next()
        .map(|(path, _)| path)
        .ok_or_else(|| "no log file found yet".to_string())
}

/// Keeps only the tail, and never splits a UTF-8 multi-byte character in
/// half (a naive `text[len - max..]` byte slice can land mid-character
/// and panic) -- walks back from the byte cutoff to the nearest real
/// char boundary.
fn truncate_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

pub fn send_report(
    log_dir: &std::path::Path,
    supabase_url: &str,
    supabase_anon_key: &str,
    tenant_id: &str,
    device_id: &str,
    app_version: &str,
) -> Result<DiagnosticsResult, String> {
    let log_path = find_active_log_file(log_dir)?;
    let full_text = std::fs::read_to_string(&log_path).map_err(|e| format!("failed to read log file: {e}"))?;
    let log_text = truncate_tail(&full_text, MAX_UPLOAD_BYTES).to_string();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{supabase_url}/functions/v1/upload-diagnostics"))
        .header("apikey", supabase_anon_key)
        .header("Authorization", format!("Bearer {supabase_anon_key}"))
        .json(&serde_json::json!({
            "tenant_id": tenant_id,
            "device_id": device_id,
            "app_version": app_version,
            "log_text": log_text,
        }))
        .send()
        .map_err(|e| format!("could not reach diagnostics service: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("diagnostics upload failed ({status}): {body}"));
    }

    #[derive(serde::Deserialize)]
    struct UploadResponse {
        path: String,
    }
    let parsed: UploadResponse = resp.json().map_err(|e| format!("invalid response shape: {e}"))?;
    Ok(DiagnosticsResult { path: parsed.path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diagnostics_test_{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn find_active_log_file_picks_the_most_recently_modified_log() {
        let dir = temp_dir("active_log");
        fs::write(dir.join("app.1.log"), b"old").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(dir.join("app.log"), b"current").unwrap();
        // A non-.log file in the same directory must never be picked, no
        // matter how recently it was touched.
        fs::write(dir.join("notes.txt"), b"ignore me").unwrap();

        let found = find_active_log_file(&dir).unwrap();
        assert_eq!(found.file_name().unwrap(), "app.log");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_active_log_file_errors_clearly_when_none_exist() {
        let dir = temp_dir("no_logs");
        let err = find_active_log_file(&dir).unwrap_err();
        assert!(err.contains("no log file"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncate_tail_keeps_only_the_last_n_bytes_and_never_splits_a_char() {
        let text = "a".repeat(100) + " العربية" + &"b".repeat(100);
        let truncated = truncate_tail(&text, 50);
        assert!(truncated.len() <= 50 + 3, "must not grow past the boundary-adjusted cutoff by more than a few bytes: got {}", truncated.len());
        // Must be valid UTF-8 on its own (would already panic above if not,
        // but assert explicitly what's being protected against).
        assert!(std::str::from_utf8(truncated.as_bytes()).is_ok());
        assert!(text.ends_with(truncated));
    }

    #[test]
    fn truncate_tail_is_a_no_op_when_text_is_already_short() {
        let text = "short log line";
        assert_eq!(truncate_tail(text, 500), text);
    }

    #[test]
    fn send_report_fails_clearly_when_no_log_file_exists_yet() {
        let dir = temp_dir("send_report_no_log");
        let err = send_report(&dir, "https://example.invalid", "anon-key", "tenant-1", "device-1", "0.1.4").unwrap_err();
        assert!(err.contains("no log file"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn send_report_reads_the_log_before_ever_touching_the_network() {
        // A file that exists but a supabase_url that can never resolve --
        // if this failed with a "failed to read log file" error instead of
        // a network error, that would mean the read step is broken, not
        // just unreachable-network flakiness.
        let dir = temp_dir("send_report_network");
        let mut f = fs::File::create(dir.join("app.log")).unwrap();
        f.write_all(b"some log content").unwrap();
        drop(f);

        let err = send_report(&dir, "https://this-host-does-not-exist.invalid", "anon-key", "tenant-1", "device-1", "0.1.4").unwrap_err();
        assert!(err.contains("could not reach diagnostics service"), "expected a network error, got: {err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
