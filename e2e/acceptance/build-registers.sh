#!/usr/bin/env bash
# Builds the acceptance-test registers (.e2e-pos/app-e2e-<r>.exe): release
# builds that trust ONLY the throwaway test key and use their own app
# identifier (own %APPDATA% data, license, WebView2 profile) -- never the
# real install. The real key is restored afterwards, even on failure.
# usage: E2E_PUBKEY_FILE=pub.b64 build-registers.sh [a b ...]
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=../..
REAL="aIaw4/8jh8nPNU/nMYY+dCGUkFUckmNAyErI68Vfafw="
PUB=$(cat "${E2E_PUBKEY_FILE:?set E2E_PUBKEY_FILE}")
MOD=src-tauri/src/license/mod.rs
restore() { sed -i "s#LICENSE_PUBLIC_KEY_B64: \&str = \"$PUB\"#LICENSE_PUBLIC_KEY_B64: \&str = \"$REAL\"#" "$MOD"; grep -q "$REAL" "$MOD" && echo "real key restored"; }
trap restore EXIT
sed -i "s#LICENSE_PUBLIC_KEY_B64: \&str = \"$REAL\"#LICENSE_PUBLIC_KEY_B64: \&str = \"$PUB\"#" "$MOD"
mkdir -p "$ROOT/.e2e-pos"
for r in "${@:-a b}"; do
  for reg in $r; do
    echo "{\"identifier\":\"com.wenzdes.pos.e2e.$reg\",\"productName\":\"wenzdes-pos-e2e-$reg\"}" > "$ROOT/.e2e-pos/conf-$reg.json"
    ok=0
    for i in 1 2 3; do
      pnpm tauri build --no-bundle --config "$ROOT/.e2e-pos/conf-$reg.json" > "$ROOT/.e2e-pos/build-$reg.log" 2>&1 && { ok=1; break; }
      sleep 5
    done
    echo "register $reg build ok=$ok"
    [ $ok = 1 ] && cp src-tauri/target/release/app.exe "$ROOT/.e2e-pos/app-e2e-$reg.exe"
  done
done
