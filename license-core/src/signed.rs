//! The signed license blob: payload shape, signing, and Ed25519
//! verification. Both the signing service and the app's offline verifier
//! depend on this crate rather than each other -- there is exactly one
//! implementation of "what bytes get signed" and "what a valid signature
//! looks like," so they cannot drift apart.

use crate::b64;
use crate::fingerprint::MachineFingerprint;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
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
    /// (the app has no server to hold one against when fully offline) but
    /// it does mean two blobs for the same tenant/expiry are never
    /// byte-identical, which keeps `issued_at` monotonicity (the actual
    /// downgrade defense, see `zaeem-pos`'s `LicenseState::accept_renewal`)
    /// meaningful even for same-day reissues.
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

/// The one, shared signing operation. Used by the signing service, the
/// local `license_signer` CLI, and test helpers -- never reimplemented.
pub fn sign_payload(signing_key: &SigningKey, payload: &LicensePayload) -> SignedLicenseFile {
    let payload_json = serde_json::to_string(payload).expect("LicensePayload always serializes");
    let signature = signing_key.sign(payload_json.as_bytes());
    SignedLicenseFile {
        payload_json,
        signature_b64: b64::encode(&signature.to_bytes()),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LicenseError {
    MalformedSignature,
    ForgedOrCorruptSignature,
    MalformedPayload,
    /// Signature verified (so the payload is authentic), but this
    /// machine's fingerprint doesn't match -- carries the payload's own
    /// `tenant_id`/`branch_id` so callers (e.g. the activation UI) can look
    /// up "how many OTHER active seats does this branch have" and tell an
    /// unpaid-terminal install apart from a genuinely unknown/new branch.
    WrongMachine { tenant_id: String, branch_id: String },
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
            Self::WrongMachine { .. } => write!(f, "license was not issued for this machine"),
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
    /// `plan`/`expires_at` are carried on every variant that has a verified
    /// payload to read them from -- added so a Settings-style UI can show
    /// real plan/expiry, not just a days-remaining number. `expires_at` is
    /// epoch millis, per this repo's time convention.
    Active { days_remaining: i64, plan: String, expires_at: i64 },
    /// Expired but within the grace window. POS + printing are completely
    /// unaffected; this is nag-banner-only.
    Grace { days_left_in_grace: i64, plan: String, expires_at: i64 },
    /// Grace exhausted. Back-office/reports must lock; POS keeps selling
    /// regardless -- that gate lives in the app's command layer, not here.
    LockedBackOffice { days_since_grace_ended: i64, plan: String, expires_at: i64 },
    /// No usable license at all (missing file, forged signature, wrong
    /// machine, corrupt payload). Back-office locks immediately; POS still
    /// sells, same as `LockedBackOffice`. No verified payload exists in this
    /// case, so there's no plan/expiry to report.
    Invalid { reason: String },
}

impl LicenseStatus {
    /// The one thing every consumer of this status actually needs to
    /// branch on for gating non-POS commands.
    pub fn back_office_locked(&self) -> bool {
        matches!(self, LicenseStatus::LockedBackOffice { .. } | LicenseStatus::Invalid { .. })
    }
}

/// The full offline decision: verify signature, verify machine, then
/// classify by expiry. `now_ms` is a parameter (not `Utc::now()`
/// internally) so tests can freely simulate "6 days past expiry" etc.
/// without sleeping. This is the fallback layer the app's hybrid
/// cloud+offline check (Slice 1c) falls back to when the cloud is
/// unreachable -- unchanged by that work, still the sole source of truth
/// when fully offline.
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
        return LicenseStatus::Invalid { reason: LicenseError::WrongMachine { tenant_id: payload.tenant_id.clone(), branch_id: payload.branch_id.clone() }.to_string() };
    }

    if now_ms <= payload.expires_at {
        let days_remaining = (payload.expires_at - now_ms) / MS_PER_DAY;
        return LicenseStatus::Active { days_remaining, plan: payload.plan, expires_at: payload.expires_at };
    }

    let days_past_expiry = (now_ms - payload.expires_at) / MS_PER_DAY;
    if days_past_expiry <= GRACE_DAYS {
        return LicenseStatus::Grace { days_left_in_grace: GRACE_DAYS - days_past_expiry, plan: payload.plan, expires_at: payload.expires_at };
    }

    LicenseStatus::LockedBackOffice { days_since_grace_ended: days_past_expiry - GRACE_DAYS, plan: payload.plan, expires_at: payload.expires_at }
}

/// Test/dev helpers -- deliberately NOT `#[cfg(test)]`. That attribute only
/// applies when THIS crate's own tests are built; a downstream crate (the
/// app, the signing service) building ITS OWN tests would not see the
/// module at all if it were cfg(test)-gated here, since `cfg(test)` is
/// evaluated per-crate, not transitively. Both zaeem-pos's and
/// license-signer's test suites use this.
pub mod test_support {
    use super::*;
    use rand::rngs::OsRng;

    pub fn test_keypair() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    /// Alias for `sign_payload` kept for continuity with existing test call
    /// sites -- exercises the exact same, single, real signing function.
    pub fn mint(signing_key: &SigningKey, payload: &LicensePayload) -> SignedLicenseFile {
        sign_payload(signing_key, payload)
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
        assert_eq!(status, LicenseStatus::Active { days_remaining: 20, plan: "standard".into(), expires_at: now + 20 * DAY });
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
        assert_eq!(status, LicenseStatus::Grace { days_left_in_grace: 4, plan: "standard".into(), expires_at: now - 3 * DAY });
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
        assert_eq!(status, LicenseStatus::LockedBackOffice { days_since_grace_ended: 3, plan: "standard".into(), expires_at: now - 10 * DAY });
        assert!(status.back_office_locked());
    }

    // --- 4. wrong machine (partial hardware match, still fails 2-of-3) ---
    #[test]
    fn wrong_machine_with_one_matching_component_is_rejected() {
        let key = test_keypair();
        let now = 1_000_000 * DAY;
        let licensed_machine = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let payload = sample_payload(licensed_machine, now - 10 * DAY, now + 20 * DAY);
        let file = mint(&key, &payload);

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
        let file = mint(&key, &payload);

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
