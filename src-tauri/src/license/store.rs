//! Loads/saves the license file and holds the cached status that the rest
//! of the app reads. The cache exists specifically so a license check is
//! never on the hot path of a sale: `cached_status()` is a `Mutex` read of
//! an already-computed enum, not a signature verification.

use super::fingerprint;
use license_core::signed::{evaluate, verify_signature, LicenseError, LicenseStatus, SignedLicenseFile};
use ed25519_dalek::VerifyingKey;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct LicenseState {
    file_path: PathBuf,
    pubkey: VerifyingKey,
    cached: Mutex<LicenseStatus>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl LicenseState {
    /// Loads whatever license is currently on disk and evaluates it
    /// immediately -- this is the boot-time check. Never panics: a missing
    /// or corrupt file just yields `Invalid`, same as a hostile one.
    pub fn init(app_data_dir: PathBuf, pubkey: VerifyingKey) -> Self {
        let file_path = app_data_dir.join("license.lic");
        let state = Self { file_path, pubkey, cached: Mutex::new(LicenseStatus::Invalid { reason: "not yet checked".into() }) };
        state.recheck();
        state
    }

    fn load_file(&self) -> Option<SignedLicenseFile> {
        let bytes = std::fs::read(&self.file_path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Atomic write (temp file + rename) so a `kill -9` mid-write leaves
    /// either the old license or the new one, never a truncated file.
    fn save_file(&self, file: &SignedLicenseFile) -> std::io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp_path = self.file_path.with_extension("lic.tmp");
        std::fs::write(&tmp_path, serde_json::to_vec_pretty(file)?)?;
        std::fs::rename(&tmp_path, &self.file_path)?;
        Ok(())
    }

    /// Re-reads the license file off disk, re-evaluates against the
    /// current machine and clock, and updates the cache. Called at boot and
    /// on the 6h timer; cheap enough (one file read + one signature check)
    /// to also call from a UI "check now" action without concern.
    pub fn recheck(&self) -> LicenseStatus {
        let file = self.load_file();
        let current_machine = fingerprint::current();
        let status = evaluate(file.as_ref(), &self.pubkey, &current_machine, now_ms());
        *self.cached.lock().unwrap() = status.clone();
        status
    }

    /// The fast path every other command reads. Never touches disk or does
    /// crypto -- just the last value `recheck()` computed.
    pub fn cached_status(&self) -> LicenseStatus {
        self.cached.lock().unwrap().clone()
    }

    /// Installs a new signed blob (pasted/scanned/dropped in by the
    /// collector). Fully offline: no server call, just re-running the same
    /// verification the boot check does, plus a downgrade guard so an old
    /// (possibly cheaper/longer) blob can't be replayed over a newer one.
    pub fn accept_renewal(&self, new_file: SignedLicenseFile) -> Result<LicenseStatus, LicenseError> {
        let new_payload = verify_signature(&new_file, &self.pubkey)?;

        let current_machine = fingerprint::current();
        if !new_payload.machine_fingerprint.fuzzy_matches(&current_machine) {
            return Err(LicenseError::WrongMachine { tenant_id: new_payload.tenant_id.clone(), branch_id: new_payload.branch_id.clone() });
        }

        if let Some(existing_file) = self.load_file() {
            if let Ok(existing_payload) = verify_signature(&existing_file, &self.pubkey) {
                if new_payload.issued_at < existing_payload.issued_at {
                    return Err(LicenseError::StaleRenewal);
                }
            }
        }

        self.save_file(&new_file).map_err(|_| LicenseError::MalformedPayload)?;
        Ok(self.recheck())
    }
}

#[cfg(test)]
mod tests {
    use license_core::signed::test_support::*;
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("license_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_license_file_yields_invalid() {
        let dir = temp_dir("missing");
        let key = test_keypair();
        let state = LicenseState::init(dir, key.verifying_key());
        assert!(matches!(state.cached_status(), LicenseStatus::Invalid { .. }));
    }

    #[test]
    fn renewal_installs_and_recomputes_status() {
        let dir = temp_dir("renewal");
        let key = test_keypair();
        let state = LicenseState::init(dir, key.verifying_key());
        assert!(state.cached_status().back_office_locked(), "starts locked with no license");

        let machine = super::fingerprint::current();
        let now = chrono::Utc::now().timestamp_millis();
        let payload = sample_payload(machine, now - 1000, now + 30 * 86_400_000);
        let file = mint(&key, &payload);

        let status = state.accept_renewal(file).expect("valid renewal must be accepted");
        assert!(!status.back_office_locked());
        assert!(matches!(state.cached_status(), LicenseStatus::Active { .. }));
    }

    #[test]
    fn renewal_rejects_an_older_blob_than_currently_installed() {
        let dir = temp_dir("stale_renewal");
        let key = test_keypair();
        let state = LicenseState::init(dir, key.verifying_key());
        let machine = super::fingerprint::current();
        let now = chrono::Utc::now().timestamp_millis();

        let newer = mint(&key, &sample_payload(machine.clone(), now, now + 60 * 86_400_000));
        state.accept_renewal(newer).unwrap();

        // Attacker replays an older, previously-issued (possibly since-revoked
        // in spirit, e.g. a shorter trial) blob to try to roll back state.
        let older = mint(&key, &sample_payload(machine, now - 10 * 86_400_000, now + 5 * 86_400_000));
        let result = state.accept_renewal(older);
        assert_eq!(result, Err(LicenseError::StaleRenewal));
    }

    #[test]
    fn renewal_for_wrong_machine_is_rejected() {
        let dir = temp_dir("wrong_machine_renewal");
        let key = test_keypair();
        let state = LicenseState::init(dir, key.verifying_key());
        let now = chrono::Utc::now().timestamp_millis();

        let someone_elses_machine = super::fingerprint::MachineFingerprint::from_raw(Some("cpu-other"), Some("disk-other"), Some("mac-other"));
        let file = mint(&key, &sample_payload(someone_elses_machine, now, now + 30 * 86_400_000));

        let result = state.accept_renewal(file);
        assert!(matches!(result, Err(LicenseError::WrongMachine { .. })));
    }
}
