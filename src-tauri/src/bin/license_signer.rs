//! Offline license signing CLI. Run locally by the person selling/renewing
//! licenses -- never shipped, never runs on a restaurant's machine. Holds
//! the private key; the app binary only ever holds the public key.
//!
//! Usage:
//!   license_signer genkey <out_dir>
//!       Writes signing_key.b64 (PRIVATE -- keep offline, never commit) and
//!       verifying_key.b64 (PUBLIC -- paste into license/signed.rs as
//!       LICENSE_PUBLIC_KEY_B64 in src-tauri/src/license/mod.rs) into <out_dir>.
//!
//!   license_signer mint <signing_key.b64> <out_file.lic> \
//!       --tenant <id> --branch <id> --market <SY|SA|...> --plan <name> \
//!       --features <comma,separated> --days <n> \
//!       --cpu <raw> --disk <raw> --mac <raw>
//!       Mints a signed license blob valid for <n> days from now, for the
//!       machine identified by the given raw component values (read these
//!       off the target machine -- e.g. via the same PowerShell one-liners
//!       `fingerprint.rs` uses -- and never re-type an already-hashed
//!       value here; this tool does the hashing).

use app_lib::license::b64;
use app_lib::license::fingerprint::MachineFingerprint;
use app_lib::license::signed::LicensePayload;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use std::collections::HashMap;
use std::env;
use std::fs;

fn parse_flags(args: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            if let Some(value) = args.get(i + 1) {
                map.insert(key.to_string(), value.clone());
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    map
}

fn genkey(out_dir: &str) {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key: VerifyingKey = signing_key.verifying_key();

    fs::create_dir_all(out_dir).expect("create out dir");
    let sk_path = format!("{out_dir}/signing_key.b64");
    let vk_path = format!("{out_dir}/verifying_key.b64");
    fs::write(&sk_path, b64::encode(signing_key.to_bytes().as_slice())).expect("write signing key");
    fs::write(&vk_path, b64::encode(verifying_key.to_bytes().as_slice())).expect("write verifying key");

    println!("Wrote PRIVATE key to {sk_path} -- keep this offline, NEVER commit it.");
    println!("Wrote PUBLIC key to {vk_path} -- paste its contents into");
    println!("  src-tauri/src/license/mod.rs as LICENSE_PUBLIC_KEY_B64.");
}

fn load_signing_key(path: &str) -> SigningKey {
    let b64_str = fs::read_to_string(path).expect("read signing key file").trim().to_string();
    let bytes = b64::decode(&b64_str).expect("signing key is not valid base64");
    let array: [u8; 32] = bytes.as_slice().try_into().expect("signing key must be 32 bytes");
    SigningKey::from_bytes(&array)
}

fn mint(signing_key_path: &str, out_path: &str, flags: &HashMap<String, String>) {
    let signing_key = load_signing_key(signing_key_path);

    let tenant_id = flags.get("tenant").cloned().unwrap_or_else(|| panic!("--tenant required"));
    let branch_id = flags.get("branch").cloned().unwrap_or_else(|| panic!("--branch required"));
    let market = flags.get("market").cloned().unwrap_or_else(|| "SY".into());
    let plan = flags.get("plan").cloned().unwrap_or_else(|| "standard".into());
    let features: Vec<String> = flags
        .get("features")
        .map(|s| s.split(',').map(|f| f.trim().to_string()).collect())
        .unwrap_or_else(|| vec!["pos".into()]);
    let days: i64 = flags.get("days").and_then(|s| s.parse().ok()).unwrap_or(365);

    let cpu = flags.get("cpu").map(String::as_str);
    let disk = flags.get("disk").map(String::as_str);
    let mac = flags.get("mac").map(String::as_str);
    let machine_fingerprint = MachineFingerprint::from_raw(cpu, disk, mac);

    let now = chrono::Utc::now().timestamp_millis();
    let payload = LicensePayload {
        tenant_id,
        branch_id,
        machine_fingerprint,
        market,
        plan,
        features,
        issued_at: now,
        expires_at: now + days * 86_400_000,
        nonce: uuid::Uuid::new_v4().to_string(),
    };

    let payload_json = serde_json::to_string(&payload).expect("serialize payload");
    let signature = signing_key.sign(payload_json.as_bytes());
    let file = app_lib::license::signed::SignedLicenseFile {
        payload_json,
        signature_b64: b64::encode(&signature.to_bytes()),
    };

    fs::write(out_path, serde_json::to_vec_pretty(&file).unwrap()).expect("write license file");
    println!("Minted license -> {out_path}");
    println!("  tenant={} branch={} plan={} expires_in={days}d", payload.tenant_id, payload.branch_id, payload.plan);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("genkey") => {
            let out_dir = args.get(2).map(String::as_str).unwrap_or("./license_keys");
            genkey(out_dir);
        }
        Some("mint") => {
            let signing_key_path = args.get(2).unwrap_or_else(|| panic!("usage: mint <signing_key.b64> <out.lic> [flags]"));
            let out_path = args.get(3).unwrap_or_else(|| panic!("usage: mint <signing_key.b64> <out.lic> [flags]"));
            let flags = parse_flags(&args[4..]);
            mint(signing_key_path, out_path, &flags);
        }
        _ => {
            eprintln!("usage:");
            eprintln!("  license_signer genkey <out_dir>");
            eprintln!("  license_signer mint <signing_key.b64> <out.lic> --tenant <id> --branch <id> [--market SY] [--plan standard] [--features pos,kds] [--days 365] [--cpu <raw>] [--disk <raw>] [--mac <raw>]");
            std::process::exit(1);
        }
    }
}
