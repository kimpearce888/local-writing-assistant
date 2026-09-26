<#
.SYNOPSIS
  Local Writing Assistant uninstaller for Windows.
.DESCRIPTION
  Removes:
    - native messaging host registration
    - native host executable + manifest
    - application folder under %LOCALAPPDATA%\LocalWritingAssistant
    - this app's own ExtensionInstallForcelist entries (and ONLY ours)
  Does NOT touch:
    - the user's LM Studio installation or models
    - unrelated Chrome settings
    - unrelated Chrome policies
#>

[CmdletBinding()]
param([switch]$Silent)

$ErrorActionPreference = "Continue"

function Write-Step($msg) { if (-not $Silent) { Write-Host "[..] $msg" -ForegroundColor Cyan } }
function Write-OK($msg) { if (-not $Silent) { Write-Host "[PASS] $msg" -ForegroundColor Green } }
function Write-Warn2($msg) { if (-not $Silent) { Write-Host "[WARN] $msg" -ForegroundColor Yellow } }

$AppFolderName = "LocalWritingAssistant"
$HostName = "com.localwritingassistant.host"
$ChromePolicy_User = "HKCU:\Software\Policies\Google\Chrome"
$ChromeNative_User = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"

# 1. Stop native host process.
Write-Step "Stopping native host process…"
Get-Process -Name "LocalWritingAssistantHost" -ErrorAction SilentlyContinue |
  ForEach-Object { try { $_ | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
Write-OK "Done."

# 2. Remove native messaging registry entry.
Write-Step "Removing native messaging host registration…"
$keyPath = "$ChromeNative_User\$HostName"
if (Test-Path $keyPath) {
  Remove-Item -Path $keyPath -Recurse -Force -ErrorAction SilentlyContinue
  Write-OK "Removed: $keyPath"
} else {
  Write-Warn2 "No native messaging registration to remove."
}

# 3. Remove our own ExtensionInstallForcelist entries (only ours).
#    We iterate the list and drop entries that contain our host name or
#    a file:// path that points into our application folder.
Write-Step "Removing our own ExtensionInstallForcelist entries…"
if (Test-Path $ChromePolicy_User) {
  try {
    $existing = Get-ItemProperty -Path $ChromePolicy_User -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
    if ($existing) {
      $kept = @()
      $removed = 0
      foreach ($p in $existing.PSObject.Properties) {
        if ($p.Name -notmatch "^\d+$") { continue }
        $val = [string]$p.Value
        if ($val -match "LocalWritingAssistant" -or $val -match "LocalWritingAssistantHost") {
          $removed++
          continue
        }
        $kept += $val
      }
      if ($removed -gt 0) {
        Remove-ItemProperty -Path $ChromePolicy_User -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
        if ($kept.Count -gt 0) {
          New-ItemProperty -Path $ChromePolicy_User -Name "ExtensionInstallForcelist" -Value $kept -PropertyType StringArray -Force | Out-Null
        }
        Write-OK "Removed $removed of our ExtensionInstallForcelist entries."
      } else {
        Write-OK "No ExtensionInstallForcelist entries belonged to us."
      }
    }
  } catch {
    Write-Warn2 "Could not inspect ExtensionInstallForcelist: $_"
  }
}

# 4. Remove application folder.
Write-Step "Removing application folder…"
$installRoot = Join-Path $env:LOCALAPPDATA $AppFolderName
if (Test-Path $installRoot) {
  Remove-Item -Path $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  Write-OK "Removed: $installRoot"
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
