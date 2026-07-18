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
