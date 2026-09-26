<#
.SYNOPSIS
  Detect Chrome installation details.
  Used by install.ps1 to decide Mode A vs Mode B.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"

$result = [PSCustomObject]@{
  Found = $false
  Path = $null
  Version = $null
  MajorVersion = $null
  IsManaged = $false
}

$candidates = @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)
foreach ($p in $candidates) {
  if (Test-Path $p) {
    $result.Found = $true
    $result.Path = $p
    try {
      $vi = (Get-Item $p).VersionInfo
      $result.Version = $vi.FileVersion
      $result.MajorVersion = $vi.FileMajorPart
    } catch {}
    break
  }
}

# Check whether Chrome appears to be enterprise-managed.
foreach ($k in @(
  "HKLM:\Software\Policies\Google\Chrome",
  "HKCU:\Software\Policies\Google\Chrome"
)) {
  if (Test-Path $k) {
    $props = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($props.PSObject.Properties.Count -gt 0) {
      $result.IsManaged = $true
      break
    }
  }
}

$result | Format-List
