<#
.SYNOPSIS
  Generate (or update) Chrome enterprise policy entries that force-install
  the Local Writing Assistant extension. Used by install.ps1 when Mode A
  is supported.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ExtensionId,
  [Parameter(Mandatory=$true)][string]$CodebaseUrl,
  [switch]$MachineScope
)

$ErrorActionPreference = "Stop"

$policyRoot = if ($MachineScope) {
  "HKLM:\Software\Policies\Google\Chrome"
} else {
  "HKCU:\Software\Policies\Google\Chrome"
}

if (-not (Test-Path $policyRoot)) {
  New-Item -Path $policyRoot -Force | Out-Null
}

# Read existing entries, find next free index, and append ours.
$existing = Get-ItemProperty -Path $policyRoot -Name "ExtensionInstallForcelist" -ErrorAction SilentlyContinue
$nextIdx = 1
$existingValues = @()
if ($existing) {
  foreach ($p in $existing.PSObject.Properties) {
    if ($p.Name -match "^\d+$") {
      $existingValues += [string]$p.Value
      $i = [int]$p.Name
      if ($i -ge $nextIdx) { $nextIdx = $i + 1 }
    }
  }
}

# Don't add a duplicate.
$entry = "$ExtensionId;$CodebaseUrl"
if ($existingValues -contains $entry) {
  Write-Host "Entry already present: $entry" -ForegroundColor Yellow
  exit 0
}

# Append. PowerShell StringArray lets us use a single Set-ItemProperty call.
$all = $existingValues + $entry
Set-ItemProperty -Path $policyRoot -Name "ExtensionInstallForcelist" -Value $all -Type MultiString -Force
Write-Host "Added ExtensionInstallForcelist[$nextIdx] = $entry" -ForegroundColor Green
