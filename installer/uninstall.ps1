<#
.SYNOPSIS
  Local Writing Assistant uninstaller for Windows.
.DESCRIPTION
  Removes:
    - native messaging host registration (HKCU and HKLM if admin)
    - native host executable + manifest
    - application folder under %LOCALAPPDATA%\LocalWritingAssistant
    - this app's own ExtensionInstallForcelist entries (and ONLY ours)
  Does NOT touch:
    - the user's LM Studio installation or models
    - unrelated Chrome settings
    - unrelated Chrome policies

  We match our own ExtensionInstallForcelist entries by the EXACT
  extension ID (lclfegmpnhibpkijgmlpjaoemnjpabcp), not by a loose
  regex on "LocalWritingAssistant" — that regex would also delete
  any unrelated extension whose URL happened to contain that string,
  which is exactly the kind of cross-app registry damage we want to
  avoid. Same for the native-messaging host key: we only remove the
  host name that this app owns (com.localwritingassistant.host).
#>

[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = "Continue"

function Write-Step($msg) { if (-not $Silent) { Write-Host "[..] $msg" -ForegroundColor Cyan } }
function Write-OK($msg) { if (-not $Silent) { Write-Host "[PASS] $msg" -ForegroundColor Green } }
function Write-Warn2($msg) { if (-not $Silent) { Write-Host "[WARN] $msg" -ForegroundColor Yellow } }
function Write-Fail($msg) { if (-not $Silent) { Write-Host "[FAIL] $msg" -ForegroundColor Red } }

$AppFolderName = "LocalWritingAssistant"
$HostName = "com.localwritingassistant.host"
# Must match installer/install.ps1 — the stable Chrome extension ID
# derived from the RSA public key embedded in extension/public/manifest.json.
$ExtensionId = "lclfegmpnhibpkijgmlpjaoemnjpabcp"

$ChromePolicy_User   = "HKCU:\Software\Policies\Google\Chrome"
$ChromePolicy_Machine = "HKLM:\Software\Policies\Google\Chrome"
$ChromeNative_User   = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
$ChromeNative_Machine = "HKLM:\Software\Google\Chrome\NativeMessagingHosts"

function Test-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 1. Stop native host process.
Write-Step "Stopping native host process…"
Get-Process -Name "LocalWritingAssistantHost" -ErrorAction SilentlyContinue |
  ForEach-Object { try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
Write-OK "Done."

# 2. Remove native messaging registry entries — both HKCU (always) and
#    HKLM (only if running as admin; otherwise warn and skip).
foreach ($scope in @(
  @{ Root = $ChromeNative_User;   Label = "HKCU"; CanWrite = $true }
  @{ Root = $ChromeNative_Machine; Label = "HKLM"; CanWrite = (Test-Admin) }
)) {
  $keyPath = "$($scope.Root)\$HostName"
  if (Test-Path $keyPath) {
    if ($scope.CanWrite) {
      try {
        Remove-Item -Path $keyPath -Recurse -Force -ErrorAction Stop
        Write-OK "Removed: $keyPath"
      } catch {
        Write-Fail "Could not remove $keyPath : $_"
      }
    } else {
      Write-Warn2 "Native messaging entry exists at $($scope.Label) but requires admin rights to remove."
      Write-Warn2 "Re-run Uninstall.bat as administrator to fully clean up."
    }
  }
}

# 3. Remove our own ExtensionInstallForcelist entries (only ours).
#    We match by the exact extension ID prefix at the start of the
#    entry — `<extensionId>;<url>`. This guarantees we never delete
#    another application's entry, even if its URL contains our app name.
Write-Step "Removing our own ExtensionInstallForcelist entries…"
foreach ($scope in @(
  @{ Root = $ChromePolicy_User;   Label = "HKCU"; CanWrite = $true }
  @{ Root = $ChromePolicy_Machine; Label = "HKLM"; CanWrite = (Test-Admin) }
)) {
  if (-not (Test-Path $scope.Root)) { continue }
  try {
    $prop = Get-ItemProperty -Path $scope.Root -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
    if (-not $prop) { continue }
    $existing = @($prop.ExtensionInstallForcelist)
    if ($existing.Count -eq 0) { continue }
    $kept = @()
    $removed = 0
    foreach ($entry in $existing) {
      # An entry looks like "lclfegmpnhibpkijgmlpjaoemnjpabcp;https://..."
      # Only remove entries that start with our exact extension ID + ";".
      if ($entry -like "$ExtensionId;*") {
        $removed++
        continue
      }
      $kept += $entry
    }
    if ($removed -gt 0) {
      if (-not $scope.CanWrite) {
        Write-Warn2 "$($scope.Label) has $removed of our ExtensionInstallForcelist entries — admin required to remove."
        continue
      }
      if ($kept.Count -eq 0) {
        Remove-ItemProperty -Path $scope.Root -Name "ExtensionInstallForcelist" -ErrorAction Stop
      } else {
        Set-ItemProperty -Path $scope.Root -Name "ExtensionInstallForcelist" -Value $kept -Type StringArray -ErrorAction Stop | Out-Null
      }
      Write-OK "Removed $removed of our ExtensionInstallForcelist entries from $($scope.Label)."
    } else {
      Write-OK "No ExtensionInstallForcelist entries belonged to us in $($scope.Label)."
    }
  } catch {
    Write-Warn2 "Could not inspect ExtensionInstallForcelist in $($scope.Label): $_"
  }
}

# 4. Remove application folder. Report failure honestly.
Write-Step "Removing application folder…"
$installRoot = Join-Path $env:LOCALAPPDATA $AppFolderName
if (Test-Path $installRoot) {
  try {
    Remove-Item -Path $installRoot -Recurse -Force -ErrorAction Stop
    Write-OK "Removed: $installRoot"
  } catch {
    Write-Fail "Could not remove $installRoot : $_"
    Write-Fail "Files may be in use — close Chrome and any editors using the extension, then re-run Uninstall.bat."
  }
} else {
  Write-Warn2 "No application folder to remove."
}

# 5. Final note.
Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Green
Write-Host ""
Write-Host "Notes:"
Write-Host "  - Your LM Studio installation and models were not touched."
Write-Host "  - If you loaded the extension as 'unpacked' in chrome://extensions,"
Write-Host "    you can remove it from there manually (chrome://extensions)."
Write-Host "  - Unrelated Chrome settings and policies were not modified."
Write-Host ""
exit 0
