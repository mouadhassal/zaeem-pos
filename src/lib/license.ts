import { invoke } from "@tauri-apps/api/core";

// Mirrors license/signed.rs's `LicenseStatus` (#[serde(tag = "kind")]) --
// the trust decision is made in Rust against the compiled-in Ed25519
// public key; this file only reads the result. Replaces the old stub that
// unconditionally returned "active" (see AGENTS.md's "things that must not
// be re-introduced" list).
export type LicenseStatus =
  | { kind: "Active"; days_remaining: number }
  | { kind: "Grace"; days_left_in_grace: number }
  | { kind: "LockedBackOffice"; days_since_grace_ended: number }
  | { kind: "Invalid"; reason: string };

export function backOfficeLocked(status: LicenseStatus): boolean {
  return status.kind === "LockedBackOffice" || status.kind === "Invalid";
}

/** Fast cached read -- no disk I/O or crypto, safe to call often. */
export async function getCachedLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("get_cached_license_status_v3");
}

/** Forces a fresh verification. Called at boot and every 6h. */
export async function checkLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("check_license_v3");
}

/**
 * Installs a renewal blob (the .lic file text the collector hands over on
 * cash payment -- pasted, scanned, or dropped in). Fully offline: this is
 * still just a local Tauri command, no network call anywhere in the path.
 */
export async function renewLicense(sessionToken: string, blobJson: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("renew_license_v3", { sessionToken, blobJson });
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Starts the periodic 6h recheck. Call once at app boot. Returns a cleanup function. */
export function startLicensePolling(): () => void {
  const interval = setInterval(() => {
    checkLicense().catch(() => {});
  }, SIX_HOURS_MS);
  return () => clearInterval(interval);
}
