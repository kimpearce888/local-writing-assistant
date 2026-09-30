#!/usr/bin/env bash
#
# Local Writing Assistant — Linux installer.
#
# Equivalent of install.ps1 for Linux. Installs:
#   - Native host binary → ~/.local/share/LocalWritingAssistant/native-host/
#   - Native messaging manifest → ~/.config/<browser>/NativeMessagingHosts/
#   - Extension files → ~/.local/share/LocalWritingAssistant/extension/
#   - LM Studio bootstrap (via setup-lm-studio.sh)
#
# Then prints clear instructions for the one-time "Load unpacked"
# step in chrome://extensions (Mode B). Mode A (enterprise force-
# install) does not exist on Linux — Linux Chrome doesn't have
# group policy support like Windows.
#
# Supports: Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi.
# Detects automatically.
#
# Usage:
#   ./install.sh              # interactive
#   ./install.sh --skip-lm-studio   # skip LM Studio bootstrap
#
# No root required — everything is per-user (~/.local/share, ~/.config).

set -uo pipefail   # NOT -e: we want to continue past non-fatal failures

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
APP_NAME="LocalWritingAssistant"
HOST_NAME="com.localwritingassistant.host"
EXTENSION_ID="lclfegmpnhibpkijgmlpjaoemnjpabcp"
INSTALL_DIR="${LOCALWRITINGASSISTANT_HOME:-$HOME/.local/share/$APP_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Color codes — only emit if stdout is a TTY
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

step() { echo -e "${CYAN}[..]${NC} $1"; }
ok()   { echo -e "${GREEN}[PASS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }

SKIP_LM_STUDIO=false
for arg in "$@"; do
  case "$arg" in
    --skip-lm-studio) SKIP_LM_STUDIO=true ;;
    -h|--help)
      cat <<EOF
Usage: $0 [options]

Options:
  --skip-lm-studio   Skip the LM Studio bootstrap (advanced users)
  -h, --help         Show this help

No root required. Everything installs to \$HOME/.local/share and \$HOME/.config.
EOF
      exit 0
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Detect browser
# ---------------------------------------------------------------------------
detect_browser() {
  # Try each browser's config dir in order. Returns "name|config_path".
  # The CLI binary may differ from the config dir name (e.g. brave-browser
  # binary but ~/.config/brave config).
  local entries=(
    "Google Chrome|google-chrome|google-chrome"
    "Chromium|chromium|chromium"
    "Brave|brave-browser|brave"
    "Microsoft Edge|microsoft-edge|microsoft-edge"
    "Vivaldi|vivaldi|vivaldi"
  )
  for entry in "${entries[@]}"; do
    local name="${entry%%|*}"
    local rest="${entry#*|}"
    local cmd="${rest%%|*}"
    local cfg="${rest##*|}"
    if command -v "$cmd" &>/dev/null; then
      echo "$name|$HOME/.config/$cfg"
      return 0
    fi
  done
  # Also check if config dir exists even when binary isn't on PATH
  for entry in "${entries[@]}"; do
    local name="${entry%%|*}"
    local rest="${entry#*|}"
    local cfg="${rest##*|}"
    if [ -d "$HOME/.config/$cfg" ]; then
      echo "$name|$HOME/.config/$cfg"
      return 0
    fi
  done
  return 1
}

echo ""
echo -e "${BOLD}=== Local Writing Assistant — Linux installer ===${NC}"
echo ""

# ---------------------------------------------------------------------------
# 1. Create install directories
# ---------------------------------------------------------------------------
step "Creating install directories..."
mkdir -p "$INSTALL_DIR/native-host"
mkdir -p "$INSTALL_DIR/extension"
mkdir -p "$INSTALL_DIR/update"
ok "Install root: $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 2. Copy native host binary
# ---------------------------------------------------------------------------
step "Locating native host binary..."
HOST_SRC="$SCRIPT_DIR/native-host/LocalWritingAssistantHost"
if [ ! -f "$HOST_SRC" ]; then
  # Try alternative locations (dev layout vs. release ZIP layout).
  HOST_SRC="$SCRIPT_DIR/../native-host/LocalWritingAssistantHost"
fi
if [ ! -f "$HOST_SRC" ]; then
  HOST_SRC="$SCRIPT_DIR/../native-host/build/LocalWritingAssistantHost"
fi
if [ ! -f "$HOST_SRC" ]; then
  fail "Could not find LocalWritingAssistantHost binary."
  fail "Looked in:"
  fail "  $SCRIPT_DIR/native-host/LocalWritingAssistantHost"
  fail "  $SCRIPT_DIR/../native-host/LocalWritingAssistantHost"
  fail "  $SCRIPT_DIR/../native-host/build/LocalWritingAssistantHost"
  exit 1
fi

HOST_DST="$INSTALL_DIR/native-host/LocalWritingAssistantHost"
cp "$HOST_SRC" "$HOST_DST"
chmod +x "$HOST_DST"
ok "Native host installed: $HOST_DST"

# ---------------------------------------------------------------------------
# 3. Detect browser
# ---------------------------------------------------------------------------
step "Detecting browser..."
BROWSER_INFO=$(detect_browser || true)
if [ -z "$BROWSER_INFO" ]; then
  warn "No supported browser found. Install one of: Google Chrome, Chromium, Brave, Microsoft Edge, Vivaldi."
  warn "The native messaging manifest will be written for all known browsers, but only the one you actually use will pick it up."
  BROWSER_NAMES=("Google Chrome" "Chromium" "Brave" "Microsoft Edge" "Vivaldi")
  BROWSER_CONFIGS=(
    "$HOME/.config/google-chrome"
    "$HOME/.config/chromium"
    "$HOME/.config/brave"
    "$HOME/.config/microsoft-edge"
    "$HOME/.config/vivaldi"
  )
else
  BROWSER_NAME="${BROWSER_INFO%%|*}"
  BROWSER_CONFIG="${BROWSER_INFO##*|}"
  ok "Detected: $BROWSER_NAME ($BROWSER_CONFIG)"
  BROWSER_NAMES=("$BROWSER_NAME")
  BROWSER_CONFIGS=("$BROWSER_CONFIG")
  # Also write to other known browsers in case the user installs one later.
  for cfg in "$HOME/.config/google-chrome" "$HOME/.config/chromium" \
             "$HOME/.config/brave" "$HOME/.config/microsoft-edge" "$HOME/.config/vivaldi"; do
    if [ "$cfg" != "$BROWSER_CONFIG" ] && [ -d "$cfg" ]; then
      BROWSER_NAMES+=("other")
      BROWSER_CONFIGS+=("$cfg")
    fi
  done
fi

# ---------------------------------------------------------------------------
# 4. Write native messaging manifest for each detected browser
# ---------------------------------------------------------------------------
for i in "${!BROWSER_CONFIGS[@]}"; do
  cfg="${BROWSER_CONFIGS[$i]}"
  nm_dir="$cfg/NativeMessagingHosts"
  mkdir -p "$nm_dir"
  manifest_path="$nm_dir/$HOST_NAME.json"
  cat > "$manifest_path" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Local Writing Assistant native messaging host",
  "path": "$HOST_DST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
  ok "Native messaging registered: $manifest_path"
done

# ---------------------------------------------------------------------------
# 5. Copy extension files
# ---------------------------------------------------------------------------
step "Installing extension files..."
EXT_SRC="$SCRIPT_DIR/extension"
if [ ! -d "$EXT_SRC" ]; then
  EXT_SRC="$SCRIPT_DIR/../extension"
fi
if [ ! -d "$EXT_SRC" ]; then
  EXT_SRC="$SCRIPT_DIR/../extension/dist"
fi
if [ ! -d "$EXT_SRC" ]; then
  fail "Could not find extension/ folder."
  fail "Looked in:"
  fail "  $SCRIPT_DIR/extension"
  fail "  $SCRIPT_DIR/../extension"
  fail "  $SCRIPT_DIR/../extension/dist"
  exit 1
fi

# If we found extension/dist (dev layout), copy its contents; otherwise
# copy extension/* (release layout already has manifest.json at top level).
if [ -f "$EXT_SRC/manifest.json" ]; then
  cp -r "$EXT_SRC"/* "$INSTALL_DIR/extension/"
else
  # EXT_SRC is extension/ but no manifest.json inside — try extension/dist
  if [ -d "$EXT_SRC/dist" ]; then
    cp -r "$EXT_SRC/dist"/* "$INSTALL_DIR/extension/"
  else
    fail "No manifest.json found in extension source."
    exit 1
  fi
fi
ok "Extension files copied to $INSTALL_DIR/extension"

# Verify the extension has a manifest.json
if [ ! -f "$INSTALL_DIR/extension/manifest.json" ]; then
  fail "Extension folder is missing manifest.json after copy."
  exit 1
fi
ok "manifest.json present (version: $(jq -r .version "$INSTALL_DIR/extension/manifest.json" 2>/dev/null || echo '?'))"

# ---------------------------------------------------------------------------
# 6. LM Studio bootstrap
# ---------------------------------------------------------------------------
if [ "$SKIP_LM_STUDIO" = "true" ]; then
  warn "Skipping LM Studio bootstrap (--skip-lm-studio)."
else
  setup_script="$SCRIPT_DIR/setup-lm-studio.sh"
  if [ -f "$setup_script" ]; then
    step "Running LM Studio bootstrap..."
    bash "$setup_script" || warn "LM Studio bootstrap failed (continuing — extension + native host are still installed)."
  else
    # Fallback: just do a reachability check
    step "Checking LM Studio reachability..."
    if curl -sf "http://127.0.0.1:1234/v1/models" &>/dev/null; then
      ok "LM Studio reachable."
    else
      warn "LM Studio not reachable on http://127.0.0.1:1234."
      warn "Open LM Studio, load a model, and start the local server."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 7. Final summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Installation complete.${NC}"
echo ""
echo "Summary:"
echo "  Install root:     $INSTALL_DIR"
echo "  Native host:      $HOST_DST"
for i in "${!BROWSER_CONFIGS[@]}"; do
  echo "  Host manifest:    ${BROWSER_CONFIGS[$i]}/NativeMessagingHosts/$HOST_NAME.json"
done
echo "  Extension dir:    $INSTALL_DIR/extension"
echo "  Extension ID:     $EXTENSION_ID"
echo ""
echo -e "${BOLD}Final step — load the extension in your browser:${NC}"
echo "  1. Open chrome://extensions (or brave://extensions, etc.)"
echo "  2. Toggle 'Developer mode' ON (top-right)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: $INSTALL_DIR/extension"
echo ""
echo "This step is needed exactly once. After it, the extension loads"
echo "automatically on every browser launch."
echo ""
echo "Run diagnose.sh for a full health check."
