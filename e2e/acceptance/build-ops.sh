#!/usr/bin/env bash
# Builds the restaurant-ops acceptance app (.e2e-pos/app-e2e-ops.exe): a debug
# build that trusts ONLY a throwaway test licence key and has its own app
# identifier (own %APPDATA% data, own WebView2 profile) -- never the real
# install. The real public key is put back afterwards, even on failure.
#
# Then:  OPS_TEST_KEY=<root>/.e2e-pos/ops-test-key.pem node acceptance/ops.mjs
# (run from apps/zaeem-pos/e2e; needs a msedgedriver matching the installed
# WebView2 -- see e2e/README.md)
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=../..
OUT="$ROOT/.e2e-pos"
REAL="aIaw4/8jh8nPNU/nMYY+dCGUkFUckmNAyErI68Vfafw="
mkdir -p "$OUT"
if [ ! -f "$OUT/ops-test-key.pem" ]; then
  node -e "
const c=require('crypto');const fs=require('fs');
const {privateKey,publicKey}=c.generateKeyPairSync('ed25519');
fs.writeFileSync('$OUT/ops-test-key.pem',privateKey.export({type:'pkcs8',format:'pem'}));
const der=publicKey.export({type:'spki',format:'der'});
fs.writeFileSync('$OUT/ops-test-pub.b64',der.subarray(der.length-32).toString('base64'));
"
fi
PUB=$(cat "$OUT/ops-test-pub.b64")
MOD=src-tauri/src/license/mod.rs
restore() {
  sed -i "s#LICENSE_PUBLIC_KEY_B64: \&str = \"$PUB\"#LICENSE_PUBLIC_KEY_B64: \&str = \"$REAL\"#" "$MOD"
  grep -q "\"$REAL\"" "$MOD" && echo "real key restored"
}
trap restore EXIT
sed -i "s#LICENSE_PUBLIC_KEY_B64: \&str = \"$REAL\"#LICENSE_PUBLIC_KEY_B64: \&str = \"$PUB\"#" "$MOD"
echo '{"identifier":"com.wenzdes.pos.e2e.ops","productName":"wenzdes-pos-e2e-ops"}' > "$OUT/conf-ops.json"
ok=0
# Windows sometimes refuses to start rustc for a moment ("Access is denied"); a retry fixes it.
for i in 1 2 3 4; do
  pnpm tauri build --debug --no-bundle --config "$OUT/conf-ops.json" > "$OUT/build-ops.log" 2>&1 && { ok=1; break; }
  sleep 15
done
echo "build ok=$ok"
[ $ok = 1 ] && cp src-tauri/target/debug/app.exe "$OUT/app-e2e-ops.exe"
