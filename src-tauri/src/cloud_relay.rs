//! Tills of ONE restaurant working together over the internet.
//!
//! The LAN link in `lan.rs` stays exactly as it is and is always tried first.
//! This module adds the internet as the fallback (or the only route, for a
//! till that joined over the internet and has no LAN address):
//!
//! * Satellite -> Hub: the command goes to the `pos-relay` edge function
//!   (`send`); the Hub's own background task (`start_hub_tasks`) long-polls it
//!   (`hub_claim`), runs the command through the SAME `lan::execute_rpc` path
//!   a LAN call takes, and posts the answer back (`hub_respond`). The
//!   satellite gets the Hub's `{ok, data}` / `{ok: false, error}` envelope
//!   back unchanged.
//! * Change nudges: a satellite on the internet route long-polls `changes`
//!   and emits the Tauri event `lan-change`, the same "go re-fetch" signal
//!   the LAN WebSocket gives (`connectLanChangeSocket` in `lan.ts`).
//!
//! Safety rules this file keeps:
//! * A LAN call falls through to the cloud only when it provably never
//!   reached the Hub (connect failure). A request that timed out after being
//!   sent may have run, e.g. a payment, so it is NOT retried elsewhere.
//! * Everything here runs on background tasks / the caller's own async task;
//!   the DB is only touched inside `spawn_blocking` on the Hub.
//! * The edge function checks the sender's licence and scopes every action
//!   to that licence's branch, so the Hub trusts cloud commands as role
//!   `lan::CLOUD_RELAY_ROLE` ('register').

use serde_json::{json, Value};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::lan::{load_lan_config, LanConfig};
use crate::Db;

/// How long the last working route is trusted before the LAN is tried again.
pub const ROUTE_MEMORY_SECS: u64 = 60;
const LAN_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const LAN_TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
/// The edge function waits at most this long for the Hub's answer.
const SEND_WAIT_MS: u64 = 13_000;
const HUB_CLAIM_WAIT_MS: u64 = 20_000;
const CHANGES_WAIT_MS: u64 = 25_000;
/// Hub answers bigger than this are replaced by a plain error (the edge
/// function enforces its own cap, this just avoids uploading what it refuses).
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Route decision (pure) + route memory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Lan,
    Cloud,
}

impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Route::Lan => "lan",
            Route::Cloud => "cloud",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteInputs {
    /// A paired LAN address exists.
    pub lan_usable: bool,
    /// The internet route is allowed (switch on, own licence token, not a free
    /// kitchen screen, pairing finished or no LAN at all).
    pub cloud_usable: bool,
    /// The last route that worked and how many seconds ago.
    pub last: Option<(Route, u64)>,
}

/// The ordered list of routes to try for one call. Pure on purpose.
///
/// * only one route usable -> just that one;
/// * both usable -> LAN first, unless the cloud worked within the last
///   `ROUTE_MEMORY_SECS` (then it goes first, so a dead LAN does not cost its
///   connect timeout on every call; the LAN is retried after the window and
///   stays as the second choice meanwhile).
pub fn plan_routes(inputs: &RouteInputs) -> Vec<Route> {
    match (inputs.lan_usable, inputs.cloud_usable) {
        (false, false) => vec![],
        (true, false) => vec![Route::Lan],
        (false, true) => vec![Route::Cloud],
        (true, true) => match inputs.last {
            Some((Route::Cloud, age)) if age < ROUTE_MEMORY_SECS => vec![Route::Cloud, Route::Lan],
            _ => vec![Route::Lan, Route::Cloud],
        },
    }
}

fn has_lan_addr(config: &LanConfig) -> bool {
    config.hub_addr.as_deref().is_some_and(|a| !a.trim().is_empty())
}

/// A satellite that joined over the internet: no LAN address, no LAN pairing.
pub fn is_cloud_only(config: &LanConfig) -> bool {
    config.mode == "satellite" && !has_lan_addr(config) && config.trust_token.is_none() && config.pairing_request_id.is_none()
}

pub fn route_inputs(config: &LanConfig, has_device_token: bool) -> RouteInputs {
    let satellite = config.mode == "satellite";
    let lan_usable = satellite && has_lan_addr(config) && config.trust_token.is_some();
    let cloud_usable = satellite
        && config.cloud
        && has_device_token
        && config.device_role.as_deref() != Some("kitchen")
        // a LAN pairing that is still waiting for approval is not a till yet
        && (lan_usable || is_cloud_only(config));
    RouteInputs { lan_usable, cloud_usable, last: recent_route() }
}

static LAST_ROUTE: StdMutex<Option<(Route, Instant)>> = StdMutex::new(None);

fn remember_route(route: Route) {
    *LAST_ROUTE.lock().unwrap_or_else(|e| e.into_inner()) = Some((route, Instant::now()));
}

fn recent_route() -> Option<(Route, u64)> {
    let guard = LAST_ROUTE.lock().unwrap_or_else(|e| e.into_inner());
    (*guard).map(|(r, at)| (r, at.elapsed().as_secs()))
}

/// The route the last relayed command took, if within the memory window.
pub fn route_in_use() -> Option<Route> {
    recent_route().filter(|(_, age)| *age < ROUTE_MEMORY_SECS).map(|(r, _)| r)
}

// ---------------------------------------------------------------------------
// HTTP to the pos-relay edge function
// ---------------------------------------------------------------------------

/// A failed call to the edge function, with a plain Arabic `message` and
/// whether the command may nevertheless have reached (and run on) the Hub.
#[derive(Debug, Clone)]
pub struct CloudError {
    pub code: String,
    pub message: String,
    pub maybe_ran: bool,
}

/// Maps what the edge function (or the network) said to the Arabic message
/// and the "may have run" flag. `status` is `None` for a failure before any
/// HTTP answer; `sent` is whether the request left this machine.
pub fn map_cloud_failure(status: Option<u16>, code: &str, sent: bool) -> (String, bool) {
    let msg = match code {
        "HUB_OFFLINE" => "الجهاز المركزي غير متصل بالإنترنت حالياً.".to_string(),
        "HUB_TIMEOUT" => "الجهاز المركزي لم يردّ في الوقت المناسب. تحقق من اتصاله بالإنترنت وحاول مجدداً.".to_string(),
        "NETWORK" => "تعذّر الاتصال بالإنترنت.".to_string(),
        "CALLER_IS_HUB" => "هذا الجهاز هو المركزي نفسه.".to_string(),
        "NOT_HUB" => "هذا الجهاز لم يعد المركزي في السحابة.".to_string(),
        _ => match status {
            Some(401) | Some(403) => "ترخيص هذا الجهاز غير فعّال، لا يمكن الاتصال عبر الإنترنت.".to_string(),
            _ => format!("تعذّر الاتصال عبر الإنترنت ({code})."),
        },
    };
    // Only these answers prove the command never ran: the function refused it
    // before queueing anything. A timeout or a server error may have run it.
    let refused_before_queue = matches!(code, "HUB_OFFLINE" | "CALLER_IS_HUB" | "NOT_HUB") || matches!(status, Some(400) | Some(401) | Some(403) | Some(413));
    (msg, sent && !refused_before_queue)
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// POSTs `{device_token, ...body}` to `pos-relay` (same headers as
/// `sync.rs::send_batch`). Returns the JSON body of a 2xx answer.
pub async fn call(token: &str, mut body: Value, timeout: Duration) -> Result<Value, CloudError> {
    use crate::license::cloud::{supabase_anon_key, supabase_url};
    if let Some(obj) = body.as_object_mut() {
        obj.insert("device_token".to_string(), Value::String(token.to_string()));
    }
    let anon = supabase_anon_key();
    let resp = http_client()
        .post(format!("{}/functions/v1/pos-relay", supabase_url()))
        .header("apikey", &anon)
        .header("Authorization", format!("Bearer {anon}"))
        .header("Content-Type", "application/json")
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            // `is_connect()`: never reached the server, so nothing ran.
            let (message, maybe_ran) = map_cloud_failure(None, "NETWORK", !e.is_connect());
            CloudError { code: "NETWORK".to_string(), message, maybe_ran }
        })?;
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(value);
    }
    let code = value.get("error").and_then(Value::as_str).unwrap_or("UNKNOWN").to_string();
    let (message, maybe_ran) = map_cloud_failure(Some(status.as_u16()), &code, true);
    Err(CloudError { code, message, maybe_ran })
}

/// Satellite -> Hub through the cloud: returns the Hub's own envelope.
pub async fn send(token: &str, command: &str, args: &Value) -> Result<Value, CloudError> {
    let v = call(
        token,
        json!({ "action": "send", "command": command, "args": args, "wait_ms": SEND_WAIT_MS }),
        Duration::from_secs(20),
    )
    .await?;
    match v.get("response") {
        Some(r) if r.is_object() => Ok(r.clone()),
        _ => Err(CloudError { code: "BAD_RESPONSE".to_string(), message: "ردّ غير مفهوم من الجهاز المركزي.".to_string(), maybe_ran: true }),
    }
}

#[derive(Debug, Clone)]
pub struct HubStatus {
    pub hub_online: bool,
    pub hub_label: Option<String>,
    pub last_seen_at: Option<String>,
    pub is_hub: bool,
}

pub async fn hub_status(token: &str) -> Result<HubStatus, CloudError> {
    let v = call(token, json!({ "action": "status" }), Duration::from_secs(8)).await?;
    Ok(HubStatus {
        hub_online: v.get("hub_online").and_then(Value::as_bool).unwrap_or(false),
        hub_label: v.get("hub_label").and_then(Value::as_str).map(str::to_string),
        last_seen_at: v.get("last_seen_at").and_then(Value::as_str).map(str::to_string),
        is_hub: v.get("is_hub").and_then(Value::as_bool).unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// Satellite: one relayed call over LAN and/or cloud
// ---------------------------------------------------------------------------

enum LanFail {
    /// Never reached the Hub (connect failure): safe to try another route.
    NotSent(String),
    /// Reached it, or may have: do not retry anywhere else.
    Failed(String),
}

fn lan_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(LAN_CONNECT_TIMEOUT)
            .timeout(LAN_TOTAL_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn lan_post(hub_addr: &str, trust_token: &str, command: &str, args: &Value) -> Result<Value, LanFail> {
    let resp = lan_client()
        .post(format!("http://{hub_addr}/rpc/{command}"))
        .bearer_auth(trust_token)
        .json(args)
        .send()
        .await
        .map_err(|e| {
            let m = format!("could not reach hub: {e}");
            if e.is_connect() { LanFail::NotSent(m) } else { LanFail::Failed(m) }
        })?;
    // Any HTTP answer, 4xx included, is the Hub speaking: pass its envelope on.
    resp.json::<Value>().await.map_err(|e| LanFail::Failed(e.to_string()))
}

/// Sends one command to the Hub over the best route and returns the Hub's
/// `{ok, data}` / `{ok: false, error}` envelope. `Err` is a plain message.
pub async fn relay(config: &LanConfig, device_token: Option<&str>, command: &str, args: &Value) -> Result<Value, String> {
    let routes = plan_routes(&route_inputs(config, device_token.is_some()));
    let mut last_err = "no route to the hub".to_string();
    for route in routes {
        match route {
            Route::Lan => {
                let (Some(addr), Some(trust)) = (config.hub_addr.as_deref(), config.trust_token.as_deref()) else { continue };
                match lan_post(addr, trust, command, args).await {
                    Ok(body) => {
                        remember_route(Route::Lan);
                        return Ok(body);
                    }
                    Err(LanFail::NotSent(m)) => last_err = m,
                    Err(LanFail::Failed(m)) => return Err(m),
                }
            }
            Route::Cloud => {
                let Some(token) = device_token else { continue };
                match send(token, command, args).await {
                    Ok(envelope) => {
                        remember_route(Route::Cloud);
                        return Ok(envelope);
                    }
                    Err(e) => {
                        last_err = e.message.clone();
                        if e.maybe_ran {
                            return Err(last_err);
                        }
                    }
                }
            }
        }
    }
    Err(last_err)
}

// ---------------------------------------------------------------------------
// Hub: answer commands that arrive through the cloud
// ---------------------------------------------------------------------------

/// Hub + internet switch on + a device token => the token to use.
fn hub_token(app: &AppHandle) -> Option<String> {
    let dir = crate::lan::db_dir(app).ok()?;
    let config = load_lan_config(&dir);
    if config.mode != "hub" || !config.cloud {
        return None;
    }
    app.try_state::<crate::license::cloud::CloudLicenseState>()?.device_token()
}

/// Starts the Hub's two background loops (once per process): the `hub_hello`
/// heartbeat and the `hub_claim` loop. Both re-read the config every round,
/// so the owner's switch and a role change apply within seconds.
pub fn start_hub_tasks(app: AppHandle) {
    static STARTED: StdMutex<bool> = StdMutex::new(false);
    {
        let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
        if *started {
            return;
        }
        *started = true;
    }
    let hello_app = app.clone();
    tauri::async_runtime::spawn(async move { hello_loop(hello_app).await });
    tauri::async_runtime::spawn(async move { claim_loop(app).await });
}

async fn hello_loop(app: AppHandle) {
    loop {
        let mut delay = Duration::from_secs(5);
        if let Some(token) = hub_token(&app) {
            let label = crate::lan::db_dir(&app).map(|d| load_lan_config(&d).device_name).unwrap_or_default();
            match call(&token, json!({ "action": "hub_hello", "device_label": label }), Duration::from_secs(10)).await {
                Ok(_) => delay = Duration::from_secs(30),
                Err(e) => log_once("hello", &e.code, &e.message),
            }
        }
        tokio::time::sleep(delay).await;
    }
}

async fn claim_loop(app: AppHandle) {
    // Let the first hello land before the first claim.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let mut backoff = 1u64;
    loop {
        let Some(token) = hub_token(&app) else {
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };
        let started = Instant::now();
        match call(&token, json!({ "action": "hub_claim", "wait_ms": HUB_CLAIM_WAIT_MS }), Duration::from_secs(35)).await {
            Ok(v) => {
                backoff = 1;
                let messages = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
                for msg in messages {
                    handle_message(&app, &token, msg).await;
                }
                // The function normally holds the request for up to 20 s; if it
                // answered at once with nothing, do not spin.
                if started.elapsed() < Duration::from_millis(400) {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
            Err(e) => {
                log_once("claim", &e.code, &e.message);
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

/// Runs one claimed command on the Hub's DB (off the async threads) through
/// the shared `lan::execute_rpc` path and posts the answer back.
async fn handle_message(app: &AppHandle, token: &str, msg: Value) {
    let Some(id) = msg.get("id").and_then(Value::as_i64) else { return };
    let command = msg.get("command").and_then(Value::as_str).unwrap_or("").to_string();
    let args = match msg.get("args") {
        Some(a) if a.is_object() => a.clone(),
        _ => json!({}),
    };
    let run_app = app.clone();
    let (mut response, changed) = tokio::task::spawn_blocking(move || run_cloud_command(&run_app, &command, args))
        .await
        .unwrap_or_else(|_| (json!({ "ok": false, "error": "internal error while running the command" }), false));
    if serde_json::to_vec(&response).map(|b| b.len()).unwrap_or(0) > MAX_RESPONSE_BYTES {
        response = json!({ "ok": false, "error": "الرد كبير جداً للإرسال عبر الإنترنت" });
    }
    if changed {
        crate::lan::broadcast_orders_changed();
    }
    let body = json!({ "action": "hub_respond", "results": [{ "id": id, "response": response, "changed": changed }] });
    // The command already ran: do not lose the answer to a hiccup.
    for attempt in 0..3u64 {
        match call(token, body.clone(), Duration::from_secs(15)).await {
            Ok(_) => return,
            Err(e) => {
                log_once("respond", &e.code, &e.message);
                tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
            }
        }
    }
}

/// Blocking: the whole Hub-side authorization + dispatch for a cloud message.
fn run_cloud_command(app: &AppHandle, command: &str, args: Value) -> (Value, bool) {
    let (Some(db), Some(license)) = (app.try_state::<Db>(), app.try_state::<crate::license::cloud::CloudLicenseState>()) else {
        return (json!({ "ok": false, "error": "db unavailable" }), false);
    };
    cloud_command_outcome(&db, &license, command, args)
}

/// Split out so a test can run it without an `AppHandle`: a cloud message is
/// trusted as role `lan::CLOUD_RELAY_ROLE` and takes the same path a LAN call does.
pub fn cloud_command_outcome(
    db: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    command: &str,
    args: Value,
) -> (Value, bool) {
    let outcome = crate::lan::execute_rpc(db, license, crate::lan::CLOUD_RELAY_ROLE, command, args);
    (outcome.body, outcome.mutated)
}

/// Logs a recurring failure once per (kind, code) change, so a Hub that is
/// offline for hours writes a line, not thousands.
fn log_once(kind: &str, code: &str, message: &str) {
    static LAST: StdMutex<Option<(String, String)>> = StdMutex::new(None);
    let key = (kind.to_string(), code.to_string());
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref() != Some(&key) {
        crate::obslog::log_lan_error(&format!("cloud relay {kind}: {code} ({message})"));
        *last = Some(key);
    }
}

// ---------------------------------------------------------------------------
// Satellite: change nudges over the internet
// ---------------------------------------------------------------------------

/// True when a satellite should be long-polling `changes`: internet route on
/// and in use (no LAN address, or the last call went through the cloud).
pub fn nudges_wanted(config: &LanConfig, has_device_token: bool, route: Option<Route>) -> bool {
    let inputs = route_inputs(config, has_device_token);
    inputs.cloud_usable && (!inputs.lan_usable || route == Some(Route::Cloud))
}

/// Starts the satellite's change-nudge loop (once per process). Idle (a
/// 5 s sleep) unless `nudges_wanted`. Emits the `lan-change` event.
pub fn start_satellite_nudges(app: AppHandle) {
    static STARTED: StdMutex<bool> = StdMutex::new(false);
    {
        let mut started = STARTED.lock().unwrap_or_else(|e| e.into_inner());
        if *started {
            return;
        }
        *started = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut since: Option<i64> = None;
        let mut backoff = 1u64;
        loop {
            let token = crate::lan::current_device_token();
            let config = crate::lan::db_dir(&app).map(|d| load_lan_config(&d)).ok();
            let wanted = match (&config, &token) {
                (Some(c), Some(_)) => nudges_wanted(c, true, route_in_use()),
                _ => false,
            };
            let Some(token) = token.filter(|_| wanted) else {
                since = None;
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            };
            let started = Instant::now();
            match call(&token, json!({ "action": "changes", "since": since, "wait_ms": CHANGES_WAIT_MS }), Duration::from_secs(35)).await {
                Ok(v) => {
                    backoff = 1;
                    let seq = v.get("seq").and_then(Value::as_i64);
                    if let (Some(prev), Some(now)) = (since, seq) {
                        if now > prev {
                            let _ = app.emit("lan-change", ());
                        }
                    }
                    since = seq.or(since);
                    if started.elapsed() < Duration::from_millis(300) {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
                Err(e) => {
                    log_once("changes", &e.code, &e.message);
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(30);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(lan: bool, cloud: bool, last: Option<(Route, u64)>) -> RouteInputs {
        RouteInputs { lan_usable: lan, cloud_usable: cloud, last }
    }

    #[test]
    fn route_plan_lan_first_unless_cloud_worked_within_a_minute() {
        assert_eq!(plan_routes(&inputs(false, false, None)), vec![]);
        assert_eq!(plan_routes(&inputs(true, false, Some((Route::Cloud, 1)))), vec![Route::Lan]);
        assert_eq!(plan_routes(&inputs(false, true, None)), vec![Route::Cloud]);
        // nothing remembered: the LAN is tried first, the cloud is the fallback
        assert_eq!(plan_routes(&inputs(true, true, None)), vec![Route::Lan, Route::Cloud]);
        assert_eq!(plan_routes(&inputs(true, true, Some((Route::Lan, 5)))), vec![Route::Lan, Route::Cloud]);
        // cloud worked a moment ago: skip the LAN timeout, keep the LAN as second choice
        assert_eq!(plan_routes(&inputs(true, true, Some((Route::Cloud, 0)))), vec![Route::Cloud, Route::Lan]);
        assert_eq!(plan_routes(&inputs(true, true, Some((Route::Cloud, 59)))), vec![Route::Cloud, Route::Lan]);
        // 60 s later the LAN is retried first
        assert_eq!(plan_routes(&inputs(true, true, Some((Route::Cloud, 60)))), vec![Route::Lan, Route::Cloud]);
        assert_eq!(plan_routes(&inputs(true, true, Some((Route::Cloud, 600)))), vec![Route::Lan, Route::Cloud]);
    }

    /// A licence state that never talks to the cloud, in its own temp folder.
    fn idle_license() -> (crate::license::cloud::CloudLicenseState, std::path::PathBuf) {
        struct NoTransport;
        #[async_trait::async_trait]
        impl crate::license::cloud::CloudTransport for NoTransport {
            async fn check(&self, _license_id: &str, _device_token: &str) -> crate::license::cloud::CloudCheckOutcome {
                crate::license::cloud::CloudCheckOutcome::Unreachable
            }
        }
        let dir = std::env::temp_dir().join(format!("cloud-relay-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = license_core::signed::test_support::test_keypair();
        let offline = crate::license::store::LicenseState::init(dir.clone(), key.verifying_key());
        (crate::license::cloud::CloudLicenseState::new(offline, dir.clone(), None, Box::new(NoTransport)), dir)
    }

    fn cfg(mode: &str) -> LanConfig {
        LanConfig { mode: mode.to_string(), ..Default::default() }
    }

    fn paired_lan_satellite() -> LanConfig {
        LanConfig {
            hub_addr: Some("192.168.1.5:47811".to_string()),
            trust_token: Some("t".to_string()),
            device_role: Some("register".to_string()),
            ..cfg("satellite")
        }
    }

    #[test]
    fn route_inputs_follow_the_config() {
        // standalone / hub never relay
        for mode in ["standalone", "hub"] {
            let i = route_inputs(&cfg(mode), true);
            assert!(!i.lan_usable && !i.cloud_usable, "{mode}");
        }
        // paired LAN satellite: LAN, plus the cloud fallback when licensed + switch on
        let lan = paired_lan_satellite();
        assert_eq!(plan_routes(&RouteInputs { last: None, ..route_inputs(&lan, true) }), vec![Route::Lan, Route::Cloud]);
        assert_eq!(plan_routes(&RouteInputs { last: None, ..route_inputs(&lan, false) }), vec![Route::Lan]);
        let off = LanConfig { cloud: false, ..lan.clone() };
        assert!(!route_inputs(&off, true).cloud_usable);
        // a free kitchen screen never uses the internet
        let kitchen = LanConfig { device_role: Some("kitchen".to_string()), ..lan.clone() };
        assert!(!route_inputs(&kitchen, true).cloud_usable);
        assert!(route_inputs(&kitchen, true).lan_usable);
        // joined over the internet: cloud only, and only with a token
        let net = LanConfig { device_role: Some("register".to_string()), ..cfg("satellite") };
        assert!(is_cloud_only(&net));
        assert_eq!(plan_routes(&RouteInputs { last: None, ..route_inputs(&net, true) }), vec![Route::Cloud]);
        assert!(plan_routes(&route_inputs(&net, false)).is_empty());
        // a LAN pairing still waiting for approval is not usable over the internet
        let pending = LanConfig { hub_addr: Some("192.168.1.5:47811".to_string()), pairing_request_id: Some("r".to_string()), ..cfg("satellite") };
        assert!(!is_cloud_only(&pending));
        assert!(plan_routes(&route_inputs(&pending, true)).is_empty());
    }

    #[test]
    fn nudge_polling_runs_only_when_the_cloud_is_the_route_in_use() {
        let lan = paired_lan_satellite();
        assert!(!nudges_wanted(&lan, true, None), "LAN works: the WebSocket does it");
        assert!(!nudges_wanted(&lan, true, Some(Route::Lan)));
        assert!(nudges_wanted(&lan, true, Some(Route::Cloud)));
        assert!(!nudges_wanted(&lan, false, Some(Route::Cloud)), "no licence token");
        let net = LanConfig { device_role: Some("register".to_string()), ..cfg("satellite") };
        assert!(nudges_wanted(&net, true, None));
        assert!(!nudges_wanted(&LanConfig { cloud: false, ..net }, true, None));
        assert!(!nudges_wanted(&cfg("hub"), true, Some(Route::Cloud)));
    }

    #[test]
    fn cloud_failures_get_plain_arabic_and_say_whether_the_command_may_have_run() {
        let (m, ran) = map_cloud_failure(Some(503), "HUB_OFFLINE", true);
        assert!(m.contains("غير متصل") && !ran, "hub offline: refused before queueing");
        let (m, ran) = map_cloud_failure(Some(504), "HUB_TIMEOUT", true);
        assert!(m.contains("لم يردّ") && ran, "timeout: it may have run, never retry on another route");
        let (_, ran) = map_cloud_failure(None, "NETWORK", false);
        assert!(!ran, "could not even connect");
        let (_, ran) = map_cloud_failure(None, "NETWORK", true);
        assert!(ran, "sent, then the line died");
        let (m, ran) = map_cloud_failure(Some(403), "License revoked", true);
        assert!(m.contains("ترخيص") && !ran);
        let (_, ran) = map_cloud_failure(Some(500), "boom", true);
        assert!(ran);
    }

    /// A cloud message is trusted as a 'register' till and takes the SAME path
    /// as a LAN call (`lan::execute_rpc`): the kitchen-role fence does not
    /// apply to it, and an unknown command is refused like on the LAN.
    #[test]
    fn a_cloud_message_takes_the_lan_dispatch_path_as_a_register_till() {
        assert_eq!(crate::lan::CLOUD_RELAY_ROLE, "register");
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let db = Db(std::sync::Mutex::new(conn));
        let (license, dir) = idle_license();

        // Not exposed over RPC at all -> same refusal as the LAN gives.
        let (body, changed) = cloud_command_outcome(&db, &license, "drop_everything_v3", json!({}));
        assert_eq!(body["ok"], json!(false));
        assert!(body["error"].as_str().unwrap().contains("not exposed"));
        assert!(!changed);

        // A register-shaped command passes the role fence (it then fails on
        // its own missing arguments, not with the kitchen "forbidden" text).
        let (body, _) = cloud_command_outcome(&db, &license, "create_full_order_v3", json!({}));
        assert_eq!(body["ok"], json!(false));
        assert!(!body["error"].as_str().unwrap().contains("kitchen-screen-only"), "{body}");
        assert!(body["error"].as_str().unwrap().contains("sessionToken"), "{body}");

        // Whereas the same command from a kitchen-role LAN terminal is fenced off.
        let kitchen = crate::lan::execute_rpc(&db, &license, "kitchen", "create_full_order_v3", json!({}));
        assert_eq!(kitchen.status, axum::http::StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unreachable_lan_hub_fails_over_but_only_when_nothing_was_sent() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // Port 1: connection refused -> provably never reached the Hub.
        let r = rt.block_on(lan_post("127.0.0.1:1", "t", "list_tables_v3", &json!({})));
        match r {
            Err(LanFail::NotSent(m)) => assert!(m.contains("could not reach hub"), "{m}"),
            _ => panic!("a refused connection must be NotSent so the cloud route may be tried"),
        }
        // With no licence token a LAN-only satellite just reports the LAN error.
        let lan = LanConfig { hub_addr: Some("127.0.0.1:1".to_string()), ..paired_lan_satellite() };
        let err = rt.block_on(relay(&lan, None, "list_tables_v3", &json!({}))).unwrap_err();
        assert!(err.contains("could not reach hub"), "{err}");
    }
}
