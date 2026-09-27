#!/usr/bin/env bash
# Generate the RSA keypair used to sign the Chrome extension CRX.
#
# The private key stays in .keys/extension.pem (NEVER commit it — .gitignore
# blocks *.pem). The public key is embedded in extension/public/manifest.json
# under the "key" field, which makes Chrome compute a stable extension ID
# (lclfegmpnhibpkijgmlpjaoemnjpabcp) on every machine that loads the
# extension.
#
# Run this script ONCE per project. Re-running it will change the extension
# ID and break Mode A force-install on already-deployed machines.
#
# Usage:
#   ./scripts/generate-keypair.sh
#
# Outputs:
#   .keys/extension.pem        — RSA private key (gitignored, NEVER commit)
#   .keys/extension.pub.b64    — base64-encoded DER public key
#   .keys/extension.id         — 32-char Chrome extension ID

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYS_DIR="$ROOT/.keys"

mkdir -p "$KEYS_DIR"

if [[ -f "$KEYS_DIR/extension.pem" ]]; then
  echo "ERROR: $KEYS_DIR/extension.pem already exists." >&2
  echo "Re-generating the keypair would change the extension ID and break" >&2
  echo "Mode A force-install on already-deployed machines." >&2
  echo "" >&2
  echo "Delete the existing key first if you really want to regenerate." >&2
  exit 1
fi

# Generate the 2048-bit RSA private key.
openssl genrsa -out "$KEYS_DIR/extension.pem" 2048 2>/dev/null

# Extract the public key as base64-encoded DER (the format Chrome expects
# in manifest.json's "key" field).
openssl rsa -in "$KEYS_DIR/extension.pem" -pubout -outform DER 2>/dev/null \
  | base64 -w0 > "$KEYS_DIR/extension.pub.b64"

# Compute the stable Chrome extension ID from the public key:
#   SHA-256 of the DER public key, take first 16 bytes, then for each
#   byte produce two chars by encoding the high nibble and the low
#   nibble into 'a'..'p'.
python3 << EOF
import base64, hashlib
with open("$KEYS_DIR/extension.pub.b64") as f:
    pub_b64 = f.read().strip()
pub_der = base64.b64decode(pub_b64)
sha = hashlib.sha256(pub_der).digest()[:16]
chars = []
for b in sha:
    chars.append('abcdefghijklmnop'[(b >> 4) & 0x0f])
    chars.append('abcdefghijklmnop'[b & 0x0f])
ext_id = ''.join(chars)
assert len(ext_id) == 32 and all(c in 'abcdefghijklmnop' for c in ext_id)
with open("$KEYS_DIR/extension.id", "w") as f:
    f.write(ext_id + "\n")
print(f"Extension ID: {ext_id}")
EOF

echo ""
echo "Generated:"
echo "  $KEYS_DIR/extension.pem        (private — NEVER commit)"
echo "  $KEYS_DIR/extension.pub.b64    (public — embedded in manifest.json)"
echo "  $KEYS_DIR/extension.id         (stable Chrome extension ID)"
echo ""
echo "To embed the public key in the manifest, run:"
echo "  ./scripts/embed-public-key.sh"
