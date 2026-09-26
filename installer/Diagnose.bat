@echo off
REM Local Writing Assistant — diagnostics launcher.
setlocal
set PS1=%~dp0diagnose.ps1

if not exist "%PS1%" (
  echo [FAIL] diagnose.ps1 not found next to %~nx0
  exit /b 1
)

where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  exit /b %ERRORLEVEL%
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
