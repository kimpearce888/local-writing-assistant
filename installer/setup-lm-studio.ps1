<#
.SYNOPSIS
  One-click LM Studio bootstrap.
.DESCRIPTION
  Ensures LM Studio is installed, running, and the local server is
  enabled on port 1234 with at least one model loaded.

  This script is called by install.ps1 BEFORE the LM Studio
  reachability check. The existing reachability check becomes a
  verification step (rather than the only way the user finds out
  LM Studio isn't running).

  Strategy:
    1. Detect existing LM Studio installation (registry + common paths + PATH)
    2. If not installed: download + silent-install from the official site
    3. If installed: ensure the LM Studio app is running (launch if not)
    4. Check if the local server is reachable on http://127.0.0.1:1234/v1/models
    5. If not reachable: try `lms server start`, fall back to GUI instructions
    6. If reachable but no models loaded: open LM Studio GUI + show instructions
    7. Print a clear status report

  What this script CANNOT do (and why):
    - Download a model file. License acceptance + multi-GB download +
      the user's choice of model (Mistral vs Llama vs Qwen, size,
      language) makes this inherently a human decision.
    - Load a model the user hasn't downloaded yet. `lms load <name>`
      only works if the model is already in the local LM Studio cache.

  So the realistic UX is:
    - If user already has LM Studio + a model: zero extra effort
      (this script handles install + launch + server start).
    - If user is new to LM Studio: this script does install + launch
      + server start, but the user must do a one-time GUI click in
      LM Studio's model browser to download their first model. We
      open the GUI to that page and print clear instructions.

.PARAMETER Silent
  Suppress informational output (errors + warnings still print).
#>

[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = "Continue"  # Don't die on transient failures — keep going

function Write-Step($msg) { if (-not $Silent) { Write-Host "[..] $msg" -ForegroundColor Cyan } }
function Write-OK($msg)   { if (-not $Silent) { Write-Host "[PASS] $msg" -ForegroundColor Green } }
function Write-Warn2($msg){ if (-not $Silent) { Write-Host "[WARN] $msg" -ForegroundColor Yellow } }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# LM Studio's default port — must match the extension's host_permissions
# and the native host's SanitizeLMStudioURL allowedHosts.
$LMS_PORT = 1234
$LMS_BASE_URL = "http://127.0.0.1:$LMS_PORT"

# LM Studio download landing page. We try to scrape the actual installer
# URL from this page; if scraping fails (HTML structure changed, network
# issue, etc.), we fall back to opening the page in the user's browser.
$LMS_DOWNLOAD_PAGE = "https://lmstudio.ai/"

# Common LM Studio install locations on Windows (per-user + per-machine).
$LMS_INSTALL_PATHS = @(
  "${env:LOCALAPPDATA}\LM-Studio\LM Studio.exe",
  "${env:LOCALAPPDATA\Programs\LM-Studio\LM Studio.exe",
  "${env:ProgramFiles}\LM Studio\LM Studio.exe",
  "${env:ProgramFiles(x86)}\LM Studio\LM Studio.exe"
)

# LM Studio CLI binary name.
$LMS_CLI_NAME = "lms.exe"

# ---------------------------------------------------------------------------
# 1. Detect existing LM Studio installation
# ---------------------------------------------------------------------------
function Find-LMStudioExe {
  # Check common paths first.
  foreach ($p in $LMS_INSTALL_PATHS) {
    if ($p -and (Test-Path $p)) {
      return $p
    }
  }
  # Check PATH for the CLI — the GUI app is usually in the same dir.
  $cliInPath = Get-Command $LMS_CLI_NAME -ErrorAction SilentlyContinue
  if ($cliInPath) {
    $cliDir = Split-Path -Parent $cliInPath.Source
    $guiCandidates = @(
      (Join-Path $cliDir "LM Studio.exe"),
      (Join-Path $cliDir "lm-studio.exe")
    )
    foreach ($g in $guiCandidates) {
      if (Test-Path $g) { return $g }
    }
  }
  # Check registry (LM Studio is installed via Inno Setup — its
  # uninstaller is at HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\).
  try {
    $uninstallKeys = @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($key in $uninstallKeys) {
      Get-ItemProperty $key -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*LM Studio*" } |
        ForEach-Object {
          $loc = $_.InstallLocation
          if ($loc -and (Test-Path $loc)) {
            $exe = Join-Path $loc "LM Studio.exe"
            if (Test-Path $exe) { return $exe }
          }
          # Inno Setup sometimes stores the main exe in UninstallString
          # e.g. "C:\path\to\LM Studio.exe" /uninstall
          $u = $_.UninstallString
          if ($u -match '"([^"]+\.exe)"') {
            $exe = $matches[1]
            if (Test-Path $exe) { return $exe }
          }
        }
    }
  } catch { /* ignore */ }
  return $null
}

function Find-LMStudioCli {
  # The CLI is typically in the same dir as the GUI, or in PATH.
  $gui = Find-LMStudioExe
  if ($gui) {
    $dir = Split-Path -Parent $gui
    $cli = Join-Path $dir $LMS_CLI_NAME
    if (Test-Path $cli) { return $cli }
  }
  $inPath = Get-Command $LMS_CLI_NAME -ErrorAction SilentlyContinue
  if ($inPath) { return $inPath.Source }
  return $null
}

# ---------------------------------------------------------------------------
# 2. Download + silent-install LM Studio if not found
# ---------------------------------------------------------------------------
function Get-LMStudioInstallerUrl {
  # Try to scrape the download page for the Windows installer URL.
  # LM Studio's site is at https://lmstudio.ai/ — the homepage has
  # direct download links. We look for .exe URLs that mention
  # "win" / "windows" / "x64".
  Write-Step "Fetching LM Studio download page: $LMS_DOWNLOAD_PAGE"
  try {
    $resp = Invoke-WebRequest -Uri $LMS_DOWNLOAD_PAGE -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    # Look for href="...exe" links that look like Windows installers.
    $matches = [regex]::Matches(
      $resp.Content,
      'https?://[^\s"''<>]+\.exe',
      "IgnoreCase"
    )
    foreach ($m in $matches) {
      $url = $m.Value
      if ($url -match "win|x64|windows" -or $url -match "lm.?studio" -and $url -notmatch "mac|linux") {
        return $url
      }
    }
    # No filter match — return the first .exe URL we found.
    if ($matches.Count -gt 0) { return $matches[0].Value }
  } catch {
    Write-Warn2 "Could not fetch download page: $_"
  }
  return $null
}

function Install-LMStudio {
  Write-Step "LM Studio not detected. Attempting auto-install…"
  $installerUrl = Get-LMStudioInstallerUrl
  if (-not $installerUrl) {
    Write-Warn2 "Could not auto-discover the LM Studio installer URL."
    Write-Warn2 "Opening https://lmstudio.ai/ in your browser —"
    Write-Warn2 "download the Windows installer, run it, then re-run Install.bat."
    try {
      Start-Process $LMS_DOWNLOAD_PAGE
    } catch { /* ignore */ }
    return $false
  }
  Write-Step "Downloading installer: $installerUrl"
  $tmpExe = Join-Path $env:TEMP "LMStudio-Setup.exe"
  try {
    Invoke-WebRequest -Uri $installerUrl -OutFile $tmpExe -UseBasicParsing -TimeoutSec 600 -ErrorAction Stop
  } catch {
    Write-Warn2 "Download failed: $_"
    Write-Warn2 "Opening https://lmstudio.ai/ in your browser — download manually."
    try { Start-Process $LMS_DOWNLOAD_PAGE } catch { /* ignore */ }
    return $false
  }
  Write-OK "Downloaded installer ($('{0:N1}' -f ((Get-Item $tmpExe).Length / 1MB)) MiB)"

  # LM Studio's installer is Inno Setup — /VERYSILENT runs it without
  # any UI. /SP- disables the "This will install…" prompt.
  Write-Step "Running installer (silent mode)…"
  try {
    $p = Start-Process -FilePath $tmpExe -ArgumentList "/VERYSILENT","/SP-","/NORESTART" -Wait -PassThru -ErrorAction Stop
    if ($p.ExitCode -ne 0) {
      Write-Warn2 "Installer exited with code $($p.ExitCode). Trying non-silent install…"
      Start-Process -FilePath $tmpExe -Wait
    }
  } catch {
    Write-Warn2 "Silent install failed: $_"
    Write-Warn2 "Opening the installer GUI for manual install…"
    Start-Process -FilePath $tmpExe -Wait
  }

  # Re-detect.
  Start-Sleep -Seconds 2  # Give the registry a moment to settle.
  $exe = Find-LMStudioExe
  if ($exe) {
    Write-OK "LM Studio installed at: $exe"
    Remove-Item -Path $tmpExe -Force -ErrorAction SilentlyContinue
    return $true
  }
  Write-Warn2 "Could not detect LM Studio after install. Please install manually from $LMS_DOWNLOAD_PAGE"
  return $false
}

# ---------------------------------------------------------------------------
# 3. Ensure LM Studio app is running
# ---------------------------------------------------------------------------
function Ensure-LMStudioRunning {
  $proc = Get-Process -Name "LM Studio" -ErrorAction SilentlyContinue
  if ($proc) {
    Write-OK "LM Studio is running (PID $($proc.Id))."
    return $true
  }
  $exe = Find-LMStudioExe
  if (-not $exe) { return $false }
  Write-Step "Launching LM Studio…"
  try {
    Start-Process -FilePath $exe -ErrorAction Stop
    # Wait up to 30s for the process to start (LM Studio is an Electron
    # app and takes a moment to register its process).
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      $proc = Get-Process -Name "LM Studio" -ErrorAction SilentlyContinue
      if ($proc) {
        Write-OK "LM Studio launched (PID $($proc.Id))."
        return $true
      }
    }
    Write-Warn2 "LM Studio process not detected after 30s. The app may have failed to launch."
    return $false
  } catch {
    Write-Warn2 "Could not launch LM Studio: $_"
    return $false
  }
}

# ---------------------------------------------------------------------------
# 4. Check server reachability + model availability
# ---------------------------------------------------------------------------
function Test-LMStudioServer {
  # Returns: @{ Reachable=$bool; Models=@(...); Error=$string }
  try {
    $resp = Invoke-WebRequest -Uri "$LMS_BASE_URL/v1/models" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) {
      $json = $resp.Content | ConvertFrom-Json
      $models = @($json.data | ForEach-Object { $_.id })
      return @{ Reachable = $true; Models = $models; Error = $null }
    }
    return @{ Reachable = $false; Models = @(); Error = "HTTP $($resp.StatusCode)" }
  } catch {
    return @{ Reachable = $false; Models = @(); Error = $_.Exception.Message }
  }
}

function Start-LMStudioServerViaCli {
  $cli = Find-LMStudioCli
  if (-not $cli) {
    Write-Warn2 "LM Studio CLI (lms.exe) not found. Cannot auto-start server."
    return $false
  }
  Write-Step "Starting LM Studio server via CLI: $cli server start --port $LMS_PORT"
  try {
    # Run `lms server start` asynchronously — it stays running in the
    # background. We use -NoNewWindow so it doesn't pop a console.
    $p = Start-Process -FilePath $cli -ArgumentList "server","start","--port",$LMS_PORT -NoNewWindow -PassThru -ErrorAction Stop
    # Wait a moment for the server to come up.
    Start-Sleep -Seconds 3
    return $true
  } catch {
    Write-Warn2 "Could not start server via CLI: $_"
    return $false
  }
}

function Open-LMStudioServerTab {
  # Open LM Studio GUI — the user needs to click the "Local Server" tab
  # and the "Start Server" button. We can't drive the GUI programmatically
  # because LM Studio doesn't expose a deep-link URL for the server tab.
  # (Some Electron apps support chrome-extension:// or lmstudio:// URLs,
  # but LM Studio doesn't currently.)
  $exe = Find-LMStudioExe
  if ($exe) {
    try { Start-Process -FilePath $exe } catch { /* ignore */ }
  }
  Write-Warn2 "  In LM Studio: click the 'Local Server' tab (left sidebar)"
  Write-Warn2 "  → click 'Start Server' (it should already be on port $LMS_PORT)"
  Write-Warn2 "  → if no model is loaded yet, click 'Select a model to load' first"
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== LM Studio bootstrap ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: detect install
Write-Step "Detecting LM Studio installation…"
$exe = Find-LMStudioExe
if ($exe) {
  Write-OK "LM Studio installed: $exe"
} else {
  Write-Warn2 "LM Studio not detected."
  $installed = Install-LMStudio
  if (-not $installed) {
    Write-Fail "Cannot continue without LM Studio. Please install it manually and re-run Install.bat."
    return
  }
  $exe = Find-LMStudioExe
}

# Step 2: ensure running
$running = Ensure-LMStudioRunning

# Step 3: check server + models
Write-Step "Checking LM Studio server on $LMS_BASE_URL…"
$status = Test-LMStudioServer
if ($status.Reachable) {
  Write-OK "LM Studio server reachable."
  if ($status.Models.Count -gt 0) {
    Write-OK "Models loaded ($($status.Models.Count)):"
    foreach ($m in $status.Models) { Write-Host "      - $m" -ForegroundColor Gray }
  } else {
    Write-Warn2 "Server is reachable but no model is loaded."
    Write-Warn2 "Open LM Studio, click 'Select a model to load',"
    Write-Warn2 "and download + load a chat-capable model (e.g. Qwen 2.5 7B instruct)."
    Open-LMStudioServerTab
  }
} else {
  Write-Warn2 "LM Studio server is not running on port $LMS_PORT."
  # Try CLI first.
  $started = Start-LMStudioServerViaCli
  if ($started) {
    Start-Sleep -Seconds 3
    $status2 = Test-LMStudioServer
    if ($status2.Reachable) {
      Write-OK "Server started via CLI."
      if ($status2.Models.Count -gt 0) {
        Write-OK "Models loaded ($($status2.Models.Count)):"
        foreach ($m in $status2.Models) { Write-Host "      - $m" -ForegroundColor Gray }
      } else {
        Write-Warn2 "Server is up but no model is loaded."
        Write-Warn2 "Open LM Studio and load a chat-capable model."
        Open-LMStudioServerTab
      }
    } else {
      Write-Warn2 "CLI start didn't bring up the server. Opening LM Studio GUI…"
      Open-LMStudioServerTab
    }
  } else {
    Open-LMStudioServerTab
  }
}

Write-Host ""
Write-Host "LM Studio bootstrap complete." -ForegroundColor Green
Write-Host ""
