use crate::audit;
use crate::repo::{NewOrder, OrderRow, Repo, FullOrderInput, SplitBillInput, TableInfo, HeldOrderResult, ReceiptConfig, LoyaltyCardLookup};
use crate::security::{self, authorize, authorize_scope, Actor, Permission, Role, Scope};
use crate::Db;
use bcrypt::{hash, verify, DEFAULT_COST};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};
use super::shared::*;

// ---------------------------------------------------------------------------
// Offline signed license -- see src-tauri/src/license/ for the actual
// crypto/fingerprint/grace-period logic. These three commands are thin
// wrappers, no auth required for the read paths (the license banner must be
// visible even at the login screen, before any staff session exists).
// ---------------------------------------------------------------------------

/// Fast path: returns whatever the last `recheck` computed, no disk I/O or
/// crypto. Safe to call frequently (e.g. every app render) without concern.
#[tauri::command]
pub fn get_cached_license_status_v3(license: State<crate::license::cloud::CloudLicenseState>) -> crate::license::signed::LicenseStatus {
    license.cached_status()
}

/// The real-world minting flow: shown on Settings -> License even before
/// any license exists (no auth, same reasoning as the status reads below --
/// this screen has to work for a brand new install with no staff session
/// yet). The customer copies this and sends it to whoever mints their
/// license; apps/admin's mint form decodes it back into the raw cpu/disk/
/// mac values the signing service needs.
#[tauri::command]
pub fn get_device_id_v3() -> String {
    crate::license::fingerprint::device_id()
}

/// Forces a fresh read of the license file + re-verification. Called at
/// boot and on a 6h timer (see lib.rs's setup); also safe to call from a
/// UI "check now" action.
#[tauri::command]
pub fn check_license_v3(license: State<crate::license::cloud::CloudLicenseState>) -> crate::license::signed::LicenseStatus {
    license.recheck()
}

/// Installs a renewal blob (pasted/scanned/dropped in by the collector on
/// cash payment). `blob_json` is the raw text of the .lic file the CLI
/// produced -- fully offline, no server round trip. No permission check
/// beyond being an authenticated staff member: a forged or wrong-machine
/// blob is rejected by signature/fingerprint verification regardless of
/// who submits it, and an owner handing a cashier the renewal file to type
/// in is a completely normal flow for this product.
#[tauri::command]
pub fn renew_license_v3(state: State<Db>, license: State<crate::license::cloud::CloudLicenseState>, session_token: String, blob_json: String) -> Result<crate::license::signed::LicenseStatus, String> {
    authenticate_actor(&state, &session_token)?;
    let file: crate::license::signed::SignedLicenseFile = serde_json::from_str(&blob_json).map_err(|_| "renewal file is not valid JSON".to_string())?;
    license.accept_renewal(file).map_err(|e| e.to_string())
}

/// Settings -> License page's "activate" action: decodes the base64
/// activation-key bundle apps/admin's mint flow produces, installs its
/// offline blob through the exact same `accept_renewal` validation
/// `renew_license_v3` uses (signature, machine fingerprint, staleness), and
/// -- if that succeeds -- wires up the cloud identity (license_id +
/// device_token) so future hybrid cloud checks (Slice 1c) start working too,
/// both in this running process and on the next boot.
#[tauri::command]
pub async fn activate_license_v3(state: State<'_, Db>, license: State<'_, crate::license::cloud::CloudLicenseState>, session_token: String, activation_key: String) -> Result<crate::license::signed::LicenseStatus, String> {
    authenticate_actor(&state, &session_token)?;
    let bundle = crate::license::cloud::decode_activation_key(&activation_key)?;
    let file = crate::license::signed::SignedLicenseFile { payload_json: bundle.payload_json, signature_b64: bundle.signature_b64 };
    let status = match license.accept_renewal(file) {
        Ok(status) => status,
        // T2.0 (plan §2): "unpaid terminal #3, better UX" -- the signature
        // already verified (that's the only way to reach WrongMachine at
        // all), so `branch_id` is authentic. A best-effort cloud lookup
        // turns "wrong machine" into either "this branch has N active
        // seats already, get a new one for this device" or -- if the count
        // comes back 0, or the cloud is unreachable -- the original,
        // generic message. Never blocks or panics on a network failure.
        Err(crate::license::signed::LicenseError::WrongMachine { branch_id, .. }) => {
            match crate::license::cloud::count_active_licenses(&branch_id).await {
                Ok(count) if count > 0 => {
                    return Err(format!(
                        "لم يتم العثور على ترخيص لهذا الجهاز. هذا الفرع لديه {count} ترخيص مفعّل — تواصل مع المندوب لإضافة جهاز جديد."
                    ));
                }
                // Cloud unreachable, or the branch genuinely has zero other
                // active seats -- fall back to the original generic message
                // rather than claim a fact the cloud couldn't confirm.
                _ => return Err("license was not issued for this machine".to_string()),
            }
        }
        Err(e) => return Err(e.to_string()),
    };

    // A bare, hand-signed blob (no license_id/device_token) has no cloud
    // identity to wire up -- that's fine, it just means this device stays
    // offline-only until a proper cloud-aware key is pasted later.
    if let (Some(license_id), Some(device_token)) = (bundle.license_id, bundle.device_token) {
        license.set_config(crate::license::cloud::CloudConfig { license_id, device_token });
        // Best-effort: if the disk write fails, activation itself already
        // succeeded (the offline blob is installed and cached_status
        // reflects it) -- this only affects whether the NEXT boot also has
        // cloud credentials, not the result the user sees right now.
        let _ = license.persist_cloud_config();
    }

    Ok(status)
}

// ---------------------------------------------------------------------------
