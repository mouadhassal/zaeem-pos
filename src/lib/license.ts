import { invoke } from "@tauri-apps/api/core";

// Mirrors license/signed.rs's `LicenseStatus` (#[serde(tag = "kind")]) --
// the trust decision is made in Rust against the compiled-in Ed25519
// public key; this file only reads the result. Replaces the old stub that
// unconditionally returned "active" (see AGENTS.md's "things that must not
// be re-introduced" list).
export type LicenseStatus =
  | { kind: "Active"; days_remaining: number; plan: string; expires_at: number }
  | { kind: "Grace"; days_left_in_grace: number; plan: string; expires_at: number }
  | { kind: "LockedBackOffice"; days_since_grace_ended: number; plan: string; expires_at: number }
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

/**
 * Settings -> License page's paste-activation action. `activationKey` is
 * the single base64 bundle apps/admin's mint flow produces (license_id +
 * device_token + payload_json + signature_b64). Installs the offline blob
 * through the same validation renewLicense() uses, and -- on success --
 * wires up the cloud identity too, so the hybrid cloud check (Slice 1c)
 * starts working for this device.
 */
export async function activateLicense(sessionToken: string, activationKey: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("activate_license_v3", { sessionToken, activationKey });
}

/**
 * The real-world minting flow: the customer reads this off Settings ->
 * License and sends it (WhatsApp, etc.) to whoever mints their license.
 * No auth required -- must work even before any staff session exists, on
 * a brand new install with no license at all.
 */
export async function getDeviceId(): Promise<string> {
  return invoke<string>("get_device_id_v3");
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Starts the periodic 6h recheck. Call once at app boot. Returns a cleanup function. */
export function startLicensePolling(): () => void {
  const interval = setInterval(() => {
    checkLicense().catch(() => {});
  }, SIX_HOURS_MS);
  return () => clearInterval(interval);
}
