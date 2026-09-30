#!/usr/bin/env bash
#
# LM Studio bootstrap for Linux.
#
# Equivalent of setup-lm-studio.ps1 for Linux. Ensures LM Studio is
# installed, running, and the local server is enabled on port 1234
# with at least one model loaded.
#
# LM Studio on Linux is distributed as an AppImage (a single
# executable file). It does NOT have a system-package installer —
# users download the AppImage, make it executable, and run it.
# After running once, LM Studio offers to install its CLI (`lms`)
# to ~/.lmstudio/bin/lms.
#
# What this script does:
#   1. Detects the LM Studio AppImage in common locations + PATH
#   2. If not found: opens https://lmstudio.ai/ in the browser
#      (can't auto-download — LM Studio doesn't publish a stable URL)
#   3. If found: ensures the LM Studio process is running (launches
#      if not, waits up to 30s for it to register)
#   4. Checks if the local server is reachable on port 1234
#   5. If not reachable: tries `lms server start` via CLI
#   6. Falls back to opening LM Studio's GUI with clear instructions
#
# What it CANNOT do (same as the Windows version):
#   - Download a model. License + size + user choice = human decision.

set -uo pipefail

LMS_PORT=1234
LMS_BASE_URL="http://127.0.0.1:$LMS_PORT"

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

# ---------------------------------------------------------------------------
# Detection — LM Studio AppImage locations on Linux
# ---------------------------------------------------------------------------
find_lms_gui() {
  # Common locations users put the AppImage:
  local paths=(
    "$HOME/Applications/LM_Studio"*.AppImage
    "$HOME/Applications/lm-studio"*.AppImage
    "$HOME/Downloads/LM_Studio"*.AppImage
    "$HOME/Downloads/lm-studio"*.AppImage
    "$HOME/.local/bin/LM_Studio"*.AppImage
    "$HOME/.local/bin/lm-studio"*.AppImage
    "$HOME/.local/share/lm-studio/LM_Studio"*.AppImage
    "/opt/lm-studio/LM_Studio"*.AppImage
    "/opt/LM_Studio"*.AppImage
  )
  for p in "${paths[@]}"; do
    # shellcheck disable=SC2086  # glob expansion is intentional
    for f in $p; do
      if [ -x "$f" ]; then
        echo "$f"
        return 0
      fi
    done
  done
  # Check PATH for an LM Studio command (sometimes users rename or
  # symlink the AppImage).
  for cmd in "lm-studio" "LM_Studio" "lmstudio"; do
    if command -v "$cmd" &>/dev/null; then
      echo "$(command -v "$cmd")"
      return 0
    fi
  done
  return 1
}

find_lms_cli() {
  # LM Studio installs the `lms` CLI to ~/.lmstudio/bin/lms after the
  # user runs LM Studio once and accepts the CLI install prompt.
  local paths=(
    "$HOME/.lmstudio/bin/lms"
    "$HOME/.local/bin/lms"
    "/usr/local/bin/lms"
    "/usr/bin/lms"
  )
  for p in "${paths[@]}"; do
    if [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  if command -v lms &>/dev/null; then
    echo "$(command -v lms)"
    return 0
  fi
  return 1
}

test_lms_server() {
  curl -sf "$LMS_BASE_URL/v1/models" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}=== LM Studio bootstrap ===${NC}"
echo ""

# 1. Detect LM Studio AppImage
step "Detecting LM Studio..."
GUI=$(find_lms_gui || true)
if [ -n "$GUI" ]; then
  ok "LM Studio found: $GUI"
else
  warn "LM Studio AppImage not detected."
  warn "Opening https://lmstudio.ai/ in your browser —"
  warn "download the Linux AppImage, make it executable"
  warn "(chmod +x LM_Studio-*.AppImage), and re-run install.sh."
  if command -v xdg-open &>/dev/null; then
    xdg-open "https://lmstudio.ai/" &>/dev/null &
  fi
  # We can't continue without LM Studio — but the extension + native
  # host are still installed, so just exit cleanly.
  exit 0
fi

# 2. Ensure LM Studio is running
step "Checking if LM Studio is running..."
if pgrep -f "LM_Studio\|lm-studio" &>/dev/null; then
  ok "LM Studio is running."
else
  step "Launching LM Studio..."
  # nohup + & to detach from this shell, redirect output to /dev/null
  # so the script can continue. The AppImage takes ~5s to start.
  nohup "$GUI" >/dev/null 2>&1 &
  # Wait up to 30s for the process to register
  for i in $(seq 1 30); do
    sleep 1
    if pgrep -f "LM_Studio\|lm-studio" &>/dev/null; then
      ok "LM Studio launched."
      break
    fi
  done
  if ! pgrep -f "LM_Studio\|lm-studio" &>/dev/null; then
    warn "LM Studio process not detected after 30s. It may have failed to launch."
  fi
fi

# 3. Check server + models
step "Checking LM Studio server on $LMS_BASE_URL..."
SERVER_OUTPUT=$(test_lms_server || true)
if [ -n "$SERVER_OUTPUT" ]; then
  ok "LM Studio server reachable."
  # Parse models via jq if available
  if command -v jq &>/dev/null; then
    MODELS=$(echo "$SERVER_OUTPUT" | jq -r '.data[].id' 2>/dev/null || echo "")
    if [ -n "$MODELS" ]; then
      ok "Models loaded:"
      echo "$MODELS" | while read -r m; do echo "      - $m"; done
    else
      warn "Server reachable but no model loaded."
      warn "Open LM Studio, click 'Select a model to load',"
      warn "download + load a chat-capable model (e.g. Qwen2.5 7B Instruct)."
    fi
  else
    ok "Server reachable (jq not installed — can't list models)."
  fi
else
  warn "LM Studio server is not running on port $LMS_PORT."
  # Try CLI first
  CLI=$(find_lms_cli || true)
  if [ -n "$CLI" ]; then
    step "Starting server via CLI: $CLI server start --port $LMS_PORT"
    nohup "$CLI" server start --port "$LMS_PORT" >/dev/null 2>&1 &
    sleep 3
    if test_lms_server &>/dev/null; then
      ok "Server started via CLI."
    else
      warn "CLI start didn't bring up the server. Opening LM Studio GUI..."
      nohup "$GUI" >/dev/null 2>&1 &
      warn "  In LM Studio: click the 'Local Server' tab (left sidebar)"
      warn "  → click 'Start Server' (default port $LMS_PORT)"
      warn "  → if no model is loaded, click 'Select a model to load' first"
    fi
  else
    warn "LM Studio CLI (lms) not found. Cannot auto-start server."
    nohup "$GUI" >/dev/null 2>&1 &
    warn "  In LM Studio: click the 'Local Server' tab (left sidebar)"
    warn "  → click 'Start Server' (default port $LMS_PORT)"
  fi
fi

echo ""
echo -e "${GREEN}LM Studio bootstrap complete.${NC}"
echo ""
