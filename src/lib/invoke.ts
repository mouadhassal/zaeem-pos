import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { useSessionStore } from "../stores/sessionStore";
import { LAN_REDIRECT_COMMANDS, relayIfSatellite } from "./lan";

/**
 * Drop-in replacement for `@tauri-apps/api/core`'s `invoke` -- same
 * signature, same return value, same thrown error. Two additions, both
 * fire-and-forget/observational, neither changes what the caller gets
 * back:
 * 1. On rejection, logs to the Rust side (`log_frontend_command_error`),
 *    which lands in the same rotating log file as every SQLite/sync/
 *    license line (see obslog.rs). This is the one place in the whole app
 *    that already knows which command just failed for every call site.
 * 2. If the rejection is specifically "session expired" (the exact text
 *    `SecurityError::SessionExpired`'s Display produces -- see
 *    security.rs, pinned by a test), flips the global session store so
 *    `SessionExpiredOverlay` shows a PIN re-entry prompt instead of every
 *    page's own catch block rendering its own generic error banner. Any
 *    OTHER error (a real DB error, a permission error, etc.) is left
 *    alone -- this only fires for the one specific, unambiguous string.
 *
 * P0 follow-up (2026-07-23): the "database is not there anymore after ~1h"
 * report was undiagnosable after the fact (fixed by #1) and, separately,
 * was actually session expiry masquerading as a database error (fixed by
 * the 16h+sliding session lifetime in security.rs, surfaced here by #2).
 *
 * T3.0 LAN hub/satellite: a third addition, ONLY for commands on
 * `LAN_REDIRECT_COMMANDS`. On a paired Satellite terminal these are sent
 * to the branch's Hub instead of running against this terminal's own
 * (otherwise-empty-of-shared-data) local DB -- this is the single
 * chokepoint that makes a second cashier register or a separate KDS
 * machine see the same orders/tables as the Hub. On a standalone or Hub
 * terminal, `relayIfSatellite` returns `redirected: false` immediately and
 * this falls through to the exact same local call as before.
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    if (LAN_REDIRECT_COMMANDS.has(cmd)) {
      const relayed = await relayIfSatellite<T>(cmd, args as Record<string, unknown> | undefined);
      if (relayed.redirected) {
        if (relayed.error) throw new Error(relayed.error);
        return relayed.data as T;
      }
    }
    return await tauriInvoke<T>(cmd, args, options);
  } catch (err) {
    tauriInvoke("log_frontend_command_error", { command: cmd, error: String(err) }).catch(() => {});
    if (String(err).includes("session expired")) {
      useSessionStore.getState().setExpired(true);
    }
    throw err;
  }
}
