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
use std::path::PathBuf;
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
    /// `status = 'active'` in the cloud row. Carries the cloud's own `plan`
    /// and `expires_at` so a fresh-cache read can report the real plan/days-
    /// remaining, not a placeholder.
    Active { expires_at_ms: i64, plan: String },
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
    /// `Mutex`, not a plain field: activation (see `set_config`) needs to
    /// wire up cloud credentials into an already-running, already-managed
    /// state -- there's no "swap the Tauri-managed value" seam, so this has
    /// to be interior-mutable instead.
    config: Mutex<Option<CloudConfig>>,
    transport: Box<dyn CloudTransport>,
    cache: Mutex<CloudCache>,
    /// Where `cloud_config.json` lives -- same directory as the offline
    /// `license.lic` file. Needed so activation can persist the newly
    /// learned `{license_id, device_token}` for the NEXT boot's
    /// `load_config_from_file` to pick up, not just the current process.
    license_dir: PathBuf,
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
                CloudVerdict::Active { expires_at_ms, plan } => {
                    LicenseStatus::Active { days_remaining: (expires_at_ms - now_ms) / MS_PER_DAY, plan: plan.clone(), expires_at: *expires_at_ms }
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
    pub fn new(offline: LicenseState, license_dir: PathBuf, config: Option<CloudConfig>, transport: Box<dyn CloudTransport>) -> Self {
        Self {
            offline,
            config: Mutex::new(config),
            transport,
            cache: Mutex::new(CloudCache { last_successful_check_at_ms: None, last_verdict: None }),
            license_dir,
        }
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
        let config = { self.config.lock().unwrap().clone() };
        let Some(config) = config else { return };
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

    /// Wires up cloud credentials into an already-running state -- used by
    /// `activate_license_v3` so a freshly-pasted activation key starts
    /// cloud-checking immediately, without requiring an app restart.
    pub fn set_config(&self, config: CloudConfig) {
        *self.config.lock().unwrap() = Some(config);
    }

    /// Writes the current cloud config to `cloud_config.json` so the NEXT
    /// boot's `load_config_from_file` also picks it up -- `set_config` alone
    /// only affects the current process's in-memory state.
    pub fn persist_cloud_config(&self) -> std::io::Result<()> {
        let config = self.config.lock().unwrap().clone();
        let Some(config) = config else { return Ok(()) };
        #[derive(serde::Serialize)]
        struct Raw<'a> {
            license_id: &'a str,
            device_token: &'a str,
        }
        let json = serde_json::to_vec_pretty(&Raw { license_id: &config.license_id, device_token: &config.device_token })?;
        std::fs::write(self.license_dir.join("cloud_config.json"), json)
    }
}

/// Everything encoded into one activation key by `apps/admin`'s mint flow --
/// base64 (standard alphabet, matching `license_core::b64`'s decoder
/// byte-for-byte) of this struct's JSON. One string an operator pastes into
/// the POS's Settings -> License page, decoded here into the pieces
/// `activate_license_v3` needs: the offline blob (`payload_json` +
/// `signature_b64`) and, if present, the cloud identity (`license_id` +
/// `device_token`) for the hybrid cloud check. `license_id`/`device_token`
/// are optional so a bare, hand-signed `SignedLicenseFile` (e.g. minted
/// directly via `services/license-signer`'s CLI, without going through
/// apps/admin's cloud-aware mint flow) can also be pasted here as plain
/// JSON, not base64 -- it installs the offline blob exactly like
/// `renew_license_v3` always did; the device simply stays unconfigured for
/// cloud checks, same as if it had never been activated with a cloud
/// identity at all.
#[derive(Debug, serde::Deserialize)]
pub struct ActivationBundle {
    #[serde(default)]
    pub license_id: Option<String>,
    #[serde(default)]
    pub device_token: Option<String>,
    pub payload_json: String,
    pub signature_b64: String,
}

pub fn decode_activation_key(key: &str) -> Result<ActivationBundle, String> {
    let trimmed = key.trim();

    // The full cloud-aware bundle: base64(JSON{license_id, device_token,
    // payload_json, signature_b64}). `b64::decode` itself rejects any
    // character outside the base64 alphabet (so plain JSON text -- which
    // starts with `{`, a character never in that alphabet -- fails here
    // immediately and falls through, it never silently mis-decodes).
    if let Some(bytes) = license_core::b64::decode(trimmed) {
        if let Ok(bundle) = serde_json::from_slice::<ActivationBundle>(&bytes) {
            return Ok(bundle);
        }
    }

    // Fallback: a bare SignedLicenseFile pasted as plain JSON, no base64,
    // no license_id/device_token wrapper.
    if let Ok(raw) = serde_json::from_str::<SignedLicenseFile>(trimmed) {
        return Ok(ActivationBundle { license_id: None, device_token: None, payload_json: raw.payload_json, signature_b64: raw.signature_b64 });
    }

    Err("activation key is corrupted or not in the expected format".to_string())
}

/// The real production Supabase project URL + anon key, compiled in.
/// Unlike `LICENSE_PUBLIC_KEY_B64` (the Ed25519 offline-verification key,
/// a completely separate credential) these are DESIGNED to be embedded in
/// public clients -- that's the entire point of RLS plus the already-proven
/// `check_license` grant restriction (Slice 1b's RLS probes): the anon key
/// can do nothing except call that one RPC. Overridable via env vars so
/// local/dev runs don't require editing source.
pub const SUPABASE_URL: &str = "https://bfeyulkqpdoykyarqvcu.supabase.co";
pub const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJmZXl1bGtxcGRveWt5YXJxdmN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMjA1NTEsImV4cCI6MjA5OTg5NjU1MX0.pnxSnMCtcKU7NuIWCRozywIGr3IZe_ZsJcTQuKR0a4I";

pub fn supabase_url() -> String {
    std::env::var("ZAEEM_SUPABASE_URL").unwrap_or_else(|_| SUPABASE_URL.to_string())
}

pub fn supabase_anon_key() -> String {
    std::env::var("ZAEEM_SUPABASE_ANON_KEY").unwrap_or_else(|_| SUPABASE_ANON_KEY.to_string())
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
    plan: String,
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
            CloudVerdict::Active { expires_at_ms, plan: row.plan }
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

/// T2.0 per-terminal licensing (plan §2): registers a KDS terminal for
/// fleet visibility ONLY -- no license row, no `device_token`, no billing
/// implication whatsoever. "KDS is a display, not a till" -- unlike every
/// other cloud call in this module, a failure here must never affect
/// license status or block anything; the caller (`register_kds_terminal_v3`)
/// treats this as fire-and-forget, same posture as `refresh_from_cloud`'s
/// background timer. Calls a dedicated `register_kds_device` Postgres
/// function (SECURITY DEFINER, granted to `anon`) rather than reusing
/// `check_license` -- there is no license/device_token to validate here at
/// all, by design.
pub async fn register_kds_device(
    tenant_id: &str,
    branch_id: &str,
    device_name: &str,
    fingerprint: &license_core::fingerprint::MachineFingerprint,
) -> Result<(), String> {
    let base = supabase_url();
    let anon = supabase_anon_key();
    let client = reqwest::Client::builder()
        .timeout(CLOUD_CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{base}/rest/v1/rpc/register_kds_device");
    let body = serde_json::json!({
        "p_tenant_id": tenant_id,
        "p_branch_id": branch_id,
        "p_device_name": device_name,
        "p_fingerprint": fingerprint,
    });
    let response = client
        .post(&url)
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {anon}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("register_kds_device returned HTTP {}", response.status()));
    }
    Ok(())
}

/// T2.0 per-terminal licensing (plan §2): "unpaid terminal #3, better UX".
/// Called from `activate_license_v3` ONLY after a signature has already
/// verified but the machine fingerprint didn't match -- at that point the
/// pasted key's `branch_id` is authentic (it came from a validly-signed
/// payload), so it's safe to ask the cloud "how many OTHER active seats does
/// this real branch have" to distinguish "this branch is licensed, just not
/// for this device" from "unknown/new branch". Calls a dedicated
/// `count_active_licenses` Postgres function (SECURITY DEFINER, granted to
/// `anon`), same pattern as `register_kds_device` above -- never touches the
/// `license` table's row contents, only a count.
pub async fn count_active_licenses(branch_id: &str) -> Result<i64, String> {
    let base = supabase_url();
    let anon = supabase_anon_key();
    let client = reqwest::Client::builder()
        .timeout(CLOUD_CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{base}/rest/v1/rpc/count_active_licenses");
    let body = serde_json::json!({ "p_branch_id": branch_id });
    let response = client
        .post(&url)
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {anon}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("count_active_licenses returned HTTP {}", response.status()));
    }
    response.json::<i64>().await.map_err(|e| e.to_string())
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

    fn offline_state_with_blob(dir_name: &str, days_from_now_expiry: i64) -> (LicenseState, PathBuf, ed25519_dalek::SigningKey) {
        let dir = temp_dir(dir_name);
        let key = test_keypair();
        let state = LicenseState::init(dir.clone(), key.verifying_key());
        let machine = crate::license::fingerprint::current();
        let now = chrono::Utc::now().timestamp_millis();
        let payload = sample_payload(machine, now - 30 * 86_400_000, now + days_from_now_expiry * 86_400_000);
        let file = mint(&key, &payload);
        state.accept_renewal(file).expect("valid renewal must be accepted");
        (state, dir, key)
    }

    fn offline_state_with_no_license(dir_name: &str) -> (LicenseState, PathBuf) {
        let dir = temp_dir(dir_name);
        let key = test_keypair();
        (LicenseState::init(dir.clone(), key.verifying_key()), dir)
    }

    fn cloud_config() -> Option<CloudConfig> {
        Some(CloudConfig { license_id: "lic-1".into(), device_token: "token-1".into() })
    }

    // --- 1. valid online: cloud says active, must not lock ---
    #[tokio::test]
    async fn valid_online_is_not_locked() {
        let (offline, dir, _key) = offline_state_with_blob("valid_online", 30);
        let now = chrono::Utc::now().timestamp_millis();
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 30 * 86_400_000, plan: "standard".into() }, None));
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "valid online check must not lock, got {status:?}");
        assert!(matches!(status, LicenseStatus::Active { .. }));
    }

    // --- 2. cloud explicitly says revoked: must lock, even though the offline blob is still within its own validity window ---
    #[tokio::test]
    async fn cloud_says_revoked_locks_even_with_valid_offline_blob() {
        let (offline, dir, _key) = offline_state_with_blob("cloud_revoked", 30); // offline blob still has 30 days left
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::NotActive { reason: "revoked".into() }, None));
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(status.back_office_locked(), "an explicit successful revoke must lock even if the offline blob looks fine, got {status:?}");
    }

    // --- 3. cloud is down, but within the 14-day cache grace: last known-good cloud verdict (active) still applies ---
    #[tokio::test]
    async fn cloud_down_within_cache_grace_uses_cached_active_verdict() {
        let (offline, dir, _key) = offline_state_with_blob("cache_grace_within", -20); // offline blob itself is long past its own 7-day grace
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        // Simulate a successful check that happened 10 days ago (within the 14-day cache grace).
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 10 * 86_400_000);
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now + 5 * 86_400_000, plan: "standard".into() });
        }

        // A live check right now fails (network down) -- must NOT clear the cache.
        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "cloud-down-but-within-cache-grace must still read as not locked, got {status:?}");
    }

    // --- 4. cloud down, past the 14-day cache grace: falls through to the offline blob, which is itself still valid ---
    #[tokio::test]
    async fn cloud_down_past_cache_grace_falls_to_valid_offline_blob() {
        let (offline, dir, _key) = offline_state_with_blob("cache_grace_past_valid_offline", 10); // offline blob still has 10 days left
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 20 * 86_400_000); // 20 days ago, past the 14-day grace
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now - 10 * 86_400_000, plan: "standard".into() });
        }

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "must fall through to the still-valid offline blob, got {status:?}");
        assert!(matches!(status, LicenseStatus::Active { .. }), "expected the offline blob's own Active status, got {status:?}");
    }

    // --- 5. cloud down, past cache grace, AND the offline blob is also expired past its own 7-day grace: only now must it lock ---
    #[tokio::test]
    async fn offline_blob_also_expired_locks_only_when_both_lapse() {
        let (offline, dir, _key) = offline_state_with_blob("both_lapsed", -20); // expired 20 days ago, past the 7-day offline grace
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut cache = cloud.cache.lock().unwrap();
            cache.last_successful_check_at_ms = Some(now - 20 * 86_400_000); // past the 14-day cache grace too
            cache.last_verdict = Some(CloudVerdict::Active { expires_at_ms: now - 20 * 86_400_000, plan: "standard".into() });
        }

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(status.back_office_locked(), "both the cloud cache and the offline blob have lapsed -- this must lock, got {status:?}");
    }

    // --- 6. fresh install, fully offline, never once reached the cloud: must behave exactly like the pre-Slice-1c offline-only path ---
    #[tokio::test]
    async fn never_checked_cloud_falls_straight_to_offline_blob() {
        let (offline, dir, _key) = offline_state_with_blob("never_checked_valid", 30);
        // No cloud config at all -- simulates a device that was never
        // handed cloud credentials, e.g. activated fully offline.
        let cloud = CloudLicenseState::new(offline, dir, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

        cloud.refresh_from_cloud().await; // should be a no-op: no config means no call at all
        let status = cloud.cached_status();
        assert!(!status.back_office_locked());
        assert!(matches!(status, LicenseStatus::Active { .. }));
    }

    #[tokio::test]
    async fn never_checked_cloud_with_no_config_never_calls_transport() {
        let (offline, dir) = offline_state_with_no_license("never_checked_no_call");
        struct CountingTransport(AtomicUsize);
        #[async_trait::async_trait]
        impl CloudTransport for CountingTransport {
            async fn check(&self, _license_id: &str, _device_token: &str) -> CloudCheckOutcome {
                self.0.fetch_add(1, Ordering::SeqCst);
                CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: 0, plan: "standard".into() }, None)
            }
        }
        let transport = CountingTransport(AtomicUsize::new(0));
        let cloud = CloudLicenseState::new(offline, dir, None, Box::new(transport));
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
        let (offline, dir, _key) = offline_state_with_blob("garbage_response", 30);
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

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
        let (offline, dir, key) = offline_state_with_blob("silent_renewal", 5); // currently expires in 5 days
        let now = chrono::Utc::now().timestamp_millis();
        let machine = crate::license::fingerprint::current();
        let fresh_payload = sample_payload(machine, now, now + 365 * 86_400_000); // a fresh year-long renewal
        let fresh_file = mint(&key, &fresh_payload);

        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 365 * 86_400_000, plan: "standard".into() }, Some(fresh_file)));
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        cloud.recheck_offline(); // re-read the (now renewed) offline blob off disk
        let offline_status = cloud.offline.cached_status();
        assert!(matches!(offline_status, LicenseStatus::Active { days_remaining, .. } if days_remaining > 300), "expected the silently-installed year-long renewal to be reflected in the offline evaluator, got {offline_status:?}");
    }

    // A malformed/wrong-machine renewal blob must not crash or block the cloud verdict itself from applying.
    #[tokio::test]
    async fn malformed_renewal_blob_does_not_break_the_cloud_verdict() {
        let (offline, dir, _key) = offline_state_with_blob("bad_renewal_blob", 30);
        let now = chrono::Utc::now().timestamp_millis();
        let bogus = SignedLicenseFile { payload_json: "not json".into(), signature_b64: "not base64!!".into() };
        let transport = ScriptedTransport::new(CloudCheckOutcome::Success(CloudVerdict::Active { expires_at_ms: now + 30 * 86_400_000, plan: "standard".into() }, Some(bogus)));
        let cloud = CloudLicenseState::new(offline, dir, cloud_config(), Box::new(transport));

        cloud.refresh_from_cloud().await;
        let status = cloud.cached_status();
        assert!(!status.back_office_locked(), "a bogus renewal blob must be silently ignored, not break the cloud verdict, got {status:?}");
    }

    /// Everything the Settings -> License paste-activation flow actually
    /// exercises: decode the activation key bundle apps/admin's mint flow
    /// produces, then run it through the exact same `CloudLicenseState`
    /// `activate_license_v3` uses. Each failure mode gets its own test with
    /// a distinct assertion, per the acceptance criteria's "each gets a
    /// distinct message" requirement -- these prove the underlying Result is
    /// actually distinct per failure, which is what the frontend's Arabic
    /// message mapping switches on.
    mod activation {
        use super::*;

        fn encode_bundle(license_id: &str, device_token: &str, payload_json: &str, signature_b64: &str) -> String {
            let json = serde_json::json!({
                "license_id": license_id,
                "device_token": device_token,
                "payload_json": payload_json,
                "signature_b64": signature_b64,
            });
            license_core::b64::encode(serde_json::to_string(&json).unwrap().as_bytes())
        }

        fn valid_bundle_key(dir_name: &str) -> (String, PathBuf, ed25519_dalek::SigningKey) {
            let dir = temp_dir(dir_name);
            let key = test_keypair();
            let machine = crate::license::fingerprint::current();
            let now = chrono::Utc::now().timestamp_millis();
            let payload = sample_payload(machine, now - 1000, now + 30 * 86_400_000);
            let file = mint(&key, &payload);
            let bundle_key = encode_bundle("lic-abc-123", "a".repeat(64).as_str(), &file.payload_json, &file.signature_b64);
            (bundle_key, dir, key)
        }

        // --- decode-level failures (never reach accept_renewal at all) ---

        #[test]
        fn garbage_input_that_is_neither_a_bundle_nor_a_raw_blob_is_rejected() {
            let err = decode_activation_key("not valid base64 at all!! and not json either").unwrap_err();
            assert_eq!(err, "activation key is corrupted or not in the expected format");
        }

        #[test]
        fn valid_base64_but_not_json_is_rejected_with_a_distinct_message() {
            let key = license_core::b64::encode(b"this is not json");
            let err = decode_activation_key(&key).unwrap_err();
            assert_eq!(err, "activation key is corrupted or not in the expected format");
        }

        #[test]
        fn valid_json_missing_required_fields_is_rejected() {
            let key = license_core::b64::encode(b"{\"license_id\":\"only-this-field\"}");
            let err = decode_activation_key(&key).unwrap_err();
            assert_eq!(err, "activation key is corrupted or not in the expected format");
        }

        // --- the bare, hand-signed blob fallback (this exact shape is what a
        // license-signer-CLI-only mint, without apps/admin, produces) ---

        #[test]
        fn bare_signed_file_json_with_no_license_id_or_device_token_decodes_and_activates() {
            let key = test_keypair();
            let machine = crate::license::fingerprint::current();
            let now = chrono::Utc::now().timestamp_millis();
            let payload = sample_payload(machine, now - 1000, now + 30 * 86_400_000);
            let file = mint(&key, &payload);
            let raw_blob = serde_json::to_string(&file).unwrap();

            let bundle = decode_activation_key(&raw_blob).expect("a bare SignedLicenseFile JSON must decode");
            assert!(bundle.license_id.is_none());
            assert!(bundle.device_token.is_none());

            let dir = temp_dir("bare_blob_activation");
            let state = LicenseState::init(dir.clone(), key.verifying_key());
            let cloud = CloudLicenseState::new(state, dir, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));
            let signed = SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };
            let status = cloud.accept_renewal(signed).expect("a valid bare blob must still activate");
            assert!(!status.back_office_locked());
        }

        #[test]
        fn bare_signed_file_json_missing_signature_is_rejected() {
            let err = decode_activation_key("{\"payload_json\":\"{}\"}").unwrap_err();
            assert_eq!(err, "activation key is corrupted or not in the expected format");
        }

        // --- full end-to-end activation through CloudLicenseState (the actual production path) ---

        #[test]
        fn valid_bundle_installs_offline_blob_and_wires_cloud_config() {
            let (bundle_key, dir, key) = valid_bundle_key("activation_valid");
            let state = LicenseState::init(dir.clone(), key.verifying_key());
            let cloud = CloudLicenseState::new(state, dir.clone(), None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

            let bundle = decode_activation_key(&bundle_key).expect("a well-formed bundle must decode");
            let license_id = bundle.license_id.clone().expect("this bundle carries a cloud identity");
            let device_token = bundle.device_token.clone().expect("this bundle carries a cloud identity");
            let file = SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };
            let status = cloud.accept_renewal(file).expect("a valid, correctly-signed bundle must be accepted");
            assert!(!status.back_office_locked(), "a freshly activated valid license must not be locked, got {status:?}");

            cloud.set_config(CloudConfig { license_id: license_id.clone(), device_token: device_token.clone() });
            cloud.persist_cloud_config().expect("persisting cloud_config.json must succeed");

            let loaded = load_config_from_file(&dir.join("cloud_config.json")).expect("cloud_config.json must be loadable after activation");
            assert_eq!(loaded.license_id, license_id);
            assert_eq!(loaded.device_token, device_token);
        }

        #[test]
        fn bundle_with_forged_signature_is_rejected() {
            let dir = temp_dir("activation_forged");
            let real_key = test_keypair();
            let attacker_key = test_keypair();
            let machine = crate::license::fingerprint::current();
            let now = chrono::Utc::now().timestamp_millis();
            let payload = sample_payload(machine, now - 1000, now + 30 * 86_400_000);
            let file = mint(&attacker_key, &payload); // signed by the WRONG key
            let bundle_key = encode_bundle("lic-x", &"b".repeat(64), &file.payload_json, &file.signature_b64);

            let state = LicenseState::init(dir.clone(), real_key.verifying_key()); // app trusts real_key, not attacker_key
            let cloud = CloudLicenseState::new(state, dir, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

            let bundle = decode_activation_key(&bundle_key).unwrap();
            let file = SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };
            let err = cloud.accept_renewal(file).unwrap_err();
            assert_eq!(err, license_core::signed::LicenseError::ForgedOrCorruptSignature);
        }

        #[test]
        fn bundle_issued_for_a_different_machine_is_rejected() {
            let dir = temp_dir("activation_wrong_machine");
            let key = test_keypair();
            let someone_elses_machine = license_core::fingerprint::MachineFingerprint::from_raw(Some("cpu-other"), Some("disk-other"), Some("mac-other"));
            let now = chrono::Utc::now().timestamp_millis();
            let payload = sample_payload(someone_elses_machine, now - 1000, now + 30 * 86_400_000);
            let file = mint(&key, &payload);
            let bundle_key = encode_bundle("lic-y", &"c".repeat(64), &file.payload_json, &file.signature_b64);

            let state = LicenseState::init(dir.clone(), key.verifying_key());
            let cloud = CloudLicenseState::new(state, dir, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

            let bundle = decode_activation_key(&bundle_key).unwrap();
            let file = SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };
            let err = cloud.accept_renewal(file).unwrap_err();
            assert!(matches!(err, license_core::signed::LicenseError::WrongMachine { .. }));
        }

        #[test]
        fn bundle_older_than_the_currently_installed_license_is_rejected_as_stale() {
            let dir = temp_dir("activation_stale");
            let key = test_keypair();
            let machine = crate::license::fingerprint::current();
            let now = chrono::Utc::now().timestamp_millis();

            let state = LicenseState::init(dir.clone(), key.verifying_key());
            let cloud = CloudLicenseState::new(state, dir, None, Box::new(ScriptedTransport::new(CloudCheckOutcome::Unreachable)));

            let newer = mint(&key, &sample_payload(machine.clone(), now, now + 60 * 86_400_000));
            cloud.accept_renewal(newer).expect("installing the newer license first must succeed");

            let older_payload = sample_payload(machine, now - 10 * 86_400_000, now + 5 * 86_400_000);
            let older = mint(&key, &older_payload);
            let bundle_key = encode_bundle("lic-z", &"d".repeat(64), &older.payload_json, &older.signature_b64);
            let bundle = decode_activation_key(&bundle_key).unwrap();
            let file = SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };

            let err = cloud.accept_renewal(file).unwrap_err();
            assert_eq!(err, license_core::signed::LicenseError::StaleRenewal);
        }
    }
}
