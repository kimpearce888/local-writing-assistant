#!/usr/bin/env bash
# Embed the public key from .keys/extension.pub.b64 into the manifest.json
# under the "key" field, so Chrome computes the stable extension ID.
#
# Idempotent — safe to re-run. The public key is NOT a secret; Chrome
# extensions publish their public keys in the manifest by design.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYS_DIR="$ROOT/.keys"
MANIFEST="$ROOT/extension/public/manifest.json"

if [[ ! -f "$KEYS_DIR/extension.pub.b64" ]]; then
  echo "ERROR: $KEYS_DIR/extension.pub.b64 not found." >&2
  echo "Run ./scripts/generate-keypair.sh first." >&2
  exit 1
fi

PUB_KEY="$(cat "$KEYS_DIR/extension.pub.b64")"
EXT_ID="$(cat "$KEYS_DIR/extension.id")"

python3 << EOF
import json
with open("$MANIFEST") as f:
    m = json.load(f)
m['key'] = """$PUB_KEY"""
with open("$MANIFEST", 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
print(f"Embedded public key in $MANIFEST")
print(f"Stable extension ID: $EXT_ID")
EOF
