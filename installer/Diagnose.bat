@echo off
REM Local Writing Assistant — diagnostics launcher.
REM Uses EnableDelayedExpansion + !ERRORLEVEL! so the launcher forwards
REM the real exit code of diagnose.ps1 instead of always 0.

setlocal enabledelayedexpansion
set PS1=%~dp0diagnose.ps1

if not exist "%PS1%" (
  echo [FAIL] diagnose.ps1 not found next to %~nx0
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
