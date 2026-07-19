//! OS-specific half of machine fingerprinting: actually reading THIS
//! machine's hardware. The `MachineFingerprint` struct itself, its
//! hashing, and its 2-of-3 fuzzy-match logic live in `license-core`
//! (shared with the signing service, which builds fingerprints `from_raw`
//! values typed in by whoever is activating a restaurant, never its own
//! hardware).
//!
//! Component gathering is Windows-only today (this fleet is Windows POS
//! terminals). On any other OS `collect_raw()` returns all-`None`, which
//! `current()` turns into a fingerprint that cannot match a real license
//! (by design -- fail closed, not silently "always active").

pub use license_core::fingerprint::MachineFingerprint;

use std::process::Command;

fn run_powershell(script: &str) -> Option<String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(target_os = "windows")]
fn collect_raw() -> (Option<String>, Option<String>, Option<String>) {
    let cpu = run_powershell("(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty ProcessorId)");
    let disk = run_powershell("(Get-CimInstance Win32_DiskDrive | Select-Object -First 1 -ExpandProperty SerialNumber)");
    let mac = run_powershell(
        "(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Sort-Object ifIndex | Select-Object -First 1 -ExpandProperty MacAddress)"
    );
    (cpu, disk, mac)
}

#[cfg(not(target_os = "windows"))]
fn collect_raw() -> (Option<String>, Option<String>, Option<String>) {
    (None, None, None)
}

/// Reads this machine's current hardware identity.
pub fn current() -> MachineFingerprint {
    let (cpu, disk, mac) = collect_raw();
    MachineFingerprint::from_raw(cpu.as_deref(), disk.as_deref(), mac.as_deref())
}

/// The real-world minting flow: a customer reads this off their own
/// Settings -> License screen and sends it (WhatsApp, etc.) to whoever
/// mints their license; apps/admin's mint form decodes it back into the
/// raw cpu/disk/mac values `/sign` needs, so the signed license's
/// `machine_fingerprint` hashes end up identical to what THIS same
/// function will compute again at verification time. Deliberately the RAW
/// values, not their hashes -- license-signer only ever accepts raw
/// cpu/disk/mac and hashes them itself (the one, shared hashing logic in
/// `license_core::fingerprint`), so this has to hand over the same raw
/// inputs, not a hash of them.
pub fn device_id() -> String {
    let (cpu, disk, mac) = collect_raw();
    let json = serde_json::json!({ "cpu": cpu, "disk": disk, "mac": mac });
    license_core::b64::encode(serde_json::to_string(&json).expect("device id json always serializes").as_bytes())
}
