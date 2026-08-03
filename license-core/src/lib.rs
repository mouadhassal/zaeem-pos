//! Shared license crypto/serialization, extracted from `apps/zaeem-pos`'s
//! `license/` module so the signing service (`services/license-signer`)
//! and the app's offline verifier share exactly one implementation of the
//! payload shape and the signed-bytes convention. If the signer and
//! verifier ever disagreed on serialization, every license check would
//! fail unpredictably -- sharing this crate makes that class of bug
//! impossible rather than "unlikely."
//!
//! What stays OUT of this crate, deliberately: reading THIS machine's real
//! hardware (Windows PowerShell calls) and the on-disk `LicenseState`
//! cache/store. Those are app-specific, not shared with the signing
//! service, which never needs to know its own "machine identity."

pub mod b64;
pub mod fingerprint;
pub mod signed;
