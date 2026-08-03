//! Machine identity for the offline license: 2-of-3 fuzzy match over
//! {CPU id, primary disk serial, primary MAC address}. Fuzzy because real
//! hardware drifts (a NIC or disk swap shouldn't brick a paying restaurant),
//! but wholesale copying the app + license file to a different machine
//! changes all three at once and must fail.
//!
//! Raw hardware identifiers are never stored or transmitted -- only their
//! SHA-256 hashes go into the signed license, so the blob itself doesn't
//! leak a machine's real CPU/disk/MAC to whoever ends up reading it.
//!
//! This module holds only the STRUCT and the hashing/matching logic --
//! actually reading a real machine's hardware (Windows PowerShell calls)
//! is app-specific and lives in `apps/zaeem-pos`'s own `license::fingerprint`
//! module, which calls `MachineFingerprint::from_raw` here. The signing
//! service never needs to know its own "machine identity" at all -- it
//! only ever builds fingerprints `from_raw` values supplied in a mint
//! request (the target restaurant's hardware, read off by whoever is
//! activating it).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct MachineFingerprint {
    pub cpu_hash: String,
    pub disk_hash: String,
    pub mac_hash: String,
}

fn hash_component(raw: Option<&str>) -> String {
    // A missing component hashes to a fixed, distinct sentinel rather than
    // "" -- so two machines that both fail to report (say) a disk serial
    // don't accidentally match on that slot.
    let input = raw.unwrap_or("<unavailable>");
    let mut hasher = Sha256::new();
    hasher.update(input.trim().to_lowercase().as_bytes());
    let out = hasher.finalize();
    crate::b64::encode(&out)
}

impl MachineFingerprint {
    /// Builds a fingerprint from already-collected raw values -- the seam
    /// used by the app's real `current()` (OS-specific), the signing
    /// service/CLI (raw values typed in from the target machine), and
    /// tests, none of which need to shell out to PowerShell.
    pub fn from_raw(cpu: Option<&str>, disk: Option<&str>, mac: Option<&str>) -> Self {
        Self {
            cpu_hash: hash_component(cpu),
            disk_hash: hash_component(disk),
            mac_hash: hash_component(mac),
        }
    }

    /// 2-of-3 fuzzy match: at least two of the three hashed components must
    /// agree. One component changing (disk swap, NIC swap) still passes;
    /// a wholesale copy to different hardware changes all three and fails.
    pub fn fuzzy_matches(&self, other: &MachineFingerprint) -> bool {
        let matches = [
            self.cpu_hash == other.cpu_hash,
            self.disk_hash == other.disk_hash,
            self.mac_hash == other.mac_hash,
        ]
        .into_iter()
        .filter(|&m| m)
        .count();
        matches >= 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_components_match() {
        let a = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let b = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        assert!(a.fuzzy_matches(&b));
    }

    #[test]
    fn one_changed_component_still_matches_2_of_3() {
        let licensed = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let after_disk_swap = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-2-new"), Some("mac-1"));
        assert!(licensed.fuzzy_matches(&after_disk_swap), "a single hardware swap must not brick the license");
    }

    #[test]
    fn two_changed_components_fail() {
        let licensed = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let wrong_machine = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-OTHER"), Some("mac-OTHER"));
        assert!(!licensed.fuzzy_matches(&wrong_machine));
    }

    #[test]
    fn completely_different_machine_fails() {
        let licensed = MachineFingerprint::from_raw(Some("cpu-1"), Some("disk-1"), Some("mac-1"));
        let copied_elsewhere = MachineFingerprint::from_raw(Some("cpu-OTHER"), Some("disk-OTHER"), Some("mac-OTHER"));
        assert!(!licensed.fuzzy_matches(&copied_elsewhere));
    }

    #[test]
    fn hashing_never_stores_raw_values() {
        let fp = MachineFingerprint::from_raw(Some("SUPER-SECRET-CPU-ID"), Some("disk"), Some("mac"));
        let json = serde_json::to_string(&fp).unwrap();
        assert!(!json.contains("SUPER-SECRET-CPU-ID"), "raw hardware identifiers must never appear in the serialized fingerprint");
    }
}
