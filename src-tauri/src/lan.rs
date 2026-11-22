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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Satellite-only: what this terminal declared itself as at pairing
    /// time -- "register" or "kitchen". Kept locally purely for the
    /// Network settings tab to display; the Hub's own `paired_terminal`
    /// row is what's actually authoritative and enforced.
    pub device_role: Option<String>,
    pub device_name: String,
    /// Internet route between the tills of one branch (`cloud_relay.rs`):
    /// the Hub answers commands other tills send through the cloud, and a
    /// Satellite falls back to it when the LAN link is down (or has no LAN
    /// address at all). Defaults to ON, also for a `lan_config.json` written
    /// before this field existed; the owner can switch it off.
    #[serde(default = "default_true")]
    pub cloud: bool,
}

fn default_true() -> bool {
    true
}

impl Default for LanConfig {
    fn default() -> Self {
        Self {
            mode: String::new(),
            hub_addr: None,
            trust_token: None,
            pairing_request_id: None,
            device_role: None,
            device_name: String::new(),
            cloud: true,
        }
    }
}

/// `dir` is this install's own data folder (every caller passes the folder,
/// never the .db file). This used to take `dir.parent()` -- i.e. the shared
/// %APPDATA% root -- so every install on the PC read and wrote ONE
/// lan_config.json: a second WENZDES install (or a test build) switching
/// to hub/satellite switched all of them.
fn lan_config_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("lan_config.json")
}

/// One-time move for installs that saved under the old shared location
/// (see `lan_config_path`): copies it in if this install has none yet.
pub fn migrate_legacy_lan_config(dir: &std::path::Path) {
    let new = lan_config_path(dir);
    if new.exists() {
        return;
    }
    if let Some(legacy) = dir.parent().map(|p| p.join("lan_config.json")) {
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, &new);
        }
    }
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

/// Same idea as `DB_DIR`: lets `resolve_actor_via_hub` (a plain `fn` with no
/// `AppHandle`) read this till's own cloud device token for the internet route.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// This till's own licence device token, if it was cloud-activated. `None`
/// in unit tests (no app handle), which keeps them off the internet route.
pub fn current_device_token() -> Option<String> {
    let app = APP_HANDLE.get()?;
    app.try_state::<crate::license::cloud::CloudLicenseState>()?.device_token()
}

/// The Hub's own "something changed" fan-out, kept here so commands answered
/// through the cloud (`cloud_relay.rs`) can nudge the LAN satellites too.
static HUB_EVENT_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();

pub fn broadcast_orders_changed() {
    if let Some(tx) = HUB_EVENT_TX.get() {
        let _ = tx.send("orders_changed".to_string());
    }
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
        // Recovers from a poisoned lock instead of panicking -- runs at
        // every app boot for Hub-mode terminals; a poisoned flag here has
        // no invariant worth protecting over just proceeding.
        let mut started = HUB_SERVER_STARTED.lock().unwrap_or_else(|e| e.into_inner());
        if *started {
            return;
        }
        *started = true;
    }

    let (event_tx, _rx) = broadcast::channel::<String>(256);
    let _ = HUB_EVENT_TX.set(event_tx.clone());
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

    // Internet route: answer commands other tills of the branch send through
    // the cloud. Idle (cheap loop) unless config says hub + cloud and this
    // till has a device token; never touches the LAN server above.
    crate::cloud_relay::start_hub_tasks(app.clone());

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
    /// "register" (a real cash register/POS terminal -- must already hold
    /// its own active license, checked client-side before this request is
    /// even sent, see `request_pairing_v3`) or "kitchen" (a KDS-only
    /// terminal -- free, and restricted server-side to a small safe
    /// command subset regardless of what it later asks for, see
    /// `kitchen_role_may_call`). Never trusted alone: the Hub-side gate in
    /// `rpc_dispatch` is what actually enforces this, not the client's own
    /// declaration.
    device_role: String,
}

#[derive(Serialize)]
struct PairRequestResponse {
    request_id: String,
}

async fn pair_request(
    AxumState(state): AxumState<LanState>,
    Json(body): Json<PairRequestBody>,
) -> impl IntoResponse {
    if body.device_role != "register" && body.device_role != "kitchen" {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "deviceRole must be \"register\" or \"kitchen\""}))).into_response();
    }
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
        "INSERT INTO paired_terminal (id, device_name, trust_token_hash, device_role, status, requested_at) VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5)",
        rusqlite::params![id, body.device_name, body.trust_token_hash, body.device_role, now],
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

/// True for the small set of commands a free 'kitchen' Satellite may call
/// regardless of what it asks for -- everything else (every order-
/// creating/paying/shift command) requires a 'register' Satellite, which
/// in turn requires its own active license (enforced client-side at
/// `request_pairing_v3` time, before it ever reaches the Hub). This is the
/// server-side half of the licensing kill-switch: a Satellite can declare
/// itself "kitchen" to pair for free, but the Hub -- not the client's own
/// declaration -- is what actually stops it from being used as a free cash
/// register.
pub fn kitchen_role_may_call(command: &str) -> bool {
    matches!(
        command,
        "login_pin_v3" | "logout_v3" | "list_kitchen_orders_v3" | "update_order_status_v3" | "__resolve_actor_v3"
            // KDS screen needs: `authStore.checkSession` probes the stored session with
            // `list_categories_v3` (a kitchen screen would otherwise be logged out on every
            // restart once that read is forwarded), the out-of-stock panel lists the menu and
            // 86's an item, and the sidebar reads the business mode. All read-only except the
            // availability toggle, which is floor work and not license- or cash-related.
            | "list_categories_v3" | "list_menu_items_v3" | "toggle_menu_item_availability_v3" | "get_business_mode_v3"
    )
}

/// Closes the LOCAL-bypass version of the licensing kill-switch (2026-07-26
/// audit, part 2): `rpc_dispatch`'s `kitchen_role_may_call` gate only
/// protects a REMOTE call arriving at the Hub over the LAN -- it does
/// nothing to stop a kitchen-role Satellite's OWN local command handlers
/// from running directly, since Tauri's IPC bridge exposes every
/// `#[tauri::command]` to the webview regardless of `invoke.ts`'s
/// JS-level redirection (a devtools console calling
/// `window.__TAURI__.core.invoke("create_full_order_v3", ...)` reaches the
/// exact same function, with zero dependency on `invoke.ts` existing at
/// all). Called at the top of every order/payment/shift `_impl` whose
/// command name is NOT in `kitchen_role_may_call`'s safe subset -- a no-op
/// for every standalone/Hub terminal and every 'register'-role satellite;
/// only `mode == "satellite" && device_role == "kitchen"` ever rejects.
pub fn reject_if_local_kitchen_satellite(command: &str) -> Result<(), String> {
    let Some(dir) = DB_DIR.get() else { return Ok(()) };
    let config = load_lan_config(dir);
    if config.mode == "satellite" && config.device_role.as_deref() == Some("kitchen") && !kitchen_role_may_call(command) {
        return Err(
            "هذا الجهاز مسجل كشاشة مطبخ فقط ولا يمكنه تنفيذ عمليات نقطة البيع (طلبات/دفع/وردية) -- يجب ربطه كجهاز كاشير مرخّص لهذا الغرض".to_string(),
        );
    }
    Ok(())
}

/// Looks up the calling Satellite's own trust token (from the
/// `Authorization: Bearer <token>` header) against approved, non-revoked
/// `paired_terminal` rows and returns its declared `device_role`. Any RPC
/// call without a valid, approved token is rejected before it ever reaches
/// real command logic.
fn authorize_satellite(conn: &rusqlite::Connection, headers: &HeaderMap) -> Result<String, String> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing Authorization header".to_string())?;
    let token = auth.strip_prefix("Bearer ").ok_or_else(|| "malformed Authorization header".to_string())?;
    let hash = sha256_hex(token);
    let now = chrono::Utc::now().to_rfc3339();
    let device_role: Option<String> = conn
        .query_row(
            "SELECT device_role FROM paired_terminal WHERE trust_token_hash = ?1 AND status = 'APPROVED'",
            rusqlite::params![hash],
            |r| r.get(0),
        )
        .ok();
    let Some(device_role) = device_role else {
        return Err("terminal is not paired/approved".to_string());
    };
    let _ = conn.execute(
        "UPDATE paired_terminal SET last_seen_at = ?1 WHERE trust_token_hash = ?2",
        rusqlite::params![now, hash],
    );
    Ok(device_role)
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

/// The role the Hub assumes for a command that arrived through the cloud
/// relay (`cloud_relay.rs`). The `pos-relay` edge function only forwards a
/// command after checking that the sender holds an active licence of THIS
/// branch, which is the same bar `request_pairing_v3` sets for a 'register'
/// Satellite; free 'kitchen' screens have no licence and cannot use it.
pub const CLOUD_RELAY_ROLE: &str = "register";

/// What running one forwarded command produced: the HTTP status the LAN
/// route answers with, the `{ok, data}` / `{ok: false, error}` envelope (the
/// same JSON both routes hand back to the Satellite), and whether the
/// command changed orders (so everyone should re-fetch).
pub struct RpcOutcome {
    pub status: StatusCode,
    pub body: Value,
    pub mutated: bool,
}

/// The one path every forwarded command takes on the Hub, whether it came in
/// over the LAN (`rpc_dispatch`, after `authorize_satellite`) or through the
/// cloud (`cloud_relay.rs`, role `CLOUD_RELAY_ROLE`).
///
/// Licensing kill-switch (2026-07-26 audit): a 'kitchen' Satellite is free
/// and read-mostly by design -- it does NOT get a free pass into the full
/// order/payment/shift command set just because it's on the same allowlist as
/// a licensed 'register' terminal. This check is authoritative regardless of
/// what `dispatch_lan_rpc`'s own allowlist would otherwise permit.
///
/// `State<T>` derefs to `&T`, so callers pass exactly the plain references a
/// unit test builds with `real_db()`/`never_checked_license()`.
pub fn execute_rpc(
    db: &Db,
    license: &crate::license::cloud::CloudLicenseState,
    device_role: &str,
    command: &str,
    args: Value,
) -> RpcOutcome {
    let fail = |status: StatusCode, message: &str| RpcOutcome {
        status,
        body: serde_json::json!({ "ok": false, "error": message }),
        mutated: false,
    };
    if device_role == "kitchen" && !kitchen_role_may_call(command) {
        return fail(
            StatusCode::FORBIDDEN,
            "this device is paired as a kitchen-screen-only terminal and cannot run cash register commands -- pair it as a register terminal with its own active license instead",
        );
    }
    match crate::commands::lan_rpc::dispatch_lan_rpc(db, license, command, args) {
        Ok(value) => RpcOutcome {
            status: StatusCode::OK,
            body: serde_json::json!({ "ok": true, "data": value }),
            mutated: crate::commands::lan_rpc::lan_rpc_mutates_orders(command),
        },
        Err(e) if e == "UNKNOWN_COMMAND" => fail(StatusCode::NOT_FOUND, &format!("'{command}' is not exposed over LAN RPC")),
        Err(e) => fail(StatusCode::BAD_REQUEST, &e),
    }
}

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
    let device_role = {
        let conn = match db.0.lock() {
            Ok(c) => c,
            Err(e) => return rpc_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        };
        match authorize_satellite(&conn, &headers) {
            Ok(role) => role,
            Err(e) => return rpc_error(StatusCode::UNAUTHORIZED, &e),
        }
    };

    let outcome = execute_rpc(&db, &license, &device_role, &command, args);
    if outcome.mutated {
        broadcast_change(&state, "orders_changed");
    }
    (outcome.status, Json(outcome.body)).into_response()
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
    /// This PC's own LAN address with the Hub port ("192.168.1.5:47811"), shown
    /// on the Hub screen so a second POS can type it when mDNS search finds
    /// nothing (firewall, router blocking multicast).
    pub local_addr: Option<String>,
    /// False when this device's own licence would refuse a 'register' pairing,
    /// so the screen only warns about a licence when one is really missing.
    pub licensed: bool,
    /// The owner's switch "السماح بالاتصال عبر الإنترنت" (`LanConfig::cloud`).
    pub cloud: bool,
    /// True when this till can use the internet route at all: it holds its
    /// own licence device token and is not a free kitchen screen.
    pub cloud_available: bool,
    /// Satellite only: the route the last relayed command used ("lan" or
    /// "cloud"); `None` when nothing was relayed in the last minute.
    pub route: Option<String>,
}

pub(crate) fn db_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_lan_status_v3(
    app: AppHandle,
    state: State<Db>,
    license: State<'_, crate::license::cloud::CloudLicenseState>,
    session_token: String,
) -> Result<LanStatusV3, String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    let paired = config.mode == "satellite" && (config.trust_token.is_some() || crate::cloud_relay::is_cloud_only(&config));
    Ok(LanStatusV3 {
        mode: config.mode.clone(),
        device_name: config.device_name,
        hub_addr: config.hub_addr,
        paired,
        local_addr: local_ip().map(|ip| format!("{ip}:{LAN_HUB_PORT}")),
        licensed: !license.cached_status().back_office_locked(),
        cloud: config.cloud,
        cloud_available: license.device_token().is_some() && config.device_role.as_deref() != Some("kitchen"),
        route: if config.mode == "satellite" { crate::cloud_relay::route_in_use().map(|r| r.as_str().to_string()) } else { None },
    })
}

/// Turns THIS terminal into the branch's Hub. Idempotent -- safe to call
/// again (e.g. after a restart); `start_hub_server` itself no-ops if the
/// server is already running in this process.
#[tauri::command]
pub fn enable_hub_mode_v3(app: AppHandle, state: State<Db>, session_token: String) -> Result<(), String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
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
    pub device_role: String,
    pub requested_at: String,
}

#[tauri::command]
pub fn list_pending_pairings_v3(state: State<Db>, session_token: String) -> Result<Vec<PendingPairingV3>, String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, device_name, device_role, requested_at FROM paired_terminal WHERE status = 'PENDING' ORDER BY requested_at ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(PendingPairingV3 { id: r.get(0)?, device_name: r.get(1)?, device_role: r.get(2)?, requested_at: r.get(3)? }))
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
    pub device_role: String,
    pub status: String,
    pub last_seen_at: Option<String>,
}

#[tauri::command]
pub fn list_paired_terminals_v3(state: State<Db>, session_token: String) -> Result<Vec<PairedTerminalV3>, String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, device_name, device_role, status, last_seen_at FROM paired_terminal WHERE status IN ('APPROVED','REVOKED') ORDER BY device_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(PairedTerminalV3 { id: r.get(0)?, device_name: r.get(1)?, device_role: r.get(2)?, status: r.get(3)?, last_seen_at: r.get(4)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn approve_pairing_v3(state: State<Db>, session_token: String, request_id: String) -> Result<(), String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
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
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
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
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
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

/// Turns what a person types (or what mDNS returned) into "host:port".
/// Accepts "192.168.1.5", "192.168.1.5:47811", "http://192.168.1.5/" and
/// surrounding spaces; adds the Hub port when it is missing. Refuses
/// anything that is not a plain host (no paths, no spaces inside).
pub fn normalize_hub_addr(raw: &str) -> Result<String, String> {
    let mut s = raw.trim();
    for prefix in ["http://", "https://"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
        }
    }
    let s = s.trim_end_matches('/');
    let bad = || "عنوان الجهاز المركزي غير صحيح. اكتبه كما يظهر على الجهاز المركزي، مثل 192.168.1.5".to_string();
    if s.is_empty() || s.contains(char::is_whitespace) || s.contains('/') {
        return Err(bad());
    }
    if let Ok(sock) = s.parse::<std::net::SocketAddr>() {
        return Ok(sock.to_string());
    }
    if let Ok(ip) = s.parse::<std::net::IpAddr>() {
        return Ok(std::net::SocketAddr::new(ip, LAN_HUB_PORT).to_string());
    }
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().map_err(|_| bad())?),
        None => (s, LAN_HUB_PORT),
    };
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err(bad());
    }
    Ok(format!("{host}:{port}"))
}

/// The PowerShell run (elevated) by `open_lan_firewall_v3`: network profile
/// Public -> Private, drop the Block rules Windows creates when someone
/// presses Cancel on its firewall prompt, then allow this app, the Hub port
/// and mDNS on every profile. A pure function so a test can check the exact
/// rules without touching the real firewall.
pub fn lan_firewall_script(exe_path: &str) -> String {
    let exe = exe_path.replace('\'', "''");
    [
        "$ErrorActionPreference = 'SilentlyContinue'".to_string(),
        "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | Set-NetConnectionProfile -NetworkCategory Private".to_string(),
        format!("Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -eq '{exe}' }} | Get-NetFirewallRule | Where-Object {{ $_.Action -eq 'Block' }} | Remove-NetFirewallRule"),
        "Get-NetFirewallRule -DisplayName 'WENZDES POS*' | Remove-NetFirewallRule".to_string(),
        format!("New-NetFirewallRule -DisplayName 'WENZDES POS app' -Direction Inbound -Program '{exe}' -Action Allow -Profile Any | Out-Null"),
        format!("New-NetFirewallRule -DisplayName 'WENZDES POS LAN TCP' -Direction Inbound -Protocol TCP -LocalPort {LAN_HUB_PORT} -Action Allow -Profile Any | Out-Null"),
        "New-NetFirewallRule -DisplayName 'WENZDES POS LAN mDNS' -Direction Inbound -Protocol UDP -LocalPort 5353 -Action Allow -Profile Any | Out-Null".to_string(),
    ]
    .join("\n")
}

/// Opens Windows Firewall for the local network link. Windows shows its own
/// admin (UAC) prompt; nothing changes unless the person accepts it. Owner /
/// manager only (ManageSettings), like every other network setting.
#[tauri::command]
pub fn open_lan_firewall_v3(state: State<Db>, session_token: String) -> Result<(), String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use base64::Engine as _;
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = lan_firewall_script(&exe.to_string_lossy());
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let launcher = format!(
            "$p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','{encoded}'; if (-not $p) {{ exit 1 }}"
        );
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &launcher])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("لم يُفتح جدار الحماية: لم تتم الموافقة على صلاحية المدير في ويندوز. أعد المحاولة واضغط «نعم».".to_string());
        }
        crate::obslog::log_lan_error("firewall opened for the LAN link (user accepted the admin prompt)");
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// Browses mDNS for ~4 seconds and returns whatever Hubs answered. Short
/// and synchronous-feeling on purpose -- this backs a "بحث" (search)
/// button on a settings screen, not a background service.
#[tauri::command]
pub async fn discover_hubs_v3() -> Result<Vec<DiscoveredHubV3>, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
    let receiver = daemon.browse(MDNS_SERVICE_TYPE).map_err(|e| e.to_string())?;
    let mut found = Vec::new();
    // 4 s: on a busy Wi-Fi the first answer often arrives after 2 s.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    while std::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let addrs = info.get_addresses();
                let ip = addrs.iter().find(|a| a.is_ipv4()).or_else(|| addrs.iter().next());
                if let Some(ip) = ip {
                    let addr = std::net::SocketAddr::new(*ip, info.get_port()).to_string();
                    if !found.iter().any(|h: &DiscoveredHubV3| h.addr == addr) {
                        let name = info.get_fullname().split("._").next().unwrap_or_default().to_string();
                        found.push(DiscoveredHubV3 { name, addr });
                    }
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

/// The Hub's `/pair/request` reply (`PairRequestResponse`, snake_case).
/// This used to be `rename_all = "camelCase"` -- expecting `requestId`
/// against a Hub that sends `request_id` -- so every pairing attempt failed
/// to parse AFTER the Hub had recorded it, the satellite never saved its
/// pairing, and a second register could never join. Accepts both.
#[derive(Deserialize)]
struct PairRequestReply {
    #[serde(alias = "requestId")]
    request_id: String,
}

/// Kicks off pairing with a Hub discovered via `discover_hubs_v3`. Safe to
/// call again after an app restart if a previous attempt is still
/// PENDING/APPROVED -- reuses the same locally-generated trust token and
/// request id rather than creating a duplicate row on the Hub.
///
/// Licensing kill-switch (2026-07-26 audit): pairing as a free "kitchen"
/// Satellite has no license requirement -- it's a read-mostly KDS by
/// design, enforced server-side on every call by `rpc_dispatch`/
/// `kitchen_role_may_call`. Pairing as "register" (a real cash register)
/// requires THIS device to already hold its own active license -- the
/// same `back_office_locked()` gate every terminal's back office already
/// obeys -- checked here, before the request ever reaches the Hub, so an
/// unlicensed device can't even become a pending pairing request.
#[tauri::command]
pub async fn request_pairing_v3(
    app: AppHandle,
    license: State<'_, crate::license::cloud::CloudLicenseState>,
    hub_addr: String,
    device_name: String,
    device_role: String,
) -> Result<(), String> {
    if device_role != "register" && device_role != "kitchen" {
        return Err("deviceRole must be \"register\" or \"kitchen\"".to_string());
    }
    if device_role == "register" && license.cached_status().back_office_locked() {
        return Err(
            "هذا الجهاز لا يملك ترخيصاً فعّالاً. كل نقطة بيع (كاشير) يجب أن يكون لها ترخيص خاص بها -- فعّل ترخيص هذا الجهاز أولاً من تبويب الترخيص، أو اربطه كشاشة مطبخ فقط (مجاناً) إذا كان الغرض عرض الطلبات فقط.".to_string()
        );
    }

    let hub_addr = normalize_hub_addr(&hub_addr)?;
    let dir = db_dir(&app)?;
    let mut config = load_lan_config(&dir);

    let trust_token = config.trust_token.clone().unwrap_or_else(random_trust_token);
    let trust_token_hash = sha256_hex(&trust_token);

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("http://{hub_addr}/pair/request"))
        .json(&serde_json::json!({ "device_name": device_name, "trust_token_hash": trust_token_hash, "device_role": device_role }))
        .send()
        .await
        .map_err(|e| {
            crate::obslog::log_lan_error(&format!("pairing: could not reach hub at {hub_addr}: {e}"));
            format!(
                "تعذّر الوصول إلى الجهاز المركزي على العنوان {hub_addr}. تأكد أن الجهازين على نفس الراوتر، وأن الجهاز المركزي مفعّل كـ«مركزي» وتطبيقه مفتوح، ثم اضغط «السماح عبر جدار الحماية» على الجهازين."
            )
        })?;
    if !resp.status().is_success() {
        return Err(format!("رفض الجهاز المركزي طلب الاتصال (رمز {}).", resp.status().as_u16()));
    }
    let body: PairRequestReply = resp.json().await.map_err(|e| e.to_string())?;

    config.mode = "satellite".to_string();
    config.hub_addr = Some(hub_addr);
    config.trust_token = Some(trust_token);
    config.pairing_request_id = Some(body.request_id);
    config.device_role = Some(device_role);
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
    // LAN first, the internet as fallback (or the only route for a till
    // joined over the internet) -- see `cloud_relay::plan_routes`.
    let device_token = current_device_token();
    if crate::cloud_relay::plan_routes(&crate::cloud_relay::route_inputs(config, device_token.is_some())).is_empty() {
        return Ok(None);
    }
    let config = config.clone();
    let session_token = session_token.to_string();

    let fetch = async move {
        crate::cloud_relay::relay(&config, device_token.as_deref(), "__resolve_actor_v3", &serde_json::json!({ "sessionToken": session_token })).await
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
            // The Hub confirmed who this is; the owner's table lives on the Hub and back-office work is done there.
            access: Default::default(),
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
    /// Empty for a till that joined over the internet (no LAN address).
    pub hub_addr: String,
    /// True when the internet route is on for this satellite.
    pub cloud: bool,
}

/// Lets the frontend know "am I a satellite, and if so, where's my Hub"
/// without an authenticated round-trip first. Returns `None` for
/// standalone/hub terminals (the overwhelming majority of calls), so this is
/// deliberately cheap: a sync file read, no DB, no network. A till joined
/// over the internet is a satellite with an empty `hub_addr`.
#[tauri::command]
pub fn get_lan_redirect_target_v3(app: AppHandle) -> Result<Option<LanRedirectTargetV3>, String> {
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    if config.mode == "satellite" {
        if let Some(hub_addr) = config.hub_addr.clone().filter(|a| !a.trim().is_empty()) {
            return Ok(Some(LanRedirectTargetV3 { hub_addr, cloud: config.cloud }));
        }
        if crate::cloud_relay::is_cloud_only(&config) {
            return Ok(Some(LanRedirectTargetV3 { hub_addr: String::new(), cloud: true }));
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
///
/// Route: the LAN first; if the Hub cannot be reached there (or this till has
/// no LAN address) and the internet route is on, through the cloud relay.
/// See `cloud_relay::relay`.
#[tauri::command]
pub async fn lan_relay_v3(app: AppHandle, command: String, args: Value) -> Result<LanRelayResultV3, String> {
    let dir = db_dir(&app)?;
    let config = load_lan_config(&dir);
    if config.mode != "satellite" {
        return Ok(LanRelayResultV3 { redirected: false, data: None, error: None });
    }
    let device_token = current_device_token();
    let inputs = crate::cloud_relay::route_inputs(&config, device_token.is_some());
    if crate::cloud_relay::plan_routes(&inputs).is_empty() {
        // A till set up for the internet whose licence/switch no longer
        // allows it must say so, not quietly sell against its own empty DB.
        if crate::cloud_relay::is_cloud_only(&config) {
            return Ok(LanRelayResultV3 {
                redirected: true,
                data: None,
                error: Some("هذا الجهاز مضبوط للعمل عبر الإنترنت لكن الاتصال عبر الإنترنت غير متاح (الترخيص غير مفعّل أو الخيار مغلق). فعّل الترخيص أو «السماح بالاتصال عبر الإنترنت» من «الشبكة المحلية».".to_string()),
            });
        }
        return Ok(LanRelayResultV3 { redirected: false, data: None, error: None });
    }

    let body = match crate::cloud_relay::relay(&config, device_token.as_deref(), &command, &args).await {
        Ok(b) => b,
        Err(e) => return Ok(LanRelayResultV3 { redirected: true, data: None, error: Some(e) }),
    };
    if body.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(LanRelayResultV3 { redirected: true, data: Some(body.get("data").cloned().unwrap_or(Value::Null)), error: None })
    } else {
        let err = body.get("error").and_then(Value::as_str).unwrap_or("hub rejected request").to_string();
        Ok(LanRelayResultV3 { redirected: true, data: None, error: Some(err) })
    }
}

// ---------------------------------------------------------------------------
// Internet route: the owner's switch, "is the Hub online", and joining a Hub
// over the internet instead of the LAN. The plumbing is `cloud_relay.rs`.
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRelayStatusV3 {
    /// This till can use the internet route at all (own licence token, not a
    /// free kitchen screen).
    pub available: bool,
    pub enabled: bool,
    /// `None` when the question could not be asked (no token / offline).
    pub hub_online: Option<bool>,
    pub hub_label: Option<String>,
    pub last_seen_at: Option<String>,
    /// This till is the one the cloud knows as the branch's hub.
    pub is_hub: bool,
    /// Plain Arabic reason when `hub_online` is unknown.
    pub error: Option<String>,
}

/// Asks the cloud whether the branch's Hub is online. One short request;
/// the settings screen calls it every ~15 s.
#[tauri::command]
pub async fn get_cloud_relay_status_v3(
    app: AppHandle,
    state: State<'_, Db>,
    license: State<'_, crate::license::cloud::CloudLicenseState>,
    session_token: String,
) -> Result<CloudRelayStatusV3, String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let config = load_lan_config(&db_dir(&app)?);
    let token = license.device_token();
    let is_kitchen = config.device_role.as_deref() == Some("kitchen");
    let available = token.is_some() && !is_kitchen;
    let mut out = CloudRelayStatusV3 {
        available,
        enabled: config.cloud,
        hub_online: None,
        hub_label: None,
        last_seen_at: None,
        is_hub: false,
        error: None,
    };
    let Some(token) = token.filter(|_| available) else {
        out.error = Some(if is_kitchen {
            "شاشة المطبخ المجانية لا تعمل عبر الإنترنت. تحتاج ترخيصاً خاصاً بهذا الجهاز.".to_string()
        } else {
            "هذا الجهاز بلا ترخيص مفعّل، فلا يمكنه الاتصال عبر الإنترنت.".to_string()
        });
        return Ok(out);
    };
    match crate::cloud_relay::hub_status(&token).await {
        Ok(s) => {
            out.hub_online = Some(s.hub_online);
            out.hub_label = s.hub_label;
            out.last_seen_at = s.last_seen_at;
            out.is_hub = s.is_hub;
        }
        Err(e) => out.error = Some(e.message),
    }
    Ok(out)
}

/// The owner's switch "السماح بالاتصال عبر الإنترنت". On a Hub it decides
/// whether it answers cloud commands; on a Satellite whether it may use the
/// internet route. Takes effect within seconds, no restart.
#[tauri::command]
pub fn set_cloud_relay_enabled_v3(app: AppHandle, state: State<Db>, session_token: String, enabled: bool) -> Result<(), String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    let dir = db_dir(&app)?;
    let mut config = load_lan_config(&dir);
    config.cloud = enabled;
    save_lan_config(&dir, &config)
}

/// "الاتصال عبر الإنترنت": makes this till a Satellite of its branch's Hub
/// without any LAN address, if the Hub is online in the cloud. Needs this
/// till's own active licence, exactly like pairing as a LAN 'register'.
#[tauri::command]
pub async fn join_hub_via_internet_v3(
    app: AppHandle,
    state: State<'_, Db>,
    license: State<'_, crate::license::cloud::CloudLicenseState>,
    session_token: String,
) -> Result<(), String> {
    let actor = crate::commands::shared::authenticate_actor(&state, &session_token)?;
    crate::security::authorize(&actor, crate::security::Permission::ManageSettings).map_err(|e| e.to_string())?;
    if license.cached_status().back_office_locked() {
        return Err(
            "هذا الجهاز لا يملك ترخيصاً فعّالاً. كل نقطة بيع (كاشير) يجب أن يكون لها ترخيص خاص بها -- فعّل ترخيص هذا الجهاز أولاً من تبويب الترخيص. شاشة المطبخ المجانية لا تعمل عبر الإنترنت.".to_string(),
        );
    }
    let Some(token) = license.device_token() else {
        return Err("هذا الجهاز غير مفعّل على السحابة، فلا يمكنه الاتصال عبر الإنترنت. فعّل الترخيص أولاً.".to_string());
    };
    let status = crate::cloud_relay::hub_status(&token).await.map_err(|e| e.message)?;
    if status.is_hub {
        return Err("هذا الجهاز هو المركزي نفسه في السحابة. افعل هذا على جهاز آخر.".to_string());
    }
    if !status.hub_online {
        return Err("الجهاز المركزي غير متصل بالإنترنت الآن. تأكد أنه مفتوح وأن «السماح بالاتصال عبر الإنترنت» مفعّل عليه.".to_string());
    }
    let dir = db_dir(&app)?;
    let mut config = load_lan_config(&dir);
    config.mode = "satellite".to_string();
    config.hub_addr = None;
    config.trust_token = None;
    config.pairing_request_id = None;
    config.device_role = Some("register".to_string());
    config.cloud = true;
    save_lan_config(&dir, &config)
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
            device_role: Some("register".to_string()),
            device_name: "Test Satellite".to_string(),
            cloud: false,
        }
    }

    #[test]
    fn hub_address_typed_by_hand_is_normalized() {
        assert_eq!(normalize_hub_addr(" 192.168.1.5 ").unwrap(), "192.168.1.5:47811");
        assert_eq!(normalize_hub_addr("192.168.1.5:47811").unwrap(), "192.168.1.5:47811");
        assert_eq!(normalize_hub_addr("http://192.168.1.5/").unwrap(), "192.168.1.5:47811");
        assert_eq!(normalize_hub_addr("10.0.0.7:9000").unwrap(), "10.0.0.7:9000");
        assert_eq!(normalize_hub_addr("pos-main.local").unwrap(), "pos-main.local:47811");
        assert_eq!(normalize_hub_addr("pos-main.local:47811").unwrap(), "pos-main.local:47811");
        for bad in ["", "   ", "192.168.1.5/evil", "a b", "host:notaport", "x;rm", ":47811"] {
            assert!(normalize_hub_addr(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn firewall_script_allows_the_app_the_hub_port_and_mdns_only() {
        let s = lan_firewall_script(r"C:\Program Files\wenzdes-pos\app.exe");
        assert!(s.contains(r"-Program 'C:\Program Files\wenzdes-pos\app.exe' -Action Allow"));
        assert!(s.contains("-Protocol TCP -LocalPort 47811 -Action Allow"));
        assert!(s.contains("-Protocol UDP -LocalPort 5353 -Action Allow"));
        assert!(s.contains("Where-Object { $_.Action -eq 'Block' }"));
        assert!(!s.contains("-Action Block"));
        // a quote in the path cannot break out of the PowerShell string
        assert!(lan_firewall_script(r"C:\it's\app.exe").contains(r"'C:\it''s\app.exe'"));
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

    #[test]
    fn reject_if_local_kitchen_satellite_is_a_no_op_without_db_dir_set() {
        // DB_DIR is a process-global OnceLock this test suite deliberately
        // never sets (see its own doc comment) -- so every test, including
        // this one, always exercises the "no config available yet" path.
        // That's still worth pinning: it must default OPEN (Ok), not
        // fail-closed, since a fresh install with no lan_config.json at
        // all is by far the most common case (standalone).
        assert!(reject_if_local_kitchen_satellite("create_full_order_v3").is_ok());
    }

    /// Licensing kill-switch (2026-07-26 audit): a free 'kitchen' Satellite
    /// must never be usable as a free cash register. Pinning the exact
    /// allowed set here means growing it back toward "everything" by
    /// accident (e.g. someone copy-pasting a new case into
    /// `dispatch_lan_rpc` and assuming it's covered) shows up as a failing
    /// test, not a silent revenue-model hole.
    #[test]
    fn kitchen_role_is_restricted_to_the_read_mostly_kds_safe_subset() {
        for allowed in [
            "login_pin_v3", "logout_v3", "list_kitchen_orders_v3", "update_order_status_v3", "__resolve_actor_v3",
            "list_categories_v3", "list_menu_items_v3", "toggle_menu_item_availability_v3", "get_business_mode_v3",
        ] {
            assert!(kitchen_role_may_call(allowed), "{allowed} must be allowed for a kitchen-role satellite");
        }
        for forbidden in [
            "create_full_order_v3",
            "void_order_item_v3",
            "take_payment_v3",
            "open_shift_v3",
            "close_shift_v3",
            "get_shift_stats_v3",
            "get_active_shift_v3",
            "clock_in_v3",
            "clock_out_v3",
            "list_tables_v3",
            // Second-till forwarding: none of the register-shaped commands may open up to a free
            // kitchen screen just because they now have a dispatch arm.
            "add_items_to_order_v3",
            "finalize_order_with_payment_v3",
            "hold_order_v3",
            "retrieve_open_order_v3",
            "edit_order_item_v3",
            "set_order_item_comp_v3",
            "verify_manager_override_v3",
            "create_table_v3",
            "list_debtors_v3",
            "redeem_loyalty_reward_v3",
            "set_delivery_status_v3",
            "settle_driver_v3",
            "list_active_printers_v3",
            "get_menu_item_photo_v3",
        ] {
            assert!(!kitchen_role_may_call(forbidden), "{forbidden} must be forbidden for a free kitchen-role satellite -- it's a cash-register-shaped command");
        }
    }

    #[test]
    fn lan_config_lives_in_this_installs_own_folder() {
        let root = std::env::temp_dir().join(format!("lan-cfg-{}", uuid::Uuid::now_v7()));
        let a = root.join("com.wenzdes.pos.a");
        let b = root.join("com.wenzdes.pos.b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let mut cfg = load_lan_config(&a);
        cfg.mode = "hub".to_string();
        save_lan_config(&a, &cfg).unwrap();
        assert!(a.join("lan_config.json").exists());
        assert_eq!(load_lan_config(&b).mode, "standalone", "another install on the same PC must not become a hub too");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_shared_lan_config_is_copied_in_once() {
        let root = std::env::temp_dir().join(format!("lan-legacy-{}", uuid::Uuid::now_v7()));
        let a = root.join("com.wenzdes.pos");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(root.join("lan_config.json"), r#"{"mode":"hub","deviceName":"X"}"#).unwrap();
        migrate_legacy_lan_config(&a);
        assert_eq!(load_lan_config(&a).mode, "hub");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `lan_config.json` written before the internet route existed has no
    /// `cloud` key: it must load with the route ON (a hub then answers cloud
    /// commands, a satellite may fall back to it) and keep every other field.
    #[test]
    fn old_lan_config_without_cloud_loads_with_the_internet_route_on() {
        let old = r#"{"mode":"satellite","hubAddr":"192.168.1.5:47811","trustToken":"abc","pairingRequestId":"r1","deviceRole":"register","deviceName":"Till 2"}"#;
        let cfg: LanConfig = serde_json::from_str(old).expect("old file must still parse");
        assert!(cfg.cloud);
        assert_eq!(cfg.mode, "satellite");
        assert_eq!(cfg.hub_addr.as_deref(), Some("192.168.1.5:47811"));
        assert_eq!(cfg.trust_token.as_deref(), Some("abc"));
        assert_eq!(cfg.device_name, "Till 2");
        // the smallest old file too
        let tiny: LanConfig = serde_json::from_str(r#"{"mode":"hub","deviceName":"X"}"#).unwrap();
        assert!(tiny.cloud);
        // an explicit off survives a save/load round trip
        let off = LanConfig { cloud: false, ..tiny };
        let back: LanConfig = serde_json::from_str(&serde_json::to_string(&off).unwrap()).unwrap();
        assert!(!back.cloud);
        // and so does a freshly built default (no file at all)
        assert!(LanConfig::default().cloud);
    }

    #[test]
    fn a_satellite_understands_the_hubs_pairing_reply() {
        let wire = serde_json::to_string(&PairRequestResponse { request_id: "req-1".into() }).unwrap();
        let reply: PairRequestReply = serde_json::from_str(&wire).expect("the satellite must parse exactly what the hub sends");
        assert_eq!(reply.request_id, "req-1");
    }
}
