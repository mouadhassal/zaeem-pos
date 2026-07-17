//! The signed license blob itself: payload shape, Ed25519 verification, and
//! the expiry/grace state machine. Verification happens entirely in Rust
//! against a public key compiled into this binary -- the frontend never
//! sees the private key and never makes the trust decision.

use super::b64;
use super::fingerprint::MachineFingerprint;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Grace window: expired-but-still-selling. Non-negotiable per product
/// policy -- a dinner service is never interrupted by a lapsed license.
pub const GRACE_DAYS: i64 = 7;
const MS_PER_DAY: i64 = 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LicensePayload {
    pub tenant_id: String,
    pub branch_id: String,
    pub machine_fingerprint: MachineFingerprint,
    pub market: String,
    pub plan: String,
    pub features: Vec<String>,
    /// Epoch millis (UTC), per this repo's time convention.
    pub issued_at: i64,
    pub expires_at: i64,
    /// Unique per mint; not independently checked against a used-nonce log
    /// (there is no server to hold one offline) but it does mean two blobs
    /// for the same tenant/expiry are never byte-identical, which keeps
    /// `issued_at` monotonicity (the actual downgrade defense, see
    /// `LicenseStore::accept_renewal`) meaningful even for same-day reissues.
    pub nonce: String,
}

/// On-disk / wire format. `payload_json` is the *exact* bytes that were
/// signed -- verification checks the signature against these bytes
/// directly, then parses them. This sidesteps any risk of the signer's and
/// verifier's JSON serialization disagreeing on field order or whitespace,
/// which would otherwise make signature checks flaky-fragile.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignedLicenseFile {
    pub payload_json: String,
    pub signature_b64: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum LicenseError {
    MalformedSignature,
    ForgedOrCorruptSignature,
    MalformedPayload,
    WrongMachine,
    /// A renewal blob whose `issued_at` is older than the currently
    /// installed license -- rejected so an old (shorter/cheaper/revoked)
    /// blob can't be replayed to roll back the license state.
    StaleRenewal,
}

impl std::fmt::Display for LicenseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedSignature => write!(f, "license signature is not valid base64/64 bytes"),
            Self::ForgedOrCorruptSignature => write!(f, "license signature does not verify against the embedded public key"),
            Self::MalformedPayload => write!(f, "license payload is not valid JSON"),
            Self::WrongMachine => write!(f, "license was not issued for this machine"),
            Self::StaleRenewal => write!(f, "this renewal is older than the currently installed license"),
        }
    }
}

/// Verifies the signature and returns the parsed payload. Does NOT check
/// machine fingerprint or expiry -- those are separate, composable checks
/// (see `evaluate`), so tests can exercise "signature ok but wrong machine"
/// independently of "signature ok but expired".
pub fn verify_signature(file: &SignedLicenseFile, pubkey: &VerifyingKey) -> Result<LicensePayload, LicenseError> {
    let sig_bytes = b64::decode(&file.signature_b64).ok_or(LicenseError::MalformedSignature)?;
    let sig_array: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| LicenseError::MalformedSignature)?;
    let signature = Signature::from_bytes(&sig_array);

    pubkey
        .verify(file.payload_json.as_bytes(), &signature)
        .map_err(|_| LicenseError::ForgedOrCorruptSignature)?;

    serde_json::from_str::<LicensePayload>(&file.payload_json).map_err(|_| LicenseError::MalformedPayload)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum LicenseStatus {
    Active { days_remaining: i64 },
    /// Expired but within the grace window. POS + printing are completely
    /// unaffected; this is nag-banner-only.
    Grace { days_left_in_grace: i64 },
    /// Grace exhausted. Back-office/reports must lock; POS keeps selling
    /// regardless -- that gate lives in the command layer, not here.
    LockedBackOffice { days_since_grace_ended: i64 },
    /// No usable license at all (missing file, forged signature, wrong
    /// machine, corrupt payload). Back-office locks immediately; POS still
    /// sells, same as `LockedBackOffice`.
    Invalid { reason: String },
}

impl LicenseStatus {
    /// The one thing every consumer of this status actually needs to
    /// branch on for gating non-POS commands.
    pub fn back_office_locked(&self) -> bool {
        matches!(self, LicenseStatus::LockedBackOffice { .. } | LicenseStatus::Invalid { .. })
    }
}

/// The full decision: verify signature, verify machine, then classify by
/// expiry. `now_ms` is a parameter (not `Utc::now()` internally) so tests
/// can freely simulate "6 days past expiry" etc. without sleeping.
pub fn evaluate(
    file: Option<&SignedLicenseFile>,
    pubkey: &VerifyingKey,
    current_machine: &MachineFingerprint,
    now_ms: i64,
) -> LicenseStatus {
    let Some(file) = file else {
        return LicenseStatus::Invalid { reason: "no license file present".into() };
    };

    let payload = match verify_signature(file, pubkey) {
        Ok(p) => p,
        Err(e) => return LicenseStatus::Invalid { reason: e.to_string() },
    };

    if !payload.machine_fingerprint.fuzzy_matches(current_machine) {
        return LicenseStatus::Invalid { reason: LicenseError::WrongMachine.to_string() };
    }

    if now_ms <= payload.expires_at {
        let days_remaining = (payload.expires_at - now_ms) / MS_PER_DAY;
        return LicenseStatus::Active { days_remaining };
    }

    let days_past_expiry = (now_ms - payload.expires_at) / MS_PER_DAY;
    if days_past_expiry <= GRACE_DAYS {
        return LicenseStatus::Grace { days_left_in_grace: GRACE_DAYS - days_past_expiry };
    }

    LicenseStatus::LockedBackOffice { days_since_grace_ended: days_past_expiry - GRACE_DAYS }
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use rand::rngs::OsRng;

    pub fn test_keypair() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    pub fn mint(signing_key: &SigningKey, payload: &LicensePayload) -> SignedLicenseFile {
        let payload_json = serde_json::to_string(payload).unwrap();
        let signature = signing_key.sign(payload_json.as_bytes());
        SignedLicenseFile {
            payload_json,
            signature_b64: b64::encode(&signature.to_bytes()),
        }
    }

    pub fn sample_payload(machine: MachineFingerprint, issued_at: i64, expires_at: i64) -> LicensePayload {
        LicensePayload {
            tenant_id: "tenant-1".into(),
            branch_id: "branch-1".into(),
            machine_fingerprint: machine,
            market: "SY".into(),
            plan: "standard".into(),
            features: vec!["pos".into(), "kds".into()],
            issued_at,
            expires_at,
            nonce: "test-nonce-1".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const DAY: i64 = MS_PER_DAY;

    fn machine() -> MachineFingerprint {
        MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"))
    }

    // --- 1. valid ---
    #[test]
    fn valid_unexpired_license_is_active() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let payload = sample_payload(machine(), now - 10 * DAY, now + 20 * DAY);
        let file = mint(&key, &payload);

        let status = evaluate(Some(&file), &key.verifying_key(), &machine(), now);
        assert_eq!(status, LicenseStatus::Active { days_remaining: 20 });
        assert!(!status.back_office_locked());
    }

    // --- 2. expired, in grace ---
    #[test]
    fn expired_in_grace_still_sells_pos_and_prints() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let payload = sample_payload(machine(), now - 30 * DAY, now - 3 * DAY); // expired 3 days ago
        let file = mint(&key, &payload);

        let status = evaluate(Some(&file), &key.verifying_key(), &machine(), now);
        assert_eq!(status, LicenseStatus::Grace { days_left_in_grace: 4 });
        assert!(!status.back_office_locked(), "grace period must not lock anything -- nag banner only");
    }

    // --- 3. expired, past grace ---
    #[test]
    fn expired_past_grace_locks_back_office_only() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let payload = sample_payload(machine(), now - 60 * DAY, now - 10 * DAY); // 10 days past expiry, grace is 7
        let file = mint(&key, &payload);

        let status = evaluate(Some(&file), &key.verifying_key(), &machine(), now);
        assert_eq!(status, LicenseStatus::LockedBackOffice { days_since_grace_ended: 3 });
        assert!(status.back_office_locked());
        // The POS-keeps-selling half of this guarantee is enforced by the
        // command layer never consulting this flag for order/payment/print
        // commands -- see commands_v3.rs and the "gate" module doc comment.
    }

    // --- 4. wrong machine (partial hardware match, still fails 2-of-3) ---
    #[test]
    fn wrong_machine_with_one_matching_component_is_rejected() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let licensed_machine = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let payload = sample_payload(licensed_machine, now - 10 * DAY, now + 20 * DAY);
        let file = mint(&key, &payload);

        // Only the MAC matches (e.g. a NIC moved into different hardware) -- 1-of-3, fails.
        let different_machine = MachineFingerprint::from_raw(Some("cpu-DIFFERENT"), Some("disk-DIFFERENT"), Some("mac-1"));
        let status = evaluate(Some(&file), &key.verifying_key(), &different_machine, now);
        assert!(matches!(status, LicenseStatus::Invalid { .. }));
        assert!(status.back_office_locked());
    }

    // --- 5. forged signature ---
    #[test]
    fn forged_signature_is_rejected() {
        let key = test_keypair();
        let attacker_key = test_keypair();
        let now = 1_000_000 * DAY;
        let payload = sample_payload(machine(), now - 10 * DAY, now + 20 * DAY);
        // Signed with a DIFFERENT key than the one compiled into the binary.
        let file = mint(&attacker_key, &payload);

        let status = evaluate(Some(&file), &key.verifying_key(), &machine(), now);
        assert_eq!(status, LicenseStatus::Invalid { reason: LicenseError::ForgedOrCorruptSignature.to_string() });
    }

    #[test]
    fn tampered_payload_after_signing_is_rejected() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let payload = sample_payload(machine(), now - 10 * DAY, now + 20 * DAY);
        let mut file = mint(&key, &payload);
        // Attacker edits the JSON directly to extend expiry, without re-signing.
        file.payload_json = file.payload_json.replace("tenant-1", "tenant-1-pirated");

        let status = evaluate(Some(&file), &key.verifying_key(), &machine(), now);
        assert_eq!(status, LicenseStatus::Invalid { reason: LicenseError::ForgedOrCorruptSignature.to_string() });
    }

    // --- 6. copied to a completely new machine ---
    #[test]
    fn copied_db_and_license_to_new_machine_is_rejected() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let original_machine = MachineFingerprint::from_raw(Some("cpu-orig"), Some("disk-orig"), Some("mac-orig"));
        let payload = sample_payload(original_machine, now - 10 * DAY, now + 20 * DAY);
        let file = mint(&key, &payload); // this is the exact blob that would sit next to a copied .db file

        // A pirate copies app data dir (db + license.lic) wholesale onto a
        // second, completely different machine.
        let new_machine = MachineFingerprint::from_raw(Some("cpu-new"), Some("disk-new"), Some("mac-new"));
        let status = evaluate(Some(&file), &key.verifying_key(), &new_machine, now);

        assert!(matches!(status, LicenseStatus::Invalid { .. }), "a wholesale copy to new hardware must never verify");
        assert!(status.back_office_locked());
    }

    #[test]
    fn no_license_file_at_all_locks_back_office_but_is_distinguishable() {
        let key = test_keypair();
        let status = evaluate(None, &key.verifying_key(), &machine(), 1_000_000 * DAY);
        assert_eq!(status, LicenseStatus::Invalid { reason: "no license file present".into() });
    }
}
