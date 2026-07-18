//! Slice 1c: the hybrid cloud+offline license check.
//!
//! The one invariant this whole module exists to protect: NO cloud failure
//! mode -- timeout, network error, garbage/non-2xx response -- ever locks a
//! valid license. Only an explicit, SUCCESSFUL "revoked" response does. A
//! dinner service must never go down because a VPS blipped.
//!
//! Precedence when `cached_status()` is read (cheap, no network -- the
//! actual cloud call happens separately, on a timer, via `refresh_from_cloud`):
//!   1. A cloud verdict from a successful check within the last
//!      `CLOUD_CACHE_GRACE_DAYS` -- authoritative, whether Active or Revoked.
//!   2. Otherwise, the existing offline Ed25519 blob's own evaluation
//!      (`license::store::LicenseState`, unchanged, with its own 7-day
//!      grace) -- this is what a device that has NEVER reached the cloud
//!      (fresh install, or offline past the cloud cache's grace) falls back
//!      to. Back-office only locks if BOTH have lapsed.

use crate::license::store::LicenseState;
use license_core::signed::{LicenseStatus, SignedLicenseFile};
use std::sync::Mutex;
use std::time::Duration;

/// Longer than the offline blob's own 7-day grace (see
/// `license_core::signed::GRACE_DAYS`) so a terminal that WAS successfully
/// talking to the cloud gets extra runway before falling back to the
/// (shorter) offline grace -- per the approved plan's adjustment #1.
pub const CLOUD_CACHE_GRACE_DAYS: i64 = 14;
pub const CLOUD_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const MS_PER_DAY: i64 = 86_400_000;

/// What a live cloud check produced. Deliberately collapses every failure
/// mode -- timeout, connection error, non-2xx, malformed JSON -- into the
/// single `Unreachable` variant: none of them may ever be treated as
/// "revoked". Only a successful response with an explicit verdict counts.
#[derive(Debug, Clone)]
pub enum CloudCheckOutcome {
    Success(CloudVerdict, Option<SignedLicenseFile>),
    Unreachable,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CloudVerdict {
    /// `status = 'active'` in the cloud row. Carries the cloud's own
    /// `expires_at` so a fresh-cache read can report a real days-remaining
    /// figure instead of a placeholder.
    Active { expires_at_ms: i64 },
    /// Any non-active cloud status (`revoked`, `superseded`, or the row not
    /// found at all for this id+token pair) -- all lock back-office.
    NotActive { reason: String },
}

/// The seam that makes this module unit-testable without a network: the
/// real implementation (`SupabaseCloudTransport`, below) speaks HTTP to the
/// `check_license` RPC; tests supply a fake that returns canned outcomes.
#[async_trait::async_trait]
pub trait CloudTransport: Send + Sync {
    async fn check(&self, license_id: &str, device_token: &str) -> CloudCheckOutcome;
}

/// Credentials needed to call the cloud at all. `None` means this device has
/// never been configured for cloud checking (e.g. a fresh, fully offline
/// install) -- `cached_status()` then falls straight through to the offline
/// blob, which is exactly the existing Slice-1a-and-earlier behavior.
#[derive(Clone)]
pub struct CloudConfig {
    pub license_id: String,
    pub device_token: String,
}

struct CloudCache {
    last_successful_check_at_ms: Option<i64>,
    last_verdict: Option<CloudVerdict>,
}

pub struct CloudLicenseState {
    offline: LicenseState,
    config: Option<CloudConfig>,
    transport: Box<dyn CloudTransport>,
    cache: Mutex<CloudCache>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The pure decision at the heart of this module -- no I/O, no clock reads,
/// fully exhaustible by unit tests. `offline_status` is whatever the
/// existing offline evaluator (`LicenseState::cached_status`) currently
/// says; this function decides whether the cloud cache overrides it.
fn combined_status(
    cache_last_success_ms: Option<i64>,
    cache_verdict: Option<&CloudVerdict>,
    offline_status: LicenseStatus,
    now_ms: i64,
) -> LicenseStatus {
    if let (Some(last_success), Some(verdict)) = (cache_last_success_ms, cache_verdict) {
        let age_days = (now_ms - last_success) / MS_PER_DAY;
        if age_days <= CLOUD_CACHE_GRACE_DAYS {
            return match verdict {
                CloudVerdict::Active { expires_at_ms } => {
                    LicenseStatus::Active { days_remaining: (expires_at_ms - now_ms) / MS_PER_DAY }
                }
                CloudVerdict::NotActive { reason } => {
                    LicenseStatus::Invalid { reason: format!("revoked by cloud: {reason}") }
                }
            };
        }
    }
    offline_status
}

impl CloudLicenseState {
    pub fn new(offline: LicenseState, config: Option<CloudConfig>, transport: Box<dyn CloudTransport>) -> Self {
        Self { offline, config, transport, cache: Mutex::new(CloudCache { last_successful_check_at_ms: None, last_verdict: None }) }
    }

    /// The fast path every command reads (mirrors `LicenseState::cached_status`
    /// exactly in signature, so callers only need a type-annotation change).
    /// Never touches the network -- just combines whatever the last
    /// `refresh_from_cloud` and the offline evaluator's own 6h timer computed.
    pub fn cached_status(&self) -> LicenseStatus {
        let cache = self.cache.lock().unwrap();
        combined_status(cache.last_successful_check_at_ms, cache.last_verdict.as_ref(), self.offline.cached_status(), now_ms())
    }

    /// Performs the actual cloud round trip (bounded by `CLOUD_CHECK_TIMEOUT`
    /// inside the transport) and updates the cache. On a successful "active"
    /// verdict that also carries a fresh signed blob, opportunistically
    /// installs it via the existing offline `accept_renewal` path -- silent
    /// renewal, no user action required. Never called from `cached_status`'s
    /// hot path; meant for a periodic background timer (and an initial
    /// best-effort call at boot).
    pub async fn refresh_from_cloud(&self) {
        let Some(config) = &self.config else { return };
        let outcome = self.transport.check(&config.license_id, &config.device_token).await;

        match outcome {
            CloudCheckOutcome::Success(verdict, renewal) => {
                {
                    let mut cache = self.cache.lock().unwrap();
                    cache.last_successful_check_at_ms = Some(now_ms());
                    cache.last_verdict = Some(verdict);
                }
                if let Some(file) = renewal {
                    // Best-effort: a stale/wrong-machine/malformed renewal is
                    // silently ignored, never surfaced as a failure -- the
                    // cloud verdict above already updated the cache, which is
                    // what actually gates back-office access.
                    let _ = self.offline.accept_renewal(file);
                }
            }
            CloudCheckOutcome::Unreachable => {
                // Deliberately does NOT touch the cache. An unreachable cloud
                // leaves whatever was cached (possibly nothing) exactly as it
                // was -- `combined_status` then falls through to cache-age or
                // the offline blob on its own.
            }
        }
    }

    /// Re-runs the offline evaluator against whatever's currently on disk
    /// (unchanged from Slice 1a/1b's own 6h timer) -- kept as a passthrough
    /// here so the app only needs to hold one managed state, not two.
    pub fn recheck_offline(&self) -> LicenseStatus {
        self.offline.recheck()
    }

    /// `check_license_v3`'s "check now" passthrough -- re-evaluates the
    /// offline blob, then returns the combined (cloud-aware) status, so a
    /// manual check reflects the same precedence `cached_status()` always
    /// does rather than the raw offline result alone.
    pub fn recheck(&self) -> LicenseStatus {
        self.offline.recheck();
        self.cached_status()
    }

    /// `renew_license_v3`'s passthrough -- installing an offline renewal
    /// blob is unchanged by Slice 1c, it's still the existing fully-offline
    /// `LicenseState::accept_renewal` path.
    pub fn accept_renewal(&self, new_file: SignedLicenseFile) -> Result<LicenseStatus, license_core::signed::LicenseError> {
        self.offline.accept_renewal(new_file)?;
        Ok(self.cached_status())
    }
}

/// Public Supabase project URL + anon key. Unlike `LICENSE_PUBLIC_KEY_B64`
/// these are DESIGNED to be embedded in public clients -- that's the entire
/// point of RLS plus the already-proven `check_license` grant restriction
/// (Slice 1b's RLS probes). Placeholders here, swapped for the real
/// production project's values as a build-config step, not bundled into
/// this slice; overridable via env vars so local/dev runs don't require
/// editing source.
pub const SUPABASE_URL_PLACEHOLDER: &str = "https://REPLACE-WITH-PRODUCTION-PROJECT.supabase.co";
pub const SUPABASE_ANON_KEY_PLACEHOLDER: &str = "REPLACE-WITH-PRODUCTION-ANON-KEY";

pub fn supabase_url() -> String {
    std::env::var("ZAEEM_SUPABASE_URL").unwrap_or_else(|_| SUPABASE_URL_PLACEHOLDER.to_string())
}

pub fn supabase_anon_key() -> String {
    std::env::var("ZAEEM_SUPABASE_ANON_KEY").unwrap_or_else(|_| SUPABASE_ANON_KEY_PLACEHOLDER.to_string())
}

/// Loads the per-device `{license_id, device_token}` pair written during
/// activation. Missing/corrupt file => `None` => `CloudLicenseState` never
/// calls the cloud at all and behaves exactly like the pre-Slice-1c
/// offline-only path -- the same "fail closed on cloud, never on the
/// offline blob" posture as everything else in this module.
pub fn load_config_from_file(path: &std::path::Path) -> Option<CloudConfig> {
    #[derive(serde::Deserialize)]
    struct Raw {
        license_id: String,
        device_token: String,
    }
    let bytes = std::fs::read(path).ok()?;
    let raw: Raw = serde_json::from_slice(&bytes).ok()?;
    Some(CloudConfig { license_id: raw.license_id, device_token: raw.device_token })
}

/// Production transport: calls Supabase's `check_license` RPC directly
/// (PostgREST's `/rest/v1/rpc/<fn>` convention) with the anon key -- the
/// exact same, already-proven-restricted entry point the Slice 1b RLS
/// probes exercised. Never uses service_role (this runs on end-user
/// hardware, not a trusted server).
pub struct SupabaseCloudTransport {
    base_url: String,
    anon_key: String,
    client: reqwest::Client,
}

impl SupabaseCloudTransport {
    pub fn new(base_url: String, anon_key: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(CLOUD_CHECK_TIMEOUT)
            .build()
            .expect("reqwest client with a fixed timeout always builds");
        Self { base_url, anon_key, client }
    }
}

#[derive(serde::Deserialize)]
struct CheckLicenseRow {
    status: String,
    expires_at: String,
    #[serde(default)]
    payload_json: Option<String>,
    #[serde(default)]
    signature_b64: Option<String>,
}

#[async_trait::async_trait]
impl CloudTransport for SupabaseCloudTransport {
    async fn check(&self, license_id: &str, device_token: &str) -> CloudCheckOutcome {
        let url = format!("{}/rest/v1/rpc/check_license", self.base_url);
        let body = serde_json::json!({ "p_license_id": license_id, "p_device_token": device_token });

        let response = match self.client.post(&url).header("apikey", &self.anon_key).header("Authorization", format!("Bearer {}", self.anon_key)).json(&body).send().await {
            Ok(r) => r,
            Err(_) => return CloudCheckOutcome::Unreachable, // timeout, DNS failure, connection refused, etc.
        };

        if !response.status().is_success() {
            return CloudCheckOutcome::Unreachable;
        }

        let rows: Vec<CheckLicenseRow> = match response.json().await {
            Ok(r) => r,
            Err(_) => return CloudCheckOutcome::Unreachable, // garbage/malformed body
        };

        let Some(row) = rows.into_iter().next() else {
            // Empty result: id+token pair didn't match any row. Cannot
            // distinguish "revoked" from "never existed" here (same as the
            // RLS proof's anon-side behavior), so it locks -- but this still
            // only happens on a SUCCESSFUL, well-formed response, never a
            // network failure.
            return CloudCheckOutcome::Success(CloudVerdict::NotActive { reason: "no matching license".to_string() }, None);
        };

        let expires_at_ms = match chrono::DateTime::parse_from_rfc3339(&row.expires_at) {
            Ok(dt) => dt.timestamp_millis(),
            Err(_) => return CloudCheckOutcome::Unreachable, // malformed timestamp -- treat as garbage, not as revoked
        };

        let verdict = if row.status == "active" {
            CloudVerdict::Active { expires_at_ms }
        } else {
            CloudVerdict::NotActive { reason: row.status }
        };

        let renewal = match (row.payload_json, row.signature_b64) {
            (Some(payload_json), Some(signature_b64)) => Some(SignedLicenseFile { payload_json, signature_b64 }),
            _ => None,
        };

        CloudCheckOutcome::Success(verdict, renewal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use license_core::signed::test_support::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cloud_license_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct ScriptedTransport {
        outcome: CloudCheckOutcome,
        calls: AtomicUsize,
    }

    impl ScriptedTransport {
        fn new(outcome: CloudCheckOutcome) -> Self {
            Self { outcome, calls: AtomicUsize::new(0) }
        }
    }

    #[async_trait::async_trait]
    impl CloudTransport for ScriptedTransport {
        async fn check(&self, _license_id: &str, _device_token: &str) -> CloudCheckOutcome {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcome.clone()
        }
    }

    fn offline_state_with_blob(dir_name: &str, days_from_now_expiry: i64) -> (LicenseState, ed25519_dalek::SigningKey) {
        let dir = temp_dir(dir_name);
        let key = test_keypair();
        let state = LicenseState::init(dir, key.verifying_key());
        let machine = crate::license::fingerprint::current();
        let now = chrono::Utc::now().timestamp_millis();
        let payload = sample_payload(machine, now - 30 * 86_400_000, now + days_from_now_expiry * 86_400_000);
        let file = mint(&key, &payload);
        state.accept_renewal(file).expect("valid renewal must be accepted");
        (state, key)
    }

    fn offline_state_with_no_license(dir_name: &str) -> LicenseState {
        let dir = temp_dir(dir_name);
        let key = test_keypair();
        LicenseState::init(dir, key.verifying_key())
    }

    fn cloud_config() -> Option<CloudConfig> {
        Some(CloudConfig { license_id: "lic-1".into(), device_token: "token-1".into() })
    }

    // --- 1. valid online: cloud says active, must not lock ---
    #[tokio::test]
    async fn valid_online_is_not_locked() {
        let (offline, _key) = offline_state_with_blob("valid_online", 30);
        let now = chrono::Utc::now().timestamp_millis();
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 30 * 86_400_000 }, None));
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "valid online check must not lock, got {status:?}");
        assert!(matches!(status, LicenseStatus::Active { .. }));
    }

    // --- 2. cloud explicitly says revoked: must lock, even though the offline blob is still within its own validity window ---
    #[tokio::test]
    async fn cloud_says_revoked_locks_even_with_valid_offline_blob() {
        let (offline, _key) = offline_state_with_blob("cloud_revoked", 30); // offline blob still has 30 days left
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::NotActive { reason: "revoked".into() }, None));
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(status.back_office_locked(), "an explicit successful revoke must lock even if the offline blob looks fine, got {status:?}");
    }

    // --- 3. cloud is down, but within the 14-day cache grace: last known-good cloud verdict (active) still applies ---
    #[tokio::test]
    async fn cloud_down_within_cache_grace_uses_cached_active_verdict() {
        let (offline, _key) = offline_state_with_blob("cache_grace_within", -20); // offline blob itself is long past its own 7-day grace
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        // Simulate a successful check that happened 10 days ago (within the 14-day cache grace).
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 10 * 86_400_000);
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now + 5 * 86_400_000 });
        }

        // A live check right now fails (network down) -- must NOT clear the cache.
        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "cloud-down-but-within-cache-grace must still read as not locked, got {status:?}");
    }

    // --- 4. cloud down, past the 14-day cache grace: falls through to the offline blob, which is itself still valid ---
    #[tokio::test]
    async fn cloud_down_past_cache_grace_falls_to_valid_offline_blob() {
        let (offline, _key) = offline_state_with_blob("cache_grace_past_valid_offline", 10); // offline blob still has 10 days left
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 20 * 86_400_000); // 20 days ago, past the 14-day grace
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now - 10 * 86_400_000 });
        }

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "must fall through to the still-valid offline blob, got {status:?}");
        assert!(matches!(status, LicenseStatus::Active { .. }), "expected the offline blob's own Active status, got {status:?}");
    }

    // --- 5. cloud down, past cache grace, AND the offline blob is also expired past its own 7-day grace: only now must it lock ---
    #[tokio::test]
    async fn offline_blob_also_expired_locks_only_when_both_lapse() {
        let (offline, _key) = offline_state_with_blob("both_lapsed", -20); // expired 20 days ago, past the 7-day offline grace
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 20 * 86_400_000); // past the 14-day cache grace too
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now - 20 * 86_400_000 });
        }

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(status.back_office_locked(), "both the cloud cache and the offline blob have lapsed -- this must lock, got {status:?}");
    }

    // --- 6. fresh install, fully offline, never once reached the cloud: must behave exactly like the pre-Slice-1c offline-only path ---
    #[tokio::test]
    async fn never_checked_cloud_falls_straight_to_offline_blob() {
        let (offline, _key) = offline_state_with_blob("never_checked_valid", 30);
        // No cloud config at all -- simulates a device that was never
        // handed cloud credentials, e.g. activated fully offline.
        let cloud = CloudLicenseState::new(offline, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        cloud.refresh_from_cloud().await; // should be a no-op: no config means no call at all
        let status = cloud.cached_status();
        assert!(!status.back_office_locked());
        assert!(matches!(status, LicenseStatus::Active { .. }));
    }

    #[tokio::test]
    async fn never_checked_cloud_with_no_config_never_calls_transport() {
        let offline = offline_state_with_no_license("never_checked_no_call");
        struct CountingTransport(AtomicUsize);
        #[async_trait::async_trait]
        impl CloudTransport for CountingTransport {
            async fn check(&self, _license_id: &str, _device_token: &str) -> CloudCheckOutcome {
                self.0.fetch_add(1, Ordering::SeqCst);
                CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: 0 }, None)
            }
        }
        let transport = CountingTransport(AtomicUsize::new(0));
        let cloud = CloudLicenseState::new(offline, None, Box::new(transport));
        cloud.refresh_from_cloud().await;
        // No way to inspect the box after moving it in -- the meaningful
        // assertion is behavioral: with no config, a fresh install with no
        // license file at all stays locked (Invalid), it does NOT crash and
        // does NOT get magically activated by a transport it should never
        // have called.
        assert!(cloud.cached_status().back_office_locked());
    }

    // --- 7. cloud returns garbage / 500: must NOT be treated as revoked ---
    #[tokio::test]
    async fn cloud_returns_garbage_or_500_does_not_lock() {
        let (offline, _key) = offline_state_with_blob("garbage_response", 30);
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "a garbage/500 cloud response must fall through to the valid offline blob, not lock, got {status:?}");

        // And explicitly: the cache must remain empty -- a failure must never populate a Revoked verdict.
        let cache = cloud.cache.lock().unwrap();
        assert!(cache.last_verdict.is_none(), "an unreachable/garbage response must never write a verdict into the cache");
    }

    // --- opportunistic silent renewal: a successful check carrying a fresh signed blob installs it via accept_renewal ---
    #[tokio::test]
    async fn successful_check_with_renewal_blob_installs_it_silently() {
        let (offline, key) = offline_state_with_blob("silent_renewal", 5); // currently expires in 5 days
        let now = chrono::Utc::now().timestamp_millis();
        let machine = crate::license::fingerprint::current();
        let fresh_payload = sample_payload(machine, now, now + 365 * 86_400_000); // a fresh year-long renewal
        let fresh_file = mint(&key, &fresh_payload);

        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 365 * 86_400_000 }, Some(fresh_file)));
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        cloud.recheck_offline(); // re-read the (now renewed) offline blob off disk
        let offline_status = cloud.offline.cached_status();
        assert!(matches!(offline_status, LicenseStatus::Active { days_remaining } if days_remaining > 300), "expected the silently-installed year-long renewal to be reflected in the offline evaluator, got {offline_status:?}");
    }

    // A malformed/wrong-machine renewal blob must not crash or block the cloud verdict itself from applying.
    #[tokio::test]
    async fn malformed_renewal_blob_does_not_break_the_cloud_verdict() {
        let (offline, _key) = offline_state_with_blob("bad_renewal_blob", 30);
        let now = chrono::Utc::now().timestamp_millis();
        let bogus = SignedLicenseFile { payload_json: "not json".into(), signature_b64: "not base64!!".into() };
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 30 * 86_400_000 }, Some(bogus)));
        let cloud = CloudLicenseState::new(offline, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "a bogus renewal blob must be silently ignored, not break the cloud verdict, got {status:?}");
    }
}
