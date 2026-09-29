@echo off
REM Local Writing Assistant — Windows uninstaller launcher.
REM Uses EnableDelayedExpansion + !ERRORLEVEL! so the launcher forwards
REM the real exit code of uninstall.ps1 instead of always 0.

setlocal enabledelayedexpansion
set PS1=%~dp0uninstall.ps1

if not exist "%PS1%" (
  echo [FAIL] uninstall.ps1 not found next to %~nx0
  echo Expected: %PS1%
  exit /b 1
)

where pwsh >nul 2>&1
if !ERRORLEVEL!==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  exit /b !ERRORLEVEL!
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b !ERRORLEVEL!
