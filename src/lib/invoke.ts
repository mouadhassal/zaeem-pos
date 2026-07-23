import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

/**
 * Drop-in replacement for `@tauri-apps/api/core`'s `invoke` -- same
 * signature, same return value, same thrown error. The only addition: on
 * rejection, fire-and-forget a log line to the Rust side
 * (`log_frontend_command_error`), which lands in the same rotating log
 * file as every SQLite/sync/license line (see obslog.rs). This is the one
 * place in the whole app that already knows which command just failed for
 * every single call site, without touching any of them beyond this import.
 *
 * P0 follow-up (2026-07-23): the "database is not there anymore after ~1h"
 * report was undiagnosable after the fact because nothing was ever
 * recorded. This makes the next occurrence diagnosable from the log file.
 */
export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (err) {
    tauriInvoke("log_frontend_command_error", { command: cmd, error: String(err) }).catch(() => {});
    throw err;
  }
}
