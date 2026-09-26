<#
.SYNOPSIS
  Local Writing Assistant diagnostics report.
.DESCRIPTION
  Prints a PASS/WARN/FAIL report covering every layer of the installation.
  This does NOT modify anything — it is read-only.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

function Pass($m) { Write-Host "[PASS] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

$AppFolderName = "LocalWritingAssistant"
$HostName = "com.localwritingassistant.host"
$ChromePolicy_User = "HKCU:\Software\Policies\Google\Chrome"
$ChromeNative_User = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"

Write-Host "===== Local Writing Assistant — Diagnostics =====" -ForegroundColor Cyan
Write-Host ""

# Windows
Write-Host "Windows:" -ForegroundColor Cyan
Write-Host "  OS:          $([System.Environment]::OSVersion.VersionString)"
Write-Host "  Arch:        $env:PROCESSOR_ARCHITECTURE"
Write-Host ""

# Chrome
Write-Host "Chrome:" -ForegroundColor Cyan
$chromePath = $null
foreach ($p in @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)) {
  if (Test-Path $p) { $chromePath = $p; break }
}
if ($chromePath) { Pass "Chrome detected: $chromePath" }
else { Fail "Chrome not detected in standard locations." }
Write-Host ""

# Native host files
Write-Host "Native host:" -ForegroundColor Cyan
$installRoot = Join-Path $env:LOCALAPPDATA $AppFolderName
$exe = Join-Path $installRoot "native-host\LocalWritingAssistantHost.exe"
$manifest = Join-Path $installRoot "native-host\host-manifest.json"
if (Test-Path $exe) { Pass "Native host EXE: $exe" } else { Fail "Native host EXE missing: $exe" }
if (Test-Path $manifest) { Pass "Native host manifest: $manifest" } else { Fail "Native host manifest missing: $manifest" }
Write-Host ""

# Native messaging registry
Write-Host "Native messaging registry:" -ForegroundColor Cyan
$regPath = "$ChromeNative_User\$HostName"
if (Test-Path $regPath) {
  $val = (Get-ItemProperty -Path $regPath -Name "(Default)" -ErrorAction SilentlyContinue)."(Default)"
  if ($val -and (Test-Path $val)) { Pass "Registry points to existing manifest: $val" }
  elseif ($val) { Warn "Registry points to manifest, but file not found: $val" }
  else { Warn "Registry entry missing default value." }
} else {
  Fail "Native messaging registry entry missing: $regPath"
}
Write-Host ""

# Chrome policy
Write-Host "Chrome policy:" -ForegroundColor Cyan
if (Test-Path $ChromePolicy_User) {
  $existing = Get-ItemProperty -Path $ChromePolicy_User -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
  if ($existing) {
    $count = ($existing.PSObject.Properties | Where-Object { $_.Name -match "^\d+$" }).Count
    Pass "ExtensionInstallForcelist exists with $count entry(ies)."
  } else {
    Warn "ExtensionInstallForcelist not present (Mode B manual install)."
  }
} else {
  Warn "No Chrome policy in HKCU. Mode A (enterprise install) not configured."
}
Write-Host ""

# Extension folder
Write-Host "Extension package:" -ForegroundColor Cyan
$extDir = Join-Path $installRoot "extension"
if (Test-Path (Join-Path $extDir "manifest.json")) {
  Pass "Extension folder present and contains manifest.json."
} else {
  Fail "Extension folder missing or incomplete: $extDir"
}
Write-Host ""

# LM Studio
Write-Host "LM Studio:" -ForegroundColor Cyan
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:1234/v1/models" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  if ($resp.StatusCode -eq 200) {
    $j = $resp.Content | ConvertFrom-Json
    $models = @($j.data)
    Pass "LM Studio reachable at http://127.0.0.1:1234"
    if ($models.Count -gt 0) {
      Pass "$($models.Count) model(s) available."
      Write-Host "  Available models:" -ForegroundColor Cyan
      foreach ($m in $models) { Write-Host "    - $($m.id)" }
    } else {
      Fail "No model loaded in LM Studio."
    }
  }
} catch {
  Fail "LM Studio not reachable on http://127.0.0.1:1234/v1/models."
  Write-Host "  ($_)" -ForegroundColor DarkGray
}
Write-Host ""

Write-Host "===== End of diagnostics =====" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:"
Write-Host "  - If any FAIL appears above, run Install.bat to repair."
Write-Host "  - If LM Studio is offline, open it, load a model, and start the local server."
Write-Host "  - If the extension was not force-installed (Mode A), load it once via chrome://extensions (Mode B)."
Write-Host ""
exit 0
