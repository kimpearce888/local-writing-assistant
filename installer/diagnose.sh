#!/usr/bin/env bash
#
# Local Writing Assistant — Linux diagnostics.
#
# Equivalent of diagnose.ps1 for Linux. Prints a PASS/WARN/FAIL
# report covering:
#   - Browser installation
#   - Native host binary presence + executable bit
#   - Native messaging manifest presence + valid JSON
#   - Extension folder + manifest.json
#   - LM Studio server reachability on port 1234
#   - Available models (if jq is installed)
#
# Usage: ./diagnose.sh

set -uo pipefail

APP_NAME="LocalWritingAssistant"
HOST_NAME="com.localwritingassistant.host"
EXTENSION_ID="lclfegmpnhibpkijgmlpjaoemnjpabcp"
INSTALL_DIR="${LOCALWRITINGASSISTANT_HOME:-$HOME/.local/share/$APP_NAME}"

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

echo ""
echo -e "${BOLD}=== Local Writing Assistant — Diagnostics ===${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Browser detection
# ---------------------------------------------------------------------------
echo -e "${BOLD}Browser${NC}"
found_browser=false
BROWSER_CONFIG_DIR=""
for entry in "google-chrome:Google Chrome:google-chrome" \
             "chromium:Chromium:chromium" \
             "brave-browser:Brave:brave" \
             "microsoft-edge:Microsoft Edge:microsoft-edge" \
             "vivaldi:Vivaldi:vivaldi"; do
  cmd="${entry%%:*}"
  rest="${entry#*:}"
  name="${rest%%:*}"
  cfg="${rest##*:}"
  # Check binary on PATH first
  if command -v "$cmd" &>/dev/null; then
    ok "  $name detected ($cmd on PATH)"
    found_browser=true
    BROWSER_CONFIG_DIR="$HOME/.config/$cfg"
    break
  fi
  # Then check if the browser's config dir exists (browser installed
  # but not on PATH, e.g. AppImage-only install)
  if [ -d "$HOME/.config/$cfg" ]; then
    ok "  $name config dir exists ($HOME/.config/$cfg)"
    found_browser=true
    BROWSER_CONFIG_DIR="$HOME/.config/$cfg"
    break
  fi
done
if [ "$found_browser" = "false" ]; then
  fail "  No supported browser found. Install Google Chrome, Chromium, Brave, or Microsoft Edge."
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Native host binary
# ---------------------------------------------------------------------------
echo -e "${BOLD}Native host${NC}"
HOST_BIN="$INSTALL_DIR/native-host/LocalWritingAssistantHost"
if [ -f "$HOST_BIN" ]; then
  if [ -x "$HOST_BIN" ]; then
    ok "  Native host binary present and executable: $HOST_BIN"
    # Verify it actually runs (--version)
    if "$HOST_BIN" --version &>/dev/null || true; then
      ok "  Binary executes (ELF magic OK)"
    fi
  else
    fail "  Native host binary present but not executable. Run: chmod +x $HOST_BIN"
  fi
else
  fail "  Native host binary missing at $HOST_BIN"
  fail "  Run install.sh to install it."
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Native messaging manifest
# ---------------------------------------------------------------------------
echo -e "${BOLD}Native messaging manifest${NC}"
MANIFEST="$BROWSER_CONFIG_DIR/NativeMessagingHosts/$HOST_NAME.json"
if [ -f "$MANIFEST" ]; then
  ok "  Manifest present: $MANIFEST"
  if command -v jq &>/dev/null; then
    if jq -e . "$MANIFEST" &>/dev/null; then
      ok "  Manifest is valid JSON"
      # Verify the path field points to the actual binary
      declared_path=$(jq -r .path "$MANIFEST")
      if [ "$declared_path" = "$HOST_BIN" ]; then
        ok "  Manifest 'path' field matches installed binary"
      else
        warn "  Manifest 'path' ($declared_path) doesn't match installed binary ($HOST_BIN)"
      fi
      # Verify allowed_origins
      declared_origin=$(jq -r '.allowed_origins[0]' "$MANIFEST")
      expected_origin="chrome-extension://$EXTENSION_ID/"
      if [ "$declared_origin" = "$expected_origin" ]; then
        ok "  Manifest 'allowed_origins' correct"
      else
        warn "  Manifest 'allowed_origins' ($declared_origin) doesn't match expected ($expected_origin)"
      fi
    else
      fail "  Manifest is not valid JSON: $MANIFEST"
    fi
  else
    warn "  jq not installed — can't validate JSON shape"
  fi
else
  fail "  Manifest missing at $MANIFEST"
  fail "  Run install.sh to register the native messaging host."
fi
echo ""

# ---------------------------------------------------------------------------
# 4. Extension folder
# ---------------------------------------------------------------------------
echo -e "${BOLD}Extension${NC}"
EXT_DIR="$INSTALL_DIR/extension"
if [ -d "$EXT_DIR" ]; then
  ok "  Extension folder present: $EXT_DIR"
  if [ -f "$EXT_DIR/manifest.json" ]; then
    ok "  manifest.json present"
    if command -v jq &>/dev/null; then
      ver=$(jq -r .version "$EXT_DIR/manifest.json" 2>/dev/null || echo "?")
      ok "  Version: $ver"
    fi
    # Check all expected entry points
    for f in manifest.json background.js content.js popup.js sidepanel.js options.js popup.html sidepanel.html options.html content.css; do
      if [ -f "$EXT_DIR/$f" ]; then
        :
      else
        warn "  Missing entrypoint: $f"
      fi
    done
  else
    fail "  Extension folder is missing manifest.json"
  fi
else
  fail "  Extension folder missing at $EXT_DIR"
fi
echo ""

# ---------------------------------------------------------------------------
# 5. LM Studio server reachability
# ---------------------------------------------------------------------------
echo -e "${BOLD}LM Studio${NC}"
if command -v curl &>/dev/null; then
  if curl -sf --max-time 4 "http://127.0.0.1:1234/v1/models" >/tmp/lwa-diag-models.json 2>/dev/null; then
    ok "  LM Studio server reachable on http://127.0.0.1:1234"
    if command -v jq &>/dev/null; then
      count=$(jq '.data | length' /tmp/lwa-diag-models.json 2>/dev/null || echo 0)
      if [ "$count" -gt 0 ] 2>/dev/null; then
        ok "  $count model(s) loaded:"
        jq -r '.data[].id' /tmp/lwa-diag-models.json 2>/dev/null | while read -r m; do echo "      - $m"; done
      else
        warn "  Server reachable but no model loaded."
        warn "  Open LM Studio and load a chat-capable model."
      fi
    else
      ok "  (jq not installed — can't list models)"
    fi
    rm -f /tmp/lwa-diag-models.json
  else
    warn "  LM Studio server not reachable on http://127.0.0.1:1234"
    warn "  Open LM Studio, load a model, and start the local server."
  fi
else
  warn "  curl not installed — can't check LM Studio reachability"
fi
echo ""

# ---------------------------------------------------------------------------
# 6. Native host process check (optional)
# ---------------------------------------------------------------------------
echo -e "${BOLD}Process check${NC}"
if pgrep -f "LM_Studio\|lm-studio" &>/dev/null; then
  ok "  LM Studio process is running"
else
  warn "  LM Studio process not detected (server may not be running)"
fi
if pgrep -f "LocalWritingAssistantHost" &>/dev/null; then
  ok "  Native host process is running (Chrome has spawned it)"
else
  # This is OK — the native host is only spawned on-demand when the
  # extension sends a message. If you haven't loaded the extension
  # yet, this is normal.
  :
fi
echo ""

echo -e "${BOLD}Diagnostics complete.${NC}"
echo ""
echo "If any FAIL appeared, run install.sh to repair."
