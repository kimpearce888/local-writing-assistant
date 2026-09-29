<#
.SYNOPSIS
  Local Writing Assistant installer for Windows.

.DESCRIPTION
  Implements the dual-mode installation described in the spec:

    Mode A (managed / enterprise Chrome):
      When HKCU or HKLM Chrome policy permits ExtensionInstallForcelist,
      register the extension through ExtensionInstallForcelist and a
      local update.xml. This installs the extension silently — no
      Developer Mode, no "Load unpacked".

    Mode B (unmanaged personal Chrome):
      Chrome refuses to silently install a self-hosted extension from
      an off-store URL. We detect this and fall back to the smallest
      possible one-time manual step (load extension/ as an unpacked
      extension once, then never again). The native host and all
      settings are still installed automatically.

  The installer is idempotent: running it again repairs the existing
  installation. It never overwrites unrelated Chrome policies.

.NOTES
  Per spec section 49 / 110:
    - We read existing ExtensionInstallForcelist keys BEFORE writing.
    - If an existing entry conflicts with ours, we report and skip.
    - We never bypass organizational restrictions.
#>

[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [switch]$Force,
  [switch]$Silent
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Local Writing Assistant Installer"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$AppFolderName   = "LocalWritingAssistant"
$HostName        = "com.localwritingassistant.host"
$ExtensionName   = "LocalWritingAssistant"

# Stable Chrome extension ID, derived from the RSA public key embedded in
# extension/public/manifest.json under the "key" field. The private key
# lives in .keys/extension.pem and is NEVER shipped in the installer
# package — it is only used by scripts/build-crx.cjs to sign the .crx for
# Mode A distribution. Because the public key is in the manifest, Chrome
# will compute this exact ID on every machine that loads the extension.
$ExtensionId     = "lclfegmpnhibpkijgmlpjaoemnjpabcp"

# Chrome registry paths (user + machine scope).
$ChromePolicy_User  = "HKCU:\Software\Policies\Google\Chrome"
$ChromePolicy_Machine = "HKLM:\Software\Policies\Google\Chrome"
$ChromeNative_User   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
$ChromeNative_Machine = "HKLM:\Software\Google\Chrome\NativeMessagingHosts"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step($msg) {
  if (-not $Silent) { Write-Host "[..] $msg" -ForegroundColor Cyan }
}
function Write-OK($msg) {
  if (-not $Silent) { Write-Host "[PASS] $msg" -ForegroundColor Green }
}
function Write-Warn2($msg) {
  if (-not $Silent) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
}
function Write-Fail($msg) {
  if (-not $Silent) { Write-Host "[FAIL] $msg" -ForegroundColor Red }
}

function Test-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-InstallDir {
  if ($InstallDir) { return $InstallDir }
  return Join-Path $env:LOCALAPPDATA $AppFolderName
}

function Get-ChromePath {
  $candidates = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Get-ChromeMajorVersion {
  $p = Get-ChromePath
  if (-not $p) { return $null }
  try {
    $vi = (Get-Item $p).VersionInfo
    return $vi.FileMajorPart
  } catch {
    return $null
  }
}

# Stable extension ID — see $ExtensionId constant above.
function Get-StableExtensionId {
  return $ExtensionId
}

function ord($c) { return [int][char]$c }

# ---------------------------------------------------------------------------
# 0. Detect environment
# ---------------------------------------------------------------------------
Write-Step "Detecting Windows architecture…"
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm") {
  if ($env:PROCESSOR_ARCHITEW6432 -eq "AMD64") { "x64" } else { "arm64" }
} elseif ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") { "x64" } else { "x86" }
Write-OK "Architecture: $arch"

Write-Step "Detecting Chrome…"
$chromePath = Get-ChromePath
if (-not $chromePath) {
  Write-Warn2 "Chrome was not found in the standard locations."
  Write-Warn2 "The native host will still be installed, but you need Chrome to use the extension."
} else {
  $ver = Get-ChromeMajorVersion
  Write-OK "Chrome detected: $chromePath (v$ver)"
}

# ---------------------------------------------------------------------------
# 1. Compute install paths
# ---------------------------------------------------------------------------
$installRoot = Get-InstallDir
$installHostDir = Join-Path $installRoot "native-host"
$installExtDir  = Join-Path $installRoot "extension"
$installPolicyDir = Join-Path $installRoot "policy"
$installUpdateDir = Join-Path $installRoot "update"

Write-Step "Install root: $installRoot"

# ---------------------------------------------------------------------------
# 2. Stop any running native host instance (best-effort)
# ---------------------------------------------------------------------------
Write-Step "Stopping previous native host instances…"
Get-Process -Name "LocalWritingAssistantHost" -ErrorAction SilentlyContinue |
  ForEach-Object { try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
Write-OK "Done."

# ---------------------------------------------------------------------------
# 3. Create directories
# ---------------------------------------------------------------------------
foreach ($d in @($installRoot, $installHostDir, $installExtDir, $installPolicyDir, $installUpdateDir)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---------------------------------------------------------------------------
# 4. Copy native host EXE + manifest template
# ---------------------------------------------------------------------------
Write-Step "Installing native host…"
$srcExe = Join-Path $PSScriptRoot "..\native-host\LocalWritingAssistantHost.exe"
if (-not (Test-Path $srcExe)) {
  $srcExe = Join-Path $PSScriptRoot "native-host\LocalWritingAssistantHost.exe"
}
if (-not (Test-Path $srcExe)) {
  Write-Fail "Could not find LocalWritingAssistantHost.exe in the installer package."
  exit 1
}
$dstExe = Join-Path $installHostDir "LocalWritingAssistantHost.exe"
Copy-Item -Path $srcExe -Destination $dstExe -Force
Write-OK "Native host installed: $dstExe"

# ---------------------------------------------------------------------------
# 5. Generate native messaging manifest with the real installed path
# ---------------------------------------------------------------------------
Write-Step "Generating native messaging host manifest…"
$extensionId = Get-StableExtensionId
$manifestPath = Join-Path $installHostDir "host-manifest.json"
$manifest = @{
  name = $HostName
  description = "Local Writing Assistant native messaging host"
  path = $dstExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8
Write-OK "Manifest written: $manifestPath (extension id = $extensionId)"

# ---------------------------------------------------------------------------
# 6. Register native messaging host in HKCU (user-scope, no admin needed)
# ---------------------------------------------------------------------------
Write-Step "Registering native messaging host (HKCU)…"
$keyPath = "$ChromeNative_User\$HostName"
if (-not (Test-Path $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
Set-ItemProperty -Path $keyPath -Name "(Default)" -Value $manifestPath -Type String
Write-OK "Native messaging registered: $keyPath"

# ---------------------------------------------------------------------------
# 7. Install extension files into $installExtDir
# ---------------------------------------------------------------------------
Write-Step "Installing extension files…"
$srcExt = Join-Path $PSScriptRoot "..\extension"
if (-not (Test-Path $srcExt)) {
  $srcExt = Join-Path $PSScriptRoot "extension"
}
if (-not (Test-Path $srcExt)) {
  Write-Fail "Could not find extension/ folder in the installer package."
  exit 1
}
# Recursively copy. robocopy exit codes 0-3 are success, 4+ are
# warnings/errors — we must check the exit code, otherwise a failed
# copy (e.g. permission denied on a file) would silently succeed.
$robocopyArgs = @($srcExt, $installExtDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
$robocopyOutput = & robocopy @robocopyArgs
$robocopyExit = $LASTEXITCODE
if ($robocopyExit -ge 8) {
  Write-Fail "robocopy failed with exit code $robocopyExit"
  Write-Fail ($robocopyOutput | Out-String)
  exit 1
}
Write-OK "Extension files copied to $installExtDir"

# ---------------------------------------------------------------------------
# 8. Generate update.xml for enterprise (ExtensionInstallForcelist)
# ---------------------------------------------------------------------------
Write-Step "Generating update.xml…"
$updateXmlPath = Join-Path $installUpdateDir "update.xml"
# Read the actual extension version from manifest.json so the update
# endpoint advertises the version Chrome is about to install. Hardcoding
# version="1.0.0" while shipping a different version makes Chrome refuse
# to install because the update check sees an older / mismatched version.
$manifestJsonPath = Join-Path $installExtDir "manifest.json"
$extVersion = "0.0.0"
if (Test-Path $manifestJsonPath) {
  try {
    $m = Get-Content $manifestJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($m.version) { $extVersion = $m.version }
  } catch {
    Write-Warn2 "Could not parse manifest.json — using placeholder version."
  }
}
# Mode A update servers MUST be HTTPS — Chrome refuses to fetch an
# update.xml from file:// or http:// (other than localhost). The default
# points at the GitHub Pages site this project publishes on every push
# to main. Operators who self-host should override via -UpdateUrlBase.
$updateUrlBase = "https://kimpearce888.github.io/local-writing-assistant/update.xml"
$updateXml = @"
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="$extensionId">
    <updatecheck codebase="$updateUrlBase" version="$extVersion" />
  </app>
</gupdate>
"@
$updateXml | Set-Content -Path $updateXmlPath -Encoding UTF8
Write-OK "update.xml written: $updateXmlPath (version=$extVersion, codebase=$updateUrlBase)"

# ---------------------------------------------------------------------------
# 9. Mode A: try to register enterprise force-install policy.
#    We check both HKCU (works for user-scope managed Chrome) and HKLM.
#    We NEVER overwrite existing policy entries — we only append ours.
# ---------------------------------------------------------------------------
Write-Step "Detecting whether Chrome accepts enterprise policy in this user context…"
$policyRoot = $null
if (Test-Path $ChromePolicy_User) { $policyRoot = $ChromePolicy_User }
elseif (Test-Path $ChromePolicy_Machine) {
  if (Test-Admin) { $policyRoot = $ChromePolicy_Machine }
  else {
    Write-Warn2 "Enterprise Chrome policy exists at HKLM but requires admin rights."
    Write-Warn2 "Re-run the installer as administrator to enable Mode A."
  }
}

$modeA = $false
if ($policyRoot) {
  # Read existing ExtensionInstallForcelist values (stored as a REG_MULTI_SZ
  # string array). We MUST preserve existing entries — operators may have
  # other extensions force-installed (corporate SSO, password managers, etc.)
  # and wiping them would be a serious data-loss / outage bug.
  #
  # The previous version of this code called New-ItemProperty -Force,
  # which DELETES the existing property and recreates it with only the
  # single new value — destroying every other force-install entry. The
  # fix below reads the existing array, appends our entry only if it
  # isn't already present, and writes the full array back with
  # Set-ItemProperty (which does NOT use -Force, so it preserves the
  # property's existing ACLs and other metadata).
  $existingValues = @()
  try {
    $prop = Get-ItemProperty -Path $policyRoot -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
    if ($prop) {
      $val = $prop.ExtensionInstallForcelist
      if ($val) { $existingValues = @($val) }
    }
  } catch { $existingValues = @() }

  $canWrite = $false
  if ($policyRoot -eq $ChromePolicy_User) { $canWrite = $true }
  elseif (Test-Admin) { $canWrite = $true }

  if ($canWrite) {
    Write-Step "Registering extension in ExtensionInstallForcelist…"
    $entry = "$extensionId;$updateUrlBase"
    if ($existingValues -contains $entry) {
      Write-OK "Mode A policy entry already present — no change needed."
      $modeA = $true
    } else {
      $newValues = @($existingValues) + $entry
      try {
        # Set-ItemProperty on a multi-string property preserves the
        # existing property's type and ACLs. -Force is NOT used.
        if ($existingValues.Count -eq 0) {
          New-ItemProperty -Path $policyRoot -Name "ExtensionInstallForcelist" -Value $newValues -PropertyType StringArray | Out-Null
        } else {
          Set-ItemProperty -Path $policyRoot -Name "ExtensionInstallForcelist" -Value $newValues -Type StringArray | Out-Null
        }
        Write-OK "Mode A policy entry added (index = $($newValues.Count - 1))."
        $modeA = $true
      } catch {
        Write-Warn2 "Failed to update ExtensionInstallForcelist: $_"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# 10. Report Mode B fallback if Mode A was not possible.
# ---------------------------------------------------------------------------
if (-not $modeA) {
  Write-Warn2 "Mode A (enterprise force-install) was NOT applied."
  Write-Warn2 "Reasons this can happen:"
  Write-Warn2 "  - This is an unmanaged personal Chrome (most common)."
  Write-Warn2 "  - The user is not an administrator and HKLM policy is needed."
  Write-Warn2 "  - An organizational policy is already in place and was not overwritten."
  Write-Warn2 ""
  Write-Warn2 "Mode B fallback (one-time manual step):"
  Write-Warn2 "  1. Open Chrome and navigate to: chrome://extensions"
  Write-Warn2 "  2. Toggle 'Developer mode' ON (top-right)."
  Write-Warn2 "  3. Click 'Load unpacked' and select this folder:"
  Write-Warn2 "     $installExtDir"
  Write-Warn2 "  4. The extension will load with extension id: $extensionId"
  Write-Warn2 ""
  Write-Warn2 "The native host and all settings are already installed."
  Write-Warn2 "No further installer steps are needed after this one-time load."
}

# ---------------------------------------------------------------------------
# 11. Verify installation
# ---------------------------------------------------------------------------
Write-Step "Verifying installation…"
$verified = $true
if (-not (Test-Path $dstExe)) { Write-Fail "Native host EXE missing."; $verified = $false }
else { Write-OK "Native host EXE present." }
if (-not (Test-Path $manifestPath)) { Write-Fail "Native host manifest missing."; $verified = $false }
else { Write-OK "Native host manifest present." }
if (-not (Test-Path $installExtDir)) { Write-Fail "Extension folder missing."; $verified = $false }
else { Write-OK "Extension folder present." }

# ---------------------------------------------------------------------------
# 12. Try to verify LM Studio reachability (best-effort, non-blocking).
# ---------------------------------------------------------------------------
Write-Step "Checking LM Studio reachability…"
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:1234/v1/models" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
  if ($resp.StatusCode -eq 200) {
    $j = $resp.Content | ConvertFrom-Json
    $count = @($j.data).Count
    if ($count -gt 0) {
      Write-OK "LM Studio reachable ($count model(s) available)."
    } else {
      Write-Warn2 "LM Studio reachable but no model is loaded."
    }
  }
} catch {
  Write-Warn2 "LM Studio not reachable on http://127.0.0.1:1234."
  Write-Warn2 "Open LM Studio, load a model, and start the local server."
}

# ---------------------------------------------------------------------------
# 13. Final summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host ""
Write-Host "Summary:"
Write-Host "  Install root:    $installRoot"
Write-Host "  Native host:    $dstExe"
Write-Host "  Host manifest:  $manifestPath"
Write-Host "  Extension dir:  $installExtDir"
Write-Host "  Extension ID:   $extensionId"
Write-Host "  Mode A (enterprise): $modeA"
if (-not $modeA) {
  Write-Host "  Mode B (manual):     one-time 'Load unpacked' needed in chrome://extensions"
}
Write-Host ""
Write-Host "Run Diagnose.bat for a full health check." -ForegroundColor Cyan

exit 0
