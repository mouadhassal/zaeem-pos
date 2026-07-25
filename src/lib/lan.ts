import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Phase 1 LAN RPC allowlist -- must match `dispatch_lan_rpc`'s match arms
 * in `commands_v3.rs` exactly. A command NOT in this set is always run
 * against this terminal's own local SQLite, even on a Satellite (Phase 1
 * only redirects the order/table/session-critical path; everything else
 * -- menu editing, reports, settings -- stays a per-terminal action).
 */
export const LAN_REDIRECT_COMMANDS = new Set([
  "login_pin_v3",
  "logout_v3",
  "list_tables_v3",
  "list_kitchen_orders_v3",
  "update_order_status_v3",
  "create_full_order_v3",
  "void_order_item_v3",
  "take_payment_v3",
  "get_active_shift_v3",
  "clock_in_v3",
  "clock_out_v3",
]);

interface LanRelayResult<T> {
  redirected: boolean;
  data?: T;
  error?: string | null;
}

/**
 * Called by `invoke.ts` for every command on `LAN_REDIRECT_COMMANDS`
 * before it would otherwise run locally. Returns `{ redirected: false }`
 * for the overwhelming majority of calls (standalone and Hub terminals,
 * which never redirect) -- the caller falls through to the normal local
 * `invoke` in that case, at the cost of one extra cheap round-trip to a
 * synchronous file read on the Rust side.
 */
export async function relayIfSatellite<T>(command: string, args?: Record<string, unknown>): Promise<LanRelayResult<T>> {
  return tauriInvoke<LanRelayResult<T>>("lan_relay_v3", { command, args: args ?? {} });
}

let cachedHubAddr: string | null | undefined;

async function getHubAddr(): Promise<string | null> {
  if (cachedHubAddr !== undefined) return cachedHubAddr;
  try {
    const target = await tauriInvoke<{ hubAddr: string } | null>("get_lan_redirect_target_v3");
    cachedHubAddr = target?.hubAddr ?? null;
  } catch {
    cachedHubAddr = null;
  }
  return cachedHubAddr;
}

/** Call after pairing/forgetting so the next `connectLanChangeSocket` picks up the new role without an app restart. */
export function invalidateLanTargetCache(): void {
  cachedHubAddr = undefined;
}

/**
 * Opens a WebSocket to the paired Hub's "something changed" broadcast
 * (see `broadcast_change` in `lan.rs`) and calls `onChange` for every
 * message -- the payload itself carries no data, it's just a nudge to
 * re-fetch, so callers should already have a working `fetchX()` to re-run.
 * No-op (returns a no-op cleanup) on standalone/Hub terminals. Reconnects
 * with a fixed backoff on drop (bad Wi-Fi, Hub restart) since this exists
 * to survive exactly that.
 */
export function connectLanChangeSocket(onChange: () => void): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  async function connect() {
    if (stopped) return;
    const hubAddr = await getHubAddr();
    if (!hubAddr || stopped) return;
    try {
      socket = new WebSocket(`ws://${hubAddr}/ws`);
      socket.onmessage = () => onChange();
      socket.onclose = scheduleRetry;
      socket.onerror = () => socket?.close();
    } catch {
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    retryTimer = setTimeout(connect, 5000);
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.close();
  };
}
