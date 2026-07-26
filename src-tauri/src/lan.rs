//! Branch-local Hub/Satellite LAN sync (T3.0 multi-terminal plan).
//!
//! The problem this solves: every physical terminal used to be a fully
//! independent island (its own SQLite file, no cross-device data at all)
//! -- a kitchen screen on a separate machine from the till saw nothing, a
//! second cashier register couldn't see the first one's tables/orders,
//! and staff had to be created separately on every machine. Cloud sync
//! (`sync.rs`) doesn't fix this: it's push-only, aggregate-only, and
//! depends on the internet being up -- unacceptable for "can the kitchen
//! see new orders," which must survive a bad Wi-Fi day.
//!
//! The fix: one terminal per branch becomes the **Hub** -- it keeps doing
//! exactly what every terminal already does today (its own local SQLite,
//! all business logic, the existing cloud sync outbox) and additionally
//! runs a small LAN-only HTTP+WebSocket server. Every other terminal in
//! the branch (a KDS, a second register) becomes a **Satellite**: it
//! forwards an allowlisted set of commands to the Hub over the LAN
//! instead of touching its own local DB for business data (see
//! `invoke.ts` on the frontend for the redirect), and gets pushed a
//! lightweight "something changed" event over WebSocket so it knows to
//! re-fetch -- this is the mechanism that makes the KDS receive orders
//! fired from a different physical cashier terminal.
//!
//! No internet is involved in any of this -- Hub and Satellites talk
//! directly over the restaurant's own Wi-Fi/Ethernet. The Hub is still
//! the only thing that ever talks to Supabase; that path is completely
//! unchanged.
//!
//! Discovery is mDNS (`_zaeempos._tcp.local.`, the same category of
//! mechanism as AirPlay/Chromecast) so a Satellite finds the Hub with
//! zero typing as long as it's on the same network. Pairing needs exactly
//! one human action (the Hub operator taps "accept" once for a new
//! device); after that it's silent and reconnects automatically forever,
//! including through reboots and Wi-Fi drops.
//!
//! Trust model: a Satellite generates its own random trust token locally
//! and only ever sends the Hub a SHA-256 hash of it when requesting to
//! pair -- the Hub never needs to generate or hand back a secret, it just
//! remembers the hash and compares on every later RPC call. This is an
//! API-key-style secret (checked on every request), deliberately NOT
//! bcrypt like a human PIN -- bcrypt's slow-by-design hashing would add
//! real latency to every single order/void/payment call from a paired
//! terminal.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State as AxumState,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex as StdMutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast;

use crate::Db;

/// Fixed, non-privileged port. A restaurant LAN is a single flat network
/// almost always -- no port negotiation/registry needed for v1.
pub const LAN_HUB_PORT: u16 = 47811;
pub const MDNS_SERVICE_TYPE: &str = "_zaeempos._tcp.local.";

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

// ---------------------------------------------------------------------------
// Local, per-device config -- NOT synced anywhere, NOT tenant/branch data.
// Lives next to zaeem_pos.db. Determines this terminal's own role.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanConfig {
    /// "standalone" (default -- today's exact single-terminal behavior),
    /// "hub", or "satellite".
    pub mode: String,
    /// Satellite-only: the paired Hub's LAN address, e.g. "192.168.1.42:47811".
    pub hub_addr: Option<String>,
    /// Satellite-only: this terminal's own trust secret. Generated once,
    /// locally, at pairing time -- the Hub only ever sees its hash.
    pub trust_token: Option<String>,
    /// Satellite-only: the pairing request id, kept so a repeated
    /// `request_pairing_v3` call after an app restart (still PENDING or
    /// already APPROVED) can resume instead of creating a duplicate row.
    pub pairing_request_id: Option<String>,
    pub device_name: String,
}

fn lan_config_path(db_path: &std::path::Path) -> std::path::PathBuf {
    db_path.parent().expect("db_path must have a parent dir").join("lan_config.json")
}

/// Set once, early in `setup()`, so `resolve_actor_via_hub` -- called from
/// deep inside `authenticate_actor` (a plain `fn` with no `AppHandle` in
/// scope, reachable from ~150 call sites) -- has somewhere to read this
/// device's own LAN role from without threading a new parameter through
/// every one of them.
static DB_DIR: OnceLock<std::path::PathBuf> = OnceLock::new();

pub fn set_db_dir(dir: std::path::PathBuf) {
    let _ = DB_DIR.set(dir);
}

pub fn load_lan_config(db_path: &std::path::Path) -> LanConfig {
    std::fs::read_to_string(lan_config_path(db_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| LanConfig {
            mode: "standalone".to_string(),
            device_name: hostname_guess(),
            ..Default::default()
        })
}

pub fn save_lan_config(db_path: &std::path::Path, config: &LanConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(lan_config_path(db_path), json).map_err(|e| e.to_string())
}

fn hostname_guess() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "POS Terminal".to_string())
}

// ---------------------------------------------------------------------------
// Hub-side shared state for the axum server.
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct LanState {
    pub app: AppHandle,
    /// Broadcast fan-out for "something changed, go re-fetch" events.
    /// Lagging receivers (a Satellite briefly disconnected) just miss a
    /// notification or two -- harmless, since the next RPC read always
    /// returns current state anyway; this is a nudge, not a data channel.
    pub event_tx: broadcast::Sender<String>,
}

/// Keeps the mDNS responder alive for the process lifetime once Hub mode
/// starts (dropping it would stop the advertisement). `OnceLock` because
/// this only ever transitions standalone/satellite -> hub once per run;
/// re-entering hub mode after already starting it is a no-op.
static MDNS_DAEMON: OnceLock<mdns_sd::ServiceDaemon> = OnceLock::new();
static HUB_SERVER_STARTED: StdMutex<bool> = StdMutex::new(false);

fn local_ip() -> Option<std::net::IpAddr> {
    // Cheap, dependency-free "what's my LAN IP" trick: open a UDP socket
    // "toward" a public address (no packet is actually sent for a UDP
    // connect -- this just asks the OS to pick the outbound interface/IP
    // it would use) and read back the local address it bound.
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

/// Starts this terminal acting as the branch's Hub: the axum RPC/WS server
/// plus mDNS advertisement. Idempotent -- calling it twice in one process
/// (e.g. the app re-checks LAN config at boot) does nothing the second
/// time. Never called for `standalone`/`satellite` mode.
pub fn start_hub_server(app: AppHandle, db_path: &std::path::Path) {
    {
        let mut started = HUB_SERVER_STARTED.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
    }

    let (event_tx, _rx) = broadcast::channel::<String>(256);
    let state = LanState { app: app.clone(), event_tx };

    let router = Router::new()
        .route("/pair/request", post(pair_request))
        .route("/pair/status/:id", get(pair_status))
        .route("/rpc/:command", post(rpc_dispatch))
        .route("/ws", get(ws_upgrade))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", LAN_HUB_PORT)).await {
            Ok(l) => l,
            Err(e) => {
                crate::obslog::log_lan_error(&format!("hub server failed to bind port {LAN_HUB_PORT}: {e}"));
                return;
            }
        };
        crate::obslog::log_lan_error(&format!("hub server listening on 0.0.0.0:{LAN_HUB_PORT}"));
        if let Err(e) = axum::serve(listener, router).await {
            crate::obslog::log_lan_error(&format!("hub server exited: {e}"));
        }
    });

    // mDNS advertisement -- best-effort. A restaurant LAN that blocks
    // multicast (rare, but real on some locked-down routers) just means a
    // Satellite falls back to typing the Hub's IP shown on its own
    // screen; the RPC/WS server above works either way.
    let tenant_branch = tenant_and_branch_for_mdns(&app);
    if let Some(ip) = local_ip() {
        match mdns_sd::ServiceDaemon::new() {
            Ok(daemon) => {
                let mut properties = std::collections::HashMap::new();
                if let Some((tenant_id, branch_id)) = &tenant_branch {
                    properties.insert("tenant_id".to_string(), tenant_id.clone());
                    properties.insert("branch_id".to_string(), branch_id.clone());
                }
                let host_name = format!("{}.local.", hostname_guess().replace(' ', "-"));
                let instance_name = load_lan_config(db_path).device_name;
                match mdns_sd::ServiceInfo::new(
                    MDNS_SERVICE_TYPE,
                    &instance_name,
                    &host_name,
                    ip,
                    LAN_HUB_PORT,
                    Some(properties),
                ) {
                    Ok(info) => {
                        if let Err(e) = daemon.register(info) {
                            crate::obslog::log_lan_error(&format!("mDNS register failed: {e}"));
                        }
                        let _ = MDNS_DAEMON.set(daemon);
                    }
                    Err(e) => crate::obslog::log_lan_error(&format!("mDNS ServiceInfo::new failed: {e}")),
                }
            }
            Err(e) => crate::obslog::log_lan_error(&format!("mDNS daemon failed to start: {e}")),
        }
    } else {
        crate::obslog::log_lan_error("could not determine local LAN IP -- mDNS advertisement skipped");
    }
}

fn tenant_and_branch_for_mdns(app: &AppHandle) -> Option<(String, String)> {
    let db = app.try_state::<Db>()?;
    let conn = db.0.lock().ok()?;
    conn.query_row(
        "SELECT tenant_id, branch_id FROM staff WHERE branch_id IS NOT NULL LIMIT 1",
        [],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// Pairing: /pair/request, /pair/status/:id
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PairRequestBody {
    device_name: String,
    trust_token_hash: String,
}

#[derive(Serialize)]
struct PairRequestResponse {
    request_id: String,
}

async fn pair_request(
    AxumState(state): AxumState<LanState>,
    Json(body): Json<PairRequestBody>,
) -> impl IntoResponse {
    let db = match state.app.try_state::<Db>() {
        Some(d) => d,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "db unavailable"}))).into_response(),
    };
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    let id = uuid::Uuid::now_v7().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let result = conn.execute(
        "INSERT INTO paired_terminal (id, device_name, trust_token_hash, status, requested_at) VALUES (?1, ?2, ?3, 'PENDING', ?4)",
        rusqlite::params![id, body.device_name, body.trust_token_hash, now],
    );
    match result {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!(PairRequestResponse { request_id: id }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    }
}

#[derive(Serialize, Deserialize)]
struct PairStatusResponse {
    status: String,
}

async fn pair_status(
    AxumState(state): AxumState<LanState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let db = match state.app.try_state::<Db>() {
        Some(d) => d,
        None => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "db unavailable"}))).into_response(),
    };
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response(),
    };
    let status: Option<String> = conn
        .query_row("SELECT status FROM paired_terminal WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
        .ok();
    match status {
        Some(status) => (StatusCode::OK, Json(serde_json::json!(PairStatusResponse { status }))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "no such pairing request"}))).into_response(),
    }
}

/// Looks up the calling Satellite's own trust token (from the
/// `Authorization: Bearer <token>` header) against approved, non-revoked
/// `paired_terminal` rows. Any RPC call without a valid, approved token is
/// rejected before it ever reaches real command logic.
fn authorize_satellite(conn: &rusqlite::Connection, headers: &HeaderMap) -> Result<(), String> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing Authorization header".to_string())?;
    let token = auth.strip_prefix("Bearer ").ok_or_else(|| "malformed Authorization header".to_string())?;
    let hash = sha256_hex(token);
    let now = chrono::Utc::now().to_rfc3339();
    let matched: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM paired_terminal WHERE trust_token_hash = ?1 AND status = 'APPROVED'",
            rusqlite::params![hash],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !matched {
        return Err("terminal is not paired/approved".to_string());
    }
    let _ = conn.execute(
        "UPDATE paired_terminal SET last_seen_at = ?1 WHERE trust_token_hash = ?2",
        rusqlite::params![now, hash],
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// WebSocket: push "something changed" nudges to connected Satellites.
// ---------------------------------------------------------------------------

async fn ws_upgrade(AxumState(state): AxumState<LanState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_handle(socket, state))
}

async fn ws_handle(mut socket: WebSocket, state: LanState) {
    let mut rx = state.event_tx.subscribe();
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(payload) => {
                        if socket.send(Message::Text(payload)).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            incoming = socket.recv() => {
                // Satellites don't send anything meaningful over this
                // socket -- it exists purely for the Hub -> Satellite
                // push direction. A closed/errored recv means the client
                // disconnected.
                if incoming.is_none() {
                    break;
                }
            }
        }
    }
}

fn broadcast_change(state: &LanState, event: &str) {
    // A push happening while zero Satellites are connected is not an
    // error -- `send` on a broadcast channel with no receivers is a
    // normal, ignorable Err.
    let _ = state.event_tx.send(event.to_string());
}

// ---------------------------------------------------------------------------
// RPC dispatch: the Phase 1 command allowlist. Each arm deserializes the
// SAME JSON shape the frontend already sends to `invoke(cmd, args)`
// (camelCase keys matching the Rust command's own arg names) and calls
// the real, unmodified `#[tauri::command]` function directly -- these are
// plain `pub fn`s underneath the macro, callable from anywhere in the
// crate given a `State<T>`, which `AppHandle::state::<T>()` provides from
// outside Tauri's own IPC dispatch just as well as from inside it.
// ---------------------------------------------------------------------------

async fn rpc_dispatch(
    AxumState(state): AxumState<LanState>,
    Path(command): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> impl IntoResponse {
    let app = state.app.clone();
    let db = match app.try_state::<Db>() {
        Some(d) => d,
        None => return rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "db unavailable"),
    };
    let license = match app.try_state::<crate::license::cloud::CloudLicenseState>() {
        Some(l) => l,
        None => return rpc_error(StatusCode::INTERNAL_SERVER_ERROR, "license state unavailable"),
    };
    {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(e) => return rpc_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
        if let Err(e) = authorize_satellite(&conn, &headers) {
            return rpc_error(StatusCode::UNAUTHORIZED, &e);
        }
    }

    // `State<T>` derefs to `&T`, so `&db`/`&license` here are exactly the
    // plain references `dispatch_lan_rpc` takes -- same values a unit
    // test builds with `real_db()`/`never_checked_license()`, just
    // sourced from Tauri's managed state instead.
    let result = crate::commands_v3::dispatch_lan_rpc(&db, &license, &command, args);
    match result {
        Ok(value) => {
            if crate::commands_v3::lan_rpc_mutates_orders(&command) {
                broadcast_change(&state, "orders_changed");
            }
            (StatusCode::OK, Json(serde_json::json!({ "ok": true, "data": value }))).into_response()
        }
        Err(e) if e == "UNKNOWN_COMMAND" => rpc_error(StatusCode::NOT_FOUND, &format!("'{command}' is not exposed over LAN RPC")),
        Err(e) => rpc_error(StatusCode::BAD_REQUEST, &e),
    }
}

fn rpc_error(status: StatusCode, message: &str) -> axum::response::Response {
    (status, Json(serde_json::json!({ "ok": false, "error": message }))).into_response()
}

// ---------------------------------------------------------------------------
// Tauri commands -- the UI surface for setting a terminal's LAN role,
// approving/rejecting pairing requests (Hub side), and discovering +
// requesting to join a Hub (Satellite side). All gated the same way as
// every other back-office action: authenticate the actor, require
// ManageSettings (only an Owner/Manager should be able to change what a
// terminal is or approve a new device onto the branch's network).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatusV3 {
    pub mode: String,
    pub device_name: String,
    pub hub_addr: Option<String>,
    pub paired: bool,
}

fn db_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_lan_status_v3(app: AppHandle, state: State<Db>, session_token: String) -> Result<LanStatusV3, String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    Ok(LanStatusV3 {
        mode: config.mode.clone(),
        device_name: config.device_name,
        hub_addr: config.hub_addr,
        paired: config.mode == "satellite" && config.trust_token.is_some(),
    })
}

/// Turns THIS terminal into the branch's Hub. Idempotent -- safe to call
/// again (e.g. after a restart); `start_hub_server` itself no-ops if the
/// server is already running in this process.
#[tauri::command]
pub fn enable_hub_mode_v3(app: AppHandle, state: State<Db>, session_token: String) -> Result<(), String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let dir = db_dir(&app)?;
    let mut config = load_lan_config(&dir);
    config.mode = "hub".to_string();
    save_lan_config(&dir, &config)?;
    start_hub_server(app, &dir);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairingV3 {
    pub id: String,
    pub device_name: String,
    pub requested_at: String,
}

#[tauri::command]
pub fn list_pending_pairings_v3(state: State<Db>, session_token: String) -> Result<Vec<PendingPairingV3>, String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, device_name, requested_at FROM paired_terminal WHERE status = 'PENDING' ORDER BY requested_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(PendingPairingV3 { id: r.get(0)?, device_name: r.get(1)?, requested_at: r.get(2)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedTerminalV3 {
    pub id: String,
    pub device_name: String,
    pub status: String,
    pub last_seen_at: Option<String>,
}

#[tauri::command]
pub fn list_paired_terminals_v3(state: State<Db>, session_token: String) -> Result<Vec<PairedTerminalV3>, String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, device_name, status, last_seen_at FROM paired_terminal WHERE status IN ('APPROVED','REVOKED') ORDER BY device_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(PairedTerminalV3 { id: r.get(0)?, device_name: r.get(1)?, status: r.get(2)?, last_seen_at: r.get(3)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn approve_pairing_v3(state: State<Db>, session_token: String, request_id: String) -> Result<(), String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn
        .execute(
            "UPDATE paired_terminal SET status = 'APPROVED', decided_at = ?1 WHERE id = ?2 AND status = 'PENDING'",
            rusqlite::params![now, request_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err("no such pending pairing request".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn reject_pairing_v3(state: State<Db>, session_token: String, request_id: String) -> Result<(), String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE paired_terminal SET status = 'REJECTED', decided_at = ?1 WHERE id = ?2 AND status = 'PENDING'",
        rusqlite::params![now, request_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn revoke_terminal_v3(state: State<Db>, session_token: String, terminal_id: String) -> Result<(), String> {
    let actor = crate::commands_v3::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE paired_terminal SET status = 'REVOKED' WHERE id = ?1 AND status = 'APPROVED'",
        rusqlite::params![terminal_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Satellite side: discover Hubs on the LAN, request to join one.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHubV3 {
    pub name: String,
    pub addr: String,
}

/// Browses mDNS for ~2 seconds and returns whatever Hubs answered. Short
/// and synchronous-feeling on purpose -- this backs a "بحث" (search)
/// button on a settings screen, not a background service.
#[tauri::command]
pub async fn discover_hubs_v3() -> Result<Vec<DiscoveredHubV3>, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(MDNS_SERVICE_TYPE).map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                if let Some(ip) = info.get_addresses().iter().next() {
                    found.push(DiscoveredHubV3 {
                        name: info.get_fullname().to_string(),
                        addr: format!("{}:{}", ip, info.get_port()),
                    });
                }
            }
            Ok(_) => continue,
            Err(_) => break, // timeout
        }
    }
    let _ = daemon.shutdown();
    Ok(found)
}

fn random_trust_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequestReply {
    request_id: String,
}

/// Kicks off pairing with a Hub discovered via `discover_hubs_v3`. Safe to
/// call again after an app restart if a previous attempt is still
/// PENDING/APPROVED -- reuses the same locally-generated trust token and
/// request id rather than creating a duplicate row on the Hub.
#[tauri::command]
pub async fn request_pairing_v3(app: AppHandle, hub_addr: String, device_name: String) -> Result<(), String> {
    let dir = db_dir(&app)?;
    let mut config = load_lan_config(&dir);

    let trust_token = config.trust_token.clone().unwrap_or_else(random_trust_token);
    let trust_token_hash = sha256_hex(&trust_token);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://{hub_addr}/pair/request"))
        .json(&serde_json::json!({ "device_name": device_name, "trust_token_hash": trust_token_hash }))
        .send()
        .await
        .map_err(|e| format!("could not reach hub at {hub_addr}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("hub rejected pairing request: {}", resp.status()));
    }
    let body: PairRequestReply = resp.json().await.map_err(|e| e.to_string())?;

    config.mode = "satellite".to_string();
    config.hub_addr = Some(hub_addr);
    config.trust_token = Some(trust_token);
    config.pairing_request_id = Some(body.request_id);
    config.device_name = device_name;
    save_lan_config(&dir, &config)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatusV3 {
    pub status: String,
}

/// Polls the paired Hub for this terminal's own pairing request status --
/// the frontend calls this on an interval while showing "بانتظار موافقة
/// المدير" (waiting for manager approval) until it sees APPROVED.
#[tauri::command]
pub async fn check_pairing_status_v3(app: AppHandle) -> Result<PairingStatusV3, String> {
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    let (Some(hub_addr), Some(request_id)) = (config.hub_addr, config.pairing_request_id) else {
        return Err("no pairing request in progress".to_string());
    };
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{hub_addr}/pair/status/{request_id}"))
        .send()
        .await
        .map_err(|e| format!("could not reach hub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("hub returned {}", resp.status()));
    }
    let body: PairStatusResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(PairingStatusV3 { status: body.status })
}

/// Reverts this terminal to standalone mode -- e.g. the owner decides to
/// stop using a terminal as a Satellite. Does NOT revoke anything on the
/// Hub side (use `revoke_terminal_v3` there for that); this only clears
/// this terminal's own local pairing state.
#[tauri::command]
pub fn forget_pairing_v3(app: AppHandle) -> Result<(), String> {
    let dir = db_dir(&app)?;
    save_lan_config(&dir, &LanConfig { mode: "standalone".to_string(), device_name: hostname_guess(), ..Default::default() })
}

// ---------------------------------------------------------------------------
// Auth resolution fallback: makes a Satellite's Hub-only session usable by
// every command, not just the Phase 1 order/table allowlist. See
// `commands_v3::authenticate_actor`'s doc comment for why this exists.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ActorWireIn {
    id: String,
    tenant_id: String,
    branch_id: Option<String>,
    role: crate::security::Role,
    device_id: String,
}

/// Called only on a LOCAL session lookup failure. Returns `Ok(None)` for a
/// standalone/Hub terminal (the overwhelming majority of calls -- local
/// lookup normally succeeds there and this is never reached at all) or a
/// Satellite with no pairing configured yet. Returns `Ok(Some(actor))` once
/// the Hub confirms the token, `Err` if this terminal IS a paired
/// Satellite but the Hub couldn't be reached or rejected the token (a real
/// session-expired/offline-Hub error, not "not applicable").
///
/// Bridges into async by hand rather than requiring `reqwest`'s separate
/// `blocking` feature: `authenticate_actor` is a plain `fn` called from
/// both sync AND async `#[tauri::command]`s, so this has to work whether
/// or not it's already running inside a tokio task on the same thread --
/// `block_in_place` for the former, a throwaway runtime for the latter.
pub fn resolve_actor_via_hub(session_token: &str) -> Result<Option<crate::security::Actor>, String> {
    let Some(dir) = DB_DIR.get() else { return Ok(None) };
    let config = load_lan_config(dir);
    resolve_actor_via_hub_with_config(&config, session_token)
}

/// The testable half of `resolve_actor_via_hub` -- everything except
/// "where do I read my own config from" (a process-global `OnceLock`,
/// deliberately not touched by tests: it can only ever be set once per
/// process, and `cargo test` runs many unrelated tests in the same one).
fn resolve_actor_via_hub_with_config(config: &LanConfig, session_token: &str) -> Result<Option<crate::security::Actor>, String> {
    if config.mode != "satellite" {
        return Ok(None);
    }
    let (Some(hub_addr), Some(trust_token)) = (config.hub_addr.clone(), config.trust_token.clone()) else {
        return Ok(None);
    };
    let session_token = session_token.to_string();

    let fetch = async move {
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://{hub_addr}/rpc/__resolve_actor_v3"))
            .bearer_auth(trust_token)
            .json(&serde_json::json!({ "sessionToken": session_token }))
            .send()
            .await
            .map_err(|e| format!("could not reach hub: {e}"))?;
        resp.json::<Value>().await.map_err(|e| e.to_string())
    };
    let body = match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fetch))?,
        Err(_) => {
            let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
            rt.block_on(fetch)?
        }
    };

    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        let wire: ActorWireIn = serde_json::from_value(body.get("data").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string())?;
        Ok(Some(crate::security::Actor {
            id: wire.id,
            tenant_id: wire.tenant_id,
            branch_id: wire.branch_id,
            role: wire.role,
            device_id: wire.device_id,
        }))
    } else {
        Err(body.get("error").and_then(Value::as_str).unwrap_or("hub rejected request").to_string())
    }
}

// ---------------------------------------------------------------------------
// Frontend redirection support -- `invoke.ts` calls these on every command
// (not just LAN-related ones), so both are deliberately NOT auth-gated:
// they only ever return/act on THIS device's own local, already-on-disk
// config, never tenant/branch data. Real authorization happens on the Hub
// side, in `authorize_satellite`, for every relayed call.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanRedirectTargetV3 {
    pub hub_addr: String,
}

/// Lets the frontend open its own WebSocket to the paired Hub without
/// needing an authenticated round-trip first -- just "am I a satellite,
/// and if so, where's my Hub." Returns `None` for standalone/hub terminals
/// (the overwhelming majority of calls), so this is deliberately cheap: a
/// sync file read, no DB, no network.
#[tauri::command]
pub fn get_lan_redirect_target_v3(app: AppHandle) -> Result<Option<LanRedirectTargetV3>, String> {
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    if config.mode == "satellite" {
        if let Some(hub_addr) = config.hub_addr {
            return Ok(Some(LanRedirectTargetV3 { hub_addr }));
        }
    }
    Ok(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanRelayResultV3 {
    /// `false` means "this terminal isn't a satellite (or isn't paired
    /// yet) -- proceed with the normal local command call." `true` means
    /// this command was actually sent to the Hub; check `error` for the
    /// outcome.
    pub redirected: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
}

/// The single chokepoint `invoke.ts` calls before running any command on
/// the Phase 1 LAN allowlist. Mirrors `rpc_dispatch`'s `{ok, data}` /
/// `{ok: false, error}` response shape one-to-one -- this function is
/// nothing but the HTTP side of that same contract, kept in Rust (instead
/// of a browser `fetch`) so it shares the app's existing CSP-free `reqwest`
/// client, exactly like `request_pairing_v3`/`check_pairing_status_v3`
/// already do.
#[tauri::command]
pub async fn lan_relay_v3(app: AppHandle, command: String, args: Value) -> Result<LanRelayResultV3, String> {
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    let (Some(hub_addr), Some(trust_token)) = (
        (config.mode == "satellite").then_some(config.hub_addr).flatten(),
        config.trust_token,
    ) else {
        return Ok(LanRelayResultV3 { redirected: false, data: None, error: None });
    };

    let client = reqwest::Client::new();
    let resp = match client
        .post(format!("http://{hub_addr}/rpc/{command}"))
        .bearer_auth(trust_token)
        .json(&args)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(LanRelayResultV3 { redirected: true, data: None, error: Some(format!("could not reach hub: {e}")) });
        }
    };
    let body: Value = match resp.json().await {
        Ok(b) => b,
        Err(e) => return Ok(LanRelayResultV3 { redirected: true, data: None, error: Some(e.to_string()) }),
    };
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(LanRelayResultV3 { redirected: true, data: Some(body.get("data").cloned().unwrap_or(Value::Null)), error: None })
    } else {
        let err = body.get("error").and_then(Value::as_str).unwrap_or("hub rejected request").to_string();
        Ok(LanRelayResultV3 { redirected: true, data: None, error: Some(err) })
    }
}

#[cfg(test)]
mod tests {
    //! Deliberately never touches `DB_DIR` (a process-global `OnceLock` --
    //! see its own doc comment) or a real Tauri `AppHandle` (constructing
    //! one crashes this dev box, see `commands_v3::tests::command_wrapper_tests`'s
    //! doc comment). Exercises `resolve_actor_via_hub_with_config` against
    //! a plain, hand-built axum server standing in for the Hub's real
    //! `/rpc/__resolve_actor_v3` route -- that's the entire surface this
    //! function talks to, so this proves the HTTP+parsing contract without
    //! needing either.
    use super::*;

    async fn spawn_stub_hub(response: serde_json::Value) -> String {
        let router = Router::new().route(
            "/rpc/__resolve_actor_v3",
            axum::routing::post(move || {
                let response = response.clone();
                async move { Json(response) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        addr.to_string()
    }

    fn satellite_config(hub_addr: String) -> LanConfig {
        LanConfig {
            mode: "satellite".to_string(),
            hub_addr: Some(hub_addr),
            trust_token: Some("test-trust-token".to_string()),
            pairing_request_id: None,
            device_name: "Test Satellite".to_string(),
        }
    }

    #[test]
    fn standalone_and_hub_terminals_never_attempt_a_network_call() {
        let standalone = LanConfig { mode: "standalone".to_string(), ..Default::default() };
        assert!(resolve_actor_via_hub_with_config(&standalone, "any-token").unwrap().is_none());

        let hub = LanConfig { mode: "hub".to_string(), ..Default::default() };
        assert!(resolve_actor_via_hub_with_config(&hub, "any-token").unwrap().is_none());
    }

    #[test]
    fn satellite_with_no_completed_pairing_yet_is_also_a_no_op() {
        let unpaired = LanConfig { mode: "satellite".to_string(), ..Default::default() };
        assert!(resolve_actor_via_hub_with_config(&unpaired, "any-token").unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_paired_satellite_resolves_a_hub_only_session_into_a_usable_actor() {
        let hub_addr = spawn_stub_hub(serde_json::json!({
            "ok": true,
            "data": {
                "id": "staff-1",
                "tenant_id": "tenant-1",
                "branch_id": "branch-1",
                "role": "Cashier",
                "device_id": "hub-terminal-1",
            }
        }))
        .await;

        let config = satellite_config(hub_addr);
        let actor = resolve_actor_via_hub_with_config(&config, "some-hub-only-session-token")
            .unwrap()
            .expect("a successful hub response must resolve to Some(actor)");
        assert_eq!(actor.id, "staff-1");
        assert_eq!(actor.tenant_id, "tenant-1");
        assert_eq!(actor.branch_id.as_deref(), Some("branch-1"));
        assert_eq!(actor.role, crate::security::Role::Cashier);
        assert_eq!(actor.device_id, "hub-terminal-1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_paired_satellite_surfaces_the_hubs_own_rejection_reason() {
        let hub_addr = spawn_stub_hub(serde_json::json!({
            "ok": false,
            "error": "session expired",
        }))
        .await;

        let config = satellite_config(hub_addr);
        let err = resolve_actor_via_hub_with_config(&config, "an-expired-token").unwrap_err();
        assert_eq!(err, "session expired");
    }

    #[test]
    fn a_paired_satellite_whose_hub_is_unreachable_gets_a_clear_error_not_a_panic() {
        // Port 1 is reserved and nothing will ever be listening there.
        let config = satellite_config("127.0.0.1:1".to_string());
        let err = resolve_actor_via_hub_with_config(&config, "any-token").unwrap_err();
        assert!(err.contains("could not reach hub"), "got: {err}");
    }
}
