import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { logger } from "./logger";

/**
 * Writes to the SAME persisted, rotating log file every other real event
 * in this app writes to (obslog.rs) -- not just `console.*`, which is
 * invisible in a packaged production build with no devtools open. Before
 * this, the auto-updater's own success/failure genuinely had no visible
 * trace anywhere, which is exactly why "I tried it and it didn't work"
 * was undiagnosable from either side.
 */
function logUpdateEvent(message: string) {
  logger.info(message);
  tauriInvoke("log_update_event", { message }).catch(() => {});
}

/**
 * 2026-07-27, shipping day: silent, no-prompt update check -- runs once at
 * cold boot, before the splash screen hands off to the real app. If a
 * signed newer build is available (see apps/control's /api/updates route
 * and the app_release table), it's downloaded and installed, then the app
 * relaunches on its own straight into the new version. The cashier never
 * sees a dialog or has to do anything; the only visible effect is the
 * splash screen taking a little longer than usual, once, on whichever
 * boot the update lands on. Every other terminal on every other branch
 * picks up the same update the same way, independently, the next time
 * each of them is cold-booted -- no manual reinstall anywhere.
 */
export async function checkForUpdatesSilently(): Promise<void> {
  if (!("__TAURI__" in window)) return; // dev-in-browser has no updater backend
  try {
    logUpdateEvent("startup check: contacting update server");
    const update = await check();
    if (!update) {
      logUpdateEvent("startup check: already on the latest version");
      return;
    }
    logUpdateEvent(`startup check: update found (v${update.version}) -- downloading and installing`);
    await update.downloadAndInstall();
    logUpdateEvent(`startup check: installed v${update.version} -- relaunching`);
    await relaunch();
  } catch (err) {
    // Never block startup on a failed/unreachable update check (no
    // internet, server down, etc.) -- the POS must still open and work
    // with whatever version is already installed.
    logUpdateEvent(`startup check FAILED (non-fatal, app continues normally): ${String(err)}`);
  }
}

export type ManualUpdateResult =
  | { kind: "up_to_date" }
  | { kind: "installed"; version: string }
  | { kind: "error"; message: string };

/**
 * The visible counterpart to `checkForUpdatesSilently` -- a real "تحقق من
 * التحديثات" button in Settings calls this and shows the actual result,
 * for exactly the situation that prompted this: someone needs to be able
 * to SEE whether the update mechanism is working at all, right now,
 * without waiting for an unobservable cold-boot check or digging through
 * a log file.
 */
export async function checkForUpdatesManually(): Promise<ManualUpdateResult> {
  if (!("__TAURI__" in window)) {
    return { kind: "error", message: "التحديثات غير متاحة في وضع المعاينة" };
  }
  try {
    logUpdateEvent("manual check: contacting update server");
    const update = await check();
    if (!update) {
      logUpdateEvent("manual check: already on the latest version");
      return { kind: "up_to_date" };
    }
    logUpdateEvent(`manual check: update found (v${update.version}) -- downloading and installing`);
    await update.downloadAndInstall();
    logUpdateEvent(`manual check: installed v${update.version} -- relaunching`);
    await relaunch();
    return { kind: "installed", version: update.version };
  } catch (err) {
    const message = String(err);
    logUpdateEvent(`manual check FAILED: ${message}`);
    return { kind: "error", message };
  }
}
