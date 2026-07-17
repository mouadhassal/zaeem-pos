//! Offline signed license. See AGENTS.md's "things that are currently
//! wrong" list -- `lib/license.ts` returning `active` unconditionally was
//! the stub this module replaces. Trust decisions happen here, in Rust,
//! never in the frontend (R1).

pub mod b64;
pub mod fingerprint;
pub mod signed;
pub mod store;

use ed25519_dalek::VerifyingKey;

/// Public key compiled into every release binary. The matching private key
/// lives only on the machine running `license_signer` and is never
/// committed to this repo. Generated once via `license_signer genkey` --
/// see that binary's doc comment to mint a new keypair if this one is ever
/// rotated.
///
/// This is a DEV/PLACEHOLDER keypair generated during this task so the
/// full pipeline (mint -> verify -> test) is real and runnable end to end.
/// Before shipping to a real restaurant, generate a production keypair the
/// same way and replace this constant -- the private half of THIS dev key
/// is sitting in the scratchpad, not the repo, but it should still be
/// treated as burned/public knowledge, never used to sign a real license.
pub const LICENSE_PUBLIC_KEY_B64: &str = "r9skr7ezD4+AGO0Fl9krD1ijHIFz422RDLkGOQQhDlk=";

pub fn compiled_public_key() -> VerifyingKey {
    let bytes = b64::decode(LICENSE_PUBLIC_KEY_B64).expect("LICENSE_PUBLIC_KEY_B64 must be valid base64");
    let array: [u8; 32] = bytes.as_slice().try_into().expect("LICENSE_PUBLIC_KEY_B64 must decode to 32 bytes");
    VerifyingKey::from_bytes(&array).expect("LICENSE_PUBLIC_KEY_B64 must be a valid Ed25519 public key")
}
