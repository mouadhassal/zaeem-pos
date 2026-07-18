//! Offline signed license. See AGENTS.md's "things that are currently
//! wrong" list -- `lib/license.ts` returning `active` unconditionally was
//! the stub this module replaces. Trust decisions happen here, in Rust,
//! never in the frontend (R1).
//!
//! The payload shape, signing, and verification logic live in the shared
//! `license-core` crate (`packages/license-core`), not here -- so this app
//! (verifier) and `services/license-signer` (signer) can never disagree on
//! serialization. This module keeps only what's app-specific: reading
//! THIS machine's real hardware (`fingerprint`) and the on-disk cache/store
//! (`store`).

pub mod cloud;
pub mod fingerprint;
pub mod store;

pub use license_core::b64;
pub use license_core::signed;

use ed25519_dalek::VerifyingKey;

/// Public key compiled into every release binary. The matching private key
/// lives only on the signing service (`services/license-signer`), never in
/// this repo. Generated via that service's own keygen step -- see its
/// README for how to mint a new keypair if this one is ever rotated.
///
/// This is a DEV/PLACEHOLDER keypair generated during earlier offline-only
/// work so the pipeline (mint -> verify -> test) was real and runnable end
/// to end. It is BURNED -- treated as public knowledge, never used to sign
/// a real license. The production keypair (generated on the signing
/// service, private half never leaving it) replaces this constant as its
/// own explicit, gated step, not bundled into this refactor.
pub const LICENSE_PUBLIC_KEY_B64: &str = "r9skr7ezD4+AGO0Fl9krD1ijHIFz422RDLkGOQQhDlk=";

pub fn compiled_public_key() -> VerifyingKey {
    let bytes = b64::decode(LICENSE_PUBLIC_KEY_B64).expect("LICENSE_PUBLIC_KEY_B64 must be valid base64");
    let array: [u8; 32] = bytes.as_slice().try_into().expect("LICENSE_PUBLIC_KEY_B64 must decode to 32 bytes");
    VerifyingKey::from_bytes(&array).expect("LICENSE_PUBLIC_KEY_B64 must be a valid Ed25519 public key")
}
